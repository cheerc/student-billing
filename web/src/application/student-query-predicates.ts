import type Database from 'better-sqlite3';
import type { NormalizedStudentQuery, QuerySelection } from '@/contracts/student-query';
import { parseTagDiscounts } from '@/domain/billing/discount-rules';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { ruleSetCapabilities } from '@/domain/billing/rule-set';
import { selectionPredicate, classPredicate, branchPredicate, applicableRateColumn, escapeLike, type QueryPredicate } from './student-query-sql';

/** 同一次 request 共用特殊折扣集合；各欄 facet 不重複全 run 掃描。 */
export function createStudentPredicateBuilder(db: Database.Database, runId: string, importId: string) {
  let specialCodes: string[] | undefined;
  const run = getCalculationRun(db, runId);
  const snapshots = run?.classCategories;
  const ruleSetVersion = run?.ruleSetVersion;
  const usesSnapshot = ruleSetCapabilities(ruleSetVersion ?? 'erp-tag-v2').categoryBasedBilling && Array.isArray(snapshots);

  const getApplicableColumn = (className: string): string | null => {
    if (usesSnapshot && snapshots) {
      const snap = snapshots.find((s) => s.base_name === className);
      if (!snap) return null;
      const fixedFiveDaysAffectsRate = !ruleSetCapabilities(ruleSetVersion ?? 'erp-tag-v2').homeworkDiscountDecoupled;
      if (fixedFiveDaysAffectsRate && snap.fixed_five_days === 1) {
        return '10000';
      }
      if (snap.category === 'care') {
        return '(CASE WHEN sc.grade IN (1,2) THEN sc.applicable_anqin_bps WHEN sc.grade BETWEEN 3 AND 6 THEN sc.applicable_tutoring_bps ELSE NULL END)';
      }
      if (snap.category === 'math') return 'sc.applicable_math_bps';
      if (snap.category === 'english') return 'sc.applicable_english_bps';
      return null;
    }
    return applicableRateColumn(className);
  };
  return (query: NormalizedStudentQuery, excludedKey?: string, replacement?: QuerySelection) => {
    const selected = { ...query.selections };
    if (excludedKey) {
      delete selected[excludedKey];
      if (replacement) selected[excludedKey] = replacement;
    }
    const clauses = ['sc.run_id = ?'];
    const args: Array<string | number> = [runId];
    const add = (predicate: QueryPredicate) => { clauses.push(predicate.sql); args.push(...predicate.args); };
    const classes = classPredicate(importId, 'sc', selected.enrollmentKey);
    add(classes);
    for (const [key, column] of Object.entries({
      grade: 'sc.grade', baseDiscountBps: 'sc.base_discount_bps', anqinDays: 'sc.anqin_days', tutoringDays: 'sc.tutoring_days', hasIssues: 'sc.has_issues',
    })) add(selectionPredicate(selected[key], column));

    const classValues = selected.enrollmentKey && !selected.enrollmentKey.none
      ? selected.enrollmentKey.values.filter((v): v is string => typeof v === 'string') : [];
    const classScopeSql = classValues.length ? `json_extract(j.value, '$.baseName') IN (${classValues.map(() => '?').join(',')}) AND ` : '';
    const mismatch: QueryPredicate = {
      sql: `EXISTS (SELECT 1 FROM json_each(sc.tier_comparisons) j WHERE ${classScopeSql}json_extract(j.value, '$.status') = 'mismatch')`,
      args: classValues,
    };
    if (selected.tierMismatch) {
      if (selected.tierMismatch.none) add({ sql: '0', args: [] });
      else {
        const terms: string[] = [];
        const termArgs: Array<string | number> = [];
        for (const value of selected.tierMismatch.values) {
          if (value === true) { terms.push(mismatch.sql); termArgs.push(...mismatch.args); }
          else if (value === false) {
            terms.push(`(EXISTS (SELECT 1 FROM json_each(sc.tier_comparisons) j WHERE ${classScopeSql}json_extract(j.value, '$.status') = 'match') ` +
              `AND NOT EXISTS (SELECT 1 FROM json_each(sc.tier_comparisons) j WHERE ${classScopeSql}json_extract(j.value, '$.status') IN ('mismatch', 'unavailable')))`);
            termArgs.push(...classValues, ...classValues);
          } else terms.push('0');
        }
        if (terms.length) add({ sql: `(${terms.join(' OR ')})`, args: termArgs });
      }
    }
    add(branchPredicate('sc.branch', selected.branch));
    add(selectionPredicate(selected.hasClass, '(coalesce(sc.subject_count,0) > 0)', '0'));
    if (selected.billingTier) add(selectionPredicate(selected.billingTier, query.careType === 'anqin' ? 'sc.anqin_days' : 'sc.tutoring_days'));
    if (selected.applicableDiscountBps) {
      const classes = selected.enrollmentKey;
      // facet 排除／替換班級時須重查單班前提，不能把排除本欄誤當使用者未選班。
      const single = classes && !classes.none && classes.values.length === 1 && typeof classes.values[0] === 'string';
      const column = single ? getApplicableColumn(String(classes.values[0])) : null;
      add(column ? selectionPredicate(selected.applicableDiscountBps, column) : { sql: '0', args: [] });
    }
    if (query.q) add({ sql: "(sc.name LIKE ? ESCAPE '\\' OR sc.person_code LIKE ? ESCAPE '\\')", args: [`%${escapeLike(query.q)}%`, `%${escapeLike(query.q)}%`] });
    if (query.subject) add({
      sql: "EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = ? AND e.person_code = sc.person_code AND (e.base_name LIKE ? ESCAPE '\\' OR e.raw_token LIKE ? ESCAPE '\\'))",
      args: [importId, `%${escapeLike(query.subject)}%`, `%${escapeLike(query.subject)}%`],
    });
    for (const [key, column, source] of [
      ['issueCode', "json_extract(j.value, '$.code')", 'sc.issues'],
      ['tierComparison', "json_extract(j.value, '$.status')", 'sc.tier_comparisons'],
    ]) {
      const group = selected[key];
      if (!group) continue;
      if (group.none) { add({ sql: '0', args: [] }); continue; }
      const parts: string[] = [];
      const termArgs: Array<string | number> = [];
      for (const value of group.values) {
        if (value === null) parts.push(`json_array_length(${source}) = 0`);
        else { parts.push(`EXISTS (SELECT 1 FROM json_each(${source}) j WHERE ${column} = ?)`); termArgs.push(String(value)); }
      }
      add({ sql: `(${parts.join(' OR ')})`, args: termArgs });
    }
    for (const [key, tag] of [['sibling', '有兄弟姊妹折扣'], ['internalStudent', '園內生']]) {
      const column = `EXISTS (SELECT 1 FROM imported_students s WHERE s.import_id = '${importId.replace(/'/g, "''")}' AND s.person_code = sc.person_code AND instr(s.tags_raw, '${tag}') > 0)`;
      add(selectionPredicate(selected[key], column, '0'));
    }
    add(selectionPredicate(selected.hasExtraDeduction,
      "(coalesce(json_extract(sc.trace, '$.careDays.anqin.hasExtraFlag'),0) OR coalesce(json_extract(sc.trace, '$.careDays.tutoring.hasExtraFlag'),0))", '0'));
    if (selected.specialDiscount) {
      if (specialCodes === undefined) {
        const tagged = db.prepare('SELECT person_code, trace FROM student_calculations WHERE run_id = ?').all(runId) as Array<{ person_code: string; trace: string }>;
        specialCodes = tagged.filter((row) => parseTagDiscounts(JSON.parse(row.trace).rawTags).specialDiscount !== null).map((row) => row.person_code);
      }
      const hasSpecial = specialCodes.length ? `sc.person_code IN (${specialCodes.map(() => '?').join(',')})` : '0';
      const terms: string[] = [];
      const termArgs: Array<string | number> = [];
      if (selected.specialDiscount.none) terms.push('0');
      for (const value of selected.specialDiscount.values) {
        if (value === null) { terms.push('0'); continue; }
        terms.push(value ? `(${hasSpecial})` : `NOT (${hasSpecial})`);
        termArgs.push(...specialCodes);
      }
      add({ sql: `(${terms.join(' OR ')})`, args: termArgs });
    }
    return { where: { sql: clauses.join(' AND '), args }, classes, mismatch, issues: selectionPredicate({ values: [true], none: false }, 'sc.has_issues') };
  };
}
