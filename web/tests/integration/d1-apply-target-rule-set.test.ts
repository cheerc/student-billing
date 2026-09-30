import { describe, it, expect } from 'vitest';
import { getDatabase } from '@/adapters/sqlite';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import type { SettingsDraft } from '@/contracts/settings';
import { activeState, activateBatch, loadModule, ruleSetOfRun, saveFixtureBatch, setRunRuleSet, useGlobalTempDb } from '../helpers/d1-test-kit';

/**
 * D1 F-3（specs/11 §3 D1、04 §8 UX37；S manifest §1.3 #10、§2.3、§A F-3）：
 * apply 使用 preview 記錄的目標規則版本，不再落回 calculate-run 的預設 erp-tag-v2。
 *
 * 舊行為的錯：active run 為 erp-tag-v1 時，preview 以 v1 計算「前／後」影響（settings-preview 用 active 版本），
 * apply 卻以預設 v2 建新 run——使用者看到的預覽與實際套用的版本不一致。
 *
 * 判定規則（寫入 03）：preview 列新增 `target_rule_set_version`（migration 0007，nullable）。
 *  - 新 preview 一律記錄 preview 當下 server 決定的版本；
 *  - apply 只讀該欄；欄位為 null（0007 之前建立的舊 preview，TTL 15 分鐘，實務上幾乎不存在）視為
 *    「建立當時的 active 版本」——因 revision CAS 保證 active 沒變，等於 apply 當下 server 解析的版本；
 *  - 欄位值不是正式軌版本（含診斷軌 compat、未知字串）→ 視為預覽資料損毀，拒絕套用（500 PREVIEW_CORRUPTED）。
 */

