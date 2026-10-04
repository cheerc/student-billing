/**
 * #81：課表 Excel 全量匯出／匯入（單純一鍵，無欄位挑選）。
 *
 * 這些 expected 全部**獨立手算或直接讀規格**，不用被測函式的輸出當黃金標準：
 *  - 表頭與欄位順序＝issue #81 明列的 7 欄；
 *  - 合法值域＝`CATEGORY_LABELS` 的四個白話標籤、時間 `HH:mm`、星期一到日（`normalizeWeekday` 的認得集合）；
 *  - 「整批拒絕」＝任一列不合法時 `parseScheduleWorkbook` 拋錯且**回傳零列**（不做部分套用）。
 */

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  SCHEDULE_TABLE_HEADERS,
  SCHEDULE_TABLE_SHEET_NAME,
  buildScheduleWorkbook,
  parseScheduleWorkbook,
  scheduleImportRowsToGridRows,
  ScheduleTableImportError,
} from '@/adapters/xlsx/schedule-table-io';
import { ScheduleGridRowSchema, type ScheduleGridRow } from '@/contracts/settings';

/** 手算的完整課表（3 列、2 個班；含一列「只有班名」的佔位列，#82 的形狀）。 */
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
  },
];

/** 手算的有效屬性：Gino → 美語班＋不固定；國小數學-一A → 數學班＋不固定（`detectFixedFiveDays` 只認「寫功課」與「美安」）。 */
const FIXTURE_ATTRS = [
  { className: '兒童美語-Gino', category: 'english' as const, fixedFiveDays: false },
  { className: '國小數學-一A', category: 'math' as const, fixedFiveDays: false },
];

