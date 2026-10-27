/**
 * 課表 Excel 全量匯出／匯入（#81）。
 *
 * 設計邊界（issue #81 明列，operator 防呆指示）：
 *  - **單純一鍵**：不提供任何欄位挑選或勾選對話框。匯出永遠是完整欄位，匯入永遠整批覆蓋。
 *  - **嚴格驗證**：表頭不符、時間格式非 `HH:mm`、星期無法識別、折扣類別非合法值，
 *    一律**整批拒絕**並回白話錯誤，不做部分套用（避免破碎資料寫進設定）。
 *
 * 這是純模組（不依賴 DB／React），因此單元測試可直接對 Buffer 做 round-trip，不必起 API。
 * ExcelJS 只在 server 端使用（`next.config.ts` 已把 exceljs 列為 serverExternalPackages），
 * 不進 browser bundle。
 */

import ExcelJS from 'exceljs';
import {
  type ScheduleGridRow,
  type ClassType,
} from '@/contracts/settings';
import { timeStringToMinutes } from '@/contracts/settings';
import type { ClassCategory, WritableCategorySource } from '@/domain/classification/class-category';
import { CATEGORY_LABELS, resolveClassAttributes } from '@/domain/classification/class-attributes';
import { normalizeWeekday } from '@/domain/schedules/overlap-calculator';

/** 匯出／匯入的完整表頭；順序即欄位順序，兩邊共用同一份（不各寫一份，避免漂移）。
 *  specs/14 §3.6：表頭包含「課程類型」（值為 安親課輔班 或 非安親課輔班；同班多列必須一致）。 */
export const SCHEDULE_TABLE_HEADERS = [
  '班級名稱',
  '課程類型',
  '列入多科折扣',
  '天數固定5天',
  '不計扣天',
  '帶班老師',
  '星期',
  '開始時間',
  '結束時間',
] as const;

const COLUMN_CLASS_NAME = 0;
const COLUMN_CLASS_TYPE = 1;
const COLUMN_CATEGORY = 2;
const COLUMN_FIXED_FIVE = 3;
// #113 follow-up：不計扣天緊接「天數固定5天」——兩者都是「扣天怎麼算」的設定。
// 這一欄是**逐列**的：同一班的不同時段可以各填各的。
const COLUMN_SKIP_DEDUCTION = 4;
const COLUMN_TEACHER = 5;
const COLUMN_WEEKDAY = 6;
const COLUMN_START = 7;
const COLUMN_END = 8;

/** 匯出／匯入檔案的工作表名（使用者可在 Excel 裡看到它，錯誤訊息也用它指位）。 */
export const SCHEDULE_TABLE_SHEET_NAME = '課表';

/** 匯出檔內「天數固定 5 天」與「不計扣天」的白話值（與畫面用語一致）。 */
const FIXED_FIVE_YES = '是';
const FIXED_FIVE_NO = '否';
/** #113：「不計扣天」為真時的白話值；為假時沿用 FIXED_FIVE_NO（兩欄共用「是／否」語彙）。 */
const SKIP_DEDUCTION_YES = '是';

/** 課程類型的白話名稱 */
export const CLASS_TYPE_CARE_LABEL = '安親課輔班';
export const CLASS_TYPE_NON_CARE_LABEL = '非安親課輔班';

/** 折扣類別的白話標籤 → 內部值。匯出寫標籤、匯入接受標籤或內部值（方便手動編輯檔案）。 */
const CATEGORY_BY_LABEL: Record<string, ClassCategory> = {
  安親課輔班: 'care',
  數學班: 'math',
  美語班: 'english',
  不列入折扣: 'none',
  // #157：未設定是一個獨立狀態；匯出寫「（未設定）」，匯入接受它回 unset，
  // 不得落回 none（那會把「使用者尚未決定」記成「使用者決定不列入」）。
  '（未設定）': 'unset',
  care: 'care',
  math: 'math',
  english: 'english',
  none: 'none',
  unset: 'unset',
};

/** 匯出時每個班級的**有效**屬性（編輯器已解析使用者的指定與未設定；這裡不再重算一次）。 */
export interface ScheduleExportClassAttr {
  className: string;
  classType?: ClassType;
  category: ClassCategory;
  categorySource?: WritableCategorySource;
  fixedFiveDays: boolean;
}

/** 匯入回傳的一列時段。
 *  #113 follow-up：`skipDeduction` 是**這一列**的旗標，同班多列可各異（只有 classType／category／fixedFiveDays
 *  仍須整班一致，由解析層驗證）。 */
export interface ScheduleImportRow {
  className: string;
  classType: ClassType;
  teacher: string | null;
  weekday: string;
  startTime: string;
  endTime: string;
  category: ClassCategory;
  fixedFiveDays: boolean;
  skipDeduction: boolean;
}

