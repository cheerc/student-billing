import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { buildHistoryEntries, getRunDeductionsOrReason } from '@/application/history-view';

/**
 * specs/09 §2（匯入紀錄次入口）、§5.2（歷史 run 不得套用最新設定，資料不足要明示不可重建）、
 * §8.3（歷史 UI 只讀）；specs/04 UX21（歷史／空篩選／loading／失敗）。
 *
 * 資料層：把「批次」與「run」整理成行政人員看得懂的一份紀錄清單，
 * 並把歷史 run 的班級扣天快照結果（含資料不足）轉成可直接顯示的狀態。
 */

const batch = (id: string, createdAt: string, fileName = `${id}.xlsx`) => ({
  id,
  fileName,
  fileHash: `hash-${id}-0123456789abcdef`,
  contentHash: `content-${id}`,
  sheetName: 'Sheet1',
  headerMap: {},
  parserVersion: '1.0.0',
  scopeNote: '',
  rowCount: 3,
  status: 'ready' as const,
  createdAt,
});

const run = (
  id: string,
  importId: string,
  createdAt: string,
  over: Partial<{ scheduleVersionId: string; ruleSetVersion: string; issueCounts: Record<string, number> }> = {}
) => ({
  id,
  importId,
  scheduleVersionId: over.scheduleVersionId ?? 'seed-v250922',
  ruleSetVersion: over.ruleSetVersion ?? 'erp-tag-v4',
  numericPolicy: 'integer-minute-rational-v1',
  asOfDate: '2026-09-15',
  status: 'completed' as const,
  issueCounts: over.issueCounts ?? {},
  totalStudents: 3,
  createdAt,
});

describe('匯入紀錄資料層（buildHistoryEntries）', () => {
  let tempDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const setActive = (runId: string, importId: string, revision = 2) =>
    db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ?, revision = ? WHERE id = 1').run(runId, importId, revision);

  it('沒有任何批次或 run → 空清單（畫面據此顯示空狀態，而不是空表格）', () => {
    expect(buildHistoryEntries(db)).toEqual([]);
  });

  /**
   * #83：「確認使用才算匯入」。上傳預覽若未按「使用這份名單」就離開，
   * 該批次不該在正式「匯入紀錄」留下任何卡片——匯入紀錄只列真正建立過
   * calculation run 的名單歷程。
   */
  it('只匯入未啟用的批次不出現在紀錄中（#83：確認使用才算匯入，預覽直接離開不留垃圾紀錄）', () => {
    saveImportBatch(db, batch('imp_unused', '2026-09-20T02:00:00.000Z', '九月下旬.xlsx'), []);

    expect(buildHistoryEntries(db)).toEqual([]);
  });

  it('未啟用的批次不影響正式紀錄：清單只有 run，最新的在前（#83）', () => {
    saveImportBatch(db, batch('imp_1', '2026-09-01T02:00:00.000Z', '九月上旬.xlsx'), []);
    saveCalculationRun(db, run('run_1', 'imp_1', '2026-09-02T02:00:00.000Z'), []);
    saveImportBatch(db, batch('imp_2', '2026-09-10T02:00:00.000Z', '九月中旬.xlsx'), []);
    saveCalculationRun(db, run('run_2', 'imp_2', '2026-09-11T02:00:00.000Z'), []);
    // 預覽後直接離開留下的批次：不得進入清單，也不得影響其他列的排序與狀態
    saveImportBatch(db, batch('imp_unused', '2026-09-20T02:00:00.000Z', '九月下旬.xlsx'), []);
    setActive('run_2', 'imp_2');

    const entries = buildHistoryEntries(db);

    expect(entries.map((e) => [e.status, e.fileName])).toEqual([
      ['current', '九月中旬.xlsx'],
      ['history', '九月上旬.xlsx'],
    ]);
    expect(entries.some((e) => e.fileName === '九月下旬.xlsx')).toBe(false);
    // 每一列都是真正建立過 run 的正式名單歷程（無 kind: 'batch'、無 runId: null）
    expect(entries.every((e) => e.kind === 'run' && e.runId !== null)).toBe(true);
    expect(entries.every((e) => e.asOfDate !== null && e.issueCount !== null)).toBe(true);
  });

  it('run 併成同一份清單：目前使用／歷史資料，最新的在前（#83：只留下真正使用過的名單）', () => {
    saveImportBatch(db, batch('imp_1', '2026-09-01T02:00:00.000Z', '九月上旬.xlsx'), []);
    saveCalculationRun(db, run('run_1', 'imp_1', '2026-09-02T02:00:00.000Z', { issueCounts: { SCHEDULE_NOT_FOUND: 2, DUPLICATE_SUBJECT_ENROLLMENT: 1 } }), []);
    saveImportBatch(db, batch('imp_2', '2026-09-10T02:00:00.000Z', '九月中旬.xlsx'), []);
    saveCalculationRun(db, run('run_2', 'imp_2', '2026-09-11T02:00:00.000Z'), []);
    setActive('run_2', 'imp_2');

    const entries = buildHistoryEntries(db);

    expect(entries.map((e) => [e.status, e.fileName])).toEqual([
      ['current', '九月中旬.xlsx'],
      ['history', '九月上旬.xlsx'],
    ]);

    const [current, history] = entries;

    // 目前使用
    expect(current.runId).toBe('run_2');
    expect(current.asOfDate).toBe('2026-09-15');
    expect(current.studentCount).toBe(3);
    expect(current.issueCount).toBe(0);
    expect(current.importedAt).toBe('2026-09-10T02:00:00.000Z');
    expect(current.updatedAt).toBe('2026-09-11T02:00:00.000Z'); // 資料更新時間＝run 建立時間

    // 歷史：待確認數＝各類問題筆數加總（2+1）
    expect(history.runId).toBe('run_1');
    expect(history.issueCount).toBe(3);
  });

  it('技術資訊（長 ID、規則版本、雜湊）另放 tech 欄位，不混在日常欄位', () => {
    saveImportBatch(db, batch('imp_1', '2026-09-01T02:00:00.000Z'), []);
    saveCalculationRun(db, run('run_1', 'imp_1', '2026-09-02T02:00:00.000Z'), []);

    const [entry] = buildHistoryEntries(db);

    expect(entry.tech).toMatchObject({
      runId: 'run_1',
      importId: 'imp_1',
      ruleSetVersion: 'erp-tag-v4',
      scheduleVersionId: 'seed-v250922',
      fileHash: 'hash-imp_1-0123456789abcdef',
    });
  });

  it('同一個批次被啟用過兩次 → 兩筆 run 各自一列，批次本身不重複出現為「尚未使用」', () => {
    saveImportBatch(db, batch('imp_1', '2026-09-01T02:00:00.000Z'), []);
    saveCalculationRun(db, run('run_a', 'imp_1', '2026-09-02T02:00:00.000Z'), []);
    saveCalculationRun(db, run('run_b', 'imp_1', '2026-09-03T02:00:00.000Z'), []);
    setActive('run_b', 'imp_1');

    const entries = buildHistoryEntries(db);

    expect(entries.map((e) => [e.runId, e.status])).toEqual([
      ['run_b', 'current'],
      ['run_a', 'history'],
    ]);
  });
});

