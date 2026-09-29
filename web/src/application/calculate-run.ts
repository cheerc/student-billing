import Database from 'better-sqlite3';
import { StudentSnapshot, ParsedToken } from '@/domain/students';
import { calculateStudentBilling, RuleSetVersion } from '@/domain/billing/billing-calculator';
import { CalculationRunRecord, StudentCalculationRecord } from '@/adapters/sqlite/runs-repository';
import seedData from '@/domain/schedules/schedule-seed.json';
import { SettingsDraft } from '@/contracts/settings';
import {
  getLatestSettingsVersion,
  draftToAliasMap,
  draftToScheduleOverride,
} from '@/adapters/sqlite/settings-repository';

/** 尚無任何已儲存設定時的課表版本 id（seed 預設課表）。 */
export const SEED_SCHEDULE_VERSION_ID = 'seed-v250922';

const seedMap = new Map<string, any>();
for (const cls of seedData.classes) {
  seedMap.set(cls.baseName, cls);
}

export interface CalculateRunOptions {
  scheduleVersionId?: string;
  ruleSetVersion?: RuleSetVersion | string;
  numericPolicy?: string;
  asOfDate?: string;
  /** T05: 設定覆寫（alias 映射與自訂時段），無則使用 seed 預設 */
  aliasMap?: Map<string, string>;
  scheduleOverride?: Map<string, Array<{ start: number; end: number; weekday?: string | null }>>;
}

/**
 * 解析最新已儲存設定供正式 run 計算使用（09 §8.2.1）。
 * 有已儲存設定版本時回傳其 id 與由其 draft 轉出的 alias／時段覆寫（與 apply 同一組轉換）；
 * 尚無任何已儲存設定時回傳 seed 版本 id 且不帶覆寫。
 * 呼叫端須在與 run 建立相同的交易內呼叫，使解析結果與 run 記錄的 scheduleVersionId 一致。
 */
export function resolveLatestSavedSettings(
  db: Database.Database
): Pick<CalculateRunOptions, 'scheduleVersionId' | 'aliasMap' | 'scheduleOverride'> {
  const latest = getLatestSettingsVersion(db);
  if (!latest) {
    return { scheduleVersionId: SEED_SCHEDULE_VERSION_ID };
  }
  const draft = JSON.parse(latest.contentJson) as SettingsDraft;
  return {
    scheduleVersionId: latest.id,
    aliasMap: draftToAliasMap(draft),
    scheduleOverride: draftToScheduleOverride(draft),
  };
}

export function executeCalculationRun(
  db: Database.Database,
  importId: string,
  runId: string,
  options: CalculateRunOptions = {}
): { run: CalculationRunRecord; results: StudentCalculationRecord[] } {
  const scheduleVersionId = options.scheduleVersionId || SEED_SCHEDULE_VERSION_ID;
  const ruleSetVersion = options.ruleSetVersion || 'erp-tag-v2';
  const numericPolicy = options.numericPolicy || 'integer-minute-rational-v1';
  const asOfDate = options.asOfDate || new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

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
    });

    // 診斷軌計算 (比較 NUMERIC_POLICY_DIFFERENCE)
    const compat = calculateStudentBilling(student, {
      ruleSetVersion: 'excel-v260922-compat',
      aliasMap: options.aliasMap,
      scheduleOverride: options.scheduleOverride,
    });

    if (
      formal.careDays.anqin.days !== compat.careDays.anqin.days ||
      formal.careDays.tutoring.days !== compat.careDays.tutoring.days
    ) {
      formal.issues.push({
        code: 'NUMERIC_POLICY_DIFFERENCE',
        message: '正式整數分鐘取整 (D24) 與歷史 Excel 日分數浮點取整產生天數差異。',
      });
    }

    // 計算八項天數
    let englishDays: number | null = null;
    const hasEnglish = enrollments.some((e) => e.baseName.includes('兒童美語'));
    if (hasEnglish) {
      const enToken = enrollments.find((e) => e.baseName.includes('兒童美語'));
      const enSeed = enToken ? seedMap.get(enToken.baseName) : null;
      englishDays = enSeed ? enSeed.sessions.length : 2;
    }

    let mathDays: number | null = null;
    const hasMath = enrollments.some((e) => e.baseName.includes('國小數學'));
    if (hasMath) {
      const maToken = enrollments.find((e) => e.baseName.includes('國小數學'));
      const maSeed = maToken ? seedMap.get(maToken.baseName) : null;
      mathDays = maSeed ? maSeed.sessions.length : 2;
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
      issues: formal.issues,
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

  return { run, results };
}
