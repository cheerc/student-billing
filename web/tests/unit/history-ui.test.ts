import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { HistoryList } from '@/components/history/history-list';
import ClassDeductionsPanel from '@/components/results/class-deductions-panel';
import HistoryLoading from '@/app/history/loading';
import HistoryError from '@/app/history/error';
import HistoryPage from '@/app/history/page';
import HistoryRunPage from '@/app/history/[runId]/page';
import type { HistoryEntry } from '@/application/history-view';

/**
 * specs/09 §2／§7／§8.3、specs/04 UX21：匯入紀錄頁（次入口）。
 * 日常介面去技術化（Run／rev／長ID／雜湊／API 連結降到摺疊區）、唯讀、四態各有明確動作。
 */

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  key: 'run_2',
  kind: 'run',
  status: 'current',
  runId: 'run_2',
  importId: 'imp_2',
  fileName: '九月中旬.xlsx',
  importedAt: '2026-09-10T02:00:00.000Z',
  updatedAt: '2026-09-11T02:00:00.000Z',
  asOfDate: '2026-09-15',
  studentCount: 477,
  issueCount: 3,
  tech: {
    runId: 'run_2',
    importId: 'imp_2',
    scheduleVersionId: 'seed-v250922',
    ruleSetVersion: 'erp-tag-v2',
    numericPolicy: 'integer-minute-rational-v1',
    fileHash: 'abcdef0123456789abcdef0123456789',
    sheetName: 'Sheet1',
  },
  ...over,
});

const ENTRIES: HistoryEntry[] = [
  entry({
    key: 'imp_3', kind: 'batch', status: 'unused', runId: null, importId: 'imp_3', fileName: '九月下旬.xlsx',
    importedAt: '2026-09-20T02:00:00.000Z', updatedAt: '2026-09-20T02:00:00.000Z', asOfDate: null, issueCount: null, studentCount: 470,
    tech: { runId: null, importId: 'imp_3', scheduleVersionId: null, ruleSetVersion: null, numericPolicy: null, fileHash: 'ffff0000ffff0000', sheetName: 'Sheet1' },
  }),
  entry({}),
  entry({
    key: 'run_1', status: 'history', runId: 'run_1', importId: 'imp_1', fileName: '九月上旬.xlsx',
    importedAt: '2026-09-01T02:00:00.000Z', updatedAt: '2026-09-02T02:00:00.000Z', issueCount: 0, studentCount: 460,
    tech: { runId: 'run_1', importId: 'imp_1', scheduleVersionId: 'seed-v250922', ruleSetVersion: 'erp-tag-v2', numericPolicy: 'integer-minute-rational-v1', fileHash: '1111222233334444', sheetName: 'Sheet1' },
  }),
];

const render = (props: Partial<React.ComponentProps<typeof HistoryList>> = {}) =>
  renderToStaticMarkup(React.createElement(HistoryList, { entries: ENTRIES, ...props }));

/** 日常介面可見的 HTML：摺疊區（<details>）內容不算日常介面（09 §7：技術資訊可查但收在摺疊區）。 */
const visible = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, '');

/** 09 §7 文案表：日常介面不得出現的工程字。 */
const FORBIDDEN = /\bRun\b|\brev\b|Run ID|SHA|雜湊|hash|\bAPI\b|\bJSON\b|alias|baseName|dry-run|\bactive\b|OOXML|inlineStr|PREVIEW_EXPIRED|REVISION_CONFLICT|erp-tag|numeric|\bready\b|imp_\d|run_\d/i;

