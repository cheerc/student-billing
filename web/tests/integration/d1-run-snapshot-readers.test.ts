import { describe, it, expect } from 'vitest';
import { GET as comparisonGET } from '@/app/api/v1/runs/[runId]/comparison/route';
import { GET as classesGET } from '@/app/api/v1/classes/route';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import type { SettingsDraft } from '@/contracts/settings';
import {
  activateBatch,
  activeState,
  fixturePreview,
  getRequest,
  makeStudent,
  saveFixtureBatch,
  saveRun,
  saveSettings,
  saveSyntheticBatch,
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

  it('已存設定的 run：差異清單以該 run 的設定快照（別名＋時段）重算——與 seed 重算不同，與規格獨立手算預期一致（F1 / F5）', async () => {
    // 依據 CLAUDE.md §8 與 operator 裁決（d-20260930131128030911-29），
    // 測試預期值必須依規格（02/D24/D30）獨立手算，絕對不可調用待測函式 calculateStudentBilling 動態產生 expected。
    //
    // 合成名冊情境（2 位學生）：
    //   1. 學生 S_3A（三年級，報名「國小數學-三A」）：
    //      - 快照課表將三A排在：週六 16:30–18:00（990–1080）與週一 16:30–18:00（990–1080）。
    //      - 課輔照顧窗口為平日 16:30–19:30（990–1170，每日 180 分鐘）。
    //      - 正式軌 v2（sameWeekdayOnly=true）：週六不計，僅週一重疊 90 分鐘 → 90/180 = 0.5 天。
    //        依 D24 取整扣 0.5 天，課輔天數 = 5.0 - 0.5 = 4.5 天。
    //      - 診斷軌 compat（sameWeekdayOnly=false）：純時刻比對，週六與週一各重疊 90 分鐘，合計 180 分鐘 → 扣 1.0 天。
    //        課輔天數 = 5.0 - 1.0 = 4.0 天。
    //      - 差異：tutoringDays 4.5（正式）vs 4.0（診斷），差異 0.5 天。
    //   2. 學生 S_NORM（一年級，報名「國小數學-一A」）：
    //      - 一A 時段為 seed 預設（週一、週三 16:30–18:00，均為平日）。
    //      - 兩軌重疊皆為 180 分鐘，扣 1.0 天，安親天數均為 4.0 天，無差異。
    //
    // 鑑別力（Discriminative check）：
    //   若 comparison route 錯誤地退回使用 seed 課表重算：
    //   seed 課表的三A 是週一與週三（均為平日），兩軌重疊皆 180 分鐘扣 1.0 天，差異為 0 筆！
    //   只有正確使用快照課表重算時，才會產生 S_3A 的 1 筆差異。

    const HAND_COMPUTED_EXPECTED_DIFFERENCES = [
      {
        personCode: 'S_3A',
        field: 'tutoringDays',
        formalValue: 4.5,
        compatValue: 4.0,
        category: 'CARE_DAYS_DIFFERENCE',
      },
    ];

    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_f5', 'f5.xlsx', '2026-09-01T08:00:00.000Z', [
      makeStudent('S_3A', ['國小數學-三A'], { grade: 3 }),
      makeStudent('S_NORM', ['國小數學-一A'], { grade: 1 }),
    ]);

    activateBatch(db, 'imp_f5', 'k-act-f5');
    const revision = activeState(db).revision;
    const preview = previewSettingsChange(db, undefined, { draft: saturdayDraft(), expectedRevision: revision });
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision: revision, idempotencyKey: 'k-apply-f5' });
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

    // 斷言比對獨立手算的 expected
    expect(body.totalDifferences).toBe(HAND_COMPUTED_EXPECTED_DIFFERENCES.length);
    expect(got).toEqual(HAND_COMPUTED_EXPECTED_DIFFERENCES);
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