/** 匯入結果：可餵給編輯器取代整份草稿的列，以及每班的屬性。 */
export interface ScheduleImportResult {
  rows: ScheduleImportRow[];
  /** 匯入明確類別為 manual；「（未設定）」保留 unset，不得升格為使用者指定。 */
  classAttrs: Array<{
    className: string;
    classType: ClassType;
    category: ClassCategory;
    categorySource: WritableCategorySource;
    fixedFiveDays: boolean;
  }>;
}

/** 匯入失敗（表頭／內容不符）。message 一律是可直接顯示給使用者的白話。 */
export class ScheduleTableImportError extends Error {
  /** 發生問題的列／欄描述，供錯誤訊息指位（不外露工程字）。 */
  public readonly location: string | null;

  constructor(message: string, location: string | null = null) {
    super(message);
    this.name = 'ScheduleTableImportError';
    this.location = location;
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) {
    // Excel 會把 HH:mm 讀成當日時間；回成 HH:mm 文字（UTC 取值，寫檔時即以 UTC 落盤）
    const h = value.getUTCHours();
    const m = value.getUTCMinutes();
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  if (typeof value === 'number') {
    // Excel 的日期序列值（天數為小數）；轉回 HH:mm
    const totalMinutes = Math.round((value % 1) * 24 * 60);
    if (!Number.isFinite(totalMinutes) || totalMinutes < 0 || totalMinutes >= 24 * 60) return '';
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
  }
  if (typeof value === 'object' && 'result' in (value as Record<string, unknown>)) {
    // ExcelJS 的公式／超連結 cell
    return cellText((value as Record<string, unknown>).result);
  }
  return String(value);
}

function normalizeHeader(value: unknown): string {
  return cellText(value).replace(/\s|　/g, '').trim();
}

/**
 * 產生課表 `.xlsx`（完整欄位，一鍵匯出）。
 * `rows` 是編輯中的平鋪時段列；`classAttrs` 提供每班的有效課程類型、折扣類別與固定 5 天。
 * 僅產出單一「課表」工作表，不包含隱藏工作表。
 */
export async function buildScheduleWorkbook(
  rows: ScheduleGridRow[],
  classAttrs: ScheduleExportClassAttr[]
): Promise<Buffer> {
  const attrsByName = new Map(classAttrs.map((a) => [a.className.trim(), a]));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '學生收費核對工具';
  const sheet = workbook.addWorksheet(SCHEDULE_TABLE_SHEET_NAME);

  sheet.columns = SCHEDULE_TABLE_HEADERS.map((header, i) => ({
    header,
    key: `c${i}`,
    width: i === COLUMN_CLASS_NAME ? 28 : i === COLUMN_CLASS_TYPE ? 16 : i === COLUMN_CATEGORY ? 16 : i === COLUMN_SKIP_DEDUCTION ? 12 : 14,
  }));

  for (const row of rows) {
    const trimmedClassName = row.className.trim();
    const explicitAttr = attrsByName.get(trimmedClassName);
    const effectiveAttr = explicitAttr ?? resolveClassAttributes(trimmedClassName);
    const isCare = effectiveAttr.classType === 'care';

    sheet.addRow({
      c0: row.className,
      c1: isCare ? CLASS_TYPE_CARE_LABEL : CLASS_TYPE_NON_CARE_LABEL,
      // #157：未指定類別匯出為「（未設定）」，不得落回「不列入折扣」（那是另一個決定）。
      c2: CATEGORY_LABELS[effectiveAttr.category ?? 'unset'],
      // specs/14 §3.6 & A11 匯出忠實輸出與欄位防護：
      // 1. 依 D17 照實呈現：天數固定 5 天忠實輸出草稿實際保存的值，若 non_care 帶有 true，由匯入端嚴格把關互斥。
      // 2. 安親課輔班時段在草稿層已被 A5 約束強制為空（sessions: []），故星期、時間留空，不計扣天填「否」，忠實反映草稿保存內容。
      c3: (effectiveAttr.fixedFiveDays ?? false) ? FIXED_FIVE_YES : FIXED_FIVE_NO,
      c4: isCare ? FIXED_FIVE_NO : ((row.skipDeduction ?? false) ? SKIP_DEDUCTION_YES : FIXED_FIVE_NO),
      c5: row.teacher ?? '',
      c6: isCare ? '' : (row.weekday === '—' ? '' : row.weekday),
      c7: isCare ? '' : row.startTime,
      c8: isCare ? '' : row.endTime,
    });
  }

  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function validateTimeCell(value: string, location: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(trimmed)) {
    throw new ScheduleTableImportError(
      `第 ${location} 列的時間格式不正確，請用「時:分」（例如 13:30）或留空。`,
      location
    );
  }
  return trimmed;
}

function parseCategoryCell(value: string, location: string): ClassCategory {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new ScheduleTableImportError(
      `第 ${location} 列的「列入多科折扣」不能空白，請填（未設定）／安親課輔班／數學班／美語班／不列入折扣。`,
      location
    );
  }
  const category = CATEGORY_BY_LABEL[trimmed];
  if (!category) {
    throw new ScheduleTableImportError(
      `第 ${location} 列的「列入多科折扣」不是可辨識的類別，請填（未設定）／安親課輔班／數學班／美語班／不列入折扣。`,
      location
    );
  }
  return category;
}

