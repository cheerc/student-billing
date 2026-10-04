import ExcelJS from 'exceljs';
import { expect, type Page } from '@playwright/test';

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

/** 讀出一份課表 xlsx 的資料列（不含表頭），每列七個儲存格轉成字串。 */
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