describe('歷史 run 的班級扣天：讀當時快照，資料不足要明示（getRunDeductionsOrReason，09 §5.2）', () => {
  let tempDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-ded-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);
    saveImportBatch(db, batch('imp_1', '2026-09-01T02:00:00.000Z'), []);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('快照存在（seed 課表）→ ok，帶班級扣天資料', () => {
    saveCalculationRun(db, run('run_ok', 'imp_1', '2026-09-02T02:00:00.000Z'), []);

    const result = getRunDeductionsOrReason(db, 'run_ok');

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.scope).toBe('run');
      expect(result.data.classes.length).toBeGreaterThan(0);
    }
  });

  it('當時的課表版本已不存在 → unavailable：明示資料不足、無法重建，且不會改用最新課表補算', () => {
    saveCalculationRun(db, run('run_gone', 'imp_1', '2026-09-02T02:00:00.000Z', { scheduleVersionId: 'settings-v-missing' }), []);

    const result = getRunDeductionsOrReason(db, 'run_gone');

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.code).toBe('SNAPSHOT_UNAVAILABLE');
      expect(result.message).toContain('資料不足');
      expect(result.message).toContain('無法重建');
      expect(result.message).toContain('不會改用最新');
      // 日常訊息不得外露長 ID 或內部版本碼
      expect(result.message).not.toContain('settings-v-missing');
      expect(result.message).not.toContain('run_gone');
    }
  });

  it('compat 歷史 run → unavailable：不以正式規則猜測班級扣天', () => {
    saveCalculationRun(db, run('run_diag', 'imp_1', '2026-09-02T02:00:00.000Z', { ruleSetVersion: 'excel-v260922-compat' }), []);

    const result = getRunDeductionsOrReason(db, 'run_diag');

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.code).toBe('UNSUPPORTED_RULESET');
      expect(result.message).toContain('無法辨識或不支援');
      expect(result.message).not.toContain('excel-v260922-compat');
    }
  });

  it('未知的歷史規則版本 → unavailable，不以 v1/v2 的星期語意猜測重建', () => {
    saveCalculationRun(db, run('run_unknown_rules', 'imp_1', '2026-09-02T02:00:00.000Z', { ruleSetVersion: 'erp-tag-v999-corrupt' }), []);

    const result = getRunDeductionsOrReason(db, 'run_unknown_rules');

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.code).toBe('UNSUPPORTED_RULESET');
      expect(result.message).toContain('無法辨識或不支援');
      expect(result.message).not.toContain('erp-tag-v999-corrupt');
    }
  });

  it('找不到 run → not_found', () => {
    expect(getRunDeductionsOrReason(db, 'run_nope').status).toBe('not_found');
  });

  it('查看歷史不寫任何資料：呼叫前後 active_state 與 run 數量不變（唯讀，09 §8.3）', () => {
    saveCalculationRun(db, run('run_ok', 'imp_1', '2026-09-02T02:00:00.000Z'), []);
    const snap = () => JSON.stringify({
      active: db.prepare('SELECT * FROM active_state WHERE id = 1').get(),
      runs: db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get(),
      settings: db.prepare('SELECT COUNT(*) AS n FROM settings_versions').get(),
    });
    const before = snap();

    getRunDeductionsOrReason(db, 'run_ok');
    buildHistoryEntries(db);

    expect(snap()).toBe(before);
  });
});