const ALIAS = { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' };

/** 一A 改成單一時段（週一 15:20–16:50）＋一→一A 別名；與 D1 無關的既有設定變更，只用來觸發 preview／apply。 */
function changedDraft(): SettingsDraft {
  const seed = buildSeedDraft();
  return {
    ...seed,
    aliases: [ALIAS],
    classes: seed.classes.map((c) =>
      c.baseName === '國小數學-一A' ? { ...c, sessions: [{ weekday: '一', startMinutes: 920, endMinutes: 1010 }] } : c
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
    if (version !== 'erp-tag-v2') setRunRuleSet(db, run.runId, version);
    return { db, revision: activeState(db).revision };
  }

  it('active 為 erp-tag-v1：preview 記錄目標 erp-tag-v1，apply 建立的新 run＝erp-tag-v1（D1 前為 v2）', async () => {
    const { db, revision } = await activeWithVersion('erp-tag-v1');
    const preview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: revision });

    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: 'k-apply-1' });
    expect(applied.runId).not.toBeNull();
    // 使用者在預覽看到的是 v1 的影響；apply 必須用同一個版本建 run（D1 前這裡是 erp-tag-v2）
    expect(ruleSetOfRun(db, applied.runId as string)).toBe('erp-tag-v1');
    expect(targetColumn(db, preview.previewId), 'preview 列需記錄目標版本').toBe('erp-tag-v1');
  });

  it('active 為 erp-tag-v2：目標 erp-tag-v2，apply 建 v2 run（特徵化）', async () => {
    const { db, revision } = await activeWithVersion('erp-tag-v2');
    const preview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: revision });
    expect(targetColumn(db, preview.previewId)).toBe('erp-tag-v2');
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: 'k-apply-2' });
    expect(ruleSetOfRun(db, applied.runId as string)).toBe('erp-tag-v2');
  });

  it('active 為診斷軌 compat：目標採現行正式軌 erp-tag-v2（診斷軌不作正式值）', async () => {
    const { db, revision } = await activeWithVersion('excel-v260922-compat');
    const preview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: revision });
    expect(targetColumn(db, preview.previewId)).toBe('erp-tag-v2');
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: 'k-apply-3' });
    expect(ruleSetOfRun(db, applied.runId as string)).toBe('erp-tag-v2');
  });

  it('settings_only（無現行名單）的 preview 也記錄目標版本（erp-tag-v2）；apply 不建 run', () => {
    const db = ctx.db();
    const preview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: 0 });
    expect(preview.mode).toBe('settings_only');
    expect(targetColumn(db, preview.previewId)).toBe('erp-tag-v2');
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: 0, idempotencyKey: 'k-so' });
    expect(applied.runId).toBeNull();
  });

  it('apply 只讀 preview 記錄的目標，不重新解析：記錄為 erp-tag-v1、active 為 v2 → 新 run＝v1', async () => {
    const { db, revision } = await activeWithVersion('erp-tag-v2');
    const preview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: revision });
    expectTargetColumn(db);
    db.prepare('UPDATE settings_previews SET target_rule_set_version = ? WHERE preview_id = ?').run('erp-tag-v1', preview.previewId);
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: 'k-apply-4' });
    expect(ruleSetOfRun(db, applied.runId as string)).toBe('erp-tag-v1');
  });

  it('舊 preview 列（目標欄位為 null）視為建立當時的 active 版本：active 為 v1 → 新 run＝v1', async () => {
    const { db, revision } = await activeWithVersion('erp-tag-v1');
    const preview = previewSettingsChange(db, undefined, { draft: changedDraft(), expectedRevision: revision });
    expectTargetColumn(db);
    db.prepare('UPDATE settings_previews SET target_rule_set_version = NULL WHERE preview_id = ?').run(preview.previewId);
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: 'k-apply-5' });
    expect(ruleSetOfRun(db, applied.runId as string)).toBe('erp-tag-v1');
  });

  it.each(['excel-v260922-compat', 'garbage-version'])(
    '記錄的目標不是正式軌版本（%s）→ 拒絕套用 500 PREVIEW_CORRUPTED，不建 run、不動 active',
    async (bad) => {
      const { db, revision } = await activeWithVersion('erp-tag-v2');
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
      expect(caught.statusCode, bad).toBe(500);
      expect(caught.code, bad).toBe('PREVIEW_CORRUPTED');
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

  it('模組存在；resolveFormalRuleSetVersion：無 active→v2；active v1→v1；active v2→v2；active compat→v2', async () => {
    const mod = await loadModule<Resolver>('@/application/rule-set-resolver');
    expect(mod, '@/application/rule-set-resolver 需存在').not.toBeNull();
    const db = ctx.db();
    expect(mod!.resolveFormalRuleSetVersion(db)).toBe('erp-tag-v2');

    await saveFixtureBatch(db, 'imp_a');
    const run = activateBatch(db, 'imp_a', 'k1');
    expect(mod!.resolveFormalRuleSetVersion(db)).toBe('erp-tag-v2');
    setRunRuleSet(db, run.runId, 'erp-tag-v1');
    expect(mod!.resolveFormalRuleSetVersion(db)).toBe('erp-tag-v1');
    setRunRuleSet(db, run.runId, 'excel-v260922-compat');
    expect(mod!.resolveFormalRuleSetVersion(db)).toBe('erp-tag-v2');
  });

  it('resolveRuleSetForApply：記錄值為正式軌則採用；null／undefined 回 server 解析值；非正式軌拋錯', async () => {
    const mod = await loadModule<Resolver>('@/application/rule-set-resolver');
    expect(mod, '@/application/rule-set-resolver 需存在').not.toBeNull();
    const db = ctx.db();
    expect(mod!.resolveRuleSetForApply(db, 'erp-tag-v1')).toBe('erp-tag-v1');
    expect(mod!.resolveRuleSetForApply(db, 'erp-tag-v2')).toBe('erp-tag-v2');
    expect(mod!.resolveRuleSetForApply(db, null)).toBe('erp-tag-v2');
    expect(mod!.resolveRuleSetForApply(db, undefined)).toBe('erp-tag-v2');
    expect(() => mod!.resolveRuleSetForApply(db, 'excel-v260922-compat')).toThrow();
    expect(() => mod!.resolveRuleSetForApply(db, 'garbage-version')).toThrow();
  });
});
