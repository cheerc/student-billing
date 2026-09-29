import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getDatabase } from '@/adapters/sqlite';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { POST as previewPOST } from '@/app/api/v1/imports/preview/route';
import { calculateSubjectCount, calculateBaseDiscountBps, parseTagDiscounts } from '@/domain/billing/discount-rules';
import { StudentSnapshot } from '@/domain/students';

/**
 * Reviewer B1（PR #32）：`computeRosterChanges` 曾只有定義與單元測試，產品沒有任何呼叫端，
 * 使用者在匯入預覽完全看不到異動。本檔從 **POST /api/v1/imports/preview** 這個產品入口驗證：
 * API 以現行名單（基準）與本次上傳名單整批計算 before/after，回傳真實的新增／異動／未出現數與逐人明細。
 *
 * 基準名單由本測試以 saveImportBatch 預先寫入（模擬「已有現行名單」），本次上傳為保形匿名 fixture。
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

describe('API: POST /api/v1/imports/preview 回傳以計算結果判定的名單異動（B1）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-api-preview-roster-'));
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

  it('尚無任何現行名單（首次上傳）→ rosterDiff.baseImportId 為 null，無異動明細', async () => {
    const res = await previewPOST(uploadRequest());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.rosterDiff.baseImportId).toBeNull();
    expect(data.rosterDiff.changes).toEqual([]);
  });

  it('有現行名單時整批比對：新增 1、異動 1、未出現 1，其餘未異動；異動帶折扣 before/after', async () => {
    const buf = fs.readFileSync(fixturePath);
    const fixture = await generateImportPreview(buf, 'sample.xlsx');
    const incomingStudents = fixture.students;

    // 挑一位「科數 1 或 2、沒有特殊折扣／兄弟姊妹標籤」的學生：加上兄弟姊妹標籤後基本折扣一定不同
    //（科數 k=1：10000→9500；k=2：9500→9000；k≥3 兩者皆 9000 → 不可用）。
    const target = incomingStudents.find((s) => {
      const k = calculateSubjectCount(s.enrollments);
      const tags = parseTagDiscounts(s.tagsRaw);
      return (k === 1 || k === 2) && !tags.sibling && tags.specialDiscount === null;
    });
    expect(target, 'fixture 內需有一位科數 1–2 的學生').toBeDefined();
    const k = calculateSubjectCount(target!.enrollments)!;
    // 獨立手算（R10）：基準名單版本帶兄弟姊妹標籤 → effective=k+1；本次上傳版本無標籤 → effective=k
    const expectedBefore = calculateBaseDiscountBps(k, true, null);
    const expectedAfter = calculateBaseDiscountBps(k, false, null);
    expect(expectedBefore).not.toBe(expectedAfter);

    // 另挑一位當「基準名單裡沒有的新增學生」
    const newcomer = incomingStudents.find((s) => s.personCode !== target!.personCode)!;

    const baseStudents: StudentSnapshot[] = incomingStudents
      .filter((s) => s.personCode !== newcomer.personCode)
      .map((s) =>
        s.personCode === target!.personCode
          ? { ...s, tagsRaw: `${s.tagsRaw ?? ''} 有兄弟姊妹折扣`.trim(), tags: [...(s.tags ?? []), '有兄弟姊妹折扣'] }
          : s
      );
    // 基準名單獨有的學生（本次上傳未出現）
    baseStudents.push({
      ...incomingStudents[0],
      personCode: 'BASE-ONLY-ZZ',
      name: '基準獨有',
      enrollments: [],
    });

    const db = getDatabase();
    saveImportBatch(
      db,
      {
        id: 'imp_base_existing',
        fileName: 'base.xlsx',
        fileHash: 'base-file-hash',
        contentHash: 'base-content-hash',
        sheetName: 'Sheet1',
        headerMap: {},
        parserVersion: '1.0.0',
        scopeNote: '',
        rowCount: baseStudents.length,
        status: 'ready',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      baseStudents
    );

    const res = await previewPOST(uploadRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    const diff = data.rosterDiff;

    expect(diff.baseImportId).toBe('imp_base_existing');
    expect(diff.newStudents).toBe(1);
    expect(diff.changedStudents).toBe(1);
    expect(diff.notAppearedStudents).toBe(1);
    expect(diff.unchangedStudents).toBe(incomingStudents.length - 2); // 本次名單扣掉「新增」與「異動」兩位

    const byCode = new Map((diff.changes as any[]).map((c) => [c.personCode, c]));
    expect(byCode.size).toBe(3);
    expect(byCode.get(newcomer.personCode).isNew).toBe(true);
    expect(byCode.get('BASE-ONLY-ZZ').isRemoved).toBe(true);
    expect(byCode.get(target!.personCode).discountChange).toMatchObject({
      beforeBps: expectedBefore,
      afterBps: expectedAfter,
    });
  });
});
