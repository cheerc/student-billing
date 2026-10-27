import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { POST as previewPOST } from '@/app/api/v1/imports/preview/route';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { activateBatch, getRequest, loadModule, makeStudent, saveRun, saveSettings, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';

/**
 * D1 班名比對報告的兩個入口（specs/11 §3 D1、04 §8 UX44–UX47；S manifest §8.2）：
 *   1. GET /api/v1/settings/class-name-report（完整報告的資料來源；範圍 latest／run 快照）；
 *   2. POST /api/v1/imports/preview 回應的 `classNameReport`（匯入預覽「使用這份名單」前的摘要：兩份清單的數量、
 *      影響人數、上一份名單來源、以及連到完整報告的路徑）。
 * read model 本身的手算案例在 d1-class-name-match-report.test.ts；這裡驗證入口的參數規則與回應形狀，
 * 以及匯入預覽摘要的數字與課表設定「班名對應」同源同判斷。
 */

const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

function uploadRequest(): Request {
  const blob = new Blob([fs.readFileSync(fixturePath)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const formData = new FormData();
  formData.append('file', blob, 'sample.xlsx');
  return new Request('http://127.0.0.1:3000/api/v1/imports/preview', { method: 'POST', body: formData });
}

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

const ROUTE = '@/app/api/v1/settings/class-name-report/route';
type RouteMod = { GET: (req: Request) => Promise<Response> };
const url = (query: string) => `http://127.0.0.1:3000/api/v1/settings/class-name-report${query}`;

describe('GET /api/v1/settings/class-name-report', () => {
  const ctx = useGlobalTempDb('sb-d1-cnr-api-');

  function scenario() {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_old', 'old.xlsx', '2026-09-01T08:00:00.000Z', [
      makeStudent('p1', ['國小數學-二A']),
      makeStudent('p2', ['國小數學-二A', '國小輔導-三年級']),
    ]);
    saveSyntheticBatch(db, 'imp_new', 'new.xlsx', '2026-09-10T08:00:00.000Z', [
      makeStudent('s1', ['國小數學-一A']),
      makeStudent('s2', ['國小數學-一']),
      makeStudent('s3', ['交通車']),
    ]);
    const seed = buildSeedDraft();
    const keep = new Set(['國小數學-一A', '國小數學-二A', '國小輔導-三年級']);
    const base = { ...seed, classes: seed.classes.filter((c) => keep.has(c.baseName)) };
    saveSettings(db, 'setv_old', 1, { ...base, aliases: [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }] });
    saveSettings(db, 'setv_new', 2, { ...base, aliases: [] });
    saveRun(db, 'run_old', 'imp_new', 'setv_old', '2026-09-11T00:00:00.000Z');
    saveRun(db, 'run_gone', 'imp_new', 'setv_missing', '2026-09-11T01:00:00.000Z');
    activateBatch(db, 'imp_old', 'k-act-old');
    return db;
  }

  it('路由存在並匯出 GET', async () => {
    const mod = await loadModule<RouteMod>(ROUTE);
    expect(mod, `${ROUTE} 需存在`).not.toBeNull();
    expect(typeof mod!.GET).toBe('function');
  });

  it('?importId：latest 範圍；上一份名單由 server 解析（本次不是現行名單 → 上一份＝現行名單 imp_old）；只回報告欄位、沒有任何「類別」', async () => {
    const mod = await loadModule<RouteMod>(ROUTE);
    expect(mod, `${ROUTE} 需存在`).not.toBeNull();
    scenario();
    const res = await mod!.GET(getRequest(url('?importId=imp_new')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ importId: 'imp_new', scope: { kind: 'latest' }, snapshotStatus: 'ok' });
    // 最新設定（setv_new，沒有別名）：一、交通車 為 米豆奶有／系統無；二A、三年級 為 系統有／本次名冊無
    expect(body.rosterOnly).toEqual([
      { baseName: '交通車', students: 1, tokens: 1 },
      { baseName: '國小數學-一', students: 1, tokens: 1 },
    ]);
    expect(body.rosterOnlyStudents).toBe(2);
    expect(body.systemOnly).toEqual([
      { baseName: '國小數學-二A', active: true, aliasCoveredBy: [] },
      { baseName: '國小輔導-三年級', active: true, aliasCoveredBy: [] },
    ]);
    expect([...collectKeys(body)].filter((k) => /categor|類別/i.test(k))).toEqual([]);
  });

  it('不帶參數：預設名冊＝現行名單（imp_old）、latest 範圍；現行名單是最早的一份 → 沒有上一份（previousRoster＝null）', async () => {
    const mod = await loadModule<RouteMod>(ROUTE);
    expect(mod, `${ROUTE} 需存在`).not.toBeNull();
    scenario();
    const res = await mod!.GET(getRequest(url('')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.importId).toBe('imp_old');
    expect(body.scope).toEqual({ kind: 'latest' });

  });

  it('?runId：名冊＝該 run 的名單、設定＝該 run 的快照（setv_old 有別名 → 「一」已對應）；快照缺失 → 200 且 snapshotStatus＝unavailable', async () => {
    const mod = await loadModule<RouteMod>(ROUTE);
    expect(mod, `${ROUTE} 需存在`).not.toBeNull();
    scenario();
    const ok = await (await mod!.GET(getRequest(url('?runId=run_old')))).json();
    expect(ok).toMatchObject({ importId: 'imp_new', scope: { kind: 'run', runId: 'run_old' }, snapshotStatus: 'ok' });
    expect(ok.rosterOnly).toEqual([{ baseName: '交通車', students: 1, tokens: 1 }]);
    expect(ok.aliasCoveredCount).toBe(1);

    const gone = await mod!.GET(getRequest(url('?runId=run_gone')));
    expect(gone.status).toBe(200);
    const goneBody = await gone.json();
    expect(goneBody).toMatchObject({ importId: 'imp_new', snapshotStatus: 'unavailable', rosterOnly: null, systemOnly: null });
  });

  it('參數錯誤：未知 runId → 404 RUN_NOT_FOUND；未知 importId → 404 IMPORT_NOT_FOUND；runId 與 importId 指向不同名單 → 400 INVALID_QUERY', async () => {
    const mod = await loadModule<RouteMod>(ROUTE);
    expect(mod, `${ROUTE} 需存在`).not.toBeNull();
    scenario();
    const noRun = await mod!.GET(getRequest(url('?runId=run_nope')));
    expect(noRun.status).toBe(404);
    expect((await noRun.json()).code).toBe('RUN_NOT_FOUND');
    const noImport = await mod!.GET(getRequest(url('?importId=imp_nope')));
    expect(noImport.status).toBe(404);
    expect((await noImport.json()).code).toBe('IMPORT_NOT_FOUND');
    const mismatch = await mod!.GET(getRequest(url('?runId=run_old&importId=imp_old')));
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).code).toBe('INVALID_QUERY');
    // 一致的 runId＋importId 可以
    const same = await mod!.GET(getRequest(url('?runId=run_old&importId=imp_new')));
    expect(same.status).toBe(200);
  });

  it('資料庫裡完全沒有名單 → 404 IMPORT_NOT_FOUND（不回空報告）', async () => {
    const mod = await loadModule<RouteMod>(ROUTE);
    expect(mod, `${ROUTE} 需存在`).not.toBeNull();
    ctx.db();
    const res = await mod!.GET(getRequest(url('')));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('IMPORT_NOT_FOUND');
  });
});

