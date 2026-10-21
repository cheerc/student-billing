import Database from 'better-sqlite3';
import { StudentSnapshot, ParsedToken } from '@/domain/students';
import { calculateStudentBilling, RuleSetVersion, ResolvedClassSession } from '@/domain/billing/billing-calculator';
import { ruleSetCapabilities } from '@/domain/billing/rule-set';
import { CalculationRunRecord, StudentCalculationRecord, RunClassCategoryRecord } from '@/adapters/sqlite/runs-repository';
import seedData from '@/domain/schedules/schedule-seed.json';
import { SettingsDraft } from '@/contracts/settings';
import { todayInTaipei } from '@/lib/datetime';
import { resolveClassEnrollment, ClassSettingLookup } from '@/domain/classification/class-category';
import {
  getLatestSettingsVersion,
  getSettingsVersionById,
  buildSeedDraft,
  draftToAliasMap,
  draftToScheduleOverride,
  readStoredDraft,
} from '@/adapters/sqlite/settings-repository';

/** 尚無任何已儲存設定時的課表版本 id（seed 預設課表）。 */
export const SEED_SCHEDULE_VERSION_ID = 'seed-v250922';

const seedMap = new Map<string, any>();
for (const cls of seedData.classes) {
  seedMap.set(cls.baseName, cls);
}

/** 將設定草稿轉為計算管線與類別快照使用的 classSettingMap (D2a R2-2)。
 *  #113 follow-up：不計扣天已逐時段化（sessions[].skipDeduction → scheduleOverride），不再是班級屬性，
 *  因此這裡不再帶 skipDeduction。 */
export function buildClassSettingMap(draft: SettingsDraft): Map<string, ClassSettingLookup> {
  const map = new Map<string, ClassSettingLookup>();
  for (const c of draft.classes) {
    map.set(c.baseName, {
      classType: c.classType,
      category: c.category,
      categorySource: c.categorySource,
      fixedFiveDays: c.fixedFiveDays,
    });
  }
  return map;
}

export interface CalculateRunOptions {
  scheduleVersionId?: string;
  ruleSetVersion?: RuleSetVersion | string;
  numericPolicy?: string;
  asOfDate?: string;
  /** T05: 設定覆寫（alias 映射與自訂時段），無則使用 seed 預設 */
  aliasMap?: Map<string, string>;
  scheduleOverride?: Map<string, ResolvedClassSession[]>;
  classSettings?: Map<string, ClassSettingLookup>;
}

/**
 * 解析最新已儲存設定供正式 run 計算使用（09 §8.2.1）。
 * 有已儲存設定版本時回傳其 id 與由其 draft 轉出的 alias／時段覆寫（與 apply 同一組轉換）；
 * 尚無任何已儲存設定時回傳 seed 版本 id 且不帶覆寫。
 * 呼叫端須在與 run 建立相同的交易內呼叫，使解析結果與 run 記錄的 scheduleVersionId 一致。
 */
export function resolveLatestSavedSettings(
  db: Database.Database
): Pick<CalculateRunOptions, 'scheduleVersionId' | 'aliasMap' | 'scheduleOverride' | 'classSettings'> {
  const latest = getLatestSettingsVersion(db);
  if (!latest) {
    const seedDraft = buildSeedDraft();
    return {
      scheduleVersionId: SEED_SCHEDULE_VERSION_ID,
      classSettings: buildClassSettingMap(seedDraft),
    };
  }
  const draft = readStoredDraft(latest.contentJson);
  return {
    scheduleVersionId: latest.id,
    aliasMap: draftToAliasMap(draft),
    scheduleOverride: draftToScheduleOverride(draft),
    classSettings: buildClassSettingMap(draft),
  };
}

