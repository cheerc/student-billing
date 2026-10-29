import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { buildSeedGridRows, isSettingsDirty } from '@/contracts/settings';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { stageClassNameSync, stageNewClassFromRoster } from '@/domain/schedules/class-name-sync';

describe('D31 & D62: 設定頁 UX（未儲存提示＋班名同步草稿）', () => {
  let tempDir: string;
  let tempDbPath: string;
  let importId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ux-test-'));
    tempDbPath = path.join(tempDir, 'test.sqlite');
    process.env.DATABASE_PATH = tempDbPath;
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    const db = getDatabase();
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const buf = fs.readFileSync(fixturePath);
    const preview = await generateImportPreview(buf, 'fixture.xlsx');
    importId = preview.previewId;
    saveImportBatch(
      db,
      {
        id: preview.previewId,
        fileName: preview.fileName,
        fileHash: preview.fileHash,
        contentHash: preview.contentHash,
        sheetName: preview.sheetName,
        headerMap: preview.headerMapping,
        parserVersion: '1.0.0',
        scopeNote: preview.scopeNote,
        rowCount: preview.stats.totalStudents,
        status: 'ready',
        createdAt: new Date().toISOString(),
      },
      preview.students
    );
    activateImport(db, {
      importId,
      expectedRevision: 0,
      idempotencyKey: `ux-setup-${Date.now()}-${Math.random()}`,
    });
  });

  afterEach(() => {
    if ((global as any).__sqlite_db__) {
      (global as any).__sqlite_db__.close();
      (global as any).__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('D31: 未儲存狀態判定 (isSettingsDirty)', () => {
    it('1. [RED D31] 初始狀態與未變更時 isSettingsDirty 應為 false', () => {
      const initialRows = buildSeedGridRows();
      const initialAliases: Array<{ rawBaseName: string; targetBaseName: string }> = [];
      const baseline = { rows: initialRows, aliases: initialAliases };

      expect(isSettingsDirty(baseline, initialRows, initialAliases)).toBe(false);
    });

    it('2. [RED D31] 修改班名、時段、星期、停用或刪除列時，isSettingsDirty 應為 true；還原時應為 false', () => {
      const initialRows = buildSeedGridRows();
      const baseline = { rows: initialRows, aliases: [] };

      // 修改班名
      const modifiedClassName = initialRows.map((r, i) =>
        i === 0 ? { ...r, className: '小六國文加強班' } : r
      );
      expect(isSettingsDirty(baseline, modifiedClassName, [])).toBe(true);

      // 修改時間
      const modifiedTime = initialRows.map((r, i) =>
        i === 0 ? { ...r, startTime: '14:00', startMinutes: 840 } : r
      );
      expect(isSettingsDirty(baseline, modifiedTime, [])).toBe(true);

      // 軟停用
      const modifiedActive = initialRows.map((r, i) =>
        i === 0 ? { ...r, active: false } : r
      );
      expect(isSettingsDirty(baseline, modifiedActive, [])).toBe(true);

      // 刪除列
      const deletedRow = initialRows.slice(1);
      expect(isSettingsDirty(baseline, deletedRow, [])).toBe(true);

      // 新增 alias
      expect(
        isSettingsDirty(baseline, initialRows, [
          { rawBaseName: '小六國文加強班', targetBaseName: '小六加強班-國文' },
        ])
      ).toBe(true);

      // 還原為 baseline
      expect(isSettingsDirty(baseline, initialRows, [])).toBe(false);
    });

    it('3. [RED D31] applySettingsPreview 套用成功後應回傳 appliedAt 時間戳', async () => {
      const db = getDatabase();
      const draft = buildSeedDraft();
      draft.aliases = [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }];
      const preview = previewSettingsChange(db, importId, { draft, expectedRevision: 1 });
      const applyRes = applySettingsPreview(db, {
        previewId: preview.previewId,
        expectedRevision: 1,
        idempotencyKey: `ux-apply-test-${Date.now()}`,
      });

      expect(applyRes).toBeDefined();
      expect(applyRes.revision).toBe(2);
      expect(applyRes.appliedAt).toBeDefined();
      expect(typeof applyRes.appliedAt).toBe('string');
      expect(new Date(applyRes.appliedAt).getTime()).not.toBeNaN();
    });

    it('8. [RED F1] 改格後或套用後舊 previewId 不得殘留或被重複送出 (409 CAS 防護)', async () => {
      const db = getDatabase();
      const draft = buildSeedDraft();
      draft.aliases = [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }];

      // 產生第一次預覽 (expectedRevision: 1)
      const preview1 = previewSettingsChange(db, importId, { draft, expectedRevision: 1 });
      expect(preview1.previewId).toBeDefined();

      // 套用第一次預覽 -> revision 推進至 2
      const applyRes1 = applySettingsPreview(db, {
        previewId: preview1.previewId,
        expectedRevision: 1,
        idempotencyKey: `ux-apply-once-${Date.now()}`,
      });
      expect(applyRes1.revision).toBe(2);

      // 改格後若未重新預覽，直接重複送出舊 previewId（無論帶舊 revision 1 或新 revision 2）皆被拒絕
      // 1. 帶舊 revision 1 -> 409 版本衝突 (REVISION_CONFLICT)
      expect(() => {
        applySettingsPreview(db, {
          previewId: preview1.previewId,
          expectedRevision: 1,
          idempotencyKey: `ux-apply-stale-rev1-${Date.now()}`,
        });
      }).toThrowError(/版本衝突/);

      // 2. 帶新 revision 2 -> 409 版本衝突（因為 preview1 建立時 expectedRevision 是 1，與請求 2 衝突）
      expect(() => {
        applySettingsPreview(db, {
          previewId: preview1.previewId,
          expectedRevision: 2,
          idempotencyKey: `ux-apply-stale-rev2-${Date.now()}`,
        });
      }).toThrowError(/版本衝突/);
    });
  });

  describe('D62：同步／新增作為設定草稿參與 dirty 判定', () => {
    it('整班同步暫存改變班名且標記 dirty；復原至原 rows／aliases 後回到 clean', () => {
      const rows = buildSeedGridRows();
      const aliases = [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }];
      const baseline = { rows, aliases };

      const staged = stageClassNameSync({ rows, aliases }, {
        erpBaseName: '國小數學-一',
        systemBaseName: '國小數學-一A',
      });
      expect(staged.rows.some((row) => row.className === '國小數學-一')).toBe(true);
      expect(staged.rows.some((row) => row.className === '國小數學-一A')).toBe(false);
      expect(staged.aliases).toHaveLength(0);
      expect(isSettingsDirty(baseline, staged.rows, staged.aliases)).toBe(true);

      const restoredRows = staged.rows.map((row) =>
        row.className === '國小數學-一' ? { ...row, className: '國小數學-一A' } : row
      );
      expect(isSettingsDirty(baseline, restoredRows, aliases)).toBe(false);
    });

    it('新增名冊班級作為設定草稿參與 dirty 判定', () => {
      const rows = buildSeedGridRows();
      const baseline = { rows, aliases: [] };
      const staged = stageNewClassFromRoster(rows, {
        erpBaseName: '交通車',
        classType: 'unscheduled',
      });

      expect(staged.newRow.className).toBe('交通車');
      expect(staged.newRow.weekday).toBe('');
      expect(isSettingsDirty(baseline, staged.rows, [])).toBe(true);
    });
  });
});
