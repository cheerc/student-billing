import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { buildSeedDraft, getLatestSettingsVersion, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import type { SettingsDraft } from '@/contracts/settings';

/**
 * 生產 preview→apply→readStoredDraft：缺欄位＝未設定，舊的 manual 值不得混入新設定快照。
 *
 * ── 涵蓋邊界（依 brief D2d G「若判斷 E2E 已足夠」的分支；純註解，零行為變更）──
 *
 * 1. **本檔只涵蓋儲存層**：`previewSettingsChange`／`applySettingsPreview`／`readStoredDraft`，
 *    即「設定草稿進資料庫」這一段。它**不觸及 client 端** `settings-editor.tsx` 的
 *    `applyManualAttrsToClasses`（草稿序列化為 classes[] 的那一步）。
 * 2. **client 端序列化契約由 `web/tests/e2e/issue-157-seed-category-lifecycle.spec.ts` 承載**：
 *    那裡驗「選回（未設定）→ 儲存 → reload 仍是未設定」，以及 seed 班改名／同名合併後
 *    「存檔再 reload 的值 ≡ 改名當下畫面顯示的值」。
 *    原 `d2c-restore-auto.spec.ts`（驗「恢復自動」按鈕）已隨 #157 Ruling 4 廢除；
 *    本 PR 曾把承載者改指向 `d2b-class-category.spec.ts`，但該檔並無任何存檔重載案例，
 *    實際承載者是上列的 lifecycle spec。
 * 3. **為何不在本檔補單元層防護**：`applyManualAttrsToClasses` 是 module-private 純函式，
 *    沒有 export。要讓單元測試 import 它必須先在產品碼加 export 或搬檔，該 commit 便不再
 *    是 tests-only，且在未修 src 上會是編譯／載入失敗而非斷言失敗——與 brief 對 RED 形態的
 *    要求互斥。且 UI 操作 → draft → preview payload 才是 client 端序列化真正的 entry point，
 *    單元層只測抽出的純函式等同測試實作形狀（§3.9 所指的鏡像測試）。
 *    （本 PR 的 client 端寫出閘門另由 `web/tests/unit/issue-157-seed-category-fallback.test.ts`
 *    以 `gridRowsToClasses → 儲存形狀 → readStoredDraft → buildClassSettingMap → resolveClassEnrollment`
 *    覆蓋——那是 contracts 層的公開轉換，不需 export 化產品程式碼。）
 * 4. 因此：本檔守「儲存層不得寫回 manual 欄位、舊快照不可變」；client 端守「使用者的指定
 *    必須持久化且 reload 後仍是同一個決定」。兩者不可互相替代。
 *
 * #157：檔名保留（原意是「恢復自動」的持久化），但測試內容改為「撤回指定後的持久化」——
 * 使用者把某班選回「（未設定）」後，儲存層不得把舊的 manual 值寫回草稿。
 */
describe('D2c 使用者指定／撤回指定的設定快照持久化', () => {
  it('撤回指定（移除欄位）後的新 draft 不含 manual；舊快照仍不可變', () => {
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
