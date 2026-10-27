/**
 * 班名比對報告（04 §8 UX44–UX47；09 §3.3、§4.1）。
 *
 * 將名冊出現的班名與「課表設定」比對，產出兩份清單：
 *  1. 米豆奶有／系統無（rosterOnly）：名冊有，但既未列於課表設定、也沒有被別名對應到設定班。
 *     影響人數為這批名單在此班的不重複學生數。
 *  2. 系統有／本次名冊無（systemOnly）：課表設定有，但本次名冊沒有人用該班名直接報名。
 *     單純呈現目前課表設定有、但本次名單無直接報名的班級與別名覆蓋備註。
 */

import Database from 'better-sqlite3';
import { SettingsDraft } from '@/contracts/settings';
import { getLatestSettingsVersion, readStoredDraft, buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { loadRunSnapshot } from '@/application/run-snapshot';
import { classifyErpDualTrack } from '@/domain/schedules/seed-manifest';

export interface RosterOnlyClass {
  baseName: string;
  students: number;
  tokens: number;
}

export interface SystemOnlyClass {
  baseName: string;
  /** 設定中此班是否啟用 */
  active: boolean;
  /** 本次名冊中被別名對到此班的米豆奶班名（名冊沒有直接以此班名報名時才會在這份清單裡出現） */
  aliasCoveredBy: string[];
}

export type ClassNameReportScope = { kind: 'latest' } | { kind: 'run'; runId: string };

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
  input: { importId: string; scope: ClassNameReportScope }
): ClassNameMatchReport {
  const { importId, scope } = input;
  if (!getBatch(db, importId)) {
    throw new ClassNameReportError(404, `找不到名單批次 ${importId}`, 'IMPORT_NOT_FOUND');
  }

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

  const scheduleClasses = draft.classes;
  const classNames = scheduleClasses.map((c) => c.baseName);
  const { activeView } = classifyErpDualTrack(rosterNames, classNames, draft.aliases);

  const rosterOnly: RosterOnlyClass[] = activeView.unmatched
    .map((baseName) => ({ baseName, ...rosterStats.get(baseName)! }))
    .sort((a, b) => b.students - a.students || (a.baseName < b.baseName ? -1 : a.baseName > b.baseName ? 1 : 0));

  const classSet = new Set(classNames);
  const rosterSet = new Set(rosterNames);
  const activeByClass = new Map(scheduleClasses.map((c) => [c.baseName, c.active]));

  const systemOnly: SystemOnlyClass[] = activeView.seedNotAppeared.map((baseName) => ({
    baseName,
    active: activeByClass.get(baseName) ?? true,
    aliasCoveredBy: draft!.aliases
      .filter((a) => a.targetBaseName === baseName && classSet.has(a.targetBaseName) && rosterSet.has(a.rawBaseName) && !classSet.has(a.rawBaseName))
      .map((a) => a.rawBaseName)
      .sort(),
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
  };
}

/**
 * 匯入預覽的摘要（「使用這份名單」之前顯示）：兩份清單的班數與影響人數，
 * 以及連到完整報告（課表設定「班名對應」）的路徑。完整清單留在報告，預覽只放數字。
 */
export interface ClassNameReportSummary {
  importId: string;
  rosterOnlyClassCount: number;
  rosterOnlyStudentCount: number;
  systemOnlyClassCount: number;
  /** 完整報告的站內連結 */
  reportPath: string;
}

export function summarizeClassNameReport(report: ClassNameMatchReport): ClassNameReportSummary {
  return {
    importId: report.importId,
    rosterOnlyClassCount: report.rosterOnly?.length ?? 0,
    rosterOnlyStudentCount: report.rosterOnlyStudents ?? 0,
    systemOnlyClassCount: report.systemOnly?.length ?? 0,
    reportPath: `/settings?tab=mapping&import=${encodeURIComponent(report.importId)}`,
  };
}