/** 直接用 ExcelJS 造一份「別人寫的」活頁簿，測匯入端的驗證（不經過被測的匯出函式）。 */
async function makeWorkbook(
  header: string[],
  body: Array<Array<string | number | Date | null>>,
  sheetName = SCHEDULE_TABLE_SHEET_NAME
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(header);
  for (const row of body) ws.addRow(row);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe('#81：課表 Excel 全量匯出／匯入', () => {
  describe('匯出', () => {
    it('產出剛好 7 欄、順序與 issue #81 一致，且不含任何欄位挑選的痕跡', async () => {
      const buffer = await buildScheduleWorkbook(FIXTURE_ROWS, FIXTURE_ATTRS);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(SCHEDULE_TABLE_SHEET_NAME)!;

      const headers = (ws.getRow(1).values as unknown[]).slice(1) as string[];
      expect(headers).toEqual([
        '班級名稱',
        '列入多科折扣',
        '天數固定5天',
        '帶班老師',
        '星期',
        '開始時間',
        '結束時間',
      ]);
      // 表頭常數是匯入端的驗證基準；兩邊共用一份，不各寫一份
      expect(headers).toEqual([...SCHEDULE_TABLE_HEADERS]);
      // 每個時段列一列，不做任何摺疊或抽樣
      expect(ws.rowCount).toBe(4);
    });

    it('匯出的是**有效屬性**的白話值（手算：Gino→美語班/否、一A→數學班/否）', async () => {
      const buffer = await buildScheduleWorkbook(FIXTURE_ROWS, FIXTURE_ATTRS);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(SCHEDULE_TABLE_SHEET_NAME)!;

      const row2 = (ws.getRow(2).values as unknown[]).slice(1) as string[];
      expect(row2).toEqual(['兒童美語-Gino', '美語班', '否', 'Cathy', '一', '15:20', '16:50']);

      const row4 = (ws.getRow(4).values as unknown[]).slice(1) as string[];
      // 只有班名的佔位列：老師與星期留空字串、時間空字串（不是 "null"、不是 undefined）
      expect(row4).toEqual(['國小數學-一A', '數學班', '否', '', '', '', '']);
    });

    it('固定 5 天為 true 時匯出「是」', async () => {
      const buffer = await buildScheduleWorkbook(FIXTURE_ROWS, [
        { className: '兒童美語-Gino', category: 'english', fixedFiveDays: true },
        { className: '國小數學-一A', category: 'math', fixedFiveDays: false },
      ]);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(SCHEDULE_TABLE_SHEET_NAME)!;
      expect((ws.getRow(2).values as unknown[])[3]).toBe('是');
    });
  });

  describe('匯入：round-trip', () => {
    it('匯出→匯入後每一列的七個欄位逐欄一致（值層級 round-trip）', async () => {
      const buffer = await buildScheduleWorkbook(FIXTURE_ROWS, FIXTURE_ATTRS);
      const result = await parseScheduleWorkbook(buffer);

      expect(result.rows).toEqual([
        {
          className: '兒童美語-Gino',
          teacher: 'Cathy',
          weekday: '一',
          startTime: '15:20',
          endTime: '16:50',
          category: 'english',
          fixedFiveDays: false,
        },
        {
          className: '兒童美語-Gino',
          teacher: 'Cathy',
          weekday: '五',
          startTime: '15:20',
          endTime: '16:50',
          category: 'english',
          fixedFiveDays: false,
        },
        {
          className: '國小數學-一A',
          teacher: null,
          weekday: '',
          startTime: '',
          endTime: '',
          category: 'math',
          fixedFiveDays: false,
        },
      ]);
    });

    it('round-trip 後的列仍符合 ScheduleGridRowSchema（空星期可存草稿）', async () => {
      const buffer = await buildScheduleWorkbook(FIXTURE_ROWS, FIXTURE_ATTRS);
      const rows = scheduleImportRowsToGridRows(await parseScheduleWorkbook(buffer));

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(ScheduleGridRowSchema.safeParse(row).success).toBe(true);
      }
      // 手算：只有班名的列，startMinutes/endMinutes 為 null（可存草稿、不產 session）
      expect(rows[2]).toMatchObject({
        className: '國小數學-一A',
        teacher: null,
        weekday: '',
        startMinutes: null,
        endMinutes: null,
      });
    });

    it('每班的屬性去重成一筆（同班兩列只回一次）', async () => {
      const buffer = await buildScheduleWorkbook(FIXTURE_ROWS, FIXTURE_ATTRS);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.classAttrs).toEqual([
        { className: '兒童美語-Gino', category: 'english', fixedFiveDays: false },
        { className: '國小數學-一A', category: 'math', fixedFiveDays: false },
      ]);
    });

    it('星期可留空（#82 的佔位列）；非空時各種寫法都正規化成一到日', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['空白班', '不列入折扣', '否', '', '', '', ''],
        ['週三班', '不列入折扣', '否', '', '週三', '10:00', '11:00'],
        ['數字班', '不列入折扣', '否', '', '5', '10:00', '11:00'],
        ['星期天', '不列入折扣', '否', '', '天', '10:00', '11:00'],
      ]);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows.map((r) => r.weekday)).toEqual(['', '三', '五', '日']);
    });

    it('折扣類別接受白話標籤，也接受內部值（方便使用者手動編輯匯出檔）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['白話班', '安親課輔班', '否', '', '一', '10:00', '11:00'],
        ['內值班', 'math', '否', '', '一', '10:00', '11:00'],
      ]);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows.map((r) => r.category)).toEqual(['care', 'math']);
    });

    it('整列空白（多餘的空白列）略過，不當成資料列', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['有資料班', '數學班', '否', '王老師', '一', '10:00', '11:00'],
        ['', '', '', '', '', '', ''],
      ]);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].className).toBe('有資料班');
    });

    it('工作表名稱不是預期的也能讀（使用者可能改過分頁名）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '數學班', '否', '', '一', '10:00', '11:00'],
      ], '我的備份');
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows).toHaveLength(1);
    });
  });

  describe('匯入：整批拒絕（不做部分套用）', () => {
    it('表頭缺欄 → 拒絕並點名缺哪一欄', async () => {
      const buffer = await makeWorkbook(
        ['班級名稱', '帶班老師', '星期'],
        [['甲班', '', '一']]
      );
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(ScheduleTableImportError);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/欄位標題不符合/);
    });

    it('表頭順序不同也算不符（匯出／匯入同一份表頭常數，順序是契約的一部分）', async () => {
      const buffer = await makeWorkbook(
        ['帶班老師', '班級名稱', '列入多科折扣', '天數固定5天', '星期', '開始時間', '結束時間'],
        [['', '甲班', '數學班', '否', '一', '10:00', '11:00']]
      );
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/欄位標題不符合/);
    });

    it('表頭有全形空格仍視為相符（行政用 Excel 手編時很容易多打空白）', async () => {
      const buffer = await makeWorkbook(
        SCHEDULE_TABLE_HEADERS.map((h, i) => (i === 0 ? `　${h} ` : h)) as unknown as string[],
        [['甲班', '數學班', '否', '', '一', '10:00', '11:00']]
      );
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows).toHaveLength(1);
    });

    it('班級名稱空白 → 拒絕（只有名稱是必填，但名稱本身不能沒有）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['  ', '數學班', '否', '', '一', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/班級名稱.*不能空白/);
    });

    it('時間格式非 HH:mm → 拒絕（25:00 不因為是數字就放行）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '數學班', '否', '', '一', '25:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/時間格式不正確/);
    });

    it('結束時間不晚於開始時間 → 拒絕', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '數學班', '否', '', '一', '15:00', '14:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/結束時間必須晚於開始時間/);
    });

    it('折扣類別不可辨識 → 拒絕', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '物理班', '否', '', '一', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/不是可辨識的類別/);
    });

    it('固定 5 天非「是／否」→ 拒絕（不接受靜默當成「否」）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '數學班', 'YES', '', '一', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/請填「是」或「否」/);
    });

    it('星期不可辨識 → 拒絕（但空白放行）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '數學班', '否', '', '八', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/星期無法辨識/);
    });

    it('同一班不同列填了不同屬性 → 拒絕（不靜默取其一）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '數學班', '否', '', '一', '10:00', '11:00'],
        ['甲班', '美語班', '否', '', '二', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/不同的折扣類別/);
    });

    it('只有表頭、沒有任何資料列 → 拒絕（避免把空課表當成合法匯入）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], []);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/沒有任何課表資料列/);
    });

    it('不是 xlsx（亂 bytes）→ 拒絕並給白話訊息，不外露例外', async () => {
      await expect(parseScheduleWorkbook(Buffer.from('this is not a zip file'))).rejects.toThrow(
        /無法讀取這個 Excel 檔案/
      );
    });

    it('拒絕時錯誤訊息不含工程碼或檔案路徑（copy-scan 的禁用詞邊界）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '數學班', '否', '', '八', '10:00', '11:00'],
      ]);
      const error = await parseScheduleWorkbook(buffer).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScheduleTableImportError);
      const message = (error as Error).message;
      expect(message).not.toMatch(/Error|undefined|NaN|\.xlsx:/);
      // 但仍要指出位置，讓使用者找得到那一列
      expect(message).toContain('第 2 列');
    });
  });
});
