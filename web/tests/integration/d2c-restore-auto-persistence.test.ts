import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { buildSeedDraft, getLatestSettingsVersion, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import type { SettingsDraft } from '@/contracts/settings';

/**
 * 生產 preview→apply→readStoredDraft：缺欄位＝自動，舊 manual 不得混入新設定快照。
 *
 * ── 涵蓋邊界（依 brief D2d G「若判斷 E2E 已足夠」的分支；純註解，零行為變更）──
 *
 * 1. **本檔只涵蓋儲存層**：`previewSettingsChange`／`applySettingsPreview`／`readStoredDraft`，
 *    即「設定草稿進資料庫」這一段。它**不觸及 client 端** `settings-editor.tsx` 的
 *    `applyManualAttrsToClasses`（草稿序列化為 classes[] 的那一步）。
 * 2. **client 端序列化契約由 `web/tests/e2e/d2c-restore-auto.spec.ts` 承載**：該檔三條
 *    （已儲存手動類別／固定 5 天／改名後恢復 → 儲存 → reload）在**未修 base `a5471a7`**
 *    上實際 3 failed（期望「自動」實得「手動」），且 PR #45 的兩位 reviewer 皆獨立重現。
 *    raw 證據見 workspace `evidence-D2c/restore-auto-red-real-input.log`。
 * 3. **為何不在本檔補單元層防護**：`applyManualAttrsToClasses` 是 module-private 純函式，
 *    沒有 export。要讓單元測試 import 它必須先在產品碼加 export 或搬檔，該 commit 便不再
 *    是 tests-only，且在未修 src 上會是編譯／載入失敗而非斷言失敗——與 brief 對 RED 形態的
 *    要求互斥。且 UI 操作 → draft → preview payload 才是 client 端序列化真正的 entry point，
 *    單元層只測抽出的純函式等同測試實作形狀（§3.9 所指的鏡像測試）。
 * 4. 因此：本檔守「儲存層不得寫回 manual 欄位、舊快照不可變」；client 端守「恢復自動必須
 *    持久化且 reload 後仍為自動」。兩者不可互相替代。
 */
describe('D2c 恢復自動的設定快照持久化', () => {
  it('移除手動欄位後的新 draft 不含 manual；舊快照仍不可變', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      const manual = buildSeedDraft();
      const cls = manual.classes.find((c) => c.baseName === '國小數學-四A')!;
      Object.assign(cls, { category: 'none', categorySource: 'manual', fixedFiveDays: true });
      const save = (draft: SettingsDraft, revision: number) => {
        const preview = previewSettingsChange(db, null, { draft, expectedRevision: revision });
        return applySettingsPreview(db, {
          previewId: preview.previewId,
          expectedRevision: revision,
          idempotencyKey: `restore-${preview.previewId}`,
        });
      };
      const first = save(manual, 0);
      const old = getLatestSettingsVersion(db)!;
      const restored = readStoredDraft(old.contentJson);
      const target = restored.classes.find((c) => c.baseName === cls.baseName)!;
      delete target.category;
      delete target.categorySource;
      delete target.fixedFiveDays;
      save(restored, first.revision);
      const latest = getLatestSettingsVersion(db)!;
      const persisted = readStoredDraft(latest.contentJson).classes.find((c) => c.baseName === cls.baseName)!;
      expect(persisted).not.toHaveProperty('category');
      expect(persisted).not.toHaveProperty('categorySource');
      expect(persisted).not.toHaveProperty('fixedFiveDays');
      const unchanged = db.prepare('SELECT content_json FROM settings_versions WHERE id = ?').get(old.id) as { content_json: string };
      expect(unchanged.content_json).toBe(old.contentJson);
    } finally {
      db.close();
    }
  });
});
