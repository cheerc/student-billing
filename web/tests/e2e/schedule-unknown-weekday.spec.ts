import { test, expect, type Page, type Locator } from '@playwright/test';
import {
  calcCell,
  classRows,
  importScheduleRowsFixture,
  keepEditing,
  leaveDialog,
  openClassScheduleFull,
  sideLink,
} from './helpers/c-batch';
import { reloadSettings, saveSettings } from './helpers/d2c-settings';
import { buildSeedGridRows, gridRowsToClasses } from '../../src/contracts/settings';

/**
 * 04 §8 UX07（修訂）／09 §3.1（11 §3 A；F01）：瀏覽器實際操作。
 *
 * 三案（各自一個 test）：(1) 非空非法星期；(2) 清空星期；(3) calculate 失敗。
 * 每案斷言：警告可聚焦（鍵盤可達）、原因可讀、舊計算值立即失效不冒充、失敗不顯示「無重疊」／0；合法週六仍為 0。
 *
 * 手算（seed 課表 兒童美語-Gino 週一 15:20–16:50，v2 同星期；安親窗 13:00–16:00、課輔窗 16:30–19:30）：
 *   安親重疊 16:00−15:20＝40 分；課輔重疊 16:50−16:30＝20 分。
 *   起始改 15:40 → 安親重疊 20 分。
 * 五個計算欄以 `data-calc` 錨點定位（`schedule-grid.tsx` 逐一對應），**不用 td 索引**：
 * #80 往表格前段插入「列入多科折扣」「天數固定 5 天」兩欄後，舊的 `nth(5)` 會默默
 * 指到 `col-time`（當時的失敗訊息正是 Expected "40" / Received "—"）。索引式的欄位
 * 假設是同一個脆點的兩次實例：欄位一增就壞，而且不會有人立刻注意到。
 *
 * D61 起列也不可用 `tbody nth(n)`：一頁籤一張表，預設安親頁籤沒有時段欄。
 * 列一律經 `openClassScheduleFull`（切到該班頁籤、不進聚焦模式）。
 */

const CALC_URL = '**/api/v1/settings/calculate';

/** 四個「窗口」計算欄（安親／課輔的重疊與扣除）。 */
const CALC_COLUMNS = [
  'anqin-overlap',
  'anqin-deduction',
  'tutoring-overlap',
  'tutoring-deduction',
] as const;
type CalcColumn = (typeof CALC_COLUMNS)[number];
/** 以欄位意義（非索引）取得某一列的計算欄儲存格。 */
type CalcCell = (name: CalcColumn) => Locator;

const CLASS = '兒童美語-Gino';
/** 同頁籤的穩定鄰班（seed 存在、屬於 english 頁籤），用來證明「其他列不受影響」。 */
const NEIGHBOR_CLASS = '兒童美語-Archy';

async function openSchedule(page: Page): Promise<{ row: Locator; cell: CalcCell }> {
  // 需要整張表（同頁籤鄰班也用得到），因此不用 ?class= 的聚焦模式。
  const row = await openClassScheduleFull(page, CLASS);
  const cell: CalcCell = (name) => calcCell(page, CLASS, name);
  await expect(cell('anqin-overlap')).toHaveText('40', { timeout: 10000 }); // 初始結果（seed 課表）
  await expect(cell('tutoring-overlap')).toHaveText('20');
  return { row, cell };
}

async function importLegacyWeekday(page: Page, weekday: string): Promise<void> {
  const seedRows = buildSeedGridRows();
  const firstClassRow = seedRows.findIndex((candidate) => candidate.className === CLASS);
  const rows = seedRows.map((row, index) => ({
    ...row,
    rowId: `legacy-weekday-${index + 1}`,
    ...(index === firstClassRow ? { weekday } : {}),
  }));
  const classes = gridRowsToClasses(rows);
  await importScheduleRowsFixture(
    page,
    rows,
    classes.map((item) => ({
      className: item.baseName,
      classType: item.classType,
      hasMultiSubjectDiscount: item.hasMultiSubjectDiscount,
      category: item.category ?? 'unset',
      categorySource: item.categorySource ?? 'unset',
      fixedFiveDays: item.fixedFiveDays ?? false,
    }))
  );
}

/** 四個計算欄（安親重疊／扣除、課輔重疊／扣除）都已被「需確認」取代：不是 0、不是舊值。 */
async function expectNeedsReviewCells(cell: CalcCell) {
  for (const name of CALC_COLUMNS) {
    await expect(cell(name)).toContainText('需確認');
    await expect(cell(name)).not.toHaveText('0');
    await expect(cell(name)).not.toHaveText('40');
  }
}

