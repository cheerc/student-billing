import { describe, it, expect } from 'vitest';
import { getDatabase } from '@/adapters/sqlite';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import type { SettingsDraft } from '@/contracts/settings';
import { activeState, activateBatch, loadModule, ruleSetOfRun, saveFixtureBatch, setRunRuleSet, useGlobalTempDb } from '../helpers/d1-test-kit';

/**
 * #159 PR-2: confirmed apply may create only v4. Active legacy runs require an explicit v4 preview;
 * applying a stale preview that records a retired version fails closed. Null-era previews resolve against
 * current active state and therefore cannot silently create a legacy run.
 */

const ALIAS = { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' };

/** 一A 改成單一時段（週一 15:20–16:50）＋一→一A 別名；與 D1 無關的既有設定變更，只用來觸發 preview／apply。 */
function changedDraft(): SettingsDraft {
  const seed = buildSeedDraft();
  return {
    ...seed,
    aliases: [ALIAS],
    classes: seed.classes.map((c) =>
      c.baseName === '國小數學-一A' ? { ...c, sessions: [{ weekday: '一', startMinutes: 920, endMinutes: 1010, skipDeduction: false }] } : c
    ),
  };
}

/** 需要直接改寫 preview 列的測試，先斷言欄位存在（缺欄位時是清楚的斷言失敗，而不是 SQL 例外）。 */
function expectTargetColumn(db: ReturnType<typeof getDatabase>) {
  const cols = db.prepare('PRAGMA table_info(settings_previews)').all() as Array<{ name: string }>;
  expect(
    cols.some((c) => c.name === 'target_rule_set_version'),
    'settings_previews 需有 target_rule_set_version 欄位（migration 0007）'
  ).toBe(true);
}

function targetColumn(db: ReturnType<typeof getDatabase>, previewId: string): string | null | 'NO_COLUMN' {
  const cols = db.prepare('PRAGMA table_info(settings_previews)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'target_rule_set_version')) return 'NO_COLUMN';
  const row = db.prepare('SELECT target_rule_set_version AS t FROM settings_previews WHERE preview_id = ?').get(previewId) as { t: string | null };
  return row.t;
}

describe('F-3：apply 使用 preview 記錄的目標規則版本', () => {
  const ctx = useGlobalTempDb('sb-d1-apply-');

  async function activeWithVersion(version: string) {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    const run = activateBatch(db, 'imp_a', 'k-act');
    // 模擬既有歷史 run metadata；其計算資料仍是啟用時保存的列，不以舊 calculator 重建。
    setRunRuleSet(db, run.runId, version);
    return { db, revision: activeState(db).revision };
  }

  it.each(['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'excel-v260922-compat', 'garbage-version'])(
    'active 為 %s：一般 preview 拒絕；明確選擇 v4 後 apply 只建立 v4', async (version) => {
      const { db, revision } = await activeWithVersion(version);
      let caught: any;
      try {
        previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: revision });
      } catch (error) {
        caught = error;
      }
      expect(caught?.code).toBe('UPGRADE_REQUIRED');

      const preview = previewSettingsChange(db, undefined, {
        draft: changedDraft(),
        expectedRevision: revision,
        targetRuleSetVersion: 'erp-tag-v4',
      });
      expect(targetColumn(db, preview.previewId)).toBe('erp-tag-v4');
      const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: `k-upgrade-${version}` });
      expect(ruleSetOfRun(db, applied.runId as string)).toBe('erp-tag-v4');
    }
  );

  it('settings_only（無現行名單）的 preview 也記錄目標版本（erp-tag-v4）；apply 不建 run', () => {
    const db = ctx.db();
    const preview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: 0 });
    expect(preview.mode).toBe('settings_only');
    expect(targetColumn(db, preview.previewId)).toBe('erp-tag-v4');
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: 0, idempotencyKey: 'k-so' });
    expect(applied.runId).toBeNull();
  });

  it('apply uses the persisted v4 target even if active metadata later becomes legacy', async () => {
    const { db, revision } = await activeWithVersion('erp-tag-v2');
    const preview = previewSettingsChange(db, undefined, {
      draft: changedDraft(),
      expectedRevision: revision,
      targetRuleSetVersion: 'erp-tag-v4',
    });
    expectTargetColumn(db);
    db.prepare('UPDATE calculation_runs SET rule_set_version = ? WHERE id = ?').run('erp-tag-v3', activeState(db).active_run_id);
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: 'k-recorded-v4' });
    expect(ruleSetOfRun(db, applied.runId as string)).toBe('erp-tag-v4');
  });

  it('舊 preview target 為 null：active v4 時 fallback 仍只建 v4；active 舊版時 fail-closed', async () => {
    const { db, revision } = await activeWithVersion('erp-tag-v4');
    const preview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: revision });
    expectTargetColumn(db);
    db.prepare('UPDATE settings_previews SET target_rule_set_version = NULL WHERE preview_id = ?').run(preview.previewId);
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: 'k-null-v4' });
    expect(ruleSetOfRun(db, applied.runId as string)).toBe('erp-tag-v4');

    const nextPreview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: applied.revision });
    db.prepare('UPDATE settings_previews SET target_rule_set_version = NULL WHERE preview_id = ?').run(nextPreview.previewId);
    db.prepare('UPDATE calculation_runs SET rule_set_version = ? WHERE id = ?').run('erp-tag-v2', applied.runId);
    let caught: any;
    try {
      applySettingsPreview(db, { previewId: nextPreview.previewId, expectedRevision: applied.revision, idempotencyKey: 'k-null-old' });
    } catch (error) {
      caught = error;
    }
    expect(caught?.code).toBe('UPGRADE_REQUIRED');
  });

  it.each(['excel-v260922-compat', 'garbage-version'])(
    '記錄的目標不是 v4（%s）→ 拒絕套用，不建 run、不動 active',
    async (bad) => {
      const { db, revision } = await activeWithVersion('erp-tag-v4');
      const preview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: revision });
      expectTargetColumn(db);
      db.prepare('UPDATE settings_previews SET target_rule_set_version = ? WHERE preview_id = ?').run(bad, preview.previewId);
      const before = activeState(db);
      const runsBefore = (db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get() as { n: number }).n;
      let caught: any;
      try {
        applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: `k-bad-${bad}` });
      } catch (e) {
        caught = e;
      }
      expect(caught, bad).toBeDefined();
      expect(caught.statusCode, bad).toBe(409);
      expect(caught.code, bad).toBe('UPGRADE_REQUIRED');
      expect(activeState(db)).toEqual(before);
      expect((db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get() as { n: number }).n).toBe(runsBefore);
    }
  );
});

