import Database from 'better-sqlite3';
import crypto from 'crypto';
import {
  SettingsDraft,
  SettingsDraftSchema,
  SettingsPreviewRequestSchema,
} from '@/contracts/settings';
import {
  hashSettingsDraft,
  saveSettingsPreview,
  draftToAliasMap,
  draftToScheduleOverride,
  buildSeedDraft,
  getLatestSettingsVersion,
} from '@/adapters/sqlite/settings-repository';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { projectActionableIssues } from '@/domain/issues/actionable-issues';
import { careWindowsMatchRuleSet, CARE_WINDOWS_MISMATCH_MESSAGE } from './schedule-preview';
import { resolveTargetRuleSetVersion, RuleSetResolutionError } from './rule-set-resolver';
import { buildClassSettingMap } from './calculate-run';
import { normalizeSettingsDraftSemantics } from '@/domain/classification/class-semantics';
import { loadStudentsForImport } from '@/adapters/sqlite/import-repository';
import { getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';

export class SettingsPreviewError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, message: string, code = 'SETTINGS_PREVIEW_FAILED') {
    super(message);
    this.name = 'SettingsPreviewError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface TierTransition {
  personCode: string;
  name: string;
  sourceRow: number;
  beforeTier: number | null;
  afterTier: number | null;
  beforeStatus: string;
  afterStatus: string;
}

export interface CourseRateDelta {
  personCode: string;
  name: string;
  course: 'anqin' | 'tutoring' | 'english' | 'math' | 'enrichment' | 'chinese';
  courseLabel: string;
  before: number | null;
  after: number | null;
}

const PREVIEW_RATE_COURSES: ReadonlyArray<{
  key: CourseRateDelta['course'];
  label: string;
}> = [
  { key: 'anqin', label: '安親' },
  { key: 'tutoring', label: '課輔' },
  { key: 'english', label: '美語' },
  { key: 'math', label: '數學' },
  { key: 'enrichment', label: '加強班' },
  { key: 'chinese', label: '國語文' },
];

export interface SettingsPreviewResult {
  /**
   * 由 server 依 active_state 決定（09 §8.2.2／§8.2.3）：有現行名單 → with_students；
   * 無現行名單 → settings_only（只存設定，學生影響欄位為 null，不能寫 0 當作驗過）。
   */
  mode: 'settings_only' | 'with_students';
  previewId: string;
  inputHash: string;
  affectedStudents: number | null;
  /** 各 -0.5 天等天數變化明細（personCode → [before, after]）；settings_only 為 null */
  dayDeltas: Array<{ personCode: string; name: string; before: number | null; after: number | null }> | null;
  mismatchBefore: number | null;
  mismatchAfter: number | null;
  tierTransitions: TierTransition[] | null;
  issueDelta: { before: number; after: number } | null;
  expiresAt: string;
  /** D2b 4（Q11）：本次套用會產生的規則版本（由 server 決定並記錄，apply 只讀它） */
  targetRuleSetVersion: string;
  /** D2b 6：已補科數（類別種數）的變化明細；只列出有變化者 */
  subjectCountDeltas: Array<{ personCode: string; name: string; before: number | null; after: number | null }> | null;
  /** D2b 6：合計折扣（基本率收取率 bps）的變化明細；只列出有變化者 */
  baseDiscountDeltas: Array<{ personCode: string; name: string; before: number | null; after: number | null }> | null;
  /** #112 Ruling 2：課程學費折扣（各課程收取率 bps）的變化明細；只列出有變化者；settings_only 為 null */
  courseRateDeltas: CourseRateDelta[] | null;
}

