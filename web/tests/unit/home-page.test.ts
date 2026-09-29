import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { buildSeedDraft, hashSettingsDraft, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';
import HomePage from '@/app/page';
import { ACTIVATE_CONFLICT_MESSAGE } from '@/lib/user-messages';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => '/',
}));

/**
 * specs/09 §2（初始首頁主動作「先確認課表」、次動作「匯入學生」；seed 存在時說「已載入初始課表，請確認」，
 * 不假稱人員已確認）、§7（DB 路徑、Local Storage、Upload XLSX、Run、409 等工程字不得出現在日常介面）、
 * 一頁一個 h1（§2）。
 */

const text = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// 區分大小寫：檔名（例如 九月上旬.xlsx）是資料，不是文案；文案裡的英文格式字「XLSX」「Upload」才是要禁的。
const FORBIDDEN = /app\.sqlite|data\/|Local Storage|Storage Path|Upload|XLSX|\bRun\b|\b409\b|localhost/;

describe('首頁三種狀態（初始／只有課表／已匯入未使用）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-home-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    const db = createDatabase(process.env.DATABASE_PATH);
    runMigrations(db);
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

  const render = async () => renderToStaticMarkup(await HomePage());

  it('初始空狀態：一個 h1；主動作「先確認課表」、次動作「匯入學生」；說明已載入初始課表；不外露資料庫路徑與英文提示', async () => {
    const html = await render();

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>學生收費核對工具<\/h1>/);
    expect(text(html)).toContain('已載入初始課表，請先確認課表');
    expect(html).toMatch(/<a[^>]*class="btn-primary"[^>]*href="\/settings\?tab=schedule"[^>]*>先確認課表<\/a>|<a[^>]*href="\/settings\?tab=schedule"[^>]*class="btn-primary"[^>]*>先確認課表<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/imports"[^>]*>匯入學生<\/a>/);
    // 不假稱人員已確認
    expect(text(html)).not.toMatch(/已確認|已對帳|已完成核對/);
    expect(text(html)).not.toMatch(FORBIDDEN);
    expect(html).not.toContain('path-box');
  });

  it('只有課表（已儲存過課表、尚未匯入學生）：說明課表已儲存，主動作改為「匯入學生」', async () => {
    const db = createDatabase(process.env.DATABASE_PATH!);
    const draft = buildSeedDraft();
    saveSettingsVersion(db, {
      id: 'set_v1', contentHash: hashSettingsDraft(draft), contentJson: JSON.stringify(draft),
      effectiveFrom: null, effectiveTo: null, createdAt: '2026-09-29T02:00:00.000Z', createdFromPreviewId: null, revision: 1,
    });
    db.close();
    (global as any).__sqlite_db__ = undefined;

    const html = await render();

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(text(html)).toContain('課表已儲存');
    expect(text(html)).toContain('2026-09-29 10:00');
    expect(html).toMatch(/<a[^>]*class="btn-primary"[^>]*href="\/imports"[^>]*>匯入學生<\/a>|<a[^>]*href="\/imports"[^>]*class="btn-primary"[^>]*>匯入學生<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/settings\?tab=schedule"[^>]*>查看課表<\/a>/);
    expect(text(html)).not.toMatch(FORBIDDEN);
  });

  it('已匯入、尚未使用：一個 h1 說明還沒開始核對；主按鈕「使用這份名單」（與匯入頁一致），沒有 Run 字樣', async () => {
    const db = createDatabase(process.env.DATABASE_PATH!);
    saveImportBatch(db, {
      id: 'imp_1', fileName: '九月上旬.xlsx', fileHash: 'h', contentHash: 'c', sheetName: 'Sheet1', headerMap: {},
      parserVersion: '1.0.0', scopeNote: '', rowCount: 0, status: 'ready', createdAt: '2026-09-01T02:00:00.000Z',
    }, []);
    db.close();
    (global as any).__sqlite_db__ = undefined;

    const html = await render();

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>尚未使用這份名單<\/h1>/);
    expect(text(html)).toContain('九月上旬.xlsx');
    expect(html).toMatch(/<button[^>]*class="btn-primary"[^>]*>使用這份名單<\/button>/);
    expect(html).toMatch(/<a[^>]*href="\/imports"[^>]*>匯入其他名單<\/a>/);
    expect(text(html)).not.toMatch(FORBIDDEN);
  });
});

describe('版本衝突（409）的使用者訊息', () => {
  it('白話說明「資料已被其他操作更新」與下一步，不外露 HTTP 狀態碼或內部詞（09 §7：REVISION_CONFLICT → 資料已更新，請重新確認）', () => {
    expect(ACTIVATE_CONFLICT_MESSAGE).toContain('資料已被其他操作更新');
    expect(ACTIVATE_CONFLICT_MESSAGE).toContain('重新整理');
    expect(ACTIVATE_CONFLICT_MESSAGE).not.toMatch(/409|REVISION|版本衝突|rev/i);
  });
});
