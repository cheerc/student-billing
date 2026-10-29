/**
 * 班名同步報告 read model（D62 Phase 1）。
 *
 * 將名冊出現的班名與「課表設定」比對（嚴格完全同名一致性）：
 *  1. exactMatchCount：名冊有、課表亦有完全同名之班名數。
 *  2. mismatches：名冊有、課表無完全同名之班名清單，附舊別名指向目標 legacyAliasTarget。
 *  3. systemOnly：課表有、本次名冊無直接報名之系統班級清單（同步候選目標），附 legacyAliasFrom。
 *  4. unmappedStudents：legacyAliasTarget === null 涵蓋之去重學生數（真正影響計費者）。
 */

import Database from 'better-sqlite3';
import { SettingsDraft, ClassType } from '@/contracts/settings';
import {
  getLatestSettingsVersion,
  getSettingsVersionById,
  readStoredDraft,
  buildSeedDraft,
} from '@/adapters/sqlite/settings-repository';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { resolveClassAttributes } from '@/domain/classification/class-attributes';

export type ClassNameReportScope = { kind: 'latest' } | { kind: 'run'; runId: string };

export interface ClassNameMismatch {
  erpBaseName: string;
  students: number;
  tokens: number;
  legacyAliasTarget: string | null;
}

export interface ClassNameSyncSystemOnly {
  baseName: string;
  active: boolean;
  classType: ClassType;
  sessionCount: number;
  legacyAliasFrom: string[];
}

