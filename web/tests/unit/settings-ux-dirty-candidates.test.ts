import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import {
  SEED_CLASSES,
  SEED_BASE_NAMES,
  NAMED_CANDIDATES,
  classifyErpDualTrack,
  filterVisibleCandidates,
} from '@/domain/schedules/seed-manifest';
import {
  ScheduleGridRow,
  classesToGridRows,
  buildSeedGridRows,
  isSettingsDirty,
} from '@/contracts/settings';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';

describe('D31 & D32-B: 設定頁 UX（未儲存提示＋候選已對齊隱藏）', () => {
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

  describe('D32-B: 候選已對齊自動隱藏 (filterVisibleCandidates & classifyErpDualTrack)', () => {
    it('4. [RED D32-B] 初始 Seed 狀態下 4 組候選皆可見且 isValid 為 true', () => {
      const activeClassSet = new Set(SEED_BASE_NAMES);
      const visible = filterVisibleCandidates(NAMED_CANDIDATES, activeClassSet);

      expect(visible.length).toBe(4);
      for (const c of visible) {
        expect(c.isValid).toBe(true);
      }
    });

    it('5. [RED D32-B] 改名對齊後：若 rawBaseName 已存在於有效班級中，該候選行自動隱藏', () => {
      // 模擬使用者將「小六加強班-國文」改名對齊為「小六國文加強班」
      const activeClassNames = SEED_BASE_NAMES.map((name) =>
        name === '小六加強班-國文' ? '小六國文加強班' : name
      );
      const activeClassSet = new Set(activeClassNames);

      const visible = filterVisibleCandidates(NAMED_CANDIDATES, activeClassSet);
      // 原 4 組候選中，「小六國文加強班」已與 ERP 對齊，應被隱藏，只剩 3 組
      expect(visible.length).toBe(3);
      expect(visible.some((c) => c.rawBaseName === '小六國文加強班')).toBe(false);

      // 其他 3 組依然可見
      expect(visible.some((c) => c.rawBaseName === '國小數學-一')).toBe(true);
      expect(visible.some((c) => c.rawBaseName === '國小國語文-小三四')).toBe(true);
      expect(visible.some((c) => c.rawBaseName === '小六數學加強班')).toBe(true);
    });

    it('6. [RED D32-B] 目標班級停用或不存在時，候選依然可見但 isValid 為 false（維持失效提示紅字）', () => {
      // 模擬將「小六加強班-數學」自有效班級中移除（停用）
      const activeClassNames = SEED_BASE_NAMES.filter((n) => n !== '小六加強班-數學');
      const activeClassSet = new Set(activeClassNames);

      const visible = filterVisibleCandidates(NAMED_CANDIDATES, activeClassSet);
      expect(visible.length).toBe(4);

      const mathCandidate = visible.find((c) => c.rawBaseName === '小六數學加強班');
      expect(mathCandidate).toBeDefined();
      expect(mathCandidate?.isValid).toBe(false);
    });

    it('7. [RED D32-B] classifyErpDualTrack 回傳的 candidates 應整合 D32-B 隱藏與有效性邏輯', () => {
      const erpBaseNames = ['小六國文加強班', '小六數學加強班', '國小數學-一'];
      // 改名對齊小六國文加強班
      const activeClasses = SEED_BASE_NAMES.map((n) =>
        n === '小六加強班-國文' ? '小六國文加強班' : n
      );

      const dual = classifyErpDualTrack(erpBaseNames, activeClasses);
      // 小六國文加強班候選應消失
      expect(dual.candidates.some((c) => c.rawBaseName === '小六國文加強班')).toBe(false);
      expect(dual.candidates.length).toBe(3);
    });
  });
});
