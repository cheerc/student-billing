import type { QuerySelection, QueryValue } from '@/contracts/student-query';
import { historicalRateCategoryOfClass } from './applicable-rate';

export interface QueryPredicate { sql: string; args: Array<string | number> }
export function sqlValue(value: Exclude<QueryValue, null>): string | number {
  return typeof value === 'boolean' ? Number(value) : value;
}

/** 同欄 OR；未設、空白與空集合分開，不用 truthiness 解析 0／false。 */
export function selectionPredicate(selected: QuerySelection | undefined, column: string, blank = `${column} IS NULL`): QueryPredicate {
  if (!selected) return { sql: '1', args: [] };
  if (selected.none) return { sql: '0', args: [] };
  const args: Array<string | number> = [];
  const terms = selected.values.map((value) => {
    if (value === null) return blank;
    args.push(sqlValue(value));
    return `${column} = ?`;
  });
  return { sql: `(${terms.join(' OR ')})`, args };
}

export function noCoursePredicate(importId: string, alias: string): QueryPredicate {
  return { sql: `NOT EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = ? AND e.person_code = ${alias}.person_code)`, args: [importId] };
}

export function classPredicate(importId: string, alias: string, selected?: QuerySelection): QueryPredicate {
  if (!selected) return { sql: '1', args: [] };
  if (selected.none) return { sql: '0', args: [] };
  const args: Array<string | number> = [];
  const terms = selected.values.map((value) => {
    args.push(importId);
    if (value === null) return `NOT EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = ? AND e.person_code = ${alias}.person_code)`;
    args.push(String(value));
    return `EXISTS (SELECT 1 FROM student_enrollments e WHERE e.import_id = ? AND e.person_code = ${alias}.person_code AND e.base_name = ?)`;
  });
  return { sql: `(${terms.join(' OR ')})`, args };
}

export function branchPredicate(column: string, selected?: QuerySelection): QueryPredicate {
  if (!selected) return { sql: '1', args: [] };
  if (selected.none) return { sql: '0', args: [] };
  const normalized = `replace(replace(${column}, char(13)||char(10), char(10)), char(13), char(10))`;
  const args: Array<string | number> = [];
  const terms = selected.values.map((value) => {
    if (value === null) return `(${column} IS NULL OR trim(${column}) = '')`;
    const branch = String(value).trim().replace(/\r\n?/g, '\n');
    const escaped = escapeLike(branch);
    args.push(branch, `${escaped}\n%`, `%\n${escaped}`, `%\n${escaped}\n%`);
    return `(${normalized} = ? OR ${normalized} LIKE ? ESCAPE '\\' OR ${normalized} LIKE ? ESCAPE '\\' OR ${normalized} LIKE ? ESCAPE '\\')`;
  });
  return { sql: `(${terms.join(' OR ')})`, args };
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** Read-only filter mapping for historical runs without class-category snapshots; current runs use their saved snapshot. */
export function applicableRateColumn(className: string): string | null {
  const category = historicalRateCategoryOfClass(className);
  if (category === 'care') return '(CASE WHEN sc.grade IN (1,2) THEN sc.applicable_anqin_bps WHEN sc.grade BETWEEN 3 AND 6 THEN sc.applicable_tutoring_bps ELSE NULL END)';
  if (category === 'math') return 'sc.applicable_math_bps';
  if (category === 'english') return 'sc.applicable_english_bps';
  return null;
}
