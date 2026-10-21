import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { POST as activatePOST } from '@/app/api/v1/imports/[previewId]/activate/route';
import { activateImport } from '@/application/activate-import';
import {
  ORIGIN,
  activeState,
  activateBatch,
  ruleSetOfRun,
  saveFixtureBatch,
  setRunRuleSet,
  useGlobalTempDb,
} from '../helpers/d1-test-kit';

/**
 * D1 F-1／F-2（specs/11 §3 D1、04 §8 UX36；S manifest §1.3 #11–#12、§A F-1／F-2）：
 * activate 的規則版本由 server 決定。
 *  - F-1：route 不再接受 client 的 `ruleSetVersion`（與 calculate 的「client 不得指定」一致），收到就 400；
 *    冪等 hash 不再含 client 值；application 層也不留後門。
 *  - F-2：沿用 active 版本（有 active run 且為正式軌），否則用目標版本 erp-tag-v4（#112 起）；
 *    active 為診斷軌 compat 時同樣採目標版本。
 *  - D2b（Q11）：目標版本由 erp-tag-v2 改為目標版本（D2b 時為 v3，#112 起為 erp-tag-v4）；既有 v2 active run 仍沿用 v2（不靜默切換）。
 * 舊契約（activate 指定 v1 就建 v1 run）已由 operator 核准改變，見 d-20260930112930661160-25。
 */

const activateReq = (previewId: string, body: unknown) =>
  new NextRequest(`http://127.0.0.1:3000/api/v1/imports/${previewId}/activate`, {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify(body),
  });