describe('POST /api/v1/imports/preview：classNameReport 摘要（使用這份名單之前）', () => {
  const ctx = useGlobalTempDb('sb-d1-preview-cnr-');

  it('首次上傳、無已存設定（seed）：兩份清單的數量與影響人數與 I19 錨點一致；沒有上一份名單 → 系統有／名冊無 的人數為 null；帶完整報告連結', async () => {
    ctx.db();
    const res = await previewPOST(uploadRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    // 錨點（I19 與 fixture 手動盤點）：ERP 班名 54＝已對應 42＋米豆奶有／系統無 12；seed 49 班中 7 個本批未出現；
    // 12 個待對應班涵蓋 191 位不重複學生（交通車 93 人；一個人可同時在多個待對應班）
    expect(body.pendingClasses).toHaveLength(12); // 特徵化：既有欄位不變
    expect(body.classNameReport).toEqual({
      importId: body.batchId,
      rosterOnlyClassCount: 12,
      rosterOnlyStudentCount: 191,
      systemOnlyClassCount: 7,
      reportPath: `/settings?tab=mapping&import=${body.batchId}`,
    });
    expect([...collectKeys(body.classNameReport)].filter((k) => /categor|類別/i.test(k))).toEqual([]);
  });

  it('有現行名單（上一份）時：系統有／名冊無 顯示上一份名單該班的去重人數（一A 2 人、四年級 2 人、一B 1 人；其中 q2 跨兩班 → 去重 4）並註明來源', async () => {
    const db = ctx.db();
    // 本次 fixture 沒有出現的 seed 班（I19：7 個）：一A、一B、四年級（另 4 個略）
    saveSyntheticBatch(db, 'imp_prev', 'prev.xlsx', '2026-09-01T08:00:00.000Z', [
      makeStudent('q1', ['國小數學-一A']),
      makeStudent('q2', ['國小數學-一A', '國小輔導-四年級']),
      makeStudent('q3', ['國小輔導-四年級']),
      makeStudent('q4', ['國小數學-一B']),
      makeStudent('q5', ['交通車']), // 本次名冊有的班，不在「系統有／名冊無」
    ]);
    activateBatch(db, 'imp_prev', 'k-act-prev');

    const body = await (await previewPOST(uploadRequest())).json();
    expect(body.classNameReport).toMatchObject({
      importId: body.batchId,
      rosterOnlyClassCount: 12,
      rosterOnlyStudentCount: 191,
      systemOnlyClassCount: 7,
    });
  });

  it('與課表設定同源同判斷：已存設定加了別名「一→一A」後，米豆奶有／系統無 少 1 班（12→11）；系統有／名冊無 仍為 7（別名不掩蓋「本次沒有直接報名」）', async () => {
    const db = ctx.db();
    const seed = buildSeedDraft();
    saveSettings(db, 'setv_a', 1, { ...seed, aliases: [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }] });
    const body = await (await previewPOST(uploadRequest())).json();
    // 手算：一（13 人）的學生同時也在其他待對應班（如交通車），所以不重複人數仍為 191
    expect(body.pendingClasses).toHaveLength(11);
    expect(body.classNameReport).toMatchObject({ rosterOnlyClassCount: 11, rosterOnlyStudentCount: 191, systemOnlyClassCount: 7 });
  });
});
