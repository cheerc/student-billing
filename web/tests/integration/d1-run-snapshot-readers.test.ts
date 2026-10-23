import { describe, it, expect } from 'vitest';
import { GET as classesGET } from '@/app/api/v1/classes/route';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import type { SettingsDraft } from '@/contracts/settings';
import { activeState, getRequest, saveFixtureBatch, saveRun, saveSettings, useGlobalTempDb } from '../helpers/d1-test-kit';

/** F-6 classes：帶 runId 時讀該 run 的類別快照；不帶 runId 維持讀最新設定。 */

describe('F-6：classes 路由帶 runId 時讀該 run 的快照', () => {
  const ctx = useGlobalTempDb('sb-d1-classes-');

  const callClasses = (query: string) => classesGET(getRequest(`http://127.0.0.1:3000/api/v1/classes${query}`));

  async function twoGenerations() {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    const seed = buildSeedDraft();
    // 舊快照 S1：一→一A 別名；三A 啟用
    saveSettings(db, 'setv_old', 1, { ...seed, aliases: [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }] });
    // 最新設定 S2：沒有別名；三A 停用
    saveSettings(db, 'setv_new', 2, {
      ...seed,
      aliases: [],
      classes: seed.classes.map((c) => (c.baseName === '國小數學-三A' ? { ...c, active: false } : c)),
    });
    saveRun(db, 'run_old', 'imp_a', 'setv_old', '2026-09-01T12:30:00.000Z');
    saveRun(db, 'run_new', 'imp_a', 'setv_new', '2026-09-02T12:30:00.000Z');
    return db;
  }

  const item = (body: any, baseName: string) => (body.items as Array<any>).find((i) => i.baseName === baseName);

  it('指定歷史 run：狀態依該 run 當時的快照（一→一A 有別名、三A 啟用），不是最新設定', async () => {
    await twoGenerations();
    const res = await callClasses('?runId=run_old');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshotStatus).toBe('ok');
    expect(item(body, '國小數學-一')).toMatchObject({ mappingStatus: 'aliased', targetBaseName: '國小數學-一A', isConfigured: true });
    expect(item(body, '國小數學-三A')).toMatchObject({ mappingStatus: 'mapped', isConfigured: true, isActive: true });
  });

  it('指定較新的 run：狀態依最新那份快照（沒有別名、三A 停用）', async () => {
    await twoGenerations();
    const body = await (await callClasses('?runId=run_new')).json();
    expect(body.snapshotStatus).toBe('ok');
    expect(item(body, '國小數學-一')).toMatchObject({ mappingStatus: 'unmapped', isConfigured: false });
    expect(item(body, '國小數學-三A')).toMatchObject({ isActive: false });
  });

  it('快照缺失 → 回「無法判定」：snapshotStatus＝unavailable，各班 mappingStatus＝undetermined，不猜 mapped／unmapped', async () => {
    const db = await twoGenerations();
    saveRun(db, 'run_gone', 'imp_a', 'setv_missing', '2026-09-03T12:30:00.000Z');
    const res = await callClasses('?runId=run_gone');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshotStatus).toBe('unavailable');
    expect(body.totalClasses).toBeGreaterThan(0);
    for (const i of body.items as Array<any>) {
      expect(i.mappingStatus, i.baseName).toBe('undetermined');
      expect(i.targetBaseName, i.baseName).toBeNull();
      expect(i.isConfigured, i.baseName).toBeNull();
      expect(i.isActive, i.baseName).toBeNull();
      expect(typeof i.studentCount).toBe('number');
    }
  });

  it('v4 semantic snapshot 缺失時，classes API 不以 run 的設定快照回填當年 subject', async () => {
    const db = await twoGenerations();
    saveRun(db, 'run_missing_semantics', 'imp_a', 'setv_old', '2026-09-03T12:30:00.000Z', 'erp-tag-v4', [], []);
    db.prepare('DELETE FROM run_class_semantics WHERE run_id = ?').run('run_missing_semantics');
    db.prepare('DELETE FROM run_semantics_snapshots WHERE run_id = ?').run('run_missing_semantics');

    const body = await (await callClasses('?runId=run_missing_semantics')).json();
    expect(item(body, '國小數學-一').subject).toBe('未設定');
  });

  it('特徵化：不帶 runId（現行 run）維持讀最新已存設定；回應仍有 baseName／studentCount／mappingStatus／isConfigured', async () => {
    const db = await twoGenerations();
    db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ? WHERE id = 1').run('run_old', 'imp_a');
    const body = await (await callClasses('')).json();
    expect(body.runId).toBe('run_old');
    // 最新設定 S2：沒有別名 → 一 為 unmapped（即使 run_old 的快照有別名）
    expect(item(body, '國小數學-一')).toMatchObject({ mappingStatus: 'unmapped' });
    expect(item(body, '國小數學-三A')).toMatchObject({ isActive: false });
  });
});