describe('F-1：activate 不再接受 client 的 ruleSetVersion', () => {
  const ctx = useGlobalTempDb('sb-d1-act-f1-');

  it('route：body 帶 ruleSetVersion（任何值，含 v2、v1、compat、未知字串、null）一律 400 INVALID_REQUEST，且不建 run、不動 active', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    for (const v of ['erp-tag-v2', 'erp-tag-v1', 'excel-v260922-compat', 'garbage-version', null]) {
      const res = await activatePOST(
        activateReq('imp_a', { expectedRevision: 0, idempotencyKey: `k-${String(v)}`, ruleSetVersion: v }),
        { params: Promise.resolve({ previewId: 'imp_a' }) }
      );
      expect(res.status, String(v)).toBe(400);
      expect((await res.json()).code, String(v)).toBe('INVALID_REQUEST');
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get() as { n: number }).n).toBe(0);
    expect(activeState(db)).toMatchObject({ active_import_id: null, active_run_id: null, revision: 0 });
  });

  it('route：不帶 ruleSetVersion 的既有呼叫方式不受影響（200；空 DB 建 run＝目標版本 erp-tag-v4，Q11）', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    const res = await activatePOST(activateReq('imp_a', { expectedRevision: 0, idempotencyKey: 'k-plain' }), {
      params: Promise.resolve({ previewId: 'imp_a' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // D2b（Q11）：空 DB 直接預設 v3；既有 v2 DB 仍沿用其 active 版本（見下一組測試）
    expect(ruleSetOfRun(db, body.runId)).toBe('erp-tag-v4');
  });

  it('application 層沒有後門：activateImport 收到 ruleSetVersion 選項一樣拒絕（ActivateError 400 INVALID_REQUEST），不建 run', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    let caught: any;
    try {
      activateImport(db, {
        importId: 'imp_a',
        expectedRevision: 0,
        idempotencyKey: 'k-app',
        ruleSetVersion: 'erp-tag-v1',
      } as never);
    } catch (e) {
      caught = e;
    }
    expect(caught, '應拋出 ActivateError').toBeDefined();
    expect(caught.name).toBe('ActivateError');
    expect(caught.statusCode).toBe(400);
    expect(caught.code).toBe('INVALID_REQUEST');
    expect((db.prepare('SELECT COUNT(*) AS n FROM calculation_runs').get() as { n: number }).n).toBe(0);
  });

  it('冪等 hash 不再含版本：新紀錄的 request_body_hash＝sha256({importId,expectedRevision,asOfDate})', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    activateImport(db, { importId: 'imp_a', expectedRevision: 0, idempotencyKey: 'k-hash' });
    const row = db.prepare('SELECT request_body_hash FROM idempotency_records WHERE idempotency_key = ?').get('k-hash') as {
      request_body_hash: string;
    };
    const expected = crypto
      .createHash('sha256')
      .update(JSON.stringify({ importId: 'imp_a', expectedRevision: 0, asOfDate: '' }))
      .digest('hex');
    expect(row.request_body_hash).toBe(expected);
  });

  it('特徵化：D1 之前寫入的冪等紀錄（hash 含 ruleSetVersion:erp-tag-v2）同 key 同內容重送仍回原結果；同 key 不同內容仍拒絕', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    const legacyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ importId: 'imp_a', expectedRevision: 0, asOfDate: '', ruleSetVersion: 'erp-tag-v2' }))
      .digest('hex');
    const payload = { runId: 'run_legacy', revision: 1, activeImportId: 'imp_a', activeRunId: 'run_legacy', status: 'completed', issueCounts: {}, totalStudents: 477 };
    db.prepare(
      `INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('k-legacy', legacyHash, 'run_legacy', JSON.stringify(payload), '2026-09-01T00:00:00.000Z');

    const replay = activateImport(db, { importId: 'imp_a', expectedRevision: 0, idempotencyKey: 'k-legacy' });
    expect(replay).toEqual(payload);

    expect(() =>
      activateImport(db, { importId: 'imp_a', expectedRevision: 0, idempotencyKey: 'k-legacy', asOfDate: '2026-01-01' })
    ).toThrowError(/不同的請求內容/);
  });
});

describe('F-2：activate 的規則版本由 server 決定（沿用 active 版本）', () => {
  const ctx = useGlobalTempDb('sb-d1-act-f2-');
  // 第二次啟用同一份名單（另一個 idempotency key、revision 已遞增）：
  // 同內容的名單只會存成一批（saveImportBatch 判重），所以「再次啟用」就是用同一個 importId。

  it('沒有 active run → 目標版本 erp-tag-v4（Q11：空 DB 直接預設新規則）', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    const r = activateBatch(db, 'imp_a', 'k1');
    expect(ruleSetOfRun(db, r.runId)).toBe('erp-tag-v4');
  });

  it('active run 為 erp-tag-v1 → 新啟用的 run 沿用 erp-tag-v1（D1 前會靜默變成 v2）', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    const first = activateBatch(db, 'imp_a', 'k1');
    setRunRuleSet(db, first.runId, 'erp-tag-v1');

    const second = activateBatch(db, 'imp_a', 'k2');
    expect(ruleSetOfRun(db, second.runId)).toBe('erp-tag-v1');
    // 舊 run 不變
    expect(ruleSetOfRun(db, first.runId)).toBe('erp-tag-v1');
  });

  it('active run 為 erp-tag-v2 → 沿用 v2（既有 v2 DB 不因 Q11 目標版本改為 v3 而被靜默升級）', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    const first = activateBatch(db, 'imp_a', 'k1');
    // 既有 v2 DB 的狀態：active run 為 v2
    setRunRuleSet(db, first.runId, 'erp-tag-v2');
    const second = activateBatch(db, 'imp_a', 'k2');
    expect(ruleSetOfRun(db, second.runId)).toBe('erp-tag-v2');
  });

  it('active run 為診斷軌 compat → 改採目標版本 erp-tag-v4（診斷軌不作正式值；Q11 空 DB 預設）', async () => {
    const db = ctx.db();
    await saveFixtureBatch(db, 'imp_a');
    const first = activateBatch(db, 'imp_a', 'k1');
    setRunRuleSet(db, first.runId, 'excel-v260922-compat');
    const second = activateBatch(db, 'imp_a', 'k2');
    expect(ruleSetOfRun(db, second.runId)).toBe('erp-tag-v4');
  });
});
