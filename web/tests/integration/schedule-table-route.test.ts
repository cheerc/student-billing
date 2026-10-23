/**
 * PR #85 G1 覆蓋缺口：直接打 `POST /api/v1/settings/schedule-table` route handler 的防護分支整合測試。
 *
 * 範圍邊界（PR #85 reviewer2 的 G1 non-blocking finding，receipt `review-receipt:m-20261004141935338628-38`）：
 * 該 PR 新增的 route 沒有直接打 handler 的 integration 測試，Excel parser 只有 unit 與 E2E 覆蓋。
 * 本檔補的正是 route 層的分支覆蓋——不是重測 parser，也不是拿 helper 的單元測試代替打 route。
 *
 * expected 全部**依規格獨立手寫**，不用被測 route 的輸出回填（CLAUDE.md §8 禁止反向產生 expected）：
 *  - 分支與狀態碼＝`web/src/app/api/v1/settings/schedule-table/route.ts` 的 guard 順序（specs/09 §3.1）；
 *  - 同源政策＝`web/src/contracts/security.ts` 的 `validateSameOrigin` 與 D45（specs/06 D45，decision
 *    `d-20261002163234657929-70`）：無 Origin／無 Referer 且 `sec-fetch-site` 非 `cross-site` 時**維持放行**，
 *    這是現行契約、必須鎖住，不得照「一律 403」的舊建議寫測試；
 *  - 上限＝`MAX_SCHEDULE_TABLE_BYTES` = 1 MiB（route 頂部常數）。
 *
 * 建構 NextRequest 的寫法比照既有 integration 測試（`settings-read-model-api.test.ts` 的 `ORIGIN` 常數
 * ＋ `new NextRequest(url, { method: 'POST', headers, body })`），不另起一套 helper。
 */

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { NextRequest } from 'next/server';
import { POST as scheduleTablePOST } from '@/app/api/v1/settings/schedule-table/route';
import { MAX_SCHEDULE_TABLE_BYTES } from '@/app/api/v1/settings/schedule-table/route';
import { SCHEDULE_TABLE_HEADERS } from '@/adapters/xlsx/schedule-table-io';
import type { ScheduleGridRow } from '@/contracts/settings';

/** 同源寫入的標準 header（比照 `settings-read-model-api.test.ts` 的 ORIGIN）。 */
const ORIGIN = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
const ROUTE_URL = 'http://127.0.0.1:3000/api/v1/settings/schedule-table';

/**
 * 手算的完整課表（2 班、3 列；含一列「只有班名」的佔位列＝#82 的形狀，缺時間不是錯誤）。
 *
 * 三列的期望值依 09 §3.1「缺時間的佔位列」與 `schedule-table-io` 的七欄契約**逐欄手算**：
 *  - 列 1、2 同班「兒童美語-Gino」：星期一／五、15:20–16:50 → 分鐘數 15*60+20=920、16*60+50=1010；
 *  - 列 3「國小數學-一A」：老師、星期、起迄全空（`null`／`''`）→ 分鐘數皆 `null`。
 */
const FIXTURE_ROWS: ScheduleGridRow[] = [
  {
    rowId: 'row-1',
    className: '兒童美語-Gino',
    teacher: 'Cathy',
    weekday: '一',
    startTime: '15:20',
    endTime: '16:50',
    startMinutes: 920,
    endMinutes: 1010,
    active: true,
    skipDeduction: false,
  },
  {
    rowId: 'row-2',
    className: '兒童美語-Gino',
    teacher: 'Cathy',
    weekday: '五',
    startTime: '15:20',
    endTime: '16:50',
    startMinutes: 920,
    endMinutes: 1010,
    active: true,
    skipDeduction: false,
  },
  {
    rowId: 'row-3',
    className: '國小數學-一A',
    teacher: null,
    weekday: '',
    startTime: '',
    endTime: '',
    startMinutes: null,
    endMinutes: null,
    active: true,
    skipDeduction: false,
  },
];

