import Database from 'better-sqlite3';
import crypto from 'crypto';
import {
  SettingsDraft,
  SettingsPreviewRequestSchema,
} from '@/contracts/settings';
import {
  hashSettingsDraft,
  saveSettingsPreview,
  draftToAliasMap,
  draftToScheduleOverride,
  getLatestSettingsVersion,
} from '@/adapters/sqlite/settings-repository';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { StudentSnapshot } from '@/domain/students';

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

export interface SettingsPreviewResult {
  previewId: string;
  inputHash: string;
  affectedStudents: number;
  /** 各 -0.5 天等天數變化明細（personCode → [before, after]） */
  dayDeltas: Array<{ personCode: string; name: string; before: number | null; after: number | null }>;
  mismatchBefore: number;
  mismatchAfter: number;
  tierTransitions: TierTransition[];
  issueDelta: { before: number; after: number };
  expiresAt: string;
}

function loadStudents(db: Database.Database, importId: string): StudentSnapshot[] {
  const studentRows = db
    .prepare('SELECT * FROM imported_students WHERE import_id = ? ORDER BY source_row ASC')
    .all(importId) as any[];
  const enrollmentRows = db
    .prepare('SELECT * FROM student_enrollments WHERE import_id = ? ORDER BY person_code ASC, token_index ASC')
    .all(importId) as any[];
  const map: Record<string, any[]> = {};
  for (const r of enrollmentRows) {
    (map[r.person_code] ??= []).push({
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
  return studentRows.map((row) => ({
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
    enrollments: map[row.person_code] || [],
    sourceRow: row.source_row,
  }));
}

/**
 * T05: 設定草稿 dry-run 影響預覽（無副作用，不寫入 active 資料）。
 *
 * 09 §8.2.2：預覽的 import 一律由 server 依 `active_state.active_import_id` 決定。
 * `clientImportId` 只是過渡期的一致性檢查：`undefined`（未帶）＝不檢查；其餘任何值（含 `null`、
 * 空字串、非字串）只要與 server 決定值不同即 400 IMPORT_MISMATCH，絕不採用 client 值，
 * 因此 client 無法藉預覽／套用偷換或啟用非 active 的批次。
 * 無 active import 時（R1a）維持拒絕 404 NO_ACTIVE_IMPORT，即使存在 ready 批次也不採用；
 * 無學生的 settings_only 儲存由 R1b 提供（09 §8.2.3）。
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
  const { draft, expectedRevision } = parsed.data;

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
  if (importId === null) {
    throw new SettingsPreviewError(
      404,
      '尚無已啟用的現行名單，暫無法預覽並套用設定（不會啟用尚未啟用的匯入批次）。',
      'NO_ACTIVE_IMPORT'
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
  const baseDraft: SettingsDraft | null = latest ? (JSON.parse(latest.contentJson) as SettingsDraft) : null;

  const students = loadStudents(db, importId);
  if (students.length === 0) {
    throw new SettingsPreviewError(404, `找不到匯入批次 ${importId} 之學生資料`);
  }

  const aliasMap = draftToAliasMap(draft);
  const scheduleOverride = draftToScheduleOverride(draft);

  // 取得目前 active run 之 ruleSetVersion（若無則預設為最新正式軌 erp-tag-v2）
  let formalRuleSetVersion = 'erp-tag-v2';
  if (active.active_run_id) {
    const runRow = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(active.active_run_id) as any;
    if (runRow?.rule_set_version) {
      formalRuleSetVersion = runRow.rule_set_version;
    }
  }

  const dayDeltas: SettingsPreviewResult['dayDeltas'] = [];
  const tierTransitions: TierTransition[] = [];
  let mismatchBefore = 0;
  let mismatchAfter = 0;
  let issuesBefore = 0;
  let issuesAfter = 0;

  for (const stu of students) {
    // 預覽僅跑正式軌（不跑 compat 診斷以保證反應速度）
    const before = calculateStudentBilling(stu, { ruleSetVersion: formalRuleSetVersion as any });
    const after = calculateStudentBilling(stu, { aliasMap, scheduleOverride, ruleSetVersion: formalRuleSetVersion as any });

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
          beforeTier: bComp.computedTier,
          afterTier: aComp.computedTier,
          beforeStatus: bComp.status,
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
    previewId,
    inputHash,
    affectedStudents: dayDeltas.length,
    dayDeltas,
    mismatchBefore,
    mismatchAfter,
    tierTransitions,
    issueDelta: { before: issuesBefore, after: issuesAfter },
    expiresAt,
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
  });

  return result;
}
