import Database from 'better-sqlite3';
import { SettingsDraft } from '@/contracts/settings';
import { buildSeedDraft, getLatestSettingsVersion, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { classifyErpDualTrack } from '@/domain/schedules/seed-manifest';
import { loadRunSnapshot } from './run-snapshot';

/**
 * 班名比對報告 read model（D1；03 §5、04 §8 UX44–UX47；S manifest §8）。純資料比對，與規則版本無關。
 *
 * 兩份清單（都以班名為單位，人數一律是去重人數，同一人在多個班算 1 人）：
 *  - rosterOnly「米豆奶有／系統無」：本次名冊出現，但既不是設定裡的班、也沒有被「班名對應」解析到設定裡的班；
 *  - systemOnly「系統有／本次名冊無」：設定裡的班，本次名冊沒有以該班名「直接」出現的報名。
 * 別名不對稱（畫面文案要明說）：米豆奶側，被別名對到系統班的名稱算「已對應」；系統側，只有別名覆蓋、
 * 名冊沒有直接以該班名報名的班，仍列在 systemOnly 並標出 aliasCoveredBy（不掩蓋真相，01 §4.3）。
 * 分類沿用 classifyErpDualTrack（與課表設定「班名對應」、匯入預覽待確認班名同源同判斷）。
 *
 * Q12-b：systemOnly 的影響人數＝「上一份名單」該班的去重人數（漂移參考），標註來源名單；沒有上一份名單 → null（不寫 0）。
 * 設定範圍：latest＝最新已儲存設定（尚無才是 seed）；run＝該 run 當時的設定快照，快照缺失 → 「無法判定」
 * （snapshotStatus＝unavailable，清單與計數為 null，不猜、不改用最新設定）。
 * D1 的報告完全不含「類別」（類別是 D2 的功能）。
 */

export type ClassNameReportScope = { kind: 'latest' } | { kind: 'run'; runId: string };

export interface RosterOnlyClass {
  baseName: string;
  /** 本次名冊中報名此班的不重複學生數 */
  students: number;
  /** 報名筆數（同一人可有多筆） */
  tokens: number;
}

export interface SystemOnlyClass {
  baseName: string;
  /** 設定中此班是否啟用 */
  active: boolean;
  /** 本次名冊中被別名對到此班的米豆奶班名（名冊沒有直接以此班名報名時才會在這份清單裡出現） */
  aliasCoveredBy: string[];
  /** 上一份名單該班的不重複學生數；沒有上一份名單為 null */
  previousRosterStudents: number | null;
}

export interface PreviousRosterInfo {
  importId: string;
  fileName: string;
  createdAt: string;
}

export interface ClassNameMatchReport {
  importId: string;
  scope: ClassNameReportScope;
  snapshotStatus: 'ok' | 'unavailable';
  rosterOnly: RosterOnlyClass[] | null;
  systemOnly: SystemOnlyClass[] | null;
  /** 已對應的名冊班名數（直接相符＋經別名對應） */
  matchedCount: number | null;
  /** 被別名覆蓋到的系統班數 */
  aliasCoveredCount: number | null;
  /** rosterOnly 涵蓋的不重複學生數 */
  rosterOnlyStudents: number | null;
  /** systemOnly 各班在上一份名單的不重複學生數（跨班去重）；沒有上一份名單為 null */
  systemOnlyPreviousRosterStudents: number | null;
  previousRoster: PreviousRosterInfo | null;
}

export class ClassNameReportError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, message: string, code: string) {
    super(message);
    this.name = 'ClassNameReportError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface BatchRow {
  id: string;
  file_name: string;
  created_at: string;
}

function getBatch(db: Database.Database, importId: string): BatchRow | undefined {
  return db.prepare('SELECT id, file_name, created_at FROM import_batches WHERE id = ?').get(importId) as BatchRow | undefined;
}

/**
 * 上一份名單（Q12-b 的漂移參考來源）：
 *  1. importId 不是現行名單且有現行名單 → 現行名單（匯入預覽：本次剛上傳、尚未啟用）；
 *  2. importId 就是現行名單，或沒有現行名單 → 比它更早建立的最近一份 ready 名單；沒有則 null。
 * 匯入預覽與完整報告都用這個規則，同一份名單兩處的參考來源與數字才會一致。
 */
export function resolvePreviousRosterImportId(db: Database.Database, importId: string): string | null {
  const batch = getBatch(db, importId);
  if (!batch) return null;
  const active = db.prepare('SELECT active_import_id FROM active_state WHERE id = 1').get() as
    | { active_import_id: string | null }
    | undefined;
  const activeImportId = active?.active_import_id ?? null;
  if (activeImportId && activeImportId !== importId && getBatch(db, activeImportId)) {
    return activeImportId;
  }
  const earlier = db
    .prepare(
      `SELECT id FROM import_batches
        WHERE status = 'ready' AND id != ? AND created_at < ?
        ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(importId, batch.created_at) as { id: string } | undefined;
  return earlier?.id ?? null;
}

function distinctStudentsIn(db: Database.Database, importId: string, baseNames: string[]): number {
  if (baseNames.length === 0) return 0;
  const placeholders = baseNames.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT person_code) AS n FROM student_enrollments
        WHERE import_id = ? AND base_name IN (${placeholders})`
    )
    .get(importId, ...baseNames) as { n: number };
  return Number(row.n);
}