/** 等待一列的四個窗口欄全部顯示「—」（計算尚未回、或失敗）。 */
async function expectDashedCells(cell: CalcCell) {
  for (const name of CALC_COLUMNS) {
    await expect(cell(name)).toHaveText('—');
  }
}

test.describe('UX07（修訂）：未知／空白星期與 calculate 失敗不冒充「沒有衝堂」', () => {
  test('(1) 非空非法星期「八」：可聚焦的「需確認」警告、原因可讀、舊值 40／20 不冒充；合法週六仍為 0', async ({ page }) => {
    const { row, cell } = await openSchedule(page);
    await importLegacyWeekday(page, '八');

    await expect(row.locator('select.input-weekday')).toHaveValue('八');
    await expect(row.locator('select.input-weekday option:checked')).toHaveText('需確認：八');

    // 警告：徽章是按鈕，鍵盤可達
    const badge = cell('anqin-overlap').getByRole('button', { name: '需確認原因' });
    await expect(badge).toBeVisible({ timeout: 10000 });
    await expectNeedsReviewCells(cell);
    await badge.focus();
    await expect(badge).toBeFocused();
    // 原因可讀：focus 就開啟說明，寫出輸入的值與後果
    const tip = page.getByRole('tooltip');
    await expect(tip).toContainText('「八」');
    await expect(tip).toContainText('無法識別');
    // 不靠 hover 的說明也在頁面上（09 §6）
    const notice = page.locator('[data-unknown-weekday-notice]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('星期無法識別');
    await expect(notice).toContainText('不代表沒有衝堂');

    // 合法週六：已驗證與週一至五窗口無交集 → 0，沒有警告
    await row.locator('select.input-weekday').selectOption('六');
    await expect(cell('anqin-overlap')).toHaveText('0', { timeout: 10000 });
    await expect(cell('tutoring-overlap')).toHaveText('0');
    await expect(row.getByRole('button', { name: '需確認原因' })).toHaveCount(0);
    await expect(page.locator('[data-unknown-weekday-notice]')).toHaveCount(0);
  });

  test('(1b) 舊值立即失效：新結果回來之前，該列已不顯示舊的 40／20（顯示「—」）', async ({ page }) => {
    const { row, cell } = await openSchedule(page);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    await page.route(CALC_URL, async (route) => {
      held = true;
      await gate; // 扣住新請求：畫面在「舊結果還在、新結果未到」的狀態
      await route.continue();
    });

    await importLegacyWeekday(page, '八');
    await expect.poll(() => held, { timeout: 5000 }).toBe(true);
    await expectDashedCells(cell);
    await expect(cell('anqin-overlap')).not.toHaveText('40');

    release();
    await expect(cell('anqin-overlap').getByRole('button', { name: '需確認原因' })).toBeVisible({ timeout: 10000 });
  });

  test('(2) 清空星期（空字串）：calculate 不再 400；該列「需確認」警告與原因；舊值不冒充', async ({ page }) => {
    const { row, cell } = await openSchedule(page);

    const blankResponse = page.waitForResponse(
      (r) => r.url().includes('/api/v1/settings/calculate') && (r.request().postData() ?? '').includes('"weekday":""')
    );
    await row.locator('select.input-weekday').selectOption('');
    expect((await blankResponse).status()).toBe(200); // 整個 calculate 不因空白星期而失敗

    const badge = cell('anqin-overlap').getByRole('button', { name: '需確認原因' });
    await expect(badge).toBeVisible({ timeout: 10000 });
    await expectNeedsReviewCells(cell);
    await badge.focus();
    await expect(page.getByRole('tooltip')).toContainText('沒有填星期');
    await expect(page.locator('[data-unknown-weekday-notice]')).toContainText('沒有填星期');
    // 其他列不受影響：同頁籤的鄰班仍是完整結果，畫面沒有整片變「—」
    await expect(page.locator('[data-calculate-error]')).toHaveCount(0);
    await expect(calcCell(page, NEIGHBOR_CLASS, 'anqin-overlap')).not.toHaveText('—');
  });

  test('(2b) 合成舊星期修正為「未定」後，重載仍是空值而不是舊異常選項', async ({ page }) => {
    await openSchedule(page);
    await importLegacyWeekday(page, '八');
    const row = classRows(page, CLASS).first();
    const weekday = row.locator('select.input-weekday');
    await expect(weekday).toHaveValue('八');
    await expect(weekday.locator('option:checked')).toHaveText('需確認：八');

    await weekday.selectOption('');
    await expect(weekday).toHaveValue('');
    await expect(weekday.locator('option:checked')).toHaveText('未定');
    await expect(weekday.locator('option[value="八"]')).toHaveCount(0);
    await saveSettings(page);
    await reloadSettings(page);
    await page.locator('#class-type-tab-english').click();

    const reloadedWeekday = classRows(page, CLASS).first().locator('select.input-weekday');
    await expect(reloadedWeekday).toHaveValue('');
    await expect(reloadedWeekday.locator('option:checked')).toHaveText('未定');
    await expect(reloadedWeekday.locator('option[value="八"]')).toHaveCount(0);
    await expect(page.locator('.save-status-clean')).toBeVisible();
  });

  test('(3) calculate 失敗（500／連線中斷）：顯示失敗說明、各欄「—」，不是 0／「無重疊」也不沿用舊值；恢復後自動重算', async ({ page }) => {
    const { row, cell } = await openSchedule(page);
    const start = row.locator('input.input-time').first();

    // 伺服器錯誤
    await page.route(CALC_URL, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
    );
    await start.fill('15:30');
    const alert = page.locator('[data-calculate-error]');
    await expect(alert).toBeVisible({ timeout: 10000 });
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toContainText('無法計算');
    await expect(alert).toContainText('不代表沒有衝堂');
    await expectDashedCells(cell);
    await expect(cell('anqin-overlap')).not.toHaveText('40');
    await expect(cell('anqin-overlap')).not.toHaveText('0');
    // 失敗說明不外露工程字（copy-scan 同規則）
    await expect(alert).not.toContainText(/500|boom|API|JSON/);

    // 連線中斷
    await page.unroute(CALC_URL);
    await page.route(CALC_URL, (route) => route.abort());
    await start.fill('15:20');
    await expect(alert).toBeVisible();
    await expectDashedCells(cell);

    // 恢復：改動即自動重算，失敗說明消失，數值是新結果（15:40 起 → 安親 20 分）
    await page.unroute(CALC_URL);
    await start.fill('15:40');
    await expect(cell('anqin-overlap')).toHaveText('20', { timeout: 10000 });
    await expect(page.locator('[data-calculate-error]')).toHaveCount(0);
  });

  test('(4) 半輸入時間保留在 pending，遮蔽舊結果並阻止確認與匯出；取消後還原', async ({ page }) => {
    const { row, cell } = await openSchedule(page);
    const start = row.locator('input.input-time').first();
    const original = await start.inputValue();

    await start.click();
    await start.fill('1');
    await page.keyboard.press('Escape');

    await expect(start).toHaveValue('1');
    const pendingError = page.locator('[data-pending-time-error]');
    await expect(pendingError).toBeVisible();
    await expect(pendingError).toContainText(/修正|完成|復原/);
    await expect(cell('anqin-overlap')).not.toHaveText('40');
    await expect(cell('anqin-overlap')).toContainText(/—|需修正/);

    // Parent-owned pending draft survives both the settings tab remount and class-type tabs.
    await page.locator('#settings-tab-sync').click();
    await page.locator('#settings-tab-schedule').click();
    await page.locator('#class-type-tab-care').click();
    await page.locator('#class-type-tab-english').click();
    await expect(start).toHaveValue('1');
    await expect(page.locator('[data-pending-time-error]')).toBeVisible();
    await expect(page.getByRole('button', { name: '確認變更' })).toBeDisabled();
    await expect(page.locator('[data-schedule-export]')).toBeDisabled();

    await page.getByRole('button', { name: '取消修改' }).click();
    await expect(start).toHaveValue(original);
    await expect(page.locator('.save-status-clean')).toBeVisible();
    await expect(cell('anqin-overlap')).toHaveText('40');
  });

  test('(4b) pending-only edit activates the leave guard and deleting its row clears pending', async ({ page }) => {
    const { row } = await openSchedule(page);
    const start = row.locator('input.input-time').first();
    await start.fill('1');
    await expect(page.locator('[data-pending-time-error]')).toBeVisible();
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await sideLink(page, /匯入學生/).click();
    await expect(leaveDialog(page)).toBeVisible();
    await keepEditing(page).click();
    await expect(leaveDialog(page)).toHaveCount(0);
    await expect(start).toHaveValue('1');
    await expect(page.locator('[data-pending-time-error]')).toBeVisible();

    const before = await classRows(page, CLASS).count();
    await row.getByRole('button', { name: `刪除時段 ${CLASS}` }).click();
    await expect(classRows(page, CLASS)).toHaveCount(before - 1);
    await expect(page.locator('[data-pending-time-error]')).toHaveCount(0);
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await page.getByRole('button', { name: '取消修改' }).click();
    await expect(classRows(page, CLASS)).toHaveCount(before);
    await expect(page.locator('[data-pending-time-error]')).toHaveCount(0);
    await expect(page.locator('.save-status-clean')).toBeVisible();
  });

  test('(5) 匯入失敗保留 pending 時間；成功整表匯入清除 pending', async ({ page }) => {
    const { row, cell } = await openSchedule(page);
    const start = row.locator('input.input-time').first();
    await start.fill('1');
    await expect(page.locator('[data-pending-time-error]')).toBeVisible();

    await page.route('**/api/v1/settings/schedule-table', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic failure' }) })
    );
    await page.getByLabel('選擇課表 Excel 檔案').setInputFiles({
      name: 'synthetic-failed-import.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('synthetic failure'),
    });
    await expect(page.locator('[data-schedule-import-error]')).toBeVisible();
    await expect(page.locator('[data-pending-time-error]')).toBeVisible();
    await expect(start).toHaveValue('1');
    await page.unroute('**/api/v1/settings/schedule-table');

    const rows = buildSeedGridRows().map((item, index) => ({ ...item, rowId: `replace-${index + 1}` }));
    const classes = gridRowsToClasses(rows);
    await importScheduleRowsFixture(
      page,
      rows,
      classes.map((item) => ({
        className: item.baseName,
        classType: item.classType,
        hasMultiSubjectDiscount: item.hasMultiSubjectDiscount,
        category: item.category ?? 'unset',
        categorySource: item.categorySource ?? 'unset',
        fixedFiveDays: item.fixedFiveDays ?? false,
      }))
    );
    await expect(page.locator('[data-pending-time-error]')).toHaveCount(0);
    const importedRow = page.locator('tr.schedule-row', {
      has: page.locator('input.input-classname[value="兒童美語-Gino"]'),
    });
    await expect(importedRow.locator('input.input-time').first()).toHaveValue('15:20');
    await expect(cell('anqin-overlap')).toHaveText('40', { timeout: 10000 });

    // A successful replacement that retains row identity must also replace slider-local preview state.
    const stableRowId = await importedRow.first().getAttribute('data-row-id');
    if (!stableRowId) throw new Error('Imported schedule row does not expose its stable row identity');
    const seedRows = buildSeedGridRows();
    const firstGinoRow = seedRows.findIndex((item) => item.className === '兒童美語-Gino');
    const replacementRows = seedRows.map((item, index) => ({
      ...item,
      rowId: index === firstGinoRow ? stableRowId : `popup-replacement-${index + 1}`,
      ...(index === firstGinoRow
        ? { startTime: '16:00', endTime: '17:00', startMinutes: 960, endMinutes: 1020 }
        : {}),
    }));
    const replacementClasses = gridRowsToClasses(replacementRows);
    const replacementAttrs = replacementClasses.map((item) => ({
      className: item.baseName,
      classType: item.classType,
      hasMultiSubjectDiscount: item.hasMultiSubjectDiscount,
      category: item.category ?? 'unset',
      categorySource: item.categorySource ?? 'unset',
      fixedFiveDays: item.fixedFiveDays ?? false,
    }));
    let started!: () => void;
    let release!: () => void;
    const importStarted = new Promise<void>((resolve) => (started = resolve));
    const importGate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/v1/settings/schedule-table', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      started();
      await importGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ rows: replacementRows, classAttrs: replacementAttrs }),
      });
    });
    try {
      await page.getByLabel('選擇課表 Excel 檔案').setInputFiles({
        name: 'synthetic-delayed-import.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from('synthetic delayed import'),
      });
      await importStarted;
      const liveRow = page.locator('tr.schedule-row', {
        has: page.locator('input.input-classname[value="兒童美語-Gino"]'),
      });
      const liveStart = liveRow.locator('input.input-time').first();
      await liveStart.click();
      const livePopover = liveRow.locator('[data-time-popover="start"]').first();
      await expect(livePopover).toBeVisible();
      const liveHourSlider = livePopover.getByRole('slider', { name: '起始時間 第 1 列 小時' });
      await expect(liveHourSlider).toHaveValue('15');

      release();
      await expect(page.locator('#toast')).toContainText('已匯入課表');
      await expect(liveStart).toHaveValue('16:00');
      await expect(liveHourSlider).toHaveValue('16');
      await expect(page.locator('[data-pending-time-error]')).toHaveCount(0);
    } finally {
      release();
      await page.unroute('**/api/v1/settings/schedule-table');
    }
  });
});
