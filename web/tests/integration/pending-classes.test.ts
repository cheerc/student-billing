import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { buildSeedDraft, hashSettingsDraft, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { findPendingClassNames } from '@/application/pending-classes';

/**
 * 匯入預覽的「N 個班名待確認」必須和課表設定「班名對應」頁籤的待確認數同源。
 *
 * R5 跨頁面檢視發現：匯入預覽的 pendingClasses 是「檔案裡所有不重複班名」（fixture 為 54 個，含已對上課表的），
 * 而課表設定的待確認是「還沒對應到課表的班名」（12 個）。同一份名單兩頁數字不同，會讓使用者不知道該處理幾個。
 * 「待確認」＝ERP 班名既不是（最新已儲存，尚無則 seed）課表裡的班，也沒有被班名對應解析到課表裡的班。
 */

describe('findPendingClassNames：匯入預覽的待確認班名（與課表設定同源）', () => {
  let tempDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pending-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('尚無已儲存設定：以 seed 課表判斷——課表裡有的班不算待確認，沒有的才算（結果排序、去重）', () => {
    const result = findPendingClassNames(db, ['國小數學-三A', '國小數學-一', '交通車', '國小數學-一']);

    expect(result).toEqual(['交通車', '國小數學-一']);
  });

  it('已有班名對應（國小數學-一 → 國小數學-一A）：解析後對得上，不再算待確認', () => {
    const draft = buildSeedDraft();
    draft.aliases = [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }];
    saveSettingsVersion(db, {
      id: 'set_v1', contentHash: hashSettingsDraft(draft), contentJson: JSON.stringify(draft),
      effectiveFrom: null, effectiveTo: null, createdAt: '2026-09-01T12:00:00.000Z', createdFromPreviewId: null, revision: 1,
    });

    const result = findPendingClassNames(db, ['國小數學-三A', '國小數學-一', '交通車']);

    expect(result).toEqual(['交通車']);
  });

  it('已儲存設定移除了某班：以最新已儲存設定為準，不退回 seed', () => {
    const draft = buildSeedDraft();
    draft.classes = draft.classes.filter((c) => c.baseName !== '國小數學-三A');
    saveSettingsVersion(db, {
      id: 'set_v2', contentHash: hashSettingsDraft(draft), contentJson: JSON.stringify(draft),
      effectiveFrom: null, effectiveTo: null, createdAt: '2026-09-01T12:00:00.000Z', createdFromPreviewId: null, revision: 1,
    });

    expect(findPendingClassNames(db, ['國小數學-三A'])).toEqual(['國小數學-三A']);
  });

  it('沒有任何班名 → 空陣列', () => {
    expect(findPendingClassNames(db, [])).toEqual([]);
  });
});