export interface ClassNameSyncReport {
  importId: string;
  scope: ClassNameReportScope;
  snapshotStatus: 'ok' | 'unavailable';
  rosterClassCount: number | null;
  exactMatchCount: number | null;
  mismatches: ClassNameMismatch[] | null;
  unmappedStudents: number | null;
  systemOnly: ClassNameSyncSystemOnly[] | null;
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
  return db
    .prepare('SELECT id, file_name, created_at FROM import_batches WHERE id = ?')
    .get(importId) as BatchRow | undefined;
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
): ClassNameSyncReport {
  const { importId, scope } = input;
  if (!getBatch(db, importId)) {
    throw new ClassNameReportError(404, `找不到名單批次 ${importId}`, 'IMPORT_NOT_FOUND');
  }

  // 設定來源
  let draft: SettingsDraft | null;
  if (scope.kind === 'run') {
    const run = getCalculationRun(db, scope.runId);
    if (!run) throw new ClassNameReportError(404, `找不到計算 run: ${scope.runId}`, 'RUN_NOT_FOUND');
    const ver = getSettingsVersionById(db, run.scheduleVersionId);
    draft =
      run.scheduleVersionId === 'seed-v250922'
        ? buildSeedDraft()
        : ver
          ? readStoredDraft(ver.contentJson)
          : null;
  } else {
    const latest = getLatestSettingsVersion(db);
    draft = latest ? readStoredDraft(latest.contentJson) : buildSeedDraft();
  }

  if (!draft) {
    return {
      importId,
      scope,
      snapshotStatus: 'unavailable',
      rosterClassCount: null,
      exactMatchCount: null,
      mismatches: null,
      unmappedStudents: null,
      systemOnly: null,
    };
  }

  const rosterRows = db
    .prepare(
      `SELECT base_name, COUNT(*) AS token_count, COUNT(DISTINCT person_code) AS student_count
         FROM student_enrollments WHERE import_id = ? GROUP BY base_name`
    )
    .all(importId) as Array<{ base_name: string; token_count: number; student_count: number }>;
  const rosterStats = new Map(
    rosterRows.map((r) => [
      r.base_name,
      { students: Number(r.student_count), tokens: Number(r.token_count) },
    ])
  );
  const rosterNames = rosterRows.map((r) => r.base_name);

  const scheduleClasses = draft.classes;
  const classNames = scheduleClasses.map((c) => c.baseName);
  const classSet = new Set(classNames);
  const rosterSet = new Set(rosterNames);

  // 1. 嚴格完全同名一致性判定
  const exactMatches = rosterNames.filter((name) => classSet.has(name));
  const exactMatchCount = exactMatches.length;
  const rosterClassCount = rosterNames.length;

  // 2. mismatches（名冊有、課表無同名）
  const aliasMap = new Map<string, string>();
  for (const a of draft.aliases) {
    aliasMap.set(a.rawBaseName.trim(), a.targetBaseName.trim());
  }

  const mismatches: ClassNameMismatch[] = rosterNames
    .filter((name) => !classSet.has(name))
    .map((erpBaseName) => {
      const stats = rosterStats.get(erpBaseName) ?? { students: 0, tokens: 0 };
      const target = aliasMap.get(erpBaseName);
      // 舊別名指向且該目標班確實存在於課表，否則為 null
      const legacyAliasTarget = target && classSet.has(target) ? target : null;
      return {
        erpBaseName,
        students: stats.students,
        tokens: stats.tokens,
        legacyAliasTarget,
      };
    })
    .sort((a, b) => {
      // 未對應優先（legacyAliasTarget === null）
      const aUnmapped = a.legacyAliasTarget === null ? 0 : 1;
      const bUnmapped = b.legacyAliasTarget === null ? 0 : 1;
      if (aUnmapped !== bUnmapped) return aUnmapped - bUnmapped;
      // 學生數多者優先
      if (b.students !== a.students) return b.students - a.students;
      // 班名正序
      return a.erpBaseName.localeCompare(b.erpBaseName, 'zh-TW');
    });

  // 3. unmappedStudents：計算 legacyAliasTarget === null 的列涵蓋之不重複學生數
  const unmappedBaseNames = mismatches
    .filter((m) => m.legacyAliasTarget === null)
    .map((m) => m.erpBaseName);
  const unmappedStudents = distinctStudentsIn(db, importId, unmappedBaseNames);

  // 4. systemOnly：課表有、名冊無直接同名報名＝同步目標候選
  const systemOnly: ClassNameSyncSystemOnly[] = scheduleClasses
    .filter((c) => !rosterSet.has(c.baseName))
    .map((c) => {
      const resolved = resolveClassAttributes(c.baseName, c);
      const normalizedClassType: ClassType =
        resolved.classType === 'non_care' ? 'other' : resolved.classType;
      const legacyAliasFrom = draft!.aliases
        .filter(
          (a) =>
            a.targetBaseName === c.baseName &&
            rosterSet.has(a.rawBaseName) &&
            !classSet.has(a.rawBaseName)
        )
        .map((a) => a.rawBaseName)
        .sort((x, y) => x.localeCompare(y, 'zh-TW'));

      return {
        baseName: c.baseName,
        active: c.active ?? true,
        classType: normalizedClassType,
        sessionCount: c.sessions ? c.sessions.length : 0,
        legacyAliasFrom,
      };
    });

  return {
    importId,
    scope,
    snapshotStatus: 'ok',
    rosterClassCount,
    exactMatchCount,
    mismatches,
    unmappedStudents,
    systemOnly,
  };
}

export interface ClassNameReportSummary {
  importId: string;
  mismatchCount: number;
  unmappedCount: number;
  unmappedStudents: number;
  reportPath: string;
  /** 舊 UI 相容欄位：未對應班數（= mismatches 中 legacyAliasTarget === null 的列數） */
  rosterOnlyClassCount: number;
  /** 舊 UI 相容欄位：未對應影響去重學生數 */
  rosterOnlyStudentCount: number;
  systemOnlyClassCount: number;
}

export function summarizeClassNameReport(report: ClassNameSyncReport): ClassNameReportSummary {
  const mismatches = report.mismatches ?? [];
  const unmapped = mismatches.filter((m) => m.legacyAliasTarget === null);
  const mismatchCount = mismatches.length;
  const unmappedCount = unmapped.length;
  const unmappedStudents = report.unmappedStudents ?? 0;
  return {
    importId: report.importId,
    mismatchCount,
    unmappedCount,
    unmappedStudents,
    reportPath: `/settings?tab=sync&import=${encodeURIComponent(report.importId)}`,
    rosterOnlyClassCount: unmappedCount,
    rosterOnlyStudentCount: unmappedStudents,
    systemOnlyClassCount: report.systemOnly?.length ?? 0,
  };
}
