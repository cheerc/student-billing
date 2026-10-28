import path from 'path';
import ExcelJS from 'exceljs';
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * 批次 C（F07 離頁提醒／F08 文案／O02 日期；specs/11 §3 C、04 §8 UX31–UX33）的 E2E 共用工具。
 * 全部使用合成資料；不含任何真實名單。
 */

export const FIXTURE = path.resolve(__dirname, '../../fixtures/conforming-erp-fixture.xlsx');
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 離頁確認視窗（09 §3.2；D38 F07）的名稱與兩個選項。 */
export const LEAVE_TITLE = '有尚未儲存的課表修改';
export const leaveDialog = (page: Page): Locator => page.getByRole('dialog', { name: LEAVE_TITLE });
export const keepEditing = (page: Page): Locator => leaveDialog(page).getByRole('button', { name: '繼續編輯' });
export const discardChanges = (page: Page): Locator => leaveDialog(page).getByRole('button', { name: '捨棄修改' });

/** 側欄與品牌連結（站內離開入口）。 */
export const sideLink = (page: Page, name: RegExp): Locator => page.locator('aside.side').getByRole('link', { name });
export const brandLink = (page: Page): Locator => page.locator('aside.side .brand a');

/** 課表頁：第 4 列（兒童美語-Gino 週一）的起始時間輸入框；改它就是一次有效的課表草稿。 */
export const scheduleHeading = (page: Page): Locator => page.locator('h1', { hasText: '課表設定' });
export const startInput = (page: Page): Locator =>
  page.locator('.schedule-table tbody tr input.input-time').first();
export const dirtyBar = (page: Page): Locator => page.locator('.save-status-dirty');

/**
 * 以「使用者實際操作」修改草稿：先切換至排課頁籤點進輸入框，再輸入。
 */
export async function editStart(page: Page, value = '15:45', input?: Locator): Promise<void> {
  const englishTab = page.locator('#class-type-tab-english');
  if (await englishTab.isVisible()) {
    const isCare = await page.locator('#class-type-tab-care').getAttribute('aria-selected');
    if (isCare === 'true') {
      await englishTab.click();
    }
  }
  const target = input ?? startInput(page);
  await target.click();
  await target.fill(value);
  await expect(dirtyBar(page)).toBeVisible();
}

export async function openSchedule(page: Page, url = '/settings'): Promise<void> {
  await page.goto(url);
  await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
  const englishTab = page.locator('#class-type-tab-english');
  if (await englishTab.isVisible()) {
    await englishTab.click();
  }
  await expect(startInput(page)).toBeVisible();
}

/** 上傳合成名冊並使用這份名單（頁內啟用），直到核對結果頁出現。已有現行資料時直接略過。 */
export async function activateFixture(page: Page): Promise<void> {
  const res = await page.request.get('/api/v1/runs/current');
  if (res.ok()) {
    const j = await res.json().catch(() => null);
    if (j?.activeRunId) return;
  }
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.locator('button', { hasText: '使用這份名單' })).toBeVisible({ timeout: 15000 });
  await page.locator('button', { hasText: '使用這份名單' }).click();
  await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
}

/** 匯入頁檔案輸入（.xlsx）。 */
export function xlsxUpload(name: string, buffer: Buffer): { name: string; mimeType: string; buffer: Buffer } {
  return { name, mimeType: XLSX_MIME, buffer };
}

/** 損毀檔案：副檔名是 .xlsx，內容不是 ZIP。 */
export const brokenXlsx = (): Buffer => Buffer.from('this is not a zip archive');

async function workbookBuffer(rows: Array<Array<string | number>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 合法的 xlsx，但沒有米豆奶匯出的必要欄位。 */
export const missingHeadersXlsx = (): Promise<Buffer> => workbookBuffer([['甲', '乙', '丙'], [1, 2, 3]]);

/** 欄位齊全，但同一個人員代碼出現兩列。 */
export const duplicateCodeXlsx = (): Promise<Buffer> =>
  workbookBuffer([
    ['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註'],
    ['DUP001', '合成甲', '合成分校', '', '一年級', '', ''],
    ['DUP001', '合成乙', '合成分校', '', '一年級', '', ''],
  ]);

/** 與產品相同的顯示規則：Asia/Taipei、YYYY-MM-DD HH:mm（測試自備，不引用產品程式）。 */
export function formatTaipei(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** 全站日期時間格式（O02／UX33）。 */
export const DATETIME_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
