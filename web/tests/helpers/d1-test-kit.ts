import { beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { buildSeedDraft, hashSettingsDraft, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import type { SettingsDraft } from '@/contracts/settings';
import type { StudentSnapshot } from '@/domain/students';

/**
 * D1 測試共用工具（只用 8961c03 已存在的公開函式；新模組一律以 loadModule 動態載入，
 * 模組不存在時得到的是「斷言失敗」而不是整檔載入失敗）。
 */

export const ORIGIN = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };

/** 以變數 specifier 動態載入；不存在回 null（vite 不會在轉換階段報 resolve 錯誤）。 */
export async function loadModule<T = Record<string, unknown>>(spec: string): Promise<T | null> {
  try {
    return (await import(/* @vite-ignore */ spec)) as T;
  } catch {
    return null;
  }
}

/** 每個測試一個全新的 temp SQLite（透過 DATABASE_PATH 與全域連線，與 route 用同一條連線）。 */
export function useGlobalTempDb(prefix = 'sb-d1-'): { db: () => ReturnType<typeof getDatabase> } {
  let tempDir = '';
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }
  });
  afterEach(() => {
    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { db: () => getDatabase() };
}

let fixtureCache: Awaited<ReturnType<typeof generateImportPreview>> | null = null;
export async function fixturePreview() {
  if (!fixtureCache) {
    const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    fixtureCache = await generateImportPreview(buf, 'fixture.xlsx');
  }
  return fixtureCache;
}

/**
 * Synthetic 477-student baseline after the explicitly approved one-time legacy semantic
 * migration. Categories remain unchanged; roster-only names become semantic-only settings.
 */
export async function buildApprovedLegacyMigrationFixtureDraft(
  draft: SettingsDraft = buildSeedDraft()
): Promise<SettingsDraft> {
  return draft;
}

/** 把合成 fixture 存成一批 ready 名單。 */
export async function saveFixtureBatch(db: ReturnType<typeof getDatabase>, id: string, createdAt = new Date().toISOString()) {
  const p = await fixturePreview();
  saveImportBatch(
    db,
    {
      id,
      fileName: 'fixture.xlsx',
      fileHash: p.fileHash,
      contentHash: p.contentHash,
      sheetName: p.sheetName,
      headerMap: p.headerMapping,
      parserVersion: '1.0.0',
      scopeNote: p.scopeNote,
      rowCount: p.stats.totalStudents,
      status: 'ready',
      createdAt,
    },
    p.students
  );
}

export function activeState(db: ReturnType<typeof getDatabase>) {
  return db.prepare('SELECT * FROM active_state WHERE id = 1').get() as {
    active_import_id: string | null;
    active_run_id: string | null;
    revision: number;
  };
}

export function ruleSetOfRun(db: ReturnType<typeof getDatabase>, runId: string): string {
  return (db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(runId) as { rule_set_version: string })
    .rule_set_version;
}

/** 啟用一批名單（application 層；版本由 server 決定）。 */
export function activateBatch(db: ReturnType<typeof getDatabase>, importId: string, key: string) {
  return activateImport(db, { importId, expectedRevision: activeState(db).revision, idempotencyKey: key });
}

/** 以 SQL 把某個 run 的規則版本改成指定值（模擬既有的 v1／compat active run；與既有 settings-read-model 測試同法）。 */
export function setRunRuleSet(db: ReturnType<typeof getDatabase>, runId: string, ruleSet: string) {
  db.prepare('UPDATE calculation_runs SET rule_set_version = ? WHERE id = ?').run(ruleSet, runId);
}

export function jsonRequest(url: string, body: unknown, method = 'POST') {
  return new NextRequest(url, { method, headers: ORIGIN, body: JSON.stringify(body) });
}

export function getRequest(url: string) {
  return new NextRequest(url, { method: 'GET', headers: ORIGIN });
}

/** 合成學生（只用虛構班名，不含個資）。 */
export function makeStudent(
  personCode: string,
  baseNames: string[],
  opts: { grade?: number; tagsRaw?: string; sourceRow?: number } = {}
): StudentSnapshot {
  const grade = opts.grade ?? null;
  return {
    personCode,
    name: `學生${personCode}`,
    branch: '本校',
    gradeRaw: grade !== null ? `${grade}年級` : '',
    grade,
    gradeStatus: grade !== null ? 'valid' : 'not_applicable',
    contact: null,
    schoolInfo: null,
    tagsRaw: opts.tagsRaw ?? '',
    tags: opts.tagsRaw ? opts.tagsRaw.split(/[,;\s]+/).filter(Boolean) : [],
    notesRaw: '',
    enrollments: baseNames.map((bn) => ({
      rawToken: `${bn}[團]`,
      yearPrefix: null,
      baseName: bn,
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    })),
    sourceRow: opts.sourceRow ?? 1,
  };
}

export function saveSyntheticBatch(
  db: ReturnType<typeof getDatabase>,
  id: string,
  fileName: string,
  createdAt: string,
  students: StudentSnapshot[]
) {
  saveImportBatch(
    db,
    {
      id,
      fileName,
      fileHash: `fh_${id}`,
      contentHash: `ch_${id}`,
      sheetName: 'S',
      headerMap: {},
      parserVersion: '1.0.0',
      scopeNote: '',
      rowCount: students.length,
      status: 'ready',
      createdAt,
    },
    students
  );
}

export function saveSettings(db: ReturnType<typeof getDatabase>, id: string, revision: number, draft: SettingsDraft) {
  saveSettingsVersion(db, {
    id,
    contentHash: hashSettingsDraft(draft),
    contentJson: JSON.stringify(draft),
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: `2026-09-0${revision}T12:00:00.000Z`,
    createdFromPreviewId: null,
    revision,
  });
}

/** Persist the one-time migration as an initial settings version for legacy-baseline tests. */
export async function saveApprovedLegacyMigrationFixtureSettings(
  db: ReturnType<typeof getDatabase>,
  id: string,
  revision = 1,
  draft: SettingsDraft = buildSeedDraft()
): Promise<SettingsDraft> {
  const migrated = await buildApprovedLegacyMigrationFixtureDraft(draft);
  saveSettings(db, id, revision, migrated);
  return migrated;
}

export function saveRun(
  db: ReturnType<typeof getDatabase>,
  id: string,
  importId: string,
  scheduleVersionId: string,
  createdAt: string,
  ruleSetVersion = 'erp-tag-v2',
  classCategories?: Parameters<typeof saveCalculationRun>[3],
) {
  saveCalculationRun(
    db,
    {
      id,
      importId,
      scheduleVersionId,
      ruleSetVersion,
      numericPolicy: 'integer-minute-rational-v1',
      asOfDate: '2026-09-15',
      status: 'completed',
      issueCounts: {},
      totalStudents: 0,
      createdAt,
    },
    [],
    classCategories,
  );
}
