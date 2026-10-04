import { test, expect, type Page, type Locator } from '@playwright/test';

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

async function openSchedule(page: Page): Promise<{ row: Locator; cell: CalcCell }> {
  await page.goto('/settings');
  await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
  const row = page.locator('.schedule-table tbody tr').nth(3); // 兒童美語-Gino 週一 15:20–16:50
  const cell: CalcCell = (name) => row.locator(`[data-calc="${name}"]`);
  await expect(cell('anqin-overlap')).toHaveText('40', { timeout: 10000 }); // 初始結果（seed 課表）
  await expect(cell('tutoring-overlap')).toHaveText('20');
  return { row, cell };
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

    await row.locator('input.input-weekday').fill('八');

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
    await row.locator('input.input-weekday').fill('六');
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

    await row.locator('input.input-weekday').fill('八');
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
    await row.locator('input.input-weekday').fill('');
    expect((await blankResponse).status()).toBe(200); // 整個 calculate 不因空白星期而失敗

    const badge = cell('anqin-overlap').getByRole('button', { name: '需確認原因' });
    await expect(badge).toBeVisible({ timeout: 10000 });
    await expectNeedsReviewCells(cell);
    await badge.focus();
    await expect(page.getByRole('tooltip')).toContainText('沒有填星期');
    await expect(page.locator('[data-unknown-weekday-notice]')).toContainText('沒有填星期');
    // 其他列不受影響：上一列（Gino 之前的列）仍是完整結果，畫面沒有整片變「—」
    await expect(page.locator('[data-calculate-error]')).toHaveCount(0);
    await expect(
      page.locator('.schedule-table tbody tr').nth(4).locator('[data-calc="anqin-overlap"]')
    ).not.toHaveText('—');
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
});
