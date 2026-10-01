import { test, expect, type Page } from '@playwright/test';
import { B2, ensureB2Activated, currentRunId } from './helpers/b2-roster';
import { applyFilter, chip } from './helpers/header-filter';

/** UX74：從無 query 的入口以 UI 建立條件，不以直接開帶參數網址取代 operator 路徑。 */
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

for (const mode of ['current', 'history'] as const) {
  test(`UX74 ${mode}：UI 篩選 → 編輯 → Back 保留兩頁籤條件與網址`, async ({ page }) => {
    const hydrationErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /hydration|hydrating|did not match/i.test(msg.text())) hydrationErrors.push(msg.text());
    });
    // 只觀測 history boundary，不改 URL／state，不製造受測狀態。
    await page.addInitScript(() => {
      const trace: Array<{ event: string; search: string; target?: string; stack?: string }> = [];
      Object.assign(window, { __batchENavigation: trace });
      window.addEventListener('popstate', () => trace.push({ event: 'popstate', search: location.search }));
      const replace = history.replaceState.bind(history);
      history.replaceState = (state, unused, url) => {
        trace.push({ event: 'replaceState', search: location.search, target: String(url), stack: new Error().stack });
        return replace(state, unused, url);
      };
    });
    await ensureB2Activated(page);
    const runId = await currentRunId(page);
    const entry = mode === 'history' ? `/history/${runId}` : '/';
    await page.goto(entry);
    await expect(tab(page, '學生總表')).toHaveAttribute('aria-selected', 'true');
    await applyFilter(page, '所屬班級', { pick: [B2.MATH] });
    await page.getByRole('textbox', { name: '搜尋姓名或人員代碼' }).fill('合成學生011');
    await expect(chip(page, '姓名或代碼', '合成學生011')).toBeVisible();
    await tab(page, '班級扣天').click();
    const teachers = await applyTeacher(page);
    const before = new URL(page.url());
    expect(before.searchParams.get('view')).toBe('deductions');
    expect(before.searchParams.getAll('enrollmentKey')).toEqual([B2.MATH]);
    expect(before.searchParams.getAll('dTeacher')).toEqual([teachers]);
    expect(before.searchParams.has('q')).toBe(false);

    await page.locator('.deductions-table tbody > tr:not(.ded-expanded) button').first().click();
    await page.getByRole('button', { name: /編輯此班課表/ }).click();
    await expect(page.locator('[data-focus-class]')).toBeVisible();
    const settingsUrl = page.url();
    await page.goBack();
    await expect(page.locator('.data-banner h1')).toBeVisible();
    const trace = await page.evaluate(() => (window as unknown as { __batchENavigation: unknown[] }).__batchENavigation);
    console.log('UX74 boundary', JSON.stringify({ mode, before: before.href, after: page.url(), trace, hydrationErrors }));
    // 直接讀已掛載畫面，RED 明列實際值，不以 timeout 充當缺陷證據。
    expect.soft(await tab(page, '班級扣天').getAttribute('aria-selected'), 'Back 後的頁籤').toBe('true');
    const after = new URL(page.url());
    expect.soft(after.searchParams.get('view'), 'Back 後 view').toBe('deductions');
    expect.soft(after.searchParams.getAll('enrollmentKey'), 'Back 後學生班級').toEqual([B2.MATH]);
    expect.soft(after.searchParams.getAll('dTeacher'), 'Back 後老師').toEqual([teachers]);
    expect.soft(hydrationErrors, '不得有 hydration error').toEqual([]);
    // RED 若已發生，保留上述完整 failure list，不在錯誤頁籤上繼續操作造成 setup timeout。
    if (after.searchParams.get('view') !== 'deductions') return;

    await expect(chip(page, '老師', teachers)).toBeVisible();
    await tab(page, '學生總表').click();
    await expect(chip(page, '所屬班級', B2.MATH)).toBeVisible();
    await expect(page.getByRole('textbox', { name: '搜尋姓名或人員代碼' })).toHaveValue('合成學生011');
    await tab(page, '班級扣天').click();
    await page.reload();
    await expect(tab(page, '班級扣天')).toHaveAttribute('aria-selected', 'true');
    await expect(chip(page, '老師', teachers)).toBeVisible();
    // reload 替換目前 history entry，但 Forward 仍應回原課表定位。
    await page.goForward();
    await expect(page).toHaveURL(settingsUrl);
    await expect(page.locator('[data-focus-class]')).toBeVisible();
    await page.goBack();
    await expect(tab(page, '班級扣天')).toHaveAttribute('aria-selected', 'true');
    await expect(chip(page, '老師', teachers)).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(settingsUrl);
    await page.goBack();
    await expect(tab(page, '班級扣天')).toHaveAttribute('aria-selected', 'true');
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    console.log('UX74 hydration errors', JSON.stringify(hydrationErrors));
    expect(hydrationErrors).toEqual([]);
  });
}

async function applyTeacher(page: Page): Promise<string> {
  await page.getByRole('button', { name: '老師篩選', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '老師篩選面板' });
  const teacherOption = panel.locator('[data-filter-option]').filter({ hasNotText: '(空白)' }).first();
  const teacher = await teacherOption.getAttribute('data-filter-option');
  expect(teacher, 'seed 課表必須有非空老師選項').toBeTruthy();
  await teacherOption.locator('input[type="checkbox"]').check();
  await panel.getByRole('button', { name: '確定', exact: true }).click();
  await expect(panel).toHaveCount(0);
  return teacher!;
}
