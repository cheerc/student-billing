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
 * Round3 PR-1（-166）真入口驗證：POST /api/v1/imports/preview 的 rosterDiff.changes
 * 帶上新的逐班資料（enrollmentChanges／classDiscountChanges），且報名集合有變就算異動。
 *
 * 產品入口：保形匿名 fixture（conforming-erp-fixture.xlsx，OOXML 原形依 CLAUDE.md:75）
 * → generateImportPreview → preview route → computeImportRosterChanges。
 * 基準名單以 saveImportBatch 預先寫入（模擬「已有現行名單」），並改造其報名／標籤以製造指定情境。
 *
 * expected 獨立手算（R09 科數＝類別存在性；R10 effectiveCount＝科數＋兄弟姊妹；R13 園內生 max(9000, basic−500)），
 * 不使用 calculateStudentBilling 的輸出回填。
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

type PreviewChange = {
  personCode: string;
  isNew: boolean;
  isRemoved: boolean;
  enrollmentChanges: Array<{ baseName: string; presence: string }>;
  classDiscountChanges: Array<{ baseName: string; sideOf: string; beforeBps: number | null; afterBps: number | null }>;
};

describe('API: preview 的 rosterDiff.changes 帶 PR-1 逐班資料（報名集合／逐班折扣）', () => {
  let tempDir: string;
  let incomingStudents: StudentSnapshot[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-preview-class-structure-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'test.sqlite');
    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }
    incomingStudents = (await generateImportPreview(fs.readFileSync(fixturePath), 'sample.xlsx')).students;
  });

  afterEach(() => {
    if (global.__sqlite_db__) {
      global.__sqlite_db__.close();
      global.__sqlite_db__ = undefined;
    }
    delete process.env.DATABASE_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const saveBase = (id: string, students: StudentSnapshot[]) => {
    saveImportBatch(
      getDatabase(),
      {
        id,
        fileName: `${id}.xlsx`,
        fileHash: `${id}-file`,
        contentHash: `${id}-content`,
        sheetName: 'Sheet1',
        headerMap: {},
        parserVersion: '1.0.0',
        scopeNote: '',
        rowCount: students.length,
        status: 'ready',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      students
    );
  };

  /**
   * RC04（spike §B1）：before 只有「國小輔導-寫功課」（不列入折扣 → 科數 0、basic 10000），
   * after 加報「國小數學-三A」（科數 1、basic 仍 10000）。折扣與天數皆未變，
   * 現行判定為「未異動」；PR-1 依 -75 必須出現在 changes，且報名集合列出 added。
   */
  it('RC04：只有寫功課 → 加報數學，即使折扣未變也出現在 changes 並列出報名集合', async () => {
    const target = incomingStudents.find((s) => s.personCode.endsWith('001'))!;
    expect(target).toBeDefined();

    const homeworkOnly: StudentSnapshot['enrollments'][number] = {
      rawToken: '115國小輔導-寫功課[團][五年級]',
      yearPrefix: '115',
      baseName: '國小輔導-寫功課',
      groupFlag: '團',
      modifiers: ['五年級'],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    };
    // 基準名單：目標學生只有「寫功課」一科（其餘學生原樣）
    const withoutTarget: StudentSnapshot[] = incomingStudents
      .filter((s) => s.personCode !== target.personCode)
      .map((s) => s);
    withoutTarget.push({ ...target, enrollments: [homeworkOnly] });

    // 獨立手算：基準（寫功課）科數 0、basic 10000；本次上傳（含數學＋可能的寫功課）科數 ≥1、basic 仍 10000（1–2 科）
    const baseOnlyHomework = calculateSubjectCount([
      { rawToken: 'x', baseName: '國小輔導-寫功課' },
    ] as never);
    expect(baseOnlyHomework).toBe(0);
    expect(calculateBaseDiscountBps(baseOnlyHomework, false, null)).toBe(10000);

    saveBase('imp_rc04', withoutTarget);

    const res = await previewPOST(uploadRequest());
    expect(res.status).toBe(200);
    const diff = (await res.json()).rosterDiff as { changes: PreviewChange[]; changedStudents: number };
    const change = diff.changes.find((c) => c.personCode === target.personCode);

    expect(change, '報名集合變了必須出現在 changes（-75）').toBeDefined();
    expect(change!.isNew).toBe(false);
    expect(change!.isRemoved).toBe(false);
    const added = change!.enrollmentChanges.filter((e) => e.presence === 'added').map((e) => e.baseName);
    expect(added.length, '基準只有寫功課，本次至少多出數學班').toBeGreaterThanOrEqual(1);
    // 折扣未變 → 不應有逐班折扣變動項
    expect(change!.classDiscountChanges.every((c) => c.beforeBps === c.afterBps)).toBe(true);
  });

  /**
   * 同類換班（spike §B3 CB）：數學三A → 三B，兩側折扣相同（科數不變）。
   * PR-1 必須把它當成報名異動（switched），而不是完全看不見。
   */
  it('同類換班出現在 changes，報名集合以 switched 表達（即使折扣未變）', async () => {
    // 找一位實際有「國小數學」報名的學生（要能把該班換成同類的另一班）
    const target = incomingStudents.find(
      (s) => s.enrollments.some((e) => e.baseName.includes('國小數學')) && !parseTagDiscounts(s.tagsRaw).sibling
    )!;
    expect(target).toBeDefined();

    const swapFrom = target.enrollments.find((e) => e.baseName.includes('國小數學'))!;
    const swapTo = { ...swapFrom, rawToken: swapFrom.rawToken.replace(swapFrom.baseName, `${swapFrom.baseName}B`), baseName: `${swapFrom.baseName}B` };

    const baseStudents = incomingStudents.map((s) =>
      s.personCode === target.personCode ? { ...s, enrollments: [swapFrom] } : s
    );
    // 獨立手算：換班不動類別 → 科數相同 → basic 相同（兩側同一值）
    expect(calculateSubjectCount([swapFrom])).toBe(calculateSubjectCount([swapTo]));
    expect(calculateBaseDiscountBps(calculateSubjectCount([swapFrom])!, false, null)).toBe(
      calculateBaseDiscountBps(calculateSubjectCount([swapTo])!, false, null)
    );

    saveBase('imp_swap', baseStudents);

    const res = await previewPOST(uploadRequest());
    expect(res.status).toBe(200);
    const diff = (await res.json()).rosterDiff as { changes: PreviewChange[] };
    const change = diff.changes.find((c) => c.personCode === target.personCode);

    expect(change, '同類換班必須出現在 changes（-75）').toBeDefined();
    const presences = change!.enrollmentChanges.filter((e) => e.presence !== 'kept').map((e) => e.presence);
    expect(presences.length, '報名集合必須有增減').toBeGreaterThanOrEqual(2);
  });

  /** 預覽回應的每筆 change 都帶兩個新欄位（畫面未改，純 additive 資料）。 */
  it('每筆 change 都帶 enrollmentChanges 與 classDiscountChanges（新增／未出現亦然）', async () => {
    const newcomer = incomingStudents[incomingStudents.length - 1];
    const baseStudents = incomingStudents.slice(0, -1);
    saveBase('imp_shape', baseStudents);

    const res = await previewPOST(uploadRequest());
    expect(res.status).toBe(200);
    const diff = (await res.json()).rosterDiff as { changes: PreviewChange[] };

    expect(diff.changes.length).toBeGreaterThan(0);
    for (const change of diff.changes) {
      expect(Array.isArray(change.enrollmentChanges)).toBe(true);
      expect(Array.isArray(change.classDiscountChanges)).toBe(true);
    }
  });
});