/** 手算的有效屬性：固定 5 天預設恆為 false，兩班皆非 → 不固定。 */
const FIXTURE_ATTRS = [
  { className: '兒童美語-Gino', classType: 'non_care' as const, category: 'english' as const, fixedFiveDays: false },
  { className: '國小數學-一A', classType: 'non_care' as const, category: 'math' as const, fixedFiveDays: false },
];

/** 打 route：multipart 表單。`headers` 可覆寫以測各 guard。 */
function postForm(form: FormData, headers: Record<string, string> = ORIGIN) {
  return scheduleTablePOST(
    new NextRequest(ROUTE_URL, { method: 'POST', headers, body: form })
  );
}

/** 直接用 ExcelJS 造「別人寫的」活頁簿，測匯入端驗證（不經過被測的匯出函式）。 */
async function makeForeignWorkbook(
  header: string[],
  body: Array<Array<string | number | Date | null>>,
  sheetName = '課表'
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(header);
  for (const row of body) ws.addRow(row);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** 讀出 error body 的 code（每條斷言都要同時斷 status 與 code）。 */
async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { code?: string }).code;
}

describe('PR #85 G1：課表 Excel route POST handler 防護分支', () => {
  describe('同源政策（D45：無 Origin／無 Referer 且非 cross-site 維持放行）', () => {
    it('明確跨來源（Origin 的 host 不同於 Host 標頭）→ 403 FORBIDDEN_CROSS_ORIGIN', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', JSON.stringify({ rows: FIXTURE_ROWS, classAttrs: FIXTURE_ATTRS }));

      const res = await postForm(form, { host: '127.0.0.1:3000', origin: 'http://evil.example' });

      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('FORBIDDEN_CROSS_ORIGIN');
    });

    it('無 Origin 但 Referer 跨來源 → 403（Referer 是次之檢查途徑）', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', JSON.stringify({ rows: FIXTURE_ROWS, classAttrs: FIXTURE_ATTRS }));

      const res = await postForm(form, { host: '127.0.0.1:3000', referer: 'http://evil.example/page' });

      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('FORBIDDEN_CROSS_ORIGIN');
    });

    it('無 Origin 且無 Referer 但 sec-fetch-site=cross-site → 403（第三道檢查）', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', JSON.stringify({ rows: FIXTURE_ROWS, classAttrs: FIXTURE_ATTRS }));

      const res = await postForm(form, { host: '127.0.0.1:3000', 'sec-fetch-site': 'cross-site' });

      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('FORBIDDEN_CROSS_ORIGIN');
    });

    it('D45 契約：無 Origin、無 Referer 且 sec-fetch-site 非 cross-site → 放行（不是 403）', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', JSON.stringify({ rows: FIXTURE_ROWS, classAttrs: FIXTURE_ATTRS }));

      // 只帶 host，刻意不放 origin／referer；sec-fetch-site 給 same-origin（非 cross-site）
      const res = await postForm(form, { host: '127.0.0.1:3000', 'sec-fetch-site': 'same-origin' });

      // D45（06，decision d-20261002163234657929-70）：這種情形維持放行。
      // 斷言「放行」而非僅「不是 403」：status 200 ＋ xlsx content-type 證明請求真的走完 export 分支。
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    });

    it('同源 Origin（host 相符）→ 放行，走完匯出分支回 200', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', JSON.stringify({ rows: FIXTURE_ROWS, classAttrs: FIXTURE_ATTRS }));

      const res = await postForm(form, ORIGIN);

      expect(res.status).toBe(200);
    });
  });

  describe('413 上限（兩條獨立路徑）', () => {
    it('宣告的 content-length 超過上限 → 413 PAYLOAD_TOO_LARGE（body 尚未解析）', async () => {
      const form = new FormData();
      form.set('mode', 'import');
      form.set('file', new File([new Uint8Array(1024)], 'tiny.xlsx'));

      const res = await postForm(form, {
        ...ORIGIN,
        'content-length': String(MAX_SCHEDULE_TABLE_BYTES + 1),
      });

      expect(res.status).toBe(413);
      expect(await codeOf(res)).toBe('PAYLOAD_TOO_LARGE');
      // 走的是「宣告長度」這條路：body 完全沒被讀，檔案本身只有 1 KiB
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    it('宣告長度在上限內但實際檔案超過 1 MiB → 413 PAYLOAD_TOO_LARGE（import 分支的 file.size）', async () => {
      // 1 MiB + 1 byte，剛好越過 MAX_SCHEDULE_TABLE_BYTES
      const oversize = new Uint8Array(MAX_SCHEDULE_TABLE_BYTES + 1);
      const form = new FormData();
      form.set('mode', 'import');
      form.set('file', new File([oversize], 'huge.xlsx'));

      const res = await postForm(form, ORIGIN);

      expect(res.status).toBe(413);
      expect(await codeOf(res)).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('400 防護分支', () => {
    it('body 不是可解析的表單 → 400 INVALID_REQUEST', async () => {
      const res = await scheduleTablePOST(
        new NextRequest(ROUTE_URL, {
          method: 'POST',
          headers: { ...ORIGIN, 'content-type': 'application/json' },
          body: '{ not form data',
        })
      );

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('INVALID_REQUEST');
    });

    it('mode=import 但沒有 file → 400 NO_FILE', async () => {
      const form = new FormData();
      form.set('mode', 'import');

      const res = await postForm(form);

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('NO_FILE');
    });

    it('未知 mode → 400 INVALID_REQUEST', async () => {
      const form = new FormData();
      form.set('mode', 'sideways');

      const res = await postForm(form);

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('INVALID_REQUEST');
    });

    it('mode=export 但 payload 不是字串 → 400 INVALID_REQUEST', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', new File([new Uint8Array(8)], 'not-a-string.txt'));

      const res = await postForm(form);

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('INVALID_REQUEST');
    });

    it('mode=export 且 payload 形狀錯（rows 不是陣列）→ 400 INVALID_REQUEST', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', JSON.stringify({ rows: 'not-an-array', classAttrs: [] }));

      const res = await postForm(form);

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('INVALID_REQUEST');
    });

    it('mode=export 且 payload 缺 classAttrs 欄位 → 400 INVALID_REQUEST', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', JSON.stringify({ rows: [] }));

      const res = await postForm(form);

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('INVALID_REQUEST');
    });

    it('mode=import 且檔案不是合法 xlsx → 400 INVALID_SCHEDULE_TABLE（帶 location 欄位）', async () => {
      const buf = await makeForeignWorkbook(['不是課表格式'], [['任意內容']]);
      const form = new FormData();
      form.set('mode', 'import');
      form.set('file', new File([new Uint8Array(buf)], 'broken.xlsx'));

      const res = await postForm(form);

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('INVALID_SCHEDULE_TABLE');
      expect(await res.clone().json()).toHaveProperty('location');
    });

    it('mode=import 且表頭不符七欄契約 → 400 INVALID_SCHEDULE_TABLE', async () => {
      const buf = await makeForeignWorkbook(
        ['班級名稱', '帶班老師', '星期', '開始時間', '結束時間'],
        [['兒童美語-Gino', 'Cathy', '一', '15:20', '16:50']]
      );
      const form = new FormData();
      form.set('mode', 'import');
      form.set('file', new File([new Uint8Array(buf)], 'wrong-headers.xlsx'));

      const res = await postForm(form);

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('INVALID_SCHEDULE_TABLE');
    });
  });

  describe('合法請求（真實入口往返）', () => {
    it('mode=export 合法 → 200，Content-Type 與 Content-Disposition 為 xlsx 下載', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', JSON.stringify({ rows: FIXTURE_ROWS, classAttrs: FIXTURE_ATTRS }));

      const res = await postForm(form);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(res.headers.get('content-disposition')).toContain('attachment');
      expect(res.headers.get('content-disposition')).toContain('schedule.xlsx');
    });

    it('mode=import 合法 → 200，rows 八欄內容與匯出時一致、逐列不計扣天往返一致、classAttrs 兩班', async () => {
      // 真實入口：先由 route 產出 xlsx，再把那份 bytes 當成匯入檔打回 route
      const exportForm = new FormData();
      exportForm.set('mode', 'export');
      exportForm.set('payload', JSON.stringify({ rows: FIXTURE_ROWS, classAttrs: FIXTURE_ATTRS }));
      const exported = await postForm(exportForm);
      expect(exported.status).toBe(200);
      const xlsxBytes = Buffer.from(await exported.arrayBuffer());

      const importForm = new FormData();
      importForm.set('mode', 'import');
      importForm.set('file', new File([xlsxBytes], 'schedule.xlsx'));
      const res = await postForm(importForm);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rows: Array<Record<string, unknown>>;
        classAttrs: Array<Record<string, unknown>>;
      };

      // 八欄平鋪時段列內容相等（#113 多一欄「不計扣天」）：逐欄比對，而非只比長度；classType 由 classAttrs 攜帶
      expect(body.rows).toHaveLength(3);
      expect(body.rows[0]).toMatchObject({
        className: '兒童美語-Gino',
        teacher: 'Cathy',
        weekday: '一',
        startTime: '15:20',
        endTime: '16:50',
      });
      expect(body.rows[1]).toMatchObject({
        className: '兒童美語-Gino',
        teacher: 'Cathy',
        weekday: '五',
        startTime: '15:20',
        endTime: '16:50',
      });
      // 佔位列（只有班名）原樣往返，老師／星期／起迄都留空
      expect(body.rows[2]).toMatchObject({
        className: '國小數學-一A',
        teacher: null,
        weekday: '',
        startTime: '',
        endTime: '',
      });

      expect(body.classAttrs).toEqual([
        { className: '兒童美語-Gino', classType: 'non_care', category: 'english', categorySource: 'manual', fixedFiveDays: false },
        { className: '國小數學-一A', classType: 'non_care', category: 'math', categorySource: 'manual', fixedFiveDays: false },
      ]);
    });

    it('mode=import 逐列往返不計扣天：同班一列勾一列不勾，匯入後仍是兩種值', async () => {
      // #113 follow-up 真實入口驗證：旗標在「列」上，route 不得把它壓回班級屬性。
      // 手算：只把第 1 列設為 true，其餘同 fixture → 匯出再匯入必須得到 [true, false, false]。
      const rows = FIXTURE_ROWS.map((r, i) => (i === 0 ? { ...r, skipDeduction: true } : r));
      const exportForm = new FormData();
      exportForm.set('mode', 'export');
      exportForm.set('payload', JSON.stringify({ rows, classAttrs: FIXTURE_ATTRS }));
      const exported = await postForm(exportForm);
      expect(exported.status).toBe(200);

      const importForm = new FormData();
      importForm.set('mode', 'import');
      importForm.set('file', new File([Buffer.from(await exported.arrayBuffer())], 'schedule.xlsx'));
      const res = await postForm(importForm);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
      expect(body.rows.map((r) => r.skipDeduction)).toEqual([true, false, false]);
    });
  });

  describe('表格契約（匯出檔表頭即匯入端驗證基準）', () => {
    it('匯出檔第一列就是課表表頭（#81 的七欄＋#113 的不計扣天），順序一致', async () => {
      const form = new FormData();
      form.set('mode', 'export');
      form.set('payload', JSON.stringify({ rows: FIXTURE_ROWS, classAttrs: FIXTURE_ATTRS }));

      const res = await postForm(form);
      expect(res.status).toBe(200);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('課表')!;

      const headers = (ws.getRow(1).values as unknown[]).slice(1) as string[];
      expect(headers).toEqual([...SCHEDULE_TABLE_HEADERS]);
    });
  });
});