/** settings_only 預覽：無名單可比對，只保存預覽草稿（hash／revision／TTL 與 with_students 相同）。 */
function saveSettingsOnlyPreview(
  db: Database.Database,
  draft: SettingsDraft,
  expectedRevision: number,
  settingsVersionId: string,
  targetRuleSetVersion: string
): SettingsPreviewResult {
  const inputHash = hashSettingsDraft(draft);
  const previewId = `setprev_${inputHash.slice(0, 12)}_${Date.now()}`;
  const now = new Date().toISOString();
  // TTL: 15 分鐘（與 with_students 相同）
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const result: SettingsPreviewResult = {
    mode: 'settings_only',
    previewId,
    inputHash,
    affectedStudents: null,
    dayDeltas: null,
    mismatchBefore: null,
    mismatchAfter: null,
    tierTransitions: null,
    issueDelta: null,
    expiresAt,
    targetRuleSetVersion,
    subjectCountDeltas: null,
    baseDiscountDeltas: null,
    courseRateDeltas: null,
  };

  saveSettingsPreview(db, {
    previewId,
    inputHash,
    draftJson: JSON.stringify(draft),
    expectedRevision,
    settingsVersionId,
    importId: null,
    resultJson: JSON.stringify(result),
    createdAt: now,
    expiresAt,
    targetRuleSetVersion,
  });

  return result;
}

/**
 * T05: 設定草稿 dry-run 影響預覽（無副作用，不寫入 active 資料）。
 *
 * 09 §8.2.2：預覽的 import 一律由 server 依 `active_state.active_import_id` 決定。
 * `clientImportId` 只是過渡期的一致性檢查：`undefined`（未帶）＝不檢查；其餘任何值（含 `null`、
 * 空字串、非字串）只要與 server 決定值不同即 400 IMPORT_MISMATCH，絕不採用 client 值，
 * 因此 client 無法藉預覽／套用偷換或啟用非 active 的批次。
 * 09 §8.2.3：無現行名單（active_import_id 為 null）→ settings_only，即使存在 ready 批次也不採用、不啟用；
 * 預覽只驗草稿格式與 revision，學生影響為 null。
 */
