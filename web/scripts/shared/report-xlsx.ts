/**
 * 共用層：財務報表 XLSX 的科目解析。
 *
 * 這裡只處理「報表長什麼樣」——欄位位置、科目文字、折價率字串；
 * 完全不知道級距代表幾天、哪個科目該對到哪一種計價方式。
 * 業務判斷留在各自的工具端。
 *
 * 折扣率以 bps 表示（basis point，10000 = 無折扣）。
 * 用整數而非百分比浮點，是為了避免 0.9 × 100 的浮點誤差讓
 * 「報表 9 折 vs 系統無折扣」這種明確差異被誤判為相等。
 */

/**
 * ExcelJS 儲存格的文字內容。
 *
 * 空儲存格的 `.text` 為 undefined，而 `?.trim()` 只會縮短字串、不會把 undefined
 * 變成空字串。此處**刻意保留 undefined 而不補成 ''**：原本的 .mjs 就是這樣把值
 * 推進 Map 的；補成 '' 會讓「該欄為空」與「該欄有一個空字串」變得無法區分。
 * 忠實保留原語意，是這次抽取的硬要求。
 */
export type CellText = string | undefined;

/** 報表欄位值：可能為 null（尚未賦值）或 undefined（來源儲存格為空）。 */
export type ReportField = string | null | undefined;

/** 一列折扣明細的解析結果。 */
export interface DiscountParse {
  /** 課程適用的折扣率（bps）；無折扣為 10000。 */
  rateBps: number;
  /** 認出折價率的原始明細；無則 null。 */
  rateDetail: ReportField;
  /**
   * 'parsed' 認得格式、'none' 全是獨立優惠項、'unknown' 見到課程費字樣卻認不出數字。
   *
   * unknown 必須與「確定無折扣」區分：前者是報表格式變了，
   * 不能當成沒折扣（review F3）。
   */
  rateParseStatus: 'parsed' | 'none' | 'unknown';
  /** 見到「課程費」字樣卻認不出折價率的明細。 */
  unparsedCourseFee: CellText[];
  /** 非「課程費 NN折」的獨立優惠項（普測優惠、訂金等）。 */
  extraDiscounts: CellText[];
}

/** 一名學生在報表中的彙整結果。 */
export interface ReportStudentEntry {
  name: string;
  /** 該科目所對應的學費明細原文；無則 null。 */
  tuition: ReportField;
  /** 全部折扣科目明細（依報表列順序）。 */
  discounts: CellText[];
  /** 其他會計科目（雜費、車資、退費等），與課程費折扣無關。 */
  other: CellText[];
  /** 折扣科目內非「課程費 NN折」的獨立優惠項。 */
  otherDiscounts: CellText[];
  billNo: ReportField;
  billDate: ReportField;
  billStatus: ReportField;
}

/**
 * 「課程費 NN折」白名單。
 *
 * 這是報表端的**字串格式**白名單，與產品端的收費級距解析無關，
 * 因此放在共用層合理。新增格式時只動這一處。
 */
export const RATE_PATTERNS: ReadonlyArray<readonly [RegExp, number]> = [
  [/課程費\s*95\s*折/, 9500],
  [/課程費\s*9\s*折/, 9000],
  [/課程費\s*85\s*折/, 8500],
  [/課程費\s*8\s*折/, 8000],
  [/課程費\s*7\s*折/, 7000],
];

/**
 * 比對白名單。
 *
 * `RegExp.prototype.test` 依規範會先把引數 ToString，因此對 undefined 相當於
 * 比對字串 "undefined"——不會命中任何一條白名單。這正是原始 .mjs 的行為，
 * 故以型別斷言明確記錄，而不是用 `?? ''` 悄悄改變它。
 */
function hitsRatePattern(d: CellText): boolean {
  return RATE_PATTERNS.some(([re]) => re.test(d as string));
}

/** 回傳命中的 bps；未命中為 null。 */
function matchRateBps(d: CellText): number | null {
  const hit = RATE_PATTERNS.find(([re]) => re.test(d as string));
  return hit ? hit[1] : null;
}

