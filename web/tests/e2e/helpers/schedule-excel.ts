import ExcelJS from 'exceljs';
import { expect, type Page } from '@playwright/test';
import { SCHEDULE_TABLE_HEADERS } from '@/adapters/xlsx/schedule-table-io';

/**
 * #81 E2E 輔助：真實下載／上傳，以及把匯出檔的**資料列**讀出來做值層級比對。
 *
 * 為什麼不比 zip 位元組：ExcelJS 寫出的 zip 帶檔案時間戳，兩次匯出的位元組必然不同，
 * 用位元組比對會得到一個「實作是對的、測試是錯的」的红。真正要證明的是
 * 「匯出→匯入→匯出，資料沒有漂移」，所以比對的是資料列本身。
 */

/** 點［匯出 Excel］並取回檔案內容（走真實的下載事件，不是假造的 Buffer）。 */
export async function exportBuffer(page: Page): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('[data-schedule-export]').click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path, '匯出應產生實際檔案').toBeTruthy();
  return Buffer.from(await download.createReadStream().then(readAll));
}

function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** 匯出檔的 MIME（匯入端會比對副檔名／型別，這裡與真實下載一致）。 */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 把一份課表 xlsx 原樣餵回「匯入 Excel」，並等到成功 toast。 */
export async function importBuffer(
  page: Page,
  buffer: Buffer,
  name = '課表.xlsx'
): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: XLSX_MIME, buffer });
  await expect(page.locator('#toast')).toContainText('已匯入課表', { timeout: 15000 });
}

/**
 * 透過「匯出 Excel → 改一格 → 匯入 Excel」改變課表設定。
 *
 * D61（R-188-P2）：既有班級的**課程類型**沒有 UI 選單——既有列只有 YesNoRadioGroup，
 * 改類型只能走 Excel 匯出入（UX106／UX109）。這個檔案是「本工具匯出格式」的單一定義處，
 * 所以突變點集中在這裡，呼叫端不必各自猜欄序。
 */
export async function mutateExport(
  page: Page,
  change: (rows: string[][]) => void
): Promise<void> {
  const rows = await readScheduleRows(await exportBuffer(page));
  const before = rows.map((r) => [...r]);
  change(rows);
  expect(rows, 'mutateExport 必須真的改到匯出資料（否則後面的斷言只是在驗原檔）').not.toEqual(before);
  await importBuffer(page, await buildScheduleWorkbookFromRows(rows));
}

/** 以匯出的表頭形狀重寫整份課表檔（值全部是字串，與解析端的白話值一致）。 */
async function buildScheduleWorkbookFromRows(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('課表');
  ws.addRow([...SCHEDULE_TABLE_HEADERS]);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 匯出檔的欄位索引（與 `SCHEDULE_TABLE_HEADERS` 同序）。 */
export const SCHEDULE_COLUMNS = {
  className: 0,
  classType: 1,
  hasMultiDiscount: 2,
  fixedFiveDays: 3,
  skipDeduction: 4,
  teacher: 5,
  weekday: 6,
  start: 7,
  end: 8,
} as const;

/** 改「課程類型」欄；`other → 數學班` 這種既有班改類型就是這樣走。 */
export function setRowClassType(
  rows: string[][],
  className: string,
  classTypeLabel: string
): void {
  let hit = 0;
  for (const row of rows) {
    if (row[SCHEDULE_COLUMNS.className]?.trim() !== className) continue;
    row[SCHEDULE_COLUMNS.classType] = classTypeLabel;
    hit += 1;
  }
  expect(hit, `匯出檔裡找不到班級「${className}」，無法改類型`).toBeGreaterThan(0);
}

/** 讀出某班在匯出檔中的「是否有多科折扣」值（是／否），確認突變真的落在正確的班。 */
export function multiDiscountOf(rows: string[][], className: string): string[] {
  return rows
    .filter((row) => row[SCHEDULE_COLUMNS.className]?.trim() === className)
    .map((row) => row[SCHEDULE_COLUMNS.hasMultiDiscount]?.trim() ?? '');
}

/**
 * 改「是否有多科折扣」欄（是／否）。
 * D61 的類別是 (課程類型, 多科折扣) 的投影：同類型下多科折扣=是 → 該類型；=否 → none。
 */
export function setRowMultiDiscount(
  rows: string[][],
  className: string,
  yes: boolean
): void {
  let hit = 0;
  for (const row of rows) {
    if (row[SCHEDULE_COLUMNS.className]?.trim() !== className) continue;
    row[SCHEDULE_COLUMNS.hasMultiDiscount] = yes ? '是' : '否';
    hit += 1;
  }
  expect(hit, `匯出檔裡找不到班級「${className}」，無法改多科折扣`).toBeGreaterThan(0);
}

/** 讀出「課表」工作表的資料列（不含表頭），每列九個儲存格轉成字串。 */
export async function readScheduleRows(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('匯出檔沒有工作表');

  const rows: string[][] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const cells = (ws.getRow(r).values as unknown[]).slice(1);
    rows.push(cells.map((v) => (v === null || v === undefined ? '' : String(v))));
  }
  return rows;
}