export function previewSettingsChange(
  db: Database.Database,
  clientImportId: unknown,
  rawBody: unknown
): SettingsPreviewResult {
  const parsed = SettingsPreviewRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new SettingsPreviewError(400, `設定草稿格式錯誤：${parsed.error.message}`, 'INVALID_DRAFT');
  }
  const { expectedRevision, targetRuleSetVersion: requestedVersion } = parsed.data;
  // New settings versions carry a bounded registry and explicit unset semantics. Legacy inputs
  // receive a read-only compatibility projection here, then the resulting version is complete.
  const draft = normalizeSettingsDraftSemantics(parsed.data.draft);
  const normalizedDraftValidation = SettingsDraftSchema.safeParse(draft);
  if (!normalizedDraftValidation.success) {
    throw new SettingsPreviewError(400, `設定草稿格式錯誤：${normalizedDraftValidation.error.message}`, 'INVALID_DRAFT');
  }
  // 窗口固定（D33）：draft.careWindows 只允許 ruleSet 值，不同即 400，不靜默忽略（09 §8.1）
  if (!careWindowsMatchRuleSet(draft)) {
    throw new SettingsPreviewError(400, CARE_WINDOWS_MISMATCH_MESSAGE, 'INVALID_DRAFT');
  }

  const active = db
    .prepare('SELECT revision, active_run_id, active_import_id FROM active_state WHERE id = 1')
    .get() as any;
  if (!active) throw new SettingsPreviewError(500, 'ActiveState 未初始化');

  const importId: string | null = active.active_import_id ?? null;
  if (clientImportId !== undefined && clientImportId !== importId) {
    throw new SettingsPreviewError(
      400,
      '請求的 importId 與伺服器依 active_state 決定的現行名單不符；設定預覽與套用不接受由 client 指定或切換名單。',
      'IMPORT_MISMATCH'
    );
  }
  if (active.revision !== expectedRevision) {
    throw new SettingsPreviewError(
      409,
      `版本衝突：目前 revision 為 ${active.revision}，請求為 ${expectedRevision}`,
      'REVISION_CONFLICT'
    );
  }

  const latest = getLatestSettingsVersion(db);
  // 新計算只允許 v4。舊版 active 預覽必須明確帶 v4（設定頁 upgrade checkbox）；
  // 其他請求 fail-closed，不會退回舊 calculator 或把舊 run 悄悄重算。
  let formalRuleSetVersion;
  try {
    formalRuleSetVersion = resolveTargetRuleSetVersion(db, requestedVersion);
  } catch (e) {
    if (e instanceof RuleSetResolutionError) {
      throw new SettingsPreviewError(409, e.message, e.code);
    }
    throw e;
  }

  const activeRun = getCurrentActiveRun(db).run;

  if (importId === null) {
    return saveSettingsOnlyPreview(db, draft, expectedRevision, latest?.id ?? 'seed-v250922', formalRuleSetVersion);
  }

  const students = loadStudentsForImport(db, importId);
  if (students.length === 0) {
    throw new SettingsPreviewError(404, `找不到匯入批次 ${importId} 之學生資料`);
  }
  if (!activeRun || activeRun.importId !== importId) {
    throw new SettingsPreviewError(
      409,
      '現行名單沒有可供比較的已保存 Run；請重新啟用名單後再預覽設定。',
      'ACTIVE_RUN_UNAVAILABLE'
    );
  }

  // 「前」一律使用 active Run 實際保存的值。尤其舊版升級時，不能再次呼叫已退役的舊 calculator。
  const persistedBefore = db.prepare(`
    SELECT person_code, subject_count, base_discount_bps, anqin_days, tutoring_days,
      applicable_anqin_bps, applicable_tutoring_bps, applicable_english_bps, applicable_math_bps,
      issues, tier_comparisons
    FROM student_calculations WHERE run_id = ?
  `).all(activeRun.id) as Array<{
    person_code: string;
    subject_count: number | null;
    base_discount_bps: number | null;
    anqin_days: number | null;
    tutoring_days: number | null;
    applicable_anqin_bps: number | null;
    applicable_tutoring_bps: number | null;
    applicable_english_bps: number | null;
    applicable_math_bps: number | null;
    issues: string;
    tier_comparisons: string;
  }>;
  const beforeByCode = new Map(persistedBefore.map((row) => [row.person_code, row]));

  const aliasMap = draftToAliasMap(draft);
  const scheduleOverride = draftToScheduleOverride(draft);
  const classSettings = buildClassSettingMap(draft);

  const dayDeltas: SettingsPreviewResult['dayDeltas'] = [];
  const subjectCountDeltas: NonNullable<SettingsPreviewResult['subjectCountDeltas']> = [];
  const baseDiscountDeltas: NonNullable<SettingsPreviewResult['baseDiscountDeltas']> = [];
  const courseRateDeltas: CourseRateDelta[] = [];
  const tierTransitions: TierTransition[] = [];
  let mismatchBefore = 0;
  let mismatchAfter = 0;
  let issuesBefore = 0;
  let issuesAfter = 0;

  for (const stu of students) {
    const saved = beforeByCode.get(stu.personCode);
    if (!saved) {
      throw new SettingsPreviewError(
        409,
        `現行 Run 缺少學生 ${stu.personCode} 的已保存結果；無法安全建立設定預覽。`,
        'ACTIVE_RUN_INCOMPLETE'
      );
    }
    const beforeTierComparisons = JSON.parse(saved.tier_comparisons || '[]') as Array<{ status?: string; computedTier?: number | null; needsReview?: boolean }>;
    const beforeIssues = JSON.parse(saved.issues || '[]') as Array<{ code: string }>;
    const actionableBefore = projectActionableIssues(beforeIssues, beforeTierComparisons);
    const beforeApplicableRates: Partial<Record<CourseRateDelta['course'], number | null>> = {
      anqin: saved.applicable_anqin_bps,
      tutoring: saved.applicable_tutoring_bps,
      english: saved.applicable_english_bps,
      math: saved.applicable_math_bps,
    };
    const before = {
      careDays: {
        anqin: { days: saved.anqin_days },
        tutoring: { days: saved.tutoring_days },
      },
      tierComparisons: beforeTierComparisons,
      hasIssues: actionableBefore.actionableHasIssues,
      subjectCount: saved.subject_count,
      baseDiscountBps: saved.base_discount_bps,
      applicableRates: beforeApplicableRates,
    };
    const after = calculateStudentBilling(stu, {
      aliasMap,
      scheduleOverride,
      classSettings,
      ruleSetVersion: formalRuleSetVersion,
    });

    const beforeDays = stu.grade !== null && stu.grade <= 2
      ? before.careDays.anqin.days
      : before.careDays.tutoring.days;
    const afterDays = stu.grade !== null && stu.grade <= 2
      ? after.careDays.anqin.days
      : after.careDays.tutoring.days;

    const bMismatch = before.tierComparisons.some((c) => c.status === 'mismatch');
    const aMismatch = after.tierComparisons.some((c) => c.status === 'mismatch');
    if (bMismatch) mismatchBefore++;
    if (aMismatch) mismatchAfter++;
    if (before.hasIssues) issuesBefore++;
    if (after.hasIssues) issuesAfter++;

    if (beforeDays !== afterDays) {
      dayDeltas.push({ personCode: stu.personCode, name: stu.name, before: beforeDays, after: afterDays });
    }

    // D2b 6：類別變更不影響天數時，科數與合計折扣仍須呈現（否則畫面會顯示「未改變收費天數」而漏掉折扣影響）
    if (before.subjectCount !== after.subjectCount) {
      subjectCountDeltas.push({ personCode: stu.personCode, name: stu.name, before: before.subjectCount, after: after.subjectCount });
    }
    if (before.baseDiscountBps !== after.baseDiscountBps) {
      baseDiscountDeltas.push({ personCode: stu.personCode, name: stu.name, before: before.baseDiscountBps, after: after.baseDiscountBps });
    }

    // #112 Ruling 2：第四類差異——課程學費折扣差異（比對各科目收取率）
    for (const { key, label } of PREVIEW_RATE_COURSES) {
      const bRate = before.applicableRates[key];
      const aRate = after.applicableRates[key];
      // 舊 schema 僅保存四個 applicable_* 欄位；enrichment/chinese before 不可由目前公式重建。
      // 缺少 persisted before 時略過比較，避免把未知值當 null 製造升級差異。
      if (bRate === undefined) continue;
      if (bRate !== aRate) {
        courseRateDeltas.push({
          personCode: stu.personCode,
          name: stu.name,
          course: key,
          courseLabel: label,
          before: bRate,
          after: aRate,
        });
      }
    }

    // 記錄 match/mismatch 轉換
    if (
      (bMismatch !== aMismatch) ||
      before.tierComparisons.some((c, i) => after.tierComparisons[i] && c.status !== after.tierComparisons[i].status)
    ) {
      const bComp = before.tierComparisons.find((c) => c.status === 'mismatch') ?? before.tierComparisons[0];
      const aComp = after.tierComparisons.find((c) => c.status === 'mismatch') ?? after.tierComparisons[0];
      if (bComp && aComp) {
        tierTransitions.push({
          personCode: stu.personCode,
          name: stu.name,
          sourceRow: stu.sourceRow,
          beforeTier: bComp.computedTier ?? null,
          afterTier: aComp.computedTier,
          beforeStatus: bComp.status ?? 'unavailable',
          afterStatus: aComp.status,
        });
      }
    }
  }

  const inputHash = hashSettingsDraft(draft);
  const previewId = `setprev_${inputHash.slice(0, 12)}_${Date.now()}`;
  const now = new Date().toISOString();
  // TTL: 15 分鐘
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const result: SettingsPreviewResult = {
    mode: 'with_students',
    previewId,
    inputHash,
    // R2-1 & #112 Ruling 2：四種差異是同一批學生的不同欄位變化，必須以 personCode **聯集去重計數**。
    // 相加會把同一人重複計算（primary B-1）。語意＝「受影響去重人數」，與 09 §3.1 一致。
    affectedStudents: new Set<string>([
      ...dayDeltas.map((d) => d.personCode),
      ...subjectCountDeltas.map((d) => d.personCode),
      ...baseDiscountDeltas.map((d) => d.personCode),
      ...courseRateDeltas.map((d) => d.personCode),
    ]).size,
    dayDeltas,
    mismatchBefore,
    mismatchAfter,
    tierTransitions,
    issueDelta: { before: issuesBefore, after: issuesAfter },
    expiresAt,
    targetRuleSetVersion: formalRuleSetVersion,
    subjectCountDeltas,
    baseDiscountDeltas,
    courseRateDeltas,
  };

  saveSettingsPreview(db, {
    previewId,
    inputHash,
    draftJson: JSON.stringify(draft),
    expectedRevision,
    settingsVersionId: latest?.id ?? 'seed-v250922',
    importId,
    resultJson: JSON.stringify(result),
    createdAt: now,
    expiresAt,
    targetRuleSetVersion: formalRuleSetVersion,
  });

  return result;
}
