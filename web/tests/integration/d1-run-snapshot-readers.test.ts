import { describe, it, expect } from 'vitest';
import { GET as comparisonGET } from '@/app/api/v1/runs/[runId]/comparison/route';
import { GET as classesGET } from '@/app/api/v1/classes/route';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { buildSeedDraft, draftToAliasMap, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import type { SettingsDraft } from '@/contracts/settings';
import {
  activateBatch,
  activeState,
  fixturePreview,
  getRequest,
  saveFixtureBatch,
  saveRun,
  saveSettings,
  useGlobalTempDb,
} from '../helpers/d1-test-kit';

/**
 * D1 F-5／F-6（specs/11 §3 D1、04 §8 UX38、UX39；S manifest §1.3 #18–#19、§A F-5／F-6）：
 * 讀取歷史 run 的入口一律讀「該 run 當時的設定快照」，不用最新設定、也不退回 seed 猜。
 *  - F-5 comparison：以 run.scheduleVersionId 的快照（alias＋scheduleOverride）重算；快照缺失 → 409 SNAPSHOT_UNAVAILABLE
 *    （比照 schedule-deductions 的既有契約，不改用最新設定補算）。
 *  - F-6 classes：帶 runId 時讀該 run 的快照；快照缺失 → 回「無法判定」（不猜）。不帶 runId 維持讀最新設定。
 */

const comparisonUrl = (runId: string) => `http://127.0.0.1:3000/api/v1/runs/${runId}/comparison?againstRuleSet=excel-v260922-compat`;
const callComparison = (runId: string) => comparisonGET(getRequest(comparisonUrl(runId)), { params: Promise.resolve({ runId }) });

describe('F-5：comparison 以 run 的設定快照重算', () => {
  const ctx = useGlobalTempDb('sb-d1-cmp-');

  /** 三A 改成 週六 16:30–18:00＋週一 16:30–18:00（990–1080）。 */
  function saturdayDraft(): SettingsDraft {
    const seed = buildSeedDraft();
    return {
      ...seed,
      classes: seed.classes.map((c) =>
        c.baseName === '國小數學-三A'
          ? {
              ...c,
              sessions: [
                { weekday: '六', startMinutes: 990, endMinutes: 1080 },
                { weekday: '一', startMinutes: 990, endMinutes: 1080 },
              ],
            }
          : c
      ),
    };
  }

  it('已存設定的 run：差異清單以該 run 的設定快照（別名＋時段）重算——與 seed 重算不同，與快照重算逐筆相同', async () => {
    // 快照＝三A 改成 週六＋週一 16:30–18:00（990–1080）：
    //   手算（課輔窗口 990–1170；正式軌 v2 只比對同星期，診斷軌純時刻不看星期）：
    //     正式軌只算週一 → 重疊 90 → 扣 0.5；診斷軌 週六＋週一 → 重疊 180 → 扣 1。
    //   所以 三A 學生（未被 5 天下限壓平者）的課輔天數：正式軌比診斷軌多 0.5。
    //   seed 課表的三A＝週一 16:30–18:00＋週三 18:00–19:30（兩軌同為 180 分），三A 學生本身沒有這個差異——
    //   D1 前 comparison 用 seed 重算，看不到這批差異。
    // 期望清單由 domain 函式在「快照情境」與「seed 情境」各自獨立算出（不經 route）：
    const students = (await fixturePreview()).students;
    const snapshotCtx = { aliasMap: draftToAliasMap(saturdayDraft()), scheduleOverride: draftToScheduleOverride(saturdayDraft()) };
    const diffsOf = (ctxOpts: Record<string, unknown>) => {
      const out: Array<{ personCode: string; field: string; formalValue: number | null; compatValue: number | null; category: string }> = [];
      for (const s of students) {
        const f = calculateStudentBilling(s, { ruleSetVersion: 'erp-tag-v2', ...ctxOpts });
        const c = calculateStudentBilling(s, { ruleSetVersion: 'excel-v260922-compat', ...ctxOpts });
        if (f.baseDiscountBps !== c.baseDiscountBps)
          out.push({ personCode: s.personCode, field: 'baseDiscountBps', formalValue: f.baseDiscountBps, compatValue: c.baseDiscountBps, category: 'DISCOUNT_DIFFERENCE' });
        if (f.careDays.anqin.days !== c.careDays.anqin.days)
          out.push({ personCode: s.personCode, field: 'anqinDays', formalValue: f.careDays.anqin.days, compatValue: c.careDays.anqin.days, category: 'CARE_DAYS_DIFFERENCE' });
        if (f.careDays.tutoring.days !== c.careDays.tutoring.days)
          out.push({ personCode: s.personCode, field: 'tutoringDays', formalValue: f.careDays.tutoring.days, compatValue: c.careDays.tutoring.days, category: 'CARE_DAYS_DIFFERENCE' });
      }
      return out;
    };
    const expectedFromSnapshot = diffsOf(snapshotCtx);
    const expectedFromSeed = diffsOf({});
    // 前提（鑑別力）：兩個情境的差異清單不同，且快照情境有三A 學生的 0.5 天差異（手算見上）
    expect(expectedFromSnapshot).not.toEqual(expectedFromSeed);
    const enrolled3A = new Set(
      students.filter((s) => s.enrollments.some((e) => e.baseName === '國小數學-三A')).map((s) => s.personCode)
    );
    const extra = expectedFromSnapshot.filter(
      (d) => d.field === 'tutoringDays' && enrolled3A.has(d.personCode) && d.formalValue! - d.compatValue! === 0.5
    );
    expect(extra.length, '快照情境應有三A 學生的課輔天數 0.5 差異').toBeGreaterThan(0);
    expect(expectedFromSeed.filter((d) => extra.some((e) => e.personCode === d.personCode && e.field === d.field)).length).toBe(0);

    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    activateBatch(db, 'imp_a', 'k-act');
    const revision = activeState(db).revision;
    const preview = previewSettingsChange(db, undefined, { draft: saturdayDraft(), expectedRevision: revision });
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: 'k-apply' });
    const runId = applied.runId as string;

    const res = await callComparison(runId);
    expect(res.status).toBe(200);
    const body = await res.json();
    const got = (body.differences as Array<any>).map((d) => ({
      personCode: d.personCode,
      field: d.field,
      formalValue: d.formalValue,
      compatValue: d.compatValue,
      category: d.category,
    }));
    expect(body.totalDifferences).toBe(expectedFromSnapshot.length);
    expect(got).toEqual(expectedFromSnapshot);
  });

  it('快照缺失（run.scheduleVersionId 指向不存在的設定版本）→ 409 SNAPSHOT_UNAVAILABLE，不改用最新設定或 seed 補算', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    saveRun(db, 'run_gone', 'imp_a', 'setv_missing', '2026-09-02T00:00:00.000Z');
    const res = await callComparison('run_gone');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SNAPSHOT_UNAVAILABLE');
  });

  it('特徵化：seed 課表的 run 維持與 seed 直接計算相同（正式軌 vs 診斷軌的差異清單逐筆相同）', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    const run = activateBatch(db, 'imp_a', 'k-act');
    const res = await callComparison(run.runId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.diagnosticAlgorithmVersion).toBe('v1');

    // 獨立重算（不經 route）：seed 路徑＝不帶 alias／override
    const students = (await fixturePreview()).students;
    let expected = 0;
    for (const s of students) {
      const f = calculateStudentBilling(s, { ruleSetVersion: 'erp-tag-v2' });
      const c = calculateStudentBilling(s, { ruleSetVersion: 'excel-v260922-compat' });
      if (f.baseDiscountBps !== c.baseDiscountBps) expected++;
      if (f.careDays.anqin.days !== c.careDays.anqin.days) expected++;
      if (f.careDays.tutoring.days !== c.careDays.tutoring.days) expected++;
    }
    expect(body.totalDifferences).toBe(expected);
  });

  it('特徵化：缺 againstRuleSet 或值不是診斷軌 → 400；找不到 run → 404', async () => {
    ctx.db();
    const noParam = await comparisonGET(getRequest('http://127.0.0.1:3000/api/v1/runs/x/comparison'), { params: Promise.resolve({ runId: 'x' }) });
    expect(noParam.status).toBe(400);
    const wrong = await comparisonGET(getRequest('http://127.0.0.1:3000/api/v1/runs/x/comparison?againstRuleSet=erp-tag-v1'), {
      params: Promise.resolve({ runId: 'x' }),
    });
    expect(wrong.status).toBe(400);
    const missing = await callComparison('run_nope');
    expect(missing.status).toBe(404);
  });
});

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
