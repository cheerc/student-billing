import path from 'path';
import ExcelJS from 'exceljs';
import { expect, type Locator, type Page } from '@playwright/test';
import { classRow, ensureClassTypeTab } from './d2c-settings';

/**
 * 排課列／頁籤定位的單一入口在 `d2c-settings`；這裡轉出，讓 spec 只需要認識一個 helper 模組。
 * 兩份檔案不各自複製頁籤邏輯（見 specs/17 §2）。
 */
export { classRow, classRows, ensureClassTypeTab } from './d2c-settings';

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

/**
 * 課表頁上「兒童美語-Gino 週一 15:20–16:50」那一列的起始時間輸入框。
 *
 * ⚠️ 這個預設值是 seed 約定，集中在這裡唯一一處（來源：`domain/schedules/seed-manifest.ts`
 * 的 `兒童美語-Gino`，該班 3 個時段、首列週一 15:20–16:50）。D61 之前它等價於
 * 「`.schedule-table tbody tr` 的 nth(3)」；改名或移除 seed 時，這一個常數是唯一需要改的地方。
 * 直接寫 `page.locator('input.input-time').first()` **不保證**指向同一列——D61 起一頁籤一張表，
 * 預設安親頁籤根本沒有時段欄。
 */
export const startInput = (page: Page, className = '兒童美語-Gino'): Locator =>
  classRow(page, className).locator('input.input-time').first();

/** 某班第一列的重疊／扣除計算欄（以 `data-calc` 意義定位，不用 td 索引）。 */
export const calcCell = (page: Page, className: string, column: string): Locator =>
  classRow(page, className).locator(`[data-calc="${column}"]`);

export const scheduleHeading = (page: Page): Locator => page.locator('h1', { hasText: '課表設定' });
export const dirtyBar = (page: Page): Locator => page.locator('.save-status-dirty');

/**
 * 以產品原生的 `?class=` 深連結（09 §3.1）開啟課表：伺服器會依該班類型選好頁籤
 * （`schedule-grid.tsx` 的 `initialTab`），helper 再確認班列真的可見才回傳。
 *
 * 回傳該班**第一列**；需要全部時段列請改用 `classRows(page, className)`。
 */
export async function openClassSchedule(page: Page, className: string): Promise<Locator> {
  await page.goto(`/settings?class=${encodeURIComponent(className)}`);
  await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#class-type-tab-care')).toBeVisible({ timeout: 15000 });
  return ensureClassTypeTab(page, className);
}

/**
 * 需要瀏覽器歷史（Back／離開守衛）時使用：先到 `/`，再由側欄進課表，
 * 最後切到該班所在頁籤。**不要**用深連結——`goto` 會把 `/` 換掉，goBack 就沒有上一頁。
 */
export async function openClassScheduleViaHome(page: Page, className: string): Promise<Locator> {
  await page.goto('/');
  await expect(page.locator('main')).toBeVisible({ timeout: 15000 });
  await sideLink(page, /課表設定/).click();
  await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
  return ensureClassTypeTab(page, className);
}

/**
 * 需要看見**整張**排課表（同頁籤其他班也在）時使用：`?class=` 會進入聚焦模式，
 * 只列該班時段（09 §3.1），鄰班案例在那裡根本不存在。此函式不帶深連結，
 * 只切到該班所在頁籤。
 */
export async function openClassScheduleFull(page: Page, className: string): Promise<Locator> {
  await page.goto('/settings');
  await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
  return ensureClassTypeTab(page, className);
}

/**
 * 以「使用者實際操作」修改草稿：先切換至排課頁籤點進輸入框，再輸入。
 * （安親／不排課頁籤沒有時段欄，因此仍要顯式切換。）
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

/**
 * 舊名稱，保留為 `openClassSchedule` 的薄包裝（既有 spec 不必一次全改）。
 *
 * `url` 只接受預設 `/settings`：D61 起安親頁籤沒有時段欄，「開啟課表」必須指名一個
 * 有排課列的班級，否則 helper 無法保證 `startInput` 可見。需要保留歷史時用
 * `openClassScheduleViaHome`，不要靠傳 url 繞過頁籤。
 */
export async function openSchedule(page: Page, url = '/settings'): Promise<void> {
  if (url !== '/settings') {
    throw new Error(`openSchedule 只支援預設 /settings（收到 ${url}）；請改用 openClassSchedule 或 openClassScheduleViaHome。`);
  }
  await openClassSchedule(page, '兒童美語-Gino');
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
