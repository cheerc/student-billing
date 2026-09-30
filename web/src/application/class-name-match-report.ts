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

export type PreviousRosterStatus = 'ok' | 'none' | 'unavailable';

export interface PreviousRosterResolution {
  status: PreviousRosterStatus;
  importId: string | null;
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
  previousRosterStatus: PreviousRosterStatus;
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

interface IdempotencyRecordRow {
  idempotency_key: string;
  run_id: string | null;
  response_payload: string;
}

interface ActiveEpisode {
  importId: string;
  predecessorImportId: string | null;
  runIds: Set<string>;
}

/**
 * 依據成功之 idempotency_records activate/apply 收據與 revision 序號，重建可證實的名冊現行歷史（Q12 / F2）。
 * 嚴禁依據「有 run」或 timestamp 猜測曾現行。
 * 若遇收據格式毀損、revision 斷裂（gap）、衝突（conflict）或批次不存在，fail-closed 回傳 unavailable。
 */
export function resolvePreviousRosterProvenance(
  db: Database.Database,
  targetImportId: string,
  scope: ClassNameReportScope = { kind: 'latest' }
): PreviousRosterResolution {
  const activeStateRow = db
    .prepare('SELECT active_import_id, active_run_id, revision FROM active_state WHERE id = 1')
    .get() as { active_import_id: string | null; active_run_id: string | null; revision: number } | undefined;

  const currentActiveRevision = activeStateRow?.revision ?? 0;
  const currentActiveImportId = activeStateRow?.active_import_id ?? null;

  const idempRows = db
    .prepare('SELECT idempotency_key, run_id, response_payload FROM idempotency_records')
    .all() as IdempotencyRecordRow[];

  type ParsedEvent =
    | { kind: 'activate'; revision: number; runId: string; importId: string }
    | { kind: 'apply_with_students'; revision: number; runId: string; importId: string }
    | { kind: 'legacy_apply'; revision: number; runId: string; importId: string }
    | { kind: 'apply_settings_only'; revision: number };

  const events: ParsedEvent[] = [];
  const revisionSet = new Set<number>();

  for (const row of idempRows) {
    let payload: any;
    try {
      payload = JSON.parse(row.response_payload);
    } catch {
      return { status: 'unavailable', importId: null };
    }

    if (!payload || typeof payload !== 'object' || typeof payload.revision !== 'number' || payload.revision <= 0) {
      return { status: 'unavailable', importId: null };
    }

    const revision = payload.revision;
    if (revisionSet.has(revision)) {
      return { status: 'unavailable', importId: null };
    }
    revisionSet.add(revision);

    if (payload.status === 'completed' && typeof payload.activeImportId === 'string' && typeof payload.activeRunId === 'string') {
      if (row.run_id !== payload.runId || payload.runId !== payload.activeRunId) {
        return { status: 'unavailable', importId: null };
      }
      const batchExists = db.prepare('SELECT 1 FROM import_batches WHERE id = ?').get(payload.activeImportId);
      const runRow = db.prepare('SELECT import_id FROM calculation_runs WHERE id = ?').get(payload.runId) as { import_id: string } | undefined;
      if (!batchExists || !runRow || runRow.import_id !== payload.activeImportId) {
        return { status: 'unavailable', importId: null };
      }
      events.push({ kind: 'activate', revision, runId: payload.runId, importId: payload.activeImportId });
    } else if (payload.mode === 'with_students' && typeof payload.runId === 'string') {
      if (row.run_id !== payload.runId) {
        return { status: 'unavailable', importId: null };
      }
      const runRow = db.prepare('SELECT import_id FROM calculation_runs WHERE id = ?').get(payload.runId) as { import_id: string } | undefined;
      if (!runRow) {
        return { status: 'unavailable', importId: null };
      }
      events.push({ kind: 'apply_with_students', revision, runId: payload.runId, importId: runRow.import_id });
    } else if (payload.mode === 'settings_only') {
      if (row.run_id !== null) {
        return { status: 'unavailable', importId: null };
      }
      events.push({ kind: 'apply_settings_only', revision });
    } else if (payload.mode === undefined && payload.status === undefined && payload.activeImportId === undefined) {
      // 35c8bde 之前寫入的 apply 收據（沒有 mode 欄位）。只接受「可證明」的形狀，不因欄位缺席就信任：
      if (typeof payload.runId === 'string' && payload.runId !== '') {
        // (a) 真實舊形狀：舊版 apply 一律建 run，收據的 run_id 欄位＝該 runId；run 與其名單批次必須都存在。
        if (row.run_id !== payload.runId) {
          return { status: 'unavailable', importId: null };
        }
        const runRow = db.prepare('SELECT import_id FROM calculation_runs WHERE id = ?').get(payload.runId) as { import_id: string } | undefined;
        if (!runRow || !getBatch(db, runRow.import_id)) {
          return { status: 'unavailable', importId: null };
        }
        events.push({ kind: 'legacy_apply', revision, runId: payload.runId, importId: runRow.import_id });
      } else if ((payload.runId === null || payload.runId === undefined) && row.run_id === null) {
        // (b) 防禦性形狀（歷史上沒有任何版本寫出過）：不建 run、不切名冊，視為 settings_only。
        events.push({ kind: 'apply_settings_only', revision });
      } else {
        return { status: 'unavailable', importId: null };
      }
    } else {
      return { status: 'unavailable', importId: null };
    }
  }

  events.sort((a, b) => a.revision - b.revision);

  if (events.length === 0) {
    if (currentActiveRevision === 0 && currentActiveImportId === null) {
      return { status: 'none', importId: null };
    }
    return { status: 'unavailable', importId: null };
  }

  for (let i = 0; i < events.length; i++) {
    if (events[i].revision !== i + 1) {
      return { status: 'unavailable', importId: null };
    }
  }
  if (events[events.length - 1].revision !== currentActiveRevision) {
    return { status: 'unavailable', importId: null };
  }

  const episodes: ActiveEpisode[] = [];
  let currentEpisode: ActiveEpisode | null = null;

  /**
   * 舊版 apply 若把名單換成「當時現行名冊以外」的名單（2bea9b8～5daef9c 的 apply 會切換 active_import_id；dd9f08d 起不會），
   * 收據沒有版本標記可區分，只有被佐證才算切換：下一個會影響名冊或 run 的事件顯示現行名冊確為該名單，
   * 或它就是最後一個事件且現行狀態（active import／run）與它一致。否則無法證明 → 整段歷史 unavailable。
   */
  const legacySwitchIsCorroborated = (index: number, ev: { runId: string; importId: string }): boolean => {
    let j = index + 1;
    while (j < events.length && events[j].kind === 'apply_settings_only') j++;
    if (j >= events.length) {
      return activeStateRow?.active_import_id === ev.importId && activeStateRow?.active_run_id === ev.runId;
    }
    const next = events[j];
    return next.kind !== 'apply_settings_only' && next.importId === ev.importId;
  };

  for (let index = 0; index < events.length; index++) {
    const ev = events[index];
    if (ev.kind === 'activate') {
      if (!currentEpisode) {
        currentEpisode = {
          importId: ev.importId,
          predecessorImportId: null,
          runIds: new Set([ev.runId]),
        };
        episodes.push(currentEpisode);
      } else if (ev.importId === currentEpisode.importId) {
        currentEpisode.runIds.add(ev.runId);
      } else {
        const prevId: string = currentEpisode.importId;
        currentEpisode = {
          importId: ev.importId,
          predecessorImportId: prevId,
          runIds: new Set([ev.runId]),
        };
        episodes.push(currentEpisode);
      }
    } else if (ev.kind === 'apply_with_students') {
      if (!currentEpisode) {
        return { status: 'unavailable', importId: null };
      }
      currentEpisode.runIds.add(ev.runId);
    } else if (ev.kind === 'legacy_apply') {
      if (currentEpisode && ev.importId === currentEpisode.importId) {
        currentEpisode.runIds.add(ev.runId);
      } else if (legacySwitchIsCorroborated(index, ev)) {
        const prevId: string | null = currentEpisode ? currentEpisode.importId : null;
        currentEpisode = { importId: ev.importId, predecessorImportId: prevId, runIds: new Set([ev.runId]) };
        episodes.push(currentEpisode);
      } else {
        return { status: 'unavailable', importId: null };
      }
    } else if (ev.kind === 'apply_settings_only') {
      // settings_only 不影響名冊與 run
    }
  }

  if (scope.kind === 'run') {
    const matchedEpisode = episodes.find((ep) => ep.runIds.has(scope.runId));
    if (!matchedEpisode) {
      return { status: 'unavailable', importId: null };
    }
    if (!matchedEpisode.predecessorImportId) {
      return { status: 'none', importId: null };
    }
    const prevBatch = getBatch(db, matchedEpisode.predecessorImportId);
    if (!prevBatch) {
      return { status: 'unavailable', importId: null };
    }
    return { status: 'ok', importId: matchedEpisode.predecessorImportId };
  }

  // scope.kind === 'latest'
  const activeEpisode = episodes.length > 0 ? episodes[episodes.length - 1] : null;
  const systemActiveImportId = activeEpisode ? activeEpisode.importId : null;

  if (targetImportId !== systemActiveImportId) {
    if (!systemActiveImportId) {
      return { status: 'none', importId: null };
    }
    const activeBatch = getBatch(db, systemActiveImportId);
    if (!activeBatch) {
      return { status: 'unavailable', importId: null };
    }
    return { status: 'ok', importId: systemActiveImportId };
  } else {
    if (!activeEpisode || !activeEpisode.predecessorImportId) {
      return { status: 'none', importId: null };
    }
    const prevBatch = getBatch(db, activeEpisode.predecessorImportId);
    if (!prevBatch) {
      return { status: 'unavailable', importId: null };
    }
    return { status: 'ok', importId: activeEpisode.predecessorImportId };
  }
}

/**
 * 上一份現行名冊（Q12；向後相容 helper）：
 */
export function resolvePreviousRosterImportId(
  db: Database.Database,
  importId: string,
  scope: ClassNameReportScope = { kind: 'latest' }
): string | null {
  const resolution = resolvePreviousRosterProvenance(db, importId, scope);
  return resolution.status === 'ok' ? resolution.importId : null;
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

  // 上一份名冊：明確 null＝不比對；未指定＝依收據歷史解析
  const resolution =
    input.previousImportId !== undefined
      ? input.previousImportId === null
        ? ({ status: 'none' as const, importId: null })
        : ({ status: 'ok' as const, importId: input.previousImportId })
      : resolvePreviousRosterProvenance(db, importId, scope);

  const previousImportId = resolution.importId;
  const previousRosterStatus = resolution.status;

  const previousBatch =
    previousImportId && previousImportId !== importId && previousRosterStatus === 'ok'
      ? getBatch(db, previousImportId)
      : undefined;

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
      previousRosterStatus,
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
    previousRosterStatus,
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
  previousRosterStatus: PreviousRosterStatus;
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
    previousRosterStatus: report.previousRosterStatus,
    reportPath: `/settings?tab=mapping&import=${encodeURIComponent(report.importId)}`,
  };
}