describe('規則版本解析器（新模組 @/application/rule-set-resolver）', () => {
  const ctx = useGlobalTempDb('sb-d1-resolver-');

  type Resolver = {
    resolveFormalRuleSetVersion: (db: unknown) => string;
    resolveRuleSetForApply: (db: unknown, recorded: string | null | undefined) => string;
  };

  it('歷史讀取 accessor 保留已知 active metadata；unknown 不會被解讀成已知版本', async () => {
    const mod = await loadModule<Resolver>('@/application/rule-set-resolver');
    expect(mod, '@/application/rule-set-resolver 需存在').not.toBeNull();
    const db = ctx.db();
    expect(mod!.resolveFormalRuleSetVersion(db)).toBe('erp-tag-v4');

    await saveFixtureBatch(db, 'imp_a');
    const run = activateBatch(db, 'imp_a', 'k1');
    expect(mod!.resolveFormalRuleSetVersion(db)).toBe('erp-tag-v4');
    setRunRuleSet(db, run.runId, 'erp-tag-v1');
    expect(mod!.resolveFormalRuleSetVersion(db)).toBe('erp-tag-v1');
    setRunRuleSet(db, run.runId, 'excel-v260922-compat');
    expect(mod!.resolveFormalRuleSetVersion(db)).toBe('erp-tag-v4');
  });

  it('resolveRuleSetForApply：只允許 v4 target；null fallback fail-closed on old active', async () => {
    const mod = await loadModule<Resolver>('@/application/rule-set-resolver');
    expect(mod, '@/application/rule-set-resolver 需存在').not.toBeNull();
    const db = ctx.db();
    expect(mod!.resolveRuleSetForApply(db, 'erp-tag-v4')).toBe('erp-tag-v4');
    expect(mod!.resolveRuleSetForApply(db, null)).toBe('erp-tag-v4');
    expect(mod!.resolveRuleSetForApply(db, undefined)).toBe('erp-tag-v4');
    expect(() => mod!.resolveRuleSetForApply(db, 'erp-tag-v1')).toThrow();
    expect(() => mod!.resolveRuleSetForApply(db, 'erp-tag-v2')).toThrow();
    expect(() => mod!.resolveRuleSetForApply(db, 'excel-v260922-compat')).toThrow();
    expect(() => mod!.resolveRuleSetForApply(db, 'garbage-version')).toThrow();
    await saveFixtureBatch(db, 'imp_a');
    const run = activateBatch(db, 'imp_a', 'k1');
    setRunRuleSet(db, run.runId, 'erp-tag-v2');
    expect(() => mod!.resolveRuleSetForApply(db, null)).toThrow();
  });
});