/** bps → 報表顯示文字。無折扣明確寫出「無折扣 (100%)」而非空白。 */
export function bpsToLabel(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '-';
  if (bps === 10000) return '無折扣 (100%)';
  const zhe = (bps / 1000).toFixed(1).replace(/\.0$/, '');
  return `${zhe}折 (${bps / 100}%)`;
}

export function parseDiscounts(details: readonly CellText[]): DiscountParse {
  let rateBps = 10000;
  let rateDetail: ReportField = null;
  const extraDiscounts: CellText[] = [];
  for (const d of details) {
    const bps = matchRateBps(d);
    if (bps !== null) {
      rateBps = bps;
      rateDetail = d;
    } else {
      extraDiscounts.push(d);
    }
  }
  // 見到「課程費」字樣卻無任何白名單命中 → 報表出現新格式，不可當成無折扣（review F-NEW-4）。
  // 判定放在迴圈之後，讓結果與明細順序無關：
  // 「未知格式 + 已解析格式」並存時，只要有任何一筆認不出，就維持 unknown。
  const unparsedCourseFee = details.filter(
    (d) => /課程費/.test(d as string) && !hitsRatePattern(d),
  );
  const rateParseStatus = rateDetail === null
    ? (details.some((d) => /課程費/.test(d as string)) ? 'unknown' : 'none')
    : (unparsedCourseFee.length > 0 ? 'unknown' : 'parsed');
  return { rateBps, rateDetail, rateParseStatus, unparsedCourseFee, extraDiscounts };
}

/**
 * 報表中「該科目代表學費明細」的判定依據。
 *
 * 語意隨工具而異：國小輔導工具只看「學費」科目；按堂計價工具的對應科目不同。
 * 抽成參數是為了讓共用層不必知道任一工具的科目語意。
 */
export interface ReportSubjects {
  /** 學費科目名，例如 '學費'。 */
  tuition: string;
  /** 折扣科目名，例如 '折扣'。 */
  discount: string;
}

/** ExcelJS 的列介面，只宣告本模組實際使用的方法。 */
export interface WorksheetLike {
  eachRow(callback: (row: ExcelRowLike, rowNumber: number) => void): void;
}

export interface ExcelRowLike {
  getCell(n: number): { text: CellText };
}

/**
 * 讀取報表工作表 → 以姓名為鍵的學生彙整表。
 *
 * 欄位位置（1=姓名、2=單號、3=日期、4=明細、7=科目、8=狀態）是米豆奶
 * 財務報表的固定版面，非本專案可自由更動的格式。
 *
 * 同名多列以**先出現者**為準（`??=`），不覆寫先取得的帳單欄位；
 * 學費與折扣則累加，因為同一名學生可能在不同科目列各有一筆。
 */
export function readReport(
  worksheet: WorksheetLike,
  subjects: ReportSubjects,
): Map<string, ReportStudentEntry> {
  const students = new Map<string, ReportStudentEntry>();
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // 第 1 列為表頭
    const name = row.getCell(1).text?.trim();
    if (!name) return;
    const entry: ReportStudentEntry = students.get(name) ?? {
      name, tuition: null, discounts: [], other: [], otherDiscounts: [],
      billNo: null, billDate: null, billStatus: null,
    };
    const detail = row.getCell(4).text?.trim();
    const subject = row.getCell(7).text?.trim();
    entry.billNo ??= row.getCell(2).text?.trim();
    entry.billDate ??= row.getCell(3).text?.trim();
    entry.billStatus ??= row.getCell(8).text?.trim();
    if (subject === subjects.tuition) {
      entry.tuition = detail;
    } else if (subject === subjects.discount) {
      entry.discounts.push(detail);
      // 折扣科目內，未被「課程費 NN折」認列者（如普測優惠、訂金）為額外獨立折扣項
      if (detail && !hitsRatePattern(detail)) entry.otherDiscounts.push(detail);
    } else {
      entry.other.push(detail);
    }
    students.set(name, entry);
  });
  return students;
}