export function executeCalculationRun(
  db: Database.Database,
  importId: string,
  runId: string,
  options: CalculateRunOptions = {}
): { run: CalculationRunRecord; results: StudentCalculationRecord[]; classCategories?: RunClassCategoryRecord[] } {
  const scheduleVersionId = options.scheduleVersionId || SEED_SCHEDULE_VERSION_ID;
  const ruleSetVersion = options.ruleSetVersion || 'erp-tag-v2';
  const numericPolicy = options.numericPolicy || 'integer-minute-rational-v1';
  const asOfDate = options.asOfDate || todayInTaipei();
  const now = new Date().toISOString();

  // R2-2: 由 executeCalculationRun 從已儲存設定或 seed 建立 classSettings，統一供給計算與快照 (同源)
  let classSettings = options.classSettings;
  if (!classSettings) {
    if (scheduleVersionId && scheduleVersionId !== SEED_SCHEDULE_VERSION_ID) {
      const ver = getSettingsVersionById(db, scheduleVersionId);
      if (ver) {
        const draft = readStoredDraft(ver.contentJson);
        classSettings = buildClassSettingMap(draft);
      }
    }
    if (!classSettings) {
      const seedDraft = buildSeedDraft();
      classSettings = buildClassSettingMap(seedDraft);
    }
  }

  // 1. 讀取學生快照
  const studentRows = db
    .prepare('SELECT * FROM imported_students WHERE import_id = ? ORDER BY source_row ASC')
    .all(importId) as any[];

  if (studentRows.length === 0) {
    throw new Error(`找不到匯入批次 ${importId} 之學生資料`);
  }

  // 2. 讀取報名快照
  const enrollmentRows = db
    .prepare('SELECT * FROM student_enrollments WHERE import_id = ? ORDER BY person_code ASC, token_index ASC')
    .all(importId) as any[];

  const enrollmentsMap: Record<string, ParsedToken[]> = {};
  for (const r of enrollmentRows) {
    if (!enrollmentsMap[r.person_code]) {
      enrollmentsMap[r.person_code] = [];
    }
    enrollmentsMap[r.person_code].push({
      rawToken: r.raw_token,
      yearPrefix: r.year_prefix,
      baseName: r.base_name,
      groupFlag: r.group_flag,
      modifiers: r.modifiers ? JSON.parse(r.modifiers) : [],
      withdrawalDate: r.withdrawal_date,
      erpBillingTierRaw: r.erp_billing_tier_raw,
      erpBillingTier: r.erp_billing_tier,
      tierParseStatus: r.tier_parse_status,
      parseStatus: r.parse_status,
    });
  }

  // 3. 逐一計算學生
  const results: StudentCalculationRecord[] = [];
  const issueCounts: Record<string, number> = {};

  for (const row of studentRows) {
    const enrollments = enrollmentsMap[row.person_code] || [];
    const student: StudentSnapshot = {
      personCode: row.person_code,
      name: row.name,
      branch: row.branch,
      gradeRaw: row.grade_raw,
      grade: row.grade,
      gradeStatus: row.grade_status,
      contact: row.contact,
      schoolInfo: row.school_info,
      tagsRaw: row.tags_raw,
      tags: row.tags_raw ? row.tags_raw.split(/[,;\s]+/).filter(Boolean) : [],
      notesRaw: row.notes_raw,
      enrollments,
      sourceRow: row.source_row,
    };

    // 正式軌計算
    const formal = calculateStudentBilling(student, {
      ruleSetVersion: ruleSetVersion as any,
      aliasMap: options.aliasMap,
      scheduleOverride: options.scheduleOverride,
      classSettings,
    });

    // 診斷軌計算 (比較 NUMERIC_POLICY_DIFFERENCE 與 RULESET_POLICY_DIFFERENCE)
    const compat = calculateStudentBilling(student, {
      ruleSetVersion: 'excel-v260922-compat',
      aliasMap: options.aliasMap,
      scheduleOverride: options.scheduleOverride,
      classSettings,
    });

    if (ruleSetCapabilities(ruleSetVersion).diagnosticsDecomposition) {
      const shadowV2 = calculateStudentBilling(student, {
        ruleSetVersion: 'erp-tag-v2',
        aliasMap: options.aliasMap,
        scheduleOverride: options.scheduleOverride,
        classSettings,
      });

      // 1. formal(v3) vs shadow(v2) 天數差 -> 新舊規則政策差異 (Q12)
      if (
        formal.careDays.anqin.days !== shadowV2.careDays.anqin.days ||
        formal.careDays.tutoring.days !== shadowV2.careDays.tutoring.days
      ) {
        formal.issues.push({
          code: 'RULESET_POLICY_DIFFERENCE',
          message: '新舊規則對這位學生的算法不同。',
        });
      }

      // 2. shadow(v2) vs compat 天數差 -> 數值取整政策差異 (D24)
      if (
        shadowV2.careDays.anqin.days !== compat.careDays.anqin.days ||
        shadowV2.careDays.tutoring.days !== compat.careDays.tutoring.days
      ) {
        formal.issues.push({
          code: 'NUMERIC_POLICY_DIFFERENCE',
          message: '正式整數分鐘取整 (D24) 與歷史 Excel 日分數浮點取整產生天數差異。',
        });
      }
    } else {
      if (
        formal.careDays.anqin.days !== compat.careDays.anqin.days ||
        formal.careDays.tutoring.days !== compat.careDays.tutoring.days
      ) {
        formal.issues.push({
          code: 'NUMERIC_POLICY_DIFFERENCE',
          message: '正式整數分鐘取整 (D24) 與歷史 Excel 日分數浮點取整產生天數差異。',
        });
      }
    }

    // 計算八項天數
    // D2d B（04 §8 UX71；D40 Q10-A）：v3 重複同類時取「選中班」的場次數，與天數計算同一份
    // 選班結果（`formal.selection`），不得各自再取一次首班——否則同一學生會出現
    // 「天數按 Chevady 算、englishDays 按 Gino 算」的鏡像不一致。
    // v1／v2／compat 無 selection（仍是首班語意），名稱判斷與 seed 場次數來源皆不變。
    let englishDays: number | null = null;
    const hasEnglish = enrollments.some((e) => e.baseName.includes('兒童美語'));
    if (hasEnglish) {
      if (ruleSetCapabilities(ruleSetVersion).categoryBasedBilling && formal.selection?.english) {
        const selected = formal.selection.english.selectedBaseName;
        const enSeed = seedMap.get(selected);
        englishDays = enSeed ? enSeed.sessions.length : 2;
      } else {
        const enToken = enrollments.find((e) => e.baseName.includes('兒童美語'));
        const enSeed = enToken ? seedMap.get(enToken.baseName) : null;
        englishDays = enSeed ? enSeed.sessions.length : 2;
      }
    }

    let mathDays: number | null = null;
    const hasMath = enrollments.some((e) => e.baseName.includes('國小數學'));
    if (hasMath) {
      if (ruleSetCapabilities(ruleSetVersion).categoryBasedBilling && formal.selection?.math) {
        const selected = formal.selection.math.selectedBaseName;
        const maSeed = seedMap.get(selected);
        mathDays = maSeed ? maSeed.sessions.length : 2;
      } else {
        const maToken = enrollments.find((e) => e.baseName.includes('國小數學'));
        const maSeed = maToken ? seedMap.get(maToken.baseName) : null;
        mathDays = maSeed ? maSeed.sessions.length : 2;
      }
    }

    let chineseDays: number | null = null;
    if (enrollments.some((e) => e.baseName.includes('國語文'))) {
      chineseDays = 1;
    }

    let homeworkDays: number | null = null;
    if (enrollments.some((e) => e.baseName.includes('寫功課'))) {
      homeworkDays = 5;
    }

    let intensiveEnglishDays: number | null = null;
    if (enrollments.some((e) => e.baseName.includes('加重美語') || e.baseName.includes('密集美語'))) {
      intensiveEnglishDays = 2;
    }

    let saturdayTutoringDays: number | null = null;
    if (enrollments.some((e) => e.baseName.includes('週六課輔') || (e.baseName.includes('加強班') && e.rawToken.includes('六')))) {
      saturdayTutoringDays = 1;
    }

    const tierMismatch = formal.tierComparisons.some((c) => c.status === 'mismatch');
    const hasIssues = formal.issues.length > 0 || formal.tierComparisons.some((c) => c.needsReview);

    // 累計各問題碼數量
    for (const issue of formal.issues) {
      issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;
    }

    const issuesArr = [...formal.issues];
    Object.defineProperty(issuesArr, 'toString', {
      value: () => JSON.stringify(formal.issues),
      configurable: true,
      writable: true,
    });

    results.push({
      id: `${runId}_${student.personCode}`,
      runId,
      personCode: student.personCode,
      name: student.name,
      branch: student.branch,
      grade: student.grade,
      gradeRaw: student.gradeRaw,
      subjectCount: formal.subjectCount,
      baseDiscountBps: formal.baseDiscountBps,
      anqinDays: formal.careDays.anqin.days,
      anqinDisplay: formal.careDays.anqin.displayDays,
      tutoringDays: formal.careDays.tutoring.days,
      tutoringDisplay: formal.careDays.tutoring.displayDays,
      englishDays,
      mathDays,
      chineseDays,
      homeworkDays,
      intensiveEnglishDays,
      saturdayTutoringDays,
      applicableAnqinBps: formal.applicableRates.anqin,
      applicableTutoringBps: formal.applicableRates.tutoring,
      applicableEnglishBps: formal.applicableRates.english,
      applicableMathBps: formal.applicableRates.math,
      tierMismatch,
      tierComparisons: formal.tierComparisons,
      issues: issuesArr,
      hasIssues,
      trace: {
        sourceRow: student.sourceRow,
        rawTags: student.tagsRaw,
        rawNotes: student.notesRaw,
        enrollments: student.enrollments,
        careDays: formal.careDays,
      },
      createdAt: now,
    });
  }

  const run: CalculationRunRecord = {
    id: runId,
    importId,
    scheduleVersionId,
    ruleSetVersion,
    numericPolicy,
    asOfDate,
    status: 'completed',
    issueCounts,
    totalStudents: results.length,
    createdAt: now,
  };

  // R2-1 & R2-2: 產生 run_class_categories 快照物件，供 saveCalculationRun 持久化
  let classCategories: RunClassCategoryRecord[] | undefined;
  if (ruleSetCapabilities(ruleSetVersion).categoryBasedBilling) {
    const classCategoryMap = new Map<string, RunClassCategoryRecord>();

    for (const r of enrollmentRows) {
      if (!classCategoryMap.has(r.base_name)) {
        const resolved = resolveClassEnrollment(
          { rawToken: r.raw_token, baseName: r.base_name },
          options.aliasMap,
          classSettings
        );
        classCategoryMap.set(r.base_name, {
          baseName: r.base_name,
          category: resolved.category,
          fixedFiveDays: resolved.fixedFiveDays ? 1 : 0,
          mapped: resolved.mapped ? 1 : 0,
          // #157 Ruling 4：來源值域為 'manual' | 'unset'（舊 'auto' 不再寫入）。
          source: resolved.categorySource,
        });
      }
    }

    classCategories = Array.from(classCategoryMap.values());

    // D2c N-1：快照寫入點唯一。
    // 原本此處另有「若 calculation_runs 在呼叫前已存在（例如測試中先建好 run）就補寫快照」
    // 的分支，該分支只為測試而存在、且讓寫入點不唯一（與 saveCalculationRun 的正式寫入並行）。
    // 已移除：快照一律由 saveCalculationRun 在 calculation_runs 確定存在之後寫入，
    // 既避免 run_class_categories 的 ON DELETE CASCADE 級聯刪除，也讓寫入點只有一處。
    // 呼叫端契約不變：executeCalculationRun 仍在回傳物件中帶 classCategories。
  }

  return { run, results, classCategories };
}
