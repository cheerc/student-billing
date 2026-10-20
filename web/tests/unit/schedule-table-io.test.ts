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
  type ScheduleExportClassAttr,
} from '@/adapters/xlsx/schedule-table-io';
import {
  ScheduleGridRowSchema,
  buildSeedGridRows,
  classesToGridRows,
  gridRowsToClasses,
  type ScheduleGridRow,
} from '@/contracts/settings';
import { normalizeWeekday } from '@/domain/schedules/overlap-calculator';
import { resolveClassAttributes } from '@/domain/classification/class-attributes';

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

/** 手算的有效屬性：Gino → 美語班＋不固定；國小數學-一A → 數學班＋不固定（固定 5 天預設恆為 false）。 */
const FIXTURE_ATTRS: ScheduleExportClassAttr[] = [
  { className: '兒童美語-Gino', classType: 'non_care', category: 'english' as const, fixedFiveDays: false },
  { className: '國小數學-一A', classType: 'non_care', category: 'math' as const, fixedFiveDays: false },
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
    it('產出剛好 9 欄（表頭包含「課程類型」），順序一致，且不含任何欄位挑選的痕跡', async () => {
      const buffer = await buildScheduleWorkbook(FIXTURE_ROWS, FIXTURE_ATTRS);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(SCHEDULE_TABLE_SHEET_NAME)!;

      const headers = (ws.getRow(1).values as unknown[]).slice(1) as string[];
      expect(headers).toEqual([
        '班級名稱',
        '課程類型',
        '列入多科折扣',
        '天數固定5天',
        '不計扣天',
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

    it('匯出的是**有效屬性**的白話值（手算：Gino→美語班/否/否、一A→數學班/否/否）', async () => {
      const buffer = await buildScheduleWorkbook(FIXTURE_ROWS, FIXTURE_ATTRS);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(SCHEDULE_TABLE_SHEET_NAME)!;

      const row2 = (ws.getRow(2).values as unknown[]).slice(1) as string[];
      expect(row2).toEqual(['兒童美語-Gino', '非安親課輔班', '美語班', '否', '否', 'Cathy', '一', '15:20', '16:50']);

      const row4 = (ws.getRow(4).values as unknown[]).slice(1) as string[];
      // 只有班名的佔位列：老師與星期留空字串、時間空字串（不是 "null"、不是 undefined）
      expect(row4).toEqual(['國小數學-一A', '非安親課輔班', '數學班', '否', '否', '', '', '', '']);
    });

    it('固定 5 天為 true 時匯出「是」（安親課輔班適用）', async () => {
      const careRow: ScheduleGridRow = {
        rowId: 'row-care-1',
        className: '國小輔導-四年級',
        teacher: '玟君',
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      };
      const buffer = await buildScheduleWorkbook([careRow], [
        { className: '國小輔導-四年級', classType: 'care', category: 'care', fixedFiveDays: true },
      ]);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(SCHEDULE_TABLE_SHEET_NAME)!;
      expect((ws.getRow(2).values as unknown[])[4]).toBe('是');
      // 固定 5 天與不計扣天是兩個獨立欄位：勾固定 5 天不會連動不計扣天
      expect((ws.getRow(2).values as unknown[])[5]).toBe('否');
    });

    /**
     * #113 follow-up：不計扣天的往返。旗標在「列」上（ScheduleExportClassAttr 已無此欄）；
     * 勾選時匯出「是」，匯入後逐欄一致。與「天數固定5天」同一套「是／否」白話值。
     */
    it('逐列的不計扣天匯出「是」，並能匯入回來（往返一致）', async () => {
      // 手算（#113 follow-up）：旗標在「列」上 → 只把第 1 列（row-1）的 FIXTURE_ROWS
      // 換成 skipDeduction=true，其餘不變；班級屬性不再帶這個欄位。
      const rows = FIXTURE_ROWS.map((r, i) => (i === 0 ? { ...r, skipDeduction: true } : r));
      const buffer = await buildScheduleWorkbook(rows, FIXTURE_ATTRS);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(SCHEDULE_TABLE_SHEET_NAME)!;
      expect((ws.getRow(2).values as unknown[])[5]).toBe('是');
      expect((ws.getRow(3).values as unknown[])[5]).toBe('否');
      expect((ws.getRow(4).values as unknown[])[5]).toBe('否');

      const result = await parseScheduleWorkbook(buffer);
      // 逐列還原：只有第 1 列是 true
      expect(result.rows.map((r) => r.skipDeduction)).toEqual([true, false, false]);
      expect(result.classAttrs).toEqual([
        { className: '兒童美語-Gino', classType: 'non_care', category: 'english', fixedFiveDays: false },
        { className: '國小數學-一A', classType: 'non_care', category: 'math', fixedFiveDays: false },
      ]);
    });

    it('關鍵案例：同一班兩列可各填各的不計扣天（逐列獨立往返）', async () => {
      // 手算：row-1 與 row-2 同為「兒童美語-Gino」，但一列勾、一列不勾 → 往返後必須仍是兩種值。
      // 這是逐時段化的核心承諾：舊版會因為「同班必須一致」而整批拒絕。
      const rows = FIXTURE_ROWS.map((r, i) => (i === 0 ? { ...r, skipDeduction: true } : r));
      const result = await parseScheduleWorkbook(await buildScheduleWorkbook(rows, FIXTURE_ATTRS));
      expect(result.rows.filter((r) => r.className === '兒童美語-Gino').map((r) => r.skipDeduction))
        .toEqual([true, false]);
      // 且帶進平鋪列後仍逐列獨立
      expect(scheduleImportRowsToGridRows(result).map((r) => r.skipDeduction)).toEqual([true, false, false]);
    });

    it('不計扣天非「是／否」→ 整批拒絕（不靜默當成「否」）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '非安親課輔班', '數學班', '否', 'YES', '', '一', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/「不計扣天」請填「是」或「否」/);
    });

    it('同一班不同列的「折扣類別」不一致 → 仍拒絕（不計扣天已逐列化，類別仍整班共用）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '非安親課輔班', '數學班', '否', '是', '', '一', '10:00', '11:00'],
        ['甲班', '非安親課輔班', '美語班', '否', '否', '', '二', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/班級「甲班」在不同列填了不同的折扣類別，請先讓它們一致再匯入。/);
    });

    it('跨類型互斥驗證（specs/14 §3.6 & A11）：安親課輔班填寫了星期或時間 → 整批拒絕', async () => {
      const bufferWithWeekday = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['安親班', '安親課輔班', '安親課輔班', '否', '否', '李老師', '一', '', ''],
      ]);
      await expect(parseScheduleWorkbook(bufferWithWeekday)).rejects.toThrow(
        /為安親課輔班，安親課輔班不輸入星期與上課時間，請留空/
      );

      const bufferWithTime = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['安親班', '安親課輔班', '安親課輔班', '否', '否', '李老師', '', '13:00', '16:00'],
      ]);
      await expect(parseScheduleWorkbook(bufferWithTime)).rejects.toThrow(
        /為安親課輔班，安親課輔班不輸入星期與上課時間，請留空/
      );
    });

    it('跨類型互斥驗證（specs/14 §3.6 & A11）：安親課輔班填寫了「不計扣天＝是」 → 整批拒絕', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['安親班', '安親課輔班', '安親課輔班', '否', '是', '李老師', '', '', ''],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(
        /為安親課輔班，安親課輔班不適用「不計扣天」，請填「否」或留空/
      );
    });

    it('跨類型互斥驗證（specs/14 §3.6 & A11）：非安親課輔班填寫了「天數固定5天＝是」 → 整批拒絕', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['數學班', '非安親課輔班', '數學班', '是', '否', '張老師', '一', '16:30', '18:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(
        /為非安親課輔班，非安親課輔班不適用「天數固定5天」，請填「否」/
      );
    });

    it('課程類型未知文字 → 整批拒絕', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['未知班', '其他班別', '數學班', '否', '否', '張老師', '一', '16:30', '18:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(
        /「課程類型」請填「安親課輔班」或「非安親課輔班」/
      );
    });

    it('同一班不同列的「課程類型」不一致 → 整批拒絕並精確點名課程類型', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['衝突班', '非安親課輔班', '數學班', '否', '否', '', '一', '10:00', '11:00'],
        ['衝突班', '安親課輔班', '數學班', '否', '否', '', '', '', ''],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(
        /班級「衝突班」在不同列填了不同的課程類型，請先讓它們一致再匯入。/
      );
    });

    it('同一班不同列的「折扣類別」不一致 → 整批拒絕並精確點名折扣類別', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['衝突班', '非安親課輔班', '數學班', '否', '否', '', '一', '10:00', '11:00'],
        ['衝突班', '非安親課輔班', '美語班', '否', '否', '', '二', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(
        /班級「衝突班」在不同列填了不同的折扣類別，請先讓它們一致再匯入。/
      );
    });

    it('同一班不同列的「固定 5 天」不一致 → 整批拒絕並精確點名固定 5 天設定', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['衝突班', '安親課輔班', '安親課輔班', '是', '否', '', '', '', ''],
        ['衝突班', '安親課輔班', '安親課輔班', '否', '否', '', '', '', ''],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(
        /班級「衝突班」在不同列填了不同的固定 5 天設定，請先讓它們一致再匯入。/
      );
    });
  });

  describe('匯入：round-trip', () => {
    it('匯出→匯入後每一列的九個欄位逐欄一致（值層級 round-trip）', async () => {
      const buffer = await buildScheduleWorkbook(FIXTURE_ROWS, FIXTURE_ATTRS);
      const result = await parseScheduleWorkbook(buffer);

      expect(result.rows).toEqual([
        {
          className: '兒童美語-Gino',
          classType: 'non_care',
          teacher: 'Cathy',
          weekday: '一',
          startTime: '15:20',
          endTime: '16:50',
          category: 'english',
          fixedFiveDays: false,
          skipDeduction: false,
        },
        {
          className: '兒童美語-Gino',
          classType: 'non_care',
          teacher: 'Cathy',
          weekday: '五',
          startTime: '15:20',
          endTime: '16:50',
          category: 'english',
          fixedFiveDays: false,
          skipDeduction: false,
        },
        {
          className: '國小數學-一A',
          classType: 'non_care',
          teacher: null,
          weekday: '',
          startTime: '',
          endTime: '',
          category: 'math',
          fixedFiveDays: false,
          skipDeduction: false,
        },
      ]);
    });

    it('安親課輔班（無時段、可勾固定 5 天）匯出與匯入 round-trip（specs/14 §3.6）', async () => {
      const careRows: ScheduleGridRow[] = [
        {
          rowId: 'row-care-1',
          className: '國小輔導-四年級',
          teacher: '玟君',
          weekday: '',
          startTime: '',
          endTime: '',
          startMinutes: null,
          endMinutes: null,
          active: true,
          skipDeduction: false,
        },
      ];
      const careAttrs: ScheduleExportClassAttr[] = [
        { className: '國小輔導-四年級', classType: 'care', category: 'care', fixedFiveDays: true },
      ];
      const buffer = await buildScheduleWorkbook(careRows, careAttrs);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows).toEqual([
        {
          className: '國小輔導-四年級',
          classType: 'care',
          teacher: '玟君',
          weekday: '',
          startTime: '',
          endTime: '',
          category: 'care',
          fixedFiveDays: true,
          skipDeduction: false,
        },
      ]);
      expect(result.classAttrs).toEqual([
        { className: '國小輔導-四年級', classType: 'care', category: 'care', fixedFiveDays: true },
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
        { className: '兒童美語-Gino', classType: 'non_care', category: 'english', fixedFiveDays: false },
        { className: '國小數學-一A', classType: 'non_care', category: 'math', fixedFiveDays: false },
      ]);
    });

    it('真實種子課表 buildSeedGridRows 89 列以 resolveClassAttributes 匯出再匯入 100% 成功通過無互斥', async () => {
      const seedRows = buildSeedGridRows();
      const distinctClassNames = Array.from(new Set(seedRows.map((r) => r.className)));
      const classAttrs = distinctClassNames.map((name) => {
        const attr = resolveClassAttributes(name);
        return {
          className: name,
          classType: attr.classType,
          category: attr.category,
          fixedFiveDays: attr.fixedFiveDays,
        };
      });

      const buffer = await buildScheduleWorkbook(seedRows, classAttrs);
      const result = await parseScheduleWorkbook(buffer);

      expect(result.rows.length).toBe(seedRows.length);
      const careRows = result.rows.filter((r) => r.classType === 'care');
      expect(careRows.length).toBeGreaterThan(0);
      for (const r of careRows) {
        expect(r.weekday).toBe('');
        expect(r.startTime).toBe('');
        expect(r.endTime).toBe('');
        expect(r.skipDeduction).toBe(false);
      }
    });

    it('若 non_care 帶有 fixedFiveDays: true，匯出時忠實輸出，匯入時嚴格拒絕互斥', async () => {
      const row: ScheduleGridRow = {
        rowId: 'r1',
        className: '國小數學-四A',
        teacher: null,
        weekday: '一',
        startTime: '16:30',
        endTime: '18:00',
        startMinutes: 990,
        endMinutes: 1080,
        active: true,
        skipDeduction: false,
      };
      const attrs: ScheduleExportClassAttr[] = [
        { className: '國小數學-四A', classType: 'non_care', category: 'math', fixedFiveDays: true },
      ];
      const buffer = await buildScheduleWorkbook([row], attrs);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const ws = wb.getWorksheet(SCHEDULE_TABLE_SHEET_NAME)!;
      // 依 D17 照實呈現：匯出端維持忠實輸出
      expect((ws.getRow(2).values as unknown[])[4]).toBe('是');

      // 匯入端嚴格把關：整批拒絕非安親課輔班之固定 5 天
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(
        /第 2 列為非安親課輔班，非安親課輔班不適用「天數固定5天」，請填「否」/
      );
    });

    it('匯出端閘門淨化：若 care 班帶有 skipDeduction: true 或星期時間，匯出時強制留空與否，避免匯入互斥', async () => {
      const row: ScheduleGridRow = {
        rowId: 'r1',
        className: '國小輔導-四年級',
        teacher: '玟君',
        weekday: '一',
        startTime: '13:00',
        endTime: '16:00',
        startMinutes: 780,
        endMinutes: 960,
        active: true,
        skipDeduction: true,
      };
      const attrs: ScheduleExportClassAttr[] = [
        { className: '國小輔導-四年級', classType: 'care', category: 'care', fixedFiveDays: true },
      ];
      const buffer = await buildScheduleWorkbook([row], attrs);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows[0].skipDeduction).toBe(false);
      expect(result.rows[0].weekday).toBe('');
      expect(result.rows[0].startTime).toBe('');
      expect(result.rows[0].endTime).toBe('');
    });

    it('匯出端查表防護：班名含空白或 attrsByName 缺失時，fallback 至 resolveClassAttributes', async () => {
      const row: ScheduleGridRow = {
        rowId: 'r1',
        className: '  國小輔導-四年級  ',
        teacher: null,
        weekday: '一',
        startTime: '13:00',
        endTime: '16:00',
        startMinutes: 780,
        endMinutes: 960,
        active: true,
        skipDeduction: false,
      };
      // 傳入空 classAttrs，迫使走 fallback
      const buffer = await buildScheduleWorkbook([row], []);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows[0].classType).toBe('care');
      expect(result.rows[0].weekday).toBe('');
      expect(result.rows[0].startTime).toBe('');
      expect(result.rows[0].endTime).toBe('');
    });

    it('星期可留空（#82 的佔位列）；非空時各種寫法都正規化成一到日', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['空白班', '非安親課輔班', '不列入折扣', '否', '否', '', '', '', ''],
        ['週三班', '非安親課輔班', '不列入折扣', '否', '否', '', '週三', '10:00', '11:00'],
        ['數字班', '非安親課輔班', '不列入折扣', '否', '否', '', '5', '10:00', '11:00'],
        ['星期天', '非安親課輔班', '不列入折扣', '否', '否', '', '天', '10:00', '11:00'],
      ]);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows.map((r) => r.weekday)).toEqual(['', '三', '五', '日']);
    });

    it('折扣類別接受白話標籤，也接受內部值（方便使用者手動編輯匯出檔）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['白話班', '非安親課輔班', '安親課輔班', '否', '否', '', '一', '10:00', '11:00'],
        ['內值班', '非安親課輔班', 'math', '否', '否', '', '一', '10:00', '11:00'],
      ]);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows.map((r) => r.category)).toEqual(['care', 'math']);
    });

    it('整列空白（多餘的空白列）略過，不當成資料列', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['有資料班', '非安親課輔班', '數學班', '否', '否', '王老師', '一', '10:00', '11:00'],
        ['', '', '', '', '', '', '', '', ''],
      ]);
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].className).toBe('有資料班');
    });

    it('工作表名稱不是預期的也能讀（使用者可能改過分頁名）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '非安親課輔班', '數學班', '否', '否', '', '一', '10:00', '11:00'],
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
        ['帶班老師', '班級名稱', '課程類型', '列入多科折扣', '天數固定5天', '不計扣天', '星期', '開始時間', '結束時間'],
        [['', '甲班', '非安親課輔班', '數學班', '否', '否', '一', '10:00', '11:00']]
      );
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/欄位標題不符合/);
    });

    it('表頭有全形空格仍視為相符（行政用 Excel 手編時很容易多打空白）', async () => {
      const buffer = await makeWorkbook(
        SCHEDULE_TABLE_HEADERS.map((h, i) => (i === 0 ? `　${h} ` : h)) as unknown as string[],
        [['甲班', '非安親課輔班', '數學班', '否', '否', '', '一', '10:00', '11:00']]
      );
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows).toHaveLength(1);
    });

    it('班級名稱空白 → 拒絕（只有名稱是必填，但名稱本身不能沒有）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['  ', '非安親課輔班', '數學班', '否', '否', '', '一', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/班級名稱.*不能空白/);
    });

    it('時間格式非 HH:mm → 拒絕（25:00 不因為是數字就放行）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '非安親課輔班', '數學班', '否', '否', '', '一', '25:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/時間格式不正確/);
    });

    it('結束時間不晚於開始時間 → 拒絕', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '非安親課輔班', '數學班', '否', '否', '', '一', '15:00', '14:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/結束時間必須晚於開始時間/);
    });

    it('折扣類別不可辨識 → 拒絕', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '非安親課輔班', '物理班', '否', '否', '', '一', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/不是可辨識的類別/);
    });

    it('固定 5 天非「是／否」→ 拒絕（不接受靜默當成「否」）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '安親課輔班', '數學班', 'YES', '否', '', '', '', ''],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/請填「是」或「否」/);
    });

    it('星期不可辨識 → 拒絕（但空白放行）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '非安親課輔班', '數學班', '否', '否', '', '八', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/星期無法辨識/);
    });

    it('同一班不同列填了不同屬性 → 拒絕（不靜默取其一）', async () => {
      const buffer = await makeWorkbook([...SCHEDULE_TABLE_HEADERS], [
        ['甲班', '非安親課輔班', '數學班', '否', '否', '', '一', '10:00', '11:00'],
        ['甲班', '非安親課輔班', '美語班', '否', '否', '', '二', '10:00', '11:00'],
      ]);
      await expect(parseScheduleWorkbook(buffer)).rejects.toThrow(/班級「甲班」在不同列填了不同的折扣類別，請先讓它們一致再匯入。/);
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
        ['甲班', '非安親課輔班', '數學班', '否', '否', '', '八', '10:00', '11:00'],
      ]);
      const error = await parseScheduleWorkbook(buffer).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScheduleTableImportError);
      const message = (error as Error).message;
      expect(message).not.toMatch(/Error|undefined|NaN|\.xlsx:/);
      // 但仍要指出位置，讓使用者找得到那一列
      expect(message).toContain('第 2 列');
    });
  });

  /**
   * 回歸：匯出的檔案必須能被自己的匯入端接受。
   *
   * 這不是風格偏好，是 #81 的核心契約（Expected Outcome 2「整批還原班級、時段、
   * 折扣類別與固定 5 天」）。實際踩到過：`classesToGridRows` 過去把空 sessions 班的
   * 星期寫成 `'—'`，那是 `normalizeWeekday` 不認得的**非空**值 → 匯出檔匯回來時被
   * 「星期無法辨識」整批拒絕，使用者剛匯出就匯不回去。
   *
   * 這個測試刻意**用真實的 app row 來源**（seed → classes → grid 的完整往返），
   * 不用挑過的 fixture：手挑 fixture 挑不到就等於沒有這條保護。
   */
  describe('回歸：自己匯出的檔案，自己匯得回去', () => {
    const appRows = () => {
      const seed = buildSeedGridRows();
      // 與 settings-editor 的 initialRows 同一條路徑
      const viaClasses = classesToGridRows(gridRowsToClasses(seed));
      return viaClasses.length > 0 ? viaClasses : seed;
    };

    const appAttrs = (rows: ScheduleGridRow[]) =>
      [...new Set(rows.map((r) => r.className))].map((className) => {
        const attr = resolveClassAttributes(className);
        return {
          className,
          classType: attr.classType,
          category: attr.category,
          fixedFiveDays: attr.fixedFiveDays,
        };
      });

    it('seed 課表（88/89 列）匯出後能原封不動匯回來', async () => {
      const rows = appRows();
      const buffer = await buildScheduleWorkbook(rows, appAttrs(rows));
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows).toHaveLength(rows.length);
    });

    it('每一列的星期都匯得回來（沒有 normalizeWeekday 不認得的非空值）', async () => {
      const rows = appRows();
      const buffer = await buildScheduleWorkbook(rows, appAttrs(rows));
      const result = await parseScheduleWorkbook(buffer);
      // 匯入端只接受一到日或空白；這裡再確認一次「空白」真的是空白而非某個符號
      for (const row of result.rows) {
        expect(
          row.weekday === '' || normalizeWeekday(row.weekday) !== null,
          `第 ${result.rows.indexOf(row) + 1} 列的星期「${row.weekday}」無法辨識`
        ).toBe(true);
      }
    });

    it('空 sessions 的佔位列匯出的是「空白星期」，不是破折號之類的符號', async () => {
      const rows = appRows();
      // 找出至少一個沒有 session 的班（seed 內有 9 個），確認它的佔位列星期是空字串
      const withSessions = new Set(
        gridRowsToClasses(buildSeedGridRows())
          .filter((c) => c.sessions.length > 0)
          .map((c) => c.baseName)
      );
      const placeholder = rows.find((r) => !withSessions.has(r.className));
      expect(placeholder, 'seed 應有沒有 session 的班').toBeDefined();
      expect(placeholder!.weekday).toBe('');

      // 這一列照樣能匯出、匯回
      const buffer = await buildScheduleWorkbook([placeholder!], appAttrs([placeholder!]));
      const result = await parseScheduleWorkbook(buffer);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].weekday).toBe('');
    });
  });
});
