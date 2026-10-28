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
  CLASS_TYPE_LABELS,
  isSchedulableClassType,
  supportsMultiSubjectDiscount,
} from '@/contracts/settings';
import { timeStringToMinutes } from '@/contracts/settings';
import type { ClassCategory, WritableCategorySource } from '@/domain/classification/class-category';
import { deriveEffectiveCategory } from '@/domain/classification/class-category';
import { resolveClassAttributes } from '@/domain/classification/class-attributes';
import { normalizeWeekday } from '@/domain/schedules/overlap-calculator';

/** 匯出／匯入的完整表頭；順序即欄位順序，兩邊共用同一份（不各寫一份，避免漂移）。
 *  D61 Phase 2：全量升級至 9 欄契約（「是否有多科折扣」取代舊「列入多科折扣」）。 */
export const SCHEDULE_TABLE_HEADERS = [
  '班級名稱',
  '課程類型',
  '是否有多科折扣',
  '天數固定5天',
  '不計扣天',
  '帶班老師',
  '星期',
  '開始時間',
  '結束時間',
] as const;

const COLUMN_CLASS_NAME = 0;
const COLUMN_CLASS_TYPE = 1;
const COLUMN_HAS_MULTI_DISCOUNT = 2;
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

/** 課程類型的白話名稱與內部值對應 */
export const CLASS_TYPE_LABELS_MAP: Record<string, ClassType> = {
  安親課輔班: 'care',
  美語班: 'english',
  數學班: 'math',
  其他班: 'other',
  不排課: 'unscheduled',
  care: 'care',
  english: 'english',
  math: 'math',
  other: 'other',
  unscheduled: 'unscheduled',
};

/** 匯出時每個班級的**有效**屬性（編輯器已解析使用者的指定與未設定；這裡不再重算一次）。 */
export interface ScheduleExportClassAttr {
  className: string;
  classType?: ClassType | 'non_care';
  hasMultiSubjectDiscount?: boolean;
  category: ClassCategory;
  categorySource?: WritableCategorySource;
  fixedFiveDays: boolean;
}

/** 匯入回傳的一列時段。
 *  #113 follow-up：`skipDeduction` 是**這一列**的旗標，同班多列可各異（只有 classType／category／fixedFiveDays
 *  仍須整班一致，由解析層驗證）。 */