/**
 * 「是／否」欄位解析（#113：「天數固定5天」與「不計扣天」共用同一組白話值與同一套嚴格驗證）。
 * `columnLabel` 只用於錯誤訊息指位；不接受靜默當成「否」。
 */
function parseYesNoCell(value: string, location: string, columnLabel: string): boolean {
  const trimmed = value.trim();
  if (trimmed === FIXED_FIVE_YES || trimmed === 'true' || trimmed === '1') return true;
  if (trimmed === FIXED_FIVE_NO || trimmed === 'false' || trimmed === '0') return false;
  throw new ScheduleTableImportError(
    `第 ${location} 列的「${columnLabel}」請填「是」或「否」。`,
    location
  );
}

function parseWeekdayCell(value: string, location: string): string {
  const trimmed = value.trim();
  // 留空是合法的（#82：星期可未定）；非空則必須是可識別的星期，否則會變成「需確認」的無效列
  if (trimmed === '') return '';
  const normalized = normalizeWeekday(trimmed);
  if (normalized === null) {
    throw new ScheduleTableImportError(
      `第 ${location} 列的星期無法辨識，請填一到日（或週一到週日），或留空等確定後再填。`,
      location
    );
  }
  return normalized;
}

/**
 * 解析課表 `.xlsx` → 可直接取代草稿的列。
 * 任一列不合法即整批拒絕（`ScheduleTableImportError`），不做部分套用。
 */