describe('匯入紀錄頁：去技術化與次入口定位（09 §2／§7）', () => {
  it('一個 h1「匯入紀錄」與一個主要動作「匯入新名單」（連到 /imports）', () => {
    const html = render();

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>匯入紀錄<\/h1>/);
    expect(html).toMatch(/<a[^>]*href="\/imports"[^>]*>匯入新名單<\/a>/);
  });

  it('日常介面沒有工程字（Run／rev／長ID／雜湊／API／JSON／raw status），只有日期、檔名、人數與中文狀態', () => {
    const shown = visible(render());

    expect(shown).not.toMatch(FORBIDDEN);
    for (const label of ['目前使用', '歷史資料', '尚未使用']) expect(shown).toContain(label);
    for (const name of ['九月上旬.xlsx', '九月中旬.xlsx', '九月下旬.xlsx']) expect(shown).toContain(name);
    expect(shown).toContain('477 人');
  });

  it('來源日期清楚：資料更新時間與核對基準日分開標示，格式固定（Asia/Taipei，不混稱月帳期）', () => {
    const shown = visible(render());

    expect(shown).toContain('2026-09-11 10:00'); // run 的資料更新時間（UTC 02:00 → 台北 10:00）
    expect(shown).toContain('2026-09-10 10:00'); // 名單匯入時間
    expect(shown).toContain('核對基準日 2026-09-15');
  });

  it('技術資訊仍可查，但收在摺疊區：長 ID、規則版本、檔案雜湊', () => {
    const html = render();
    const details = html.match(/<details[\s\S]*?<\/details>/g) ?? [];

    expect(details.length).toBeGreaterThan(0);
    const joined = details.join('');
    expect(joined).toContain('技術資訊');
    expect(joined).toContain('run_2');
    expect(joined).toContain('imp_2');
    expect(joined).toContain('erp-tag-v2');
    expect(joined).toContain('abcdef0123456789abcdef0123456789');
  });

  it('只有「已使用過」的紀錄能查看當時結果（連到 /history/{id}）；尚未使用的沒有；沒有任何 API 外連', () => {
    const html = render();

    expect(html).toMatch(/href="\/history\/run_2"[^>]*>[^<]*查看當時結果/);
    expect(html).toMatch(/href="\/history\/run_1"[^>]*>[^<]*查看當時結果/);
    expect((html.match(/查看當時結果/g) ?? []).length).toBe(2);
    expect(html).not.toContain('/api/');
    expect(html).not.toContain('target="_blank"');
  });

  it('目前使用的資料摘要一行：檔名、資料更新時間、核對基準日；沒有目前使用時明說', () => {
    expect(visible(render())).toMatch(/目前使用的資料[\s\S]*九月中旬\.xlsx/);

    const noCurrent = visible(render({ entries: ENTRIES.filter((e) => e.status !== 'current') }));
    expect(noCurrent).toContain('目前尚未使用任何名單');
  });

  it('唯讀：沒有任何「恢復／還原／設為現行」動作（09 §8.3）', () => {
    const html = render();

    expect(html).not.toMatch(/恢復|還原|設為現行|回復為現行/);
    expect(html).not.toContain('<form');
  });

  it('表頭有 scope="col"，狀態以文字呈現（不以顏色或 emoji 作唯一線索，09 §6）', () => {
    const html = render();

    expect(html).toMatch(/<th scope="col"/);
    expect(visible(html)).not.toMatch(/[✅❌⚠✓✔🟢🔴]/u);
  });
});

describe('匯入紀錄頁：四態各有明確動作（UX21）', () => {
  it('空狀態（完全沒有紀錄）→ 說明＋主動作「匯入學生名單」，不顯示空表格', () => {
    const html = render({ entries: [] });

    expect(html).toContain('還沒有匯入紀錄');
    expect(html).toMatch(/<a[^>]*href="\/imports"[^>]*>匯入學生名單<\/a>/);
    expect(html).not.toContain('<table');
  });

  it('空篩選（有紀錄但篩選後沒有）→ 明說沒有符合，並提供「清除篩選」，不假裝成功', () => {
    const html = render({ initialQuery: '不存在的檔名' });

    expect(html).toContain('沒有符合的紀錄');
    expect(html).toMatch(/<button[^>]*>清除篩選<\/button>/);
    expect(html).not.toContain('查看當時結果');
    expect(html).toContain('role="status"');
  });

  it('狀態篩選也能得到空篩選：只看「歷史資料」時沒有符合者要能清除', () => {
    const onlyCurrent = ENTRIES.filter((e) => e.status === 'current');
    const html = render({ entries: onlyCurrent, initialStatus: 'history' });

    expect(html).toContain('沒有符合的紀錄');
    expect(html).toMatch(/<button[^>]*>清除篩選<\/button>/);
  });

  it('篩選控制項有真正的 label（檔名搜尋、狀態下拉）', () => {
    const html = render();

    expect(html).toMatch(/<label[^>]*for="history-search"[^>]*>[^<]*檔名/);
    expect(html).toMatch(/<input[^>]*id="history-search"/);
    expect(html).toMatch(/<label[^>]*for="history-status"[^>]*>[^<]*狀態/);
    expect(html).toMatch(/<select[^>]*id="history-status"/);
  });

  it('loading → 有明確的載入中訊息（role=status），不顯示舊資料', () => {
    const html = renderToStaticMarkup(React.createElement(HistoryLoading));

    expect(html).toContain('role="status"');
    expect(html).toContain('載入匯入紀錄中');
  });

  it('失敗 → 白話說明＋「重試」＋離開路徑；原始錯誤訊息不外露於日常介面', () => {
    let retried = 0;
    const error = Object.assign(new Error('SQLITE_BUSY: database is locked at /Users/x/data/app.sqlite'), { digest: 'd1' });
    const html = renderToStaticMarkup(React.createElement(HistoryError, { error, reset: () => { retried += 1; } }));

    expect(html).toContain('無法載入匯入紀錄');
    expect(html).toMatch(/<button[^>]*>重試<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>回到核對結果<\/a>/);
    expect(html).toContain('role="alert"');
    const shown = visible(html);
    expect(shown).not.toContain('SQLITE_BUSY');
    expect(shown).not.toContain('/Users/x');
    expect(retried).toBe(0); // 只渲染，不自動重試
  });
});