export function getClassNameMatchReport(
  db: Database.Database,
  input: { importId: string; scope: ClassNameReportScope; previousImportId?: string | null }
): ClassNameMatchReport {
  const { importId, scope } = input;
  if (!getBatch(db, importId)) {
    throw new ClassNameReportError(404, `找不到名單批次 ${importId}`, 'IMPORT_NOT_FOUND');
  }

  // 上一份名單：未指定＝依規則解析；明確 null＝不比對；與本次相同或不存在也視為沒有
  const previousImportId = input.previousImportId === undefined ? resolvePreviousRosterImportId(db, importId) : input.previousImportId;
  const previousBatch = previousImportId && previousImportId !== importId ? getBatch(db, previousImportId) : undefined;
  const previousRoster: PreviousRosterInfo | null = previousBatch
    ? { importId: previousBatch.id, fileName: previousBatch.file_name, createdAt: previousBatch.created_at }
    : null;

  // 設定來源
  let draft: SettingsDraft | null;
  if (scope.kind === 'run') {
    const run = getCalculationRun(db, scope.runId);
    if (!run) throw new ClassNameReportError(404, `找不到計算 run: ${scope.runId}`, 'RUN_NOT_FOUND');
    draft = loadRunSnapshot(db, run.scheduleVersionId)?.draft ?? null;
  } else {
    const latest = getLatestSettingsVersion(db);
    draft = latest ? readStoredDraft(latest.contentJson) : buildSeedDraft();
  }

  if (!draft) {
    // 該 run 當時的設定快照已不存在：無法判定，不猜
    return {
      importId,
      scope,
      snapshotStatus: 'unavailable',
      rosterOnly: null,
      systemOnly: null,
      matchedCount: null,
      aliasCoveredCount: null,
      rosterOnlyStudents: null,
      systemOnlyPreviousRosterStudents: null,
      previousRoster,
    };
  }

  const rosterRows = db
    .prepare(
      `SELECT base_name, COUNT(*) AS token_count, COUNT(DISTINCT person_code) AS student_count
         FROM student_enrollments WHERE import_id = ? GROUP BY base_name`
    )
    .all(importId) as Array<{ base_name: string; token_count: number; student_count: number }>;
  const rosterStats = new Map(rosterRows.map((r) => [r.base_name, { students: Number(r.student_count), tokens: Number(r.token_count) }]));
  const rosterNames = rosterRows.map((r) => r.base_name);

  const classNames = draft.classes.map((c) => c.baseName);
  const { activeView } = classifyErpDualTrack(rosterNames, classNames, draft.aliases);

  const rosterOnly: RosterOnlyClass[] = activeView.unmatched
    .map((baseName) => ({ baseName, ...rosterStats.get(baseName)! }))
    .sort((a, b) => b.students - a.students || (a.baseName < b.baseName ? -1 : a.baseName > b.baseName ? 1 : 0));

  const classSet = new Set(classNames);
  const rosterSet = new Set(rosterNames);
  const activeByClass = new Map(draft.classes.map((c) => [c.baseName, c.active]));
  const previousCounts = new Map<string, number>();
  if (previousRoster) {
    const rows = db
      .prepare(
        `SELECT base_name, COUNT(DISTINCT person_code) AS n FROM student_enrollments
          WHERE import_id = ? GROUP BY base_name`
      )
      .all(previousRoster.importId) as Array<{ base_name: string; n: number }>;
    for (const r of rows) previousCounts.set(r.base_name, Number(r.n));
  }

  const systemOnly: SystemOnlyClass[] = activeView.seedNotAppeared.map((baseName) => ({
    baseName,
    active: activeByClass.get(baseName) ?? true,
    // 只算「實際靠別名解析」的名冊班名：本身就是設定班的名稱以直接相符為準（與 classifyErpDualTrack 一致）
    aliasCoveredBy: draft!.aliases
      .filter((a) => a.targetBaseName === baseName && classSet.has(a.targetBaseName) && rosterSet.has(a.rawBaseName) && !classSet.has(a.rawBaseName))
      .map((a) => a.rawBaseName)
      .sort(),
    previousRosterStudents: previousRoster ? previousCounts.get(baseName) ?? 0 : null,
  }));

  return {
    importId,
    scope,
    snapshotStatus: 'ok',
    rosterOnly,
    systemOnly,
    matchedCount: activeView.matchedCount,
    aliasCoveredCount: activeView.aliasCoveredCount ?? 0,
    rosterOnlyStudents: distinctStudentsIn(db, importId, rosterOnly.map((r) => r.baseName)),
    systemOnlyPreviousRosterStudents: previousRoster
      ? distinctStudentsIn(db, previousRoster.importId, systemOnly.map((r) => r.baseName))
      : null,
    previousRoster,
  };
}

/**
 * 匯入預覽的摘要（「使用這份名單」之前顯示）：兩份清單的班數與影響人數、上一份名單來源，
 * 以及連到完整報告（課表設定「班名對應」）的路徑。完整清單留在報告，預覽只放數字。
 */
export interface ClassNameReportSummary {
  importId: string;
  rosterOnlyClassCount: number;
  rosterOnlyStudentCount: number;
  systemOnlyClassCount: number;
  /** 上一份名單在「系統有／本次名冊無」各班的不重複學生數；沒有上一份名單為 null */
  systemOnlyPreviousRosterStudentCount: number | null;
  previousRoster: PreviousRosterInfo | null;
  /** 完整報告的站內連結 */
  reportPath: string;
}

export function summarizeClassNameReport(report: ClassNameMatchReport): ClassNameReportSummary {
  return {
    importId: report.importId,
    rosterOnlyClassCount: report.rosterOnly?.length ?? 0,
    rosterOnlyStudentCount: report.rosterOnlyStudents ?? 0,
    systemOnlyClassCount: report.systemOnly?.length ?? 0,
    systemOnlyPreviousRosterStudentCount: report.systemOnlyPreviousRosterStudents,
    previousRoster: report.previousRoster,
    reportPath: `/settings?tab=mapping&import=${encodeURIComponent(report.importId)}`,
  };
}
