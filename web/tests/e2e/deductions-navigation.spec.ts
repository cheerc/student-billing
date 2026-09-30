import { test, expect, type Page } from '@playwright/test';
import { ensureB2Activated, currentRunId } from './helpers/b2-roster';
import { urlParams } from './helpers/header-filter';

/**
 * specs/04 UX27／09 §2、§5.2（11 B2；F04）：
 *   - 直接開 /?view=deductions、重新整理、返回，頁籤依網址，不退回學生總表；
 *   - 班級扣天的「編輯此班課表」帶穩定班級識別；課表頁定位並列出該班全部時段。
 *
 * expected 的班級與時段數取自 GET /api/v1/settings/deductions（課表 read model）；
 * 畫面上的逐堂列數與課表頁的時段列數都拿它對照。
 */
const tab = (page: Page, name: string) => page.locator('button[role="tab"]', { hasText: name });

test.beforeEach(async ({ page }) => {
  await ensureB2Activated(page);
});

test.describe('UX27 頁籤依網址', () => {
  test('直接開 /?view=deductions 停在班級扣天；重新整理、切頁籤、離開後返回都不丟頁籤', async ({ page }) => {
    await page.goto('/?view=deductions');
    await expect(tab(page, '班級扣天')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.deductions-table')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.results-table')).toHaveCount(0);

    await page.reload();
    await expect(tab(page, '班級扣天')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.deductions-table')).toBeVisible({ timeout: 15000 });

    // 切到學生總表：網址同步（重新整理停在學生總表）
    await tab(page, '學生總表').click();
    await expect(page.locator('.results-table')).toBeVisible();
    // 預設狀態（學生總表、無條件）網址回到乾淨路徑：沒有 view 參數＝學生總表
    expect(urlParams(page).get('view') ?? 'students').toBe('students');
    await page.reload();
    await expect(tab(page, '學生總表')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.results-table')).toBeVisible({ timeout: 15000 });

    // 班級扣天 → 離開到課表設定 → 瀏覽器返回：仍在班級扣天
    await tab(page, '班級扣天').click();
    expect(urlParams(page).get('view')).toBe('deductions');
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await page.goBack();
    await expect(tab(page, '班級扣天')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.deductions-table')).toBeVisible({ timeout: 15000 });
  });

  test('歷史資料頁同樣依網址 view 開啟班級扣天', async ({ page }) => {
    const runId = await currentRunId(page);
    await page.goto(`/history/${runId}?view=deductions`);
    await expect(page.locator('.data-banner-history h1')).toHaveText('歷史資料（唯讀）', { timeout: 15000 });
    await expect(tab(page, '班級扣天')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.deductions-table')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('F04 編輯此班課表：穩定班級識別、課表頁列出該班全部時段', () => {
  test('展開班級 → 編輯此班課表 → 課表頁只列該班且列出全部時段；可回到全部班級；返回仍在班級扣天', async ({ page }) => {
    const runId = await currentRunId(page);
    const res = await page.request.get(`/api/v1/settings/deductions?runId=${runId}`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    const multi = (data.classes as Array<{ classKey: string; rowIds: string[] }>).filter((c) => c.rowIds.length >= 2);
    expect(multi.length, '需要至少一個有多個時段的班').toBeGreaterThan(0);
    const target = multi[0];
    const expectedSessions = target.rowIds.length;
    const allRows = (data.rows as unknown[]).length;
    expect(allRows).toBeGreaterThan(expectedSessions);

    await page.goto('/?view=deductions');
    await expect(page.locator('.deductions-table')).toBeVisible({ timeout: 15000 });
    const esc = target.classKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await page.locator('.deductions-table tbody > tr:not(.ded-expanded) button', { hasText: new RegExp(`^${esc}\\s`) }).click();
    await expect(page.locator('.ded-session-table tbody tr')).toHaveCount(expectedSessions);
    await page.getByRole('button', { name: /編輯此班課表/ }).click();

    // 帶穩定班級識別（班名），不依畫面排序或列序
    await expect(page).toHaveURL(/\/settings\?/);
    expect(urlParams(page).get('class')).toBe(target.classKey);
    expect(urlParams(page).get('tab')).toBe('schedule');

    // 課表頁定位到該班：只列該班，全部時段都在，且每列班名一致
    const scheduleRows = page.locator('.schedule-table tbody tr.schedule-row');
    await expect(scheduleRows).toHaveCount(expectedSessions, { timeout: 15000 });
    const names = await scheduleRows.locator('input.input-classname').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(names.every((n) => n === target.classKey)).toBe(true);
    const banner = page.locator('[data-focus-class]');
    await expect(banner).toContainText(target.classKey);
    await expect(banner).toContainText(`${expectedSessions} 個時段`);

    // 可回到全部班級
    await banner.getByRole('button', { name: '顯示全部班級' }).click();
    await expect(scheduleRows).toHaveCount(allRows);

    // 返回：仍是班級扣天頁籤
    await page.goBack();
    await expect(tab(page, '班級扣天')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.deductions-table')).toBeVisible({ timeout: 15000 });
  });

  test('班級已不存在（例如改名後）：課表頁明說找不到該班並顯示全部班級，不白屏', async ({ page }) => {
    await page.goto(`/settings?tab=schedule&class=${encodeURIComponent('已不存在的班')}`);
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-focus-class-missing]')).toContainText('已不存在的班');
    await expect(page.locator('.schedule-table tbody tr.schedule-row').first()).toBeVisible();
  });
});