describe('班級扣天：歷史 run 資料不足時明示不可重建（09 §5.2）', () => {
  const unavailable = {
    code: 'SNAPSHOT_UNAVAILABLE',
    message: '找不到當時的課表資料，資料不足，無法重建。系統不會改用最新課表補算，以免與當時的結果不一致。',
  };

  it('顯示原因與離開動作，且不顯示任何表格或數字（不能假裝算出來）', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClassDeductionsPanel, { unavailable, onEditClass: () => {} } as any)
    );

    expect(html).toContain('資料不足');
    expect(html).toContain('無法重建');
    expect(html).toContain('不會改用最新');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<table');
    expect(html).toMatch(/<a[^>]*href="\/history"[^>]*>回到匯入紀錄<\/a>/);
  });
});

describe('匯入紀錄頁與歷史檢視（伺服器頁面，真 SQLite）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-page-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    const db = createDatabase(process.env.DATABASE_PATH);
    runMigrations(db);
    saveImportBatch(db, {
      id: 'imp_1', fileName: '九月上旬.xlsx', fileHash: 'h1', contentHash: 'c1', sheetName: 'Sheet1', headerMap: {},
      parserVersion: '1.0.0', scopeNote: '', rowCount: 3, status: 'ready', createdAt: '2026-09-01T02:00:00.000Z',
    }, []);
    saveCalculationRun(db, {
      id: 'run_gone', importId: 'imp_1', scheduleVersionId: 'settings-v-missing', ruleSetVersion: 'erp-tag-v2',
      numericPolicy: 'integer-minute-rational-v1', asOfDate: '2026-09-15', status: 'completed', issueCounts: {}, totalStudents: 3,
      createdAt: '2026-09-02T02:00:00.000Z',
    }, []);
    db.close();
    (global as any).__sqlite_db__ = undefined;
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('/history 從真 DB 組出紀錄：檔名、人數、查看當時結果，日常介面沒有工程字', async () => {
    const html = renderToStaticMarkup(await HistoryPage());

    expect(html).toContain('九月上旬.xlsx');
    expect(html).toContain('3 人');
    expect(html).toContain('/history/run_gone');
    expect(visible(html)).not.toMatch(FORBIDDEN);
  });

  it('/history/[runId]：唯讀歷史檢視，標明「歷史資料（唯讀）」、來源檔與日期，沒有上傳新版本／恢復動作', async () => {
    const html = renderToStaticMarkup(await HistoryRunPage({ params: Promise.resolve({ runId: 'run_gone' }) }));

    expect(html).toContain('歷史資料（唯讀）');
    expect(html).toContain('九月上旬.xlsx');
    expect(html).toContain('2026-09-02 10:00');
    expect(html).toContain('核對基準日 2026-09-15');
    expect(html).toMatch(/<a[^>]*href="\/history"[^>]*>回到匯入紀錄<\/a>/);
    expect(html).not.toMatch(/上傳新版本|恢復|還原|設為現行/);
    expect(visible(html)).not.toMatch(FORBIDDEN);
  });

  it('/history/[runId]：找不到這筆紀錄 → 走 not-found（不渲染空白或崩潰）', async () => {
    await expect(HistoryRunPage({ params: Promise.resolve({ runId: 'run_nope' }) })).rejects.toThrow();
  });
});
