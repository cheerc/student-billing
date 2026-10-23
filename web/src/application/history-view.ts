import Database from 'better-sqlite3';
import { getCurrentActiveRun, getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { DeductionsResponse, getScheduleDeductions } from './schedule-deductions';
import { SchedulePreviewError } from './schedule-preview';
import { countActionableIssues } from '@/domain/issues/actionable-issues';

/**
 * 匯入紀錄（specs/09 §2 次入口、§8.3 只讀；UX21）。
 *
 * 行政人員看的是「哪一份名單、何時、現在用的是哪一份」，不是 Run／批次兩張工程表：
 *   - 每個用過的名單（run）一列：目前使用 或 歷史資料
 * 「匯入」的業務語意是「確認使用才算匯入」（#83）：只上傳看預覽、未按「使用這份名單」
 * 就離開的批次，不是匯入，不在此出現，也不留下無效的垃圾卡片。
 * 長 ID、規則版本、雜湊等收進 tech，由畫面放在摺疊區。
 * 本檔只讀不寫（不建 run、不改 active_state、不寫設定）。
 */

export type HistoryStatus = 'current' | 'history';

export interface HistoryEntryTech {
  runId: string | null;
  importId: string;
  scheduleVersionId: string | null;
  ruleSetVersion: string | null;
  numericPolicy: string | null;
  fileHash: string;
  sheetName: string;
}

export interface HistoryEntry {
  /** React key：run id */
  key: string;
  /**
   * 本清單只收真正建立過 calculation run 的名單歷程，故一律是 'run'。
   * 保留此欄位是為了讓「無 run 的列不可能存在」成為可被型別與測試同時約束的契約。
   */
  kind: 'run';
  status: HistoryStatus;
  runId: string;
  importId: string;
  fileName: string;
  /** 名單匯入時間（ISO） */
  importedAt: string;
  /** 資料更新時間（ISO）：run 的建立時間 */
  updatedAt: string;
  /** 核對基準日 */
  asOfDate: string;
  studentCount: number;
  /** 待確認事項筆數（各類問題加總） */
  issueCount: number;
  tech: HistoryEntryTech;
}

interface RunRow {
  run_id: string;
  import_id: string;
  schedule_version_id: string;
  rule_set_version: string;
  numeric_policy: string;
  as_of_date: string;
  issue_counts: string;
  total_students: number;
  run_created_at: string;
  file_name: string | null;
  file_hash: string | null;
  sheet_name: string | null;
  import_created_at: string | null;
}

/** 把每個真正使用過的名單（run）併成一份紀錄清單，最新的在前。 */
export function buildHistoryEntries(db: Database.Database): HistoryEntry[] {
  const currentRunId = getCurrentActiveRun(db).activeRunId;

  // #83：只查 calculation_runs。只上傳看預覽就離開的 import_batches 不在此出現——
  // 沒有 run 就不算匯入，匯入紀錄不為未啟用批次保留分類或垃圾卡片。
  const runRows = db
    .prepare(`
      SELECT r.id AS run_id, r.import_id, r.schedule_version_id, r.rule_set_version, r.numeric_policy,
             r.as_of_date, r.issue_counts, r.total_students, r.created_at AS run_created_at,
             b.file_name, b.file_hash, b.sheet_name, b.created_at AS import_created_at
      FROM calculation_runs r
      LEFT JOIN import_batches b ON b.id = r.import_id
    `)
    .all() as RunRow[];

  const entries: HistoryEntry[] = [];

  for (const r of runRows) {
    const counts = JSON.parse(r.issue_counts || '{}') as Record<string, number>;
    const issueCount = countActionableIssues(counts);
    entries.push({
      key: r.run_id,
      kind: 'run',
      status: r.run_id === currentRunId ? 'current' : 'history',
      runId: r.run_id,
      importId: r.import_id,
      fileName: r.file_name ?? '（來源檔案已不存在）',
      importedAt: r.import_created_at ?? r.run_created_at,
      updatedAt: r.run_created_at,
      asOfDate: r.as_of_date,
      studentCount: r.total_students,
      issueCount,
      tech: {
        runId: r.run_id,
        importId: r.import_id,
        scheduleVersionId: r.schedule_version_id,
        ruleSetVersion: r.rule_set_version,
        numericPolicy: r.numeric_policy,
        fileHash: r.file_hash ?? '',
        sheetName: r.sheet_name ?? '',
      },
    });
  }

  // 由新到舊
  return entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export type RunDeductionsResult =
  | { status: 'ok'; data: DeductionsResponse }
  | { status: 'unavailable'; code: 'SNAPSHOT_UNAVAILABLE' | 'UNSUPPORTED_RULESET'; message: string }
  | { status: 'not_found' };

/** 資料不足的白話說明（09 §5.2）；不外露 run／版本碼，技術訊息留在 API。 */
const UNAVAILABLE_MESSAGES = {
  SNAPSHOT_UNAVAILABLE:
    '找不到當時的課表資料，資料不足，無法重建。系統不會改用最新課表補算，以免與當時的結果不一致。',
  UNSUPPORTED_RULESET: '這筆結果的規則版本無法辨識或不支援，無法安全重建班級扣天。',
} as const;

/**
 * 歷史 run 的班級扣天：讀該 run 當時的課表快照（scope=run），絕不用最新設定補算。
 * 快照不存在或版本無法安全重建時回 unavailable 與可直接顯示的說明；其餘錯誤照常丟出（畫面走失敗態）。
 */
export function getRunDeductionsOrReason(db: Database.Database, runId: string): RunDeductionsResult {
  if (!getCalculationRun(db, runId)) return { status: 'not_found' };
  try {
    return { status: 'ok', data: getScheduleDeductions(db, { runId }) };
  } catch (error) {
    if (error instanceof SchedulePreviewError) {
      if (error.code === 'SNAPSHOT_UNAVAILABLE' || error.code === 'UNSUPPORTED_RULESET') {
        return { status: 'unavailable', code: error.code, message: UNAVAILABLE_MESSAGES[error.code] };
      }
      if (error.code === 'RUN_NOT_FOUND') return { status: 'not_found' };
    }
    throw error;
  }
}
