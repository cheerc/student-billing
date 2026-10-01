import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { buildSeedDraft, getLatestSettingsVersion, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import type { SettingsDraft } from '@/contracts/settings';

/** 生產 preview→apply→readStoredDraft：缺欄位＝自動，舊 manual 不得混入新設定快照。 */
describe('D2c 恢復自動的設定快照持久化', () => {
  it('移除手動欄位後的新 draft 不含 manual；舊快照仍不可變', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      const manual = buildSeedDraft();
      const cls = manual.classes.find((c) => c.baseName === '國小數學-四A')!;
      Object.assign(cls, { category: 'none', categorySource: 'manual', fixedFiveDays: true, fixedSource: 'manual' });
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
      delete target.fixedSource;
      save(restored, first.revision);
      const latest = getLatestSettingsVersion(db)!;
      const persisted = readStoredDraft(latest.contentJson).classes.find((c) => c.baseName === cls.baseName)!;
      expect(persisted).not.toHaveProperty('category');
      expect(persisted).not.toHaveProperty('categorySource');
      expect(persisted).not.toHaveProperty('fixedFiveDays');
      expect(persisted).not.toHaveProperty('fixedSource');
      const unchanged = db.prepare('SELECT content_json FROM settings_versions WHERE id = ?').get(old.id) as { content_json: string };
      expect(unchanged.content_json).toBe(old.contentJson);
    } finally {
      db.close();
    }
  });
});
