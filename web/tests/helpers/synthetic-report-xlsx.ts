import ExcelJS from 'exceljs';

/**
 * 合成財務報表 fixture（issue #140 第 1 項、#231 Phase 1 擴充）。
 *
 * ## 為什麼不用真實報表
 *
 * 真實報表含姓名、人員代碼與實際帳務，依 CLAUDE.md §3 不得進 Git／CI。
 * 但 `main()` 的接線測試需要一份**真的能被 ExcelJS 讀進來**的 xlsx——
 * 這正是關鍵：`readReport` 收的是 `WorksheetLike`，測試很容易用一個
 * `{ eachRow }` 的假物件騙過去，那樣驗到的是「假物件能不能餵 compare()」，
 * 而不是「ExcelJS 解出來的東西能不能餵 compare()」。本檔一律寫真檔案。
 *
 * ## 欄位位置
 *
 * 1=姓名、2=單號、3=日期、4=明細、7=科目、8=狀態（米豆奶財務報表固定版面，
 * 見 `scripts/shared/report-xlsx.ts` 的 `collectEntries`）。第 1 列為表頭。
 * 欄 9 起為班別金額欄與「非學費費用」欄。
 *
 * 本檔產生的內容全部是 `測試生` 這類明顯合成的字串，不含任何真實姓名。
 */

/** 報表科目名稱（與 `REPORT_SUBJECTS` 同源，不在此另行定義一份真相）。 */
const SUBJECT_TUITION = '學費';
const SUBJECT_DISCOUNT = '折扣';

export interface SyntheticReportRow {
  name: string;
  billNo?: string;
  billDate?: string;
  /** 欄 4：明細文字（學費為「班名 - N 堂課」，折扣為「班名 - N折」）。 */
  detail: string;
  /** 欄 7：學費／折扣。 */
  subject: string;
  billStatus?: string;
}

/** 一個 ExcelJS 可寫入的儲存格值。 */
type CellValue = string | number | null;

/** grid 內未給的欄位補 `null`，`getCell(n).text` 才不會是 undefined。 */
export function writeSyntheticReportGrid(grid: CellValue[][], filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('班級營收狀況');
  for (const row of grid) ws.addRow(row);
  return workbook.xlsx.writeFile(filePath);
}

/** 表頭列（欄 1..8），其餘為空。 */
function headerRow(): CellValue[] {
  return ['姓名', '單號', '日期', '明細', null, null, '科目', '狀態'];
}

/**
 * 產生一份最小但**完整可解析**的輔導報表：一位學生、一筆學費、一筆折扣。
 *
 * @param classToken 學費明細裡的班名（含級距修飾），例如 `115國小輔導-三年級[團][3]`
 * @param rateDetail 折扣明細文字，例如 `課程費 9折`
 */
export async function writeSyntheticBillingReport(
  filePath: string,
  {
    name = '測試生',
    className,
    rateDetail,
  }: { name?: string; className: string; rateDetail: string }
): Promise<void> {
  const grid: (string | number | null)[][] = [
    headerRow(),
    [name, 'B0001', '2026-10-01', `${className} - 40 堂課`, null, null, SUBJECT_TUITION, '已開單'],
    [name, 'B0001', '2026-10-01', `${className} - ${rateDetail}`, null, null, SUBJECT_DISCOUNT, '已開單'],
  ];
  await writeSyntheticReportGrid(grid, filePath);
}

/**
 * 產生一份可被 `readMultiTuitionReport` 解析的報表（按堂計價工具）。
 *
 * 金額欄（欄 9..）留空：本測試只關心折扣，且 CLAUDE.md §9.3 明訂工具不比對金額。
 */
export async function writeSyntheticSessionsReport(
  filePath: string,
  {
    name = '測試生',
    tuitionRows,
    rateDetail,
  }: { name?: string; tuitionRows: string[]; rateDetail: string }
): Promise<void> {
  const grid: (string | number | null)[][] = [headerRow()];
  for (const detail of tuitionRows) {
    grid.push([name, 'B0001', '2026-10-01', detail, null, null, SUBJECT_TUITION, '已開單']);
  }
  grid.push([name, 'B0001', '2026-10-01', rateDetail, null, null, SUBJECT_DISCOUNT, '已開單']);
  await writeSyntheticReportGrid(grid, filePath);
}

export interface SyntheticStudentEntry {
  name: string;
  billNo?: string;
  billDate?: string;
  billStatus?: string;
  tuitionRows?: Array<{ detail: string; amount?: number | null; className?: string }>;
  discounts?: string[];
  ancillaryRows?: Array<{ subject: string; detail: string; amount?: number | null }>;
}

/**
 * 產生包含多位學生、學費欄位、非學費項目（書籍費、商品）之完整合成報表。
 */
export async function writeSyntheticMultiStudentReport(
  filePath: string,
  students: SyntheticStudentEntry[],
  options: {
    classHeadings?: string[];
    nonTuitionHeading?: string;
  } = {}
): Promise<void> {
  const classHeadings = options.classHeadings ?? [];
  const nonTuitionHeading = options.nonTuitionHeading ?? '非學費費用';
  const headers: CellValue[] = [
    '姓名', '單號', '日期', '明細', null, null, '科目', '狀態',
    ...classHeadings,
    nonTuitionHeading,
  ];

  const grid: CellValue[][] = [headers];
  const nonTuitionColIdx = 8 + classHeadings.length; // 0-based in grid

  for (const s of students) {
    const billNo = s.billNo ?? 'B0001';
    const billDate = s.billDate ?? '2026-10-01';
    const billStatus = s.billStatus ?? '已開單';

    // 學費列
    for (const t of s.tuitionRows ?? []) {
      const row: CellValue[] = [s.name, billNo, billDate, t.detail, null, null, SUBJECT_TUITION, billStatus];
      for (const h of classHeadings) {
        if (t.className && h === t.className && t.amount != null) {
          row.push(t.amount);
        } else {
          row.push(null);
        }
      }
      row.push(null); // non-tuition column
      grid.push(row);
    }

    // 折扣列
    for (const d of s.discounts ?? []) {
      const row: CellValue[] = [s.name, billNo, billDate, d, null, null, SUBJECT_DISCOUNT, billStatus];
      for (let i = 0; i <= classHeadings.length; i++) row.push(null);
      grid.push(row);
    }

    // 附加費用列（書籍費、教材、商品等）
    for (const a of s.ancillaryRows ?? []) {
      const row: CellValue[] = [s.name, billNo, billDate, a.detail, null, null, a.subject, billStatus];
      for (let i = 0; i < classHeadings.length; i++) row.push(null);
      row.push(a.amount ?? null);
      grid.push(row);
    }
  }

  await writeSyntheticReportGrid(grid, filePath);
}