export interface ScheduleImportRow {
  className: string;
  classType: ClassType | 'non_care';
  teacher: string | null;
  weekday: string;
  startTime: string;
  endTime: string;
  hasMultiSubjectDiscount?: boolean;
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
    classType: ClassType | 'non_care';
    hasMultiSubjectDiscount?: boolean;
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
 * `rows` 是編輯中的平鋪時段列；`classAttrs` 提供每班的有效課程類型、是否有多科折扣與固定 5 天。
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
    width:
      i === COLUMN_CLASS_NAME
        ? 28
        : i === COLUMN_CLASS_TYPE
          ? 16
          : i === COLUMN_HAS_MULTI_DISCOUNT
            ? 16
            : i === COLUMN_SKIP_DEDUCTION
              ? 12
              : 14,
  }));

  for (const row of rows) {
    const trimmedClassName = row.className.trim();
    const explicitAttr = attrsByName.get(trimmedClassName);
    const effectiveAttr = explicitAttr ?? resolveClassAttributes(trimmedClassName);
    const rawType = effectiveAttr.classType ?? 'other';
    const effectiveClassType: ClassType = rawType === 'non_care' ? 'other' : rawType;
    const isCare = effectiveClassType === 'care';
    const isSchedulable = isSchedulableClassType(effectiveClassType);

    // 是否有多科折扣：other 與 unscheduled 固定輸出 否
    const hasMulti =
      supportsMultiSubjectDiscount(effectiveClassType) &&
      (effectiveAttr.hasMultiSubjectDiscount ?? true);

    // 天數固定 5 天：忠實輸出草稿實際保存的值（D17）；若非安親課輔班帶有 true，由匯入端嚴格把關互斥
    const fixedFive = effectiveAttr.fixedFiveDays ?? false;

    // 不計扣天：僅排課類型（english, math, other）支援；care 與 unscheduled 固定 否
    const skipDed = isSchedulable && (row.skipDeduction ?? false);

    sheet.addRow({
      c0: row.className,
      c1: CLASS_TYPE_LABELS[effectiveClassType] ?? effectiveClassType,
      c2: hasMulti ? FIXED_FIVE_YES : FIXED_FIVE_NO,
      c3: fixedFive ? FIXED_FIVE_YES : FIXED_FIVE_NO,
      c4: skipDed ? SKIP_DEDUCTION_YES : FIXED_FIVE_NO,
      c5: row.teacher ?? '',
      c6: !isSchedulable ? '' : (row.weekday === '—' ? '' : row.weekday),
      c7: !isSchedulable ? '' : row.startTime,
      c8: !isSchedulable ? '' : row.endTime,
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
  const attrsByName = new Map<
    string,
    { classType: ClassType; hasMultiDiscount: boolean; fixedFiveDays: boolean }
  >();
  const rowCount = sheet.rowCount;

  for (let rowNumber = 2; rowNumber <= rowCount; rowNumber++) {
    const excelRow = sheet.getRow(rowNumber);
    const cells = [
      cellText(excelRow.getCell(COLUMN_CLASS_NAME + 1).value),
      cellText(excelRow.getCell(COLUMN_CLASS_TYPE + 1).value),
      cellText(excelRow.getCell(COLUMN_HAS_MULTI_DISCOUNT + 1).value),
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
    const classType = CLASS_TYPE_LABELS_MAP[rawClassType];
    if (!classType) {
      throw new ScheduleTableImportError(
        `第 ${location} 列的「課程類型」請填「安親課輔班」、「美語班」、「數學班」、「其他班」或「不排課」。`,
        location
      );
    }

    const hasMultiDiscount = parseYesNoCell(cells[COLUMN_HAS_MULTI_DISCOUNT], location, '是否有多科折扣');
    const fixedFiveDays = parseYesNoCell(cells[COLUMN_FIXED_FIVE], location, '天數固定5天');
    const skipDeduction = parseYesNoCell(cells[COLUMN_SKIP_DEDUCTION], location, '不計扣天');

    // 只有整班共用的屬性（課程類型、是否有多科折扣、固定 5 天）必須一致；不一致代表檔案本身矛盾，不靜默取其一。
    const existing = attrsByName.get(className);
    if (existing) {
      if (existing.classType !== classType) {
        throw new ScheduleTableImportError(
          `班級「${className}」在不同列填了不同的課程類型，請先讓它們一致再匯入。`,
          location
        );
      }
      if (existing.hasMultiDiscount !== hasMultiDiscount) {
        throw new ScheduleTableImportError(
          `班級「${className}」在不同列填了不同的多科折扣設定，請先讓它們一致再匯入。`,
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
      attrsByName.set(className, { classType, hasMultiDiscount, fixedFiveDays });
    }

    // specs/16 §3.6 & A11 & D61 Phase 2：跨類型欄位嚴格驗證
    const rawWeekday = cells[COLUMN_WEEKDAY].trim();
    const rawStart = cells[COLUMN_START].trim();
    const rawEnd = cells[COLUMN_END].trim();
    const hasTimeInput = rawWeekday !== '' || rawStart !== '' || rawEnd !== '';

    if (classType === 'care') {
      if (hasTimeInput) {
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
    } else if (classType === 'english' || classType === 'math') {
      if (fixedFiveDays) {
        throw new ScheduleTableImportError(
          `第 ${location} 列為${CLASS_TYPE_LABELS[classType]}，${CLASS_TYPE_LABELS[classType]}不適用「天數固定5天」，請填「否」。`,
          location
        );
      }
    } else if (classType === 'other') {
      if (hasMultiDiscount) {
        throw new ScheduleTableImportError(
          `第 ${location} 列為其他班，其他班不適用「是否有多科折扣」，請填「否」。`,
          location
        );
      }
      if (fixedFiveDays) {
        throw new ScheduleTableImportError(
          `第 ${location} 列為其他班，其他班不適用「天數固定5天」，請填「否」。`,
          location
        );
      }
    } else if (classType === 'unscheduled') {
      if (hasTimeInput) {
        throw new ScheduleTableImportError(
          `第 ${location} 列為不排課班級，不排課班級不輸入星期與上課時間，請留空。`,
          location
        );
      }
      if (hasMultiDiscount || fixedFiveDays || skipDeduction) {
        throw new ScheduleTableImportError(
          `第 ${location} 列為不排課班級，不排課班級不適用「是否有多科折扣」、「天數固定5天」或「不計扣天」，請填「否」。`,
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

    const category = deriveEffectiveCategory(classType, hasMultiDiscount);

    rows.push({
      className,
      classType,
      teacher: cells[COLUMN_TEACHER].trim() === '' ? null : cells[COLUMN_TEACHER].trim(),
      weekday: parseWeekdayCell(cells[COLUMN_WEEKDAY], location),
      startTime,
      endTime,
      hasMultiSubjectDiscount: hasMultiDiscount,
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
    hasMultiSubjectDiscount: a.hasMultiDiscount,
    category: deriveEffectiveCategory(a.classType, a.hasMultiDiscount),
    categorySource: 'manual' as const,
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
