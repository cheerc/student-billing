import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { POST as previewPOST } from '@/app/api/v1/imports/preview/route';
import { POST as activatePOST } from '@/app/api/v1/imports/[previewId]/activate/route';
import { resolveActivationImportId } from '@/components/imports/imports-workflow';

/**
 * Reviewer N1（PR #32）：32417b4 把啟用改為用 `batchId`（實際保存的批次 id）而非 `previewId`，
 * 修正「重傳同檔判重時，前端用不存在的 previewId 呼叫 activate 而 500」。修正正確但零測試覆蓋。
 *
 * 兩條路徑都必須啟用**正確**的批次：
 *   1. 首次匯入（不觸發判重）：batchId === previewId，啟用該批
 *   2. 重傳同檔（觸發判重）：batchId 是**既有**批次、與本次 previewId 不同，啟用必須指向既有批次
 */

const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

function uploadRequest(): Request {
  const blob = new Blob([fs.readFileSync(fixturePath)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const formData = new FormData();
  formData.append('file', blob, 'sample.xlsx');
  return new Request('http://127.0.0.1:3000/api/v1/imports/preview', { method: 'POST', body: formData });
}

function activateRequest(importId: string, idempotencyKey: string): [NextRequest, { params: Promise<{ previewId: string }> }] {
  const req = new NextRequest(`http://127.0.0.1:3000/api/v1/imports/${importId}/activate`, {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    body: JSON.stringify({ expectedRevision: 0, idempotencyKey }),
  });
  return [req, { params: Promise.resolve({ previewId: importId }) }];
}

describe('匯入啟用以 batchId 指向實際保存的批次（N1 回歸）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-api-batch-id-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }
  });

  afterEach(() => {
    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('路徑 1：首次匯入（未判重）→ batchId 與 previewId 相同，以 batchId 啟用成功並成為現行名單', async () => {
    const preview = await (await previewPOST(uploadRequest())).json();

    expect(preview.isDuplicate).toBe(false);
    expect(preview.batchId).toBe(preview.previewId);
    expect(resolveActivationImportId(preview)).toBe(preview.batchId);

    const [req, ctx] = activateRequest(resolveActivationImportId(preview), 'key-first-import');
    const res = await activatePOST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeImportId).toBe(preview.batchId);

    const active = getDatabase().prepare('SELECT active_import_id FROM active_state WHERE id = 1').get() as any;
    expect(active.active_import_id).toBe(preview.batchId);
  });

  it('路徑 2：重傳同檔（判重）→ batchId 是既有批次、與本次 previewId 不同；以 batchId 啟用成功且指向既有批次', async () => {
    const first = await (await previewPOST(uploadRequest())).json();
    const second = await (await previewPOST(uploadRequest())).json();

    expect(second.isDuplicate).toBe(true);
    expect(second.duplicateReason).toBe('same_file');
    expect(second.previewId).not.toBe(first.previewId);
    expect(second.batchId).toBe(first.batchId); // 判重回傳既有批次
    expect(second.batchId).not.toBe(second.previewId);
    expect(resolveActivationImportId(second)).toBe(first.batchId);

    // 修正前的行為：以「本次 previewId」啟用 → 該批次從未寫入 DB，啟用失敗（這正是 500 的成因）
    const [badReq, badCtx] = activateRequest(second.previewId, 'key-bad-preview-id');
    const badRes = await activatePOST(badReq, badCtx);
    expect(badRes.status).not.toBe(200);

    const [req, ctx] = activateRequest(resolveActivationImportId(second), 'key-dup-batch-id');
    const res = await activatePOST(req, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).activeImportId).toBe(first.batchId);
  });

  it('resolveActivationImportId：有 batchId 用 batchId；舊回應無 batchId 時退回 previewId', () => {
    expect(resolveActivationImportId({ previewId: 'p1', batchId: 'b1' })).toBe('b1');
    expect(resolveActivationImportId({ previewId: 'p1' })).toBe('p1');
  });
});