export async function parseScheduleWorkbook(input: Buffer | Uint8Array): Promise<ScheduleImportResult> {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs 的型別宣告把 load() 收窄成 DOM 的 ArrayBuffer，實際接受 Buffer；沿用 erp-reader 的處理方式
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new ScheduleTableImportError(
      '無法讀取這個 Excel 檔案，請確認是本工具匯出的課表 .xlsx 檔。'
    );
  }

  const sheet = workbook.worksheets.find((ws) => ws.name === SCHEDULE_TABLE_SHEET_NAME)
    ?? workbook.worksheets[0];
  if (!sheet) {
    throw new ScheduleTableImportError('這個 Excel 檔案裡沒有工作表，無法匯入課表。');
  }

  const headerRow = sheet.getRow(1);
  const missing = SCHEDULE_TABLE_HEADERS.filter(
    (header, i) => normalizeHeader(headerRow.getCell(i + 1).value) !== normalizeHeader(header)
  );
  if (missing.length > 0) {
    throw new ScheduleTableImportError(
      `這個 Excel 的欄位標題不符合課表格式，缺少：${missing.join('、')}。請改用本工具匯出的檔案。`
    );
  }

  const rows: ScheduleImportRow[] = [];
  const attrsByName = new Map<string, { classType: ClassType; category: ClassCategory; fixedFiveDays: boolean }>();
  const rowCount = sheet.rowCount;

  for (let rowNumber = 2; rowNumber <= rowCount; rowNumber++) {
    const excelRow = sheet.getRow(rowNumber);
    const cells = [
      cellText(excelRow.getCell(COLUMN_CLASS_NAME + 1).value),
      cellText(excelRow.getCell(COLUMN_CLASS_TYPE + 1).value),
      cellText(excelRow.getCell(COLUMN_CATEGORY + 1).value),
      cellText(excelRow.getCell(COLUMN_FIXED_FIVE + 1).value),
      cellText(excelRow.getCell(COLUMN_SKIP_DEDUCTION + 1).value),
      cellText(excelRow.getCell(COLUMN_TEACHER + 1).value),
      cellText(excelRow.getCell(COLUMN_WEEKDAY + 1).value),
      cellText(excelRow.getCell(COLUMN_START + 1).value),
      cellText(excelRow.getCell(COLUMN_END + 1).value),
    ];

    // 整列空白＝多餘的空白列，略過（不當成資料列）
    if (cells.every((c) => c.trim() === '')) continue;

    const location = `${rowNumber}`;
    const className = cells[COLUMN_CLASS_NAME].trim();
    if (className === '') {
      throw new ScheduleTableImportError(`第 ${location} 列的「班級名稱」不能空白。`, location);
    }

    const rawClassType = cells[COLUMN_CLASS_TYPE].trim();
    let classType: ClassType;
    if (rawClassType === CLASS_TYPE_CARE_LABEL || rawClassType === 'care') {
      classType = 'care';
    } else if (rawClassType === CLASS_TYPE_NON_CARE_LABEL || rawClassType === 'non_care') {
      classType = 'non_care';
    } else {
      throw new ScheduleTableImportError(
        `第 ${location} 列的「課程類型」請填「安親課輔班」或「非安親課輔班」。`,
        location
      );
    }

    const category = parseCategoryCell(cells[COLUMN_CATEGORY], location);
    const fixedFiveDays = parseYesNoCell(cells[COLUMN_FIXED_FIVE], location, '天數固定5天');
    const skipDeduction = parseYesNoCell(cells[COLUMN_SKIP_DEDUCTION], location, '不計扣天');

    // #113 follow-up：不計扣天是**逐列**的，同班多列可各填各的 → 不列入一致性檢查。
    // 只有仍為整班共用的屬性（課程類型、折扣類別、固定 5 天）必須一致；不一致代表檔案本身矛盾，不靜默取其一。
    const existing = attrsByName.get(className);
    if (existing) {
      if (existing.classType !== classType) {
        throw new ScheduleTableImportError(
          `班級「${className}」在不同列填了不同的課程類型，請先讓它們一致再匯入。`,
          location
        );
      }
      if (existing.category !== category) {
        throw new ScheduleTableImportError(
          `班級「${className}」在不同列填了不同的折扣類別，請先讓它們一致再匯入。`,
          location
        );
      }
      if (existing.fixedFiveDays !== fixedFiveDays) {
        throw new ScheduleTableImportError(
          `班級「${className}」在不同列填了不同的固定 5 天設定，請先讓它們一致再匯入。`,
          location
        );
      }
    } else {
      attrsByName.set(className, { classType, category, fixedFiveDays });
    }

    // specs/14 §3.6 & A11：跨類型欄位嚴格驗證
    if (classType === 'care') {
      const rawWeekday = cells[COLUMN_WEEKDAY].trim();
      const rawStart = cells[COLUMN_START].trim();
      const rawEnd = cells[COLUMN_END].trim();
      if (rawWeekday !== '' || rawStart !== '' || rawEnd !== '') {
        throw new ScheduleTableImportError(
          `第 ${location} 列為安親課輔班，安親課輔班不輸入星期與上課時間，請留空。`,
          location
        );
      }
      if (skipDeduction) {
        throw new ScheduleTableImportError(
          `第 ${location} 列為安親課輔班，安親課輔班不適用「不計扣天」，請填「否」或留空。`,
          location
        );
      }
    } else {
      if (fixedFiveDays) {
        throw new ScheduleTableImportError(
          `第 ${location} 列為非安親課輔班，非安親課輔班不適用「天數固定5天」，請填「否」。`,
          location
        );
      }
    }

    const startTime = validateTimeCell(cells[COLUMN_START], location);
    const endTime = validateTimeCell(cells[COLUMN_END], location);
    if (startTime !== '' && endTime !== '' && timeStringToMinutes(endTime)! <= timeStringToMinutes(startTime)!) {
      throw new ScheduleTableImportError(
        `第 ${location} 列的結束時間必須晚於開始時間，請檢查「${startTime}」與「${endTime}」。`,
        location
      );
    }

    rows.push({
      className,
      classType,
      teacher: cells[COLUMN_TEACHER].trim() === '' ? null : cells[COLUMN_TEACHER].trim(),
      weekday: parseWeekdayCell(cells[COLUMN_WEEKDAY], location),
      startTime,
      endTime,
      category,
      fixedFiveDays,
      skipDeduction,
    });
  }

  if (rows.length === 0) {
    throw new ScheduleTableImportError('這個 Excel 檔案裡沒有任何課表資料列。');
  }

  const classAttrs: ScheduleImportResult['classAttrs'] = [...attrsByName.entries()].map(([className, a]) => ({
    className,
    classType: a.classType,
    category: a.category,
    categorySource: a.category === 'unset' ? ('unset' as const) : ('manual' as const),
    fixedFiveDays: a.fixedFiveDays,
  }));

  return {
    rows,
    classAttrs,
  };
}

/** 匯入結果 → 平鋪時段列（帶分鐘數與穩定 rowId）。屬性另外交給編輯器的 manualAttrs。 */
export function scheduleImportRowsToGridRows(result: ScheduleImportResult): ScheduleGridRow[] {
  return result.rows.map((r, i) => ({
    rowId: `import-row-${i + 1}`,
    className: r.className,
    teacher: r.teacher,
    weekday: r.weekday,
    startTime: r.startTime,
    endTime: r.endTime,
    startMinutes: timeStringToMinutes(r.startTime),
    endMinutes: timeStringToMinutes(r.endTime),
    active: true,
    // #113 follow-up：逐列帶入該列自己的不計扣天
    skipDeduction: r.skipDeduction ?? false,
  }));
}
