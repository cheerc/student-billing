import { test, expect, type Locator, type Page } from '@playwright/test';
import { keepEditing, leaveDialog, scheduleHeading, sideLink, startInput } from './helpers/c-batch';

/**
 * 離頁確認視窗（leave-confirm-dialog）關閉後的焦點還原（09 §6「關閉返回焦點」；issue #48）。
 *
 * leave-confirm-dialog 與 impact-dialog 同型：開啟時記下 `document.activeElement`，關閉（繼續編輯／Esc）後
 * 還給它；元件在 `open=false` 時直接卸載 `<dialog>`，瀏覽器原生的「關閉時還原焦點」不會發生，必須手動還原。
 *
 * 矩陣＝入口（站內連結點擊、瀏覽器 Back）× 焦點起點（課表格子、確認變更、取消修改）× 離開方式（繼續編輯、Esc）。
 * 另以 `page.clock` 凍結重現 late-disable：焦點在「確認變更」時，離頁確認開著的期間 debounce 觸發
 * `setCalculating(true)` → opener 變 disabled，此刻關閉確認視窗 → `focus()` 對 disabled 元素是 no-op、
 * 焦點掉到 `<body>`；之後按鈕恢復 enabled，沒有任何機制再還原一次（impact-dialog 的 F-4 同型缺陷）。
 *
 * 斷言一律印出實際的 activeElement（標籤＋文字），失敗時看得到「落到哪裡」，不只是 inactive。
 */

const T0 = 4_102_444_800_000;

async function describeActive(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return 'null';
    const label = (a.getAttribute('aria-label') || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    return `${a.tagName}:${label}`;
  });
}

const opener = (page: Page): Locator => page.locator('button', { hasText: '確認變更' });
const cancelEdit = (page: Page): Locator => page.locator('button', { hasText: '取消修改' });

/** 首頁 → 側欄進課表設定（站內導覽，歷史才有上一頁）→ 改一格讓草稿 dirty。 */
async function openDirtySchedule(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('main')).toBeVisible();
  await sideLink(page, /課表設定/).click();
  await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
  await startInput(page).click();
  await startInput(page).fill('15:45');
  await expect(page.locator('.save-status-dirty')).toBeVisible();
  // 等 debounce 計算結束，確保「確認變更」可聚焦（late-disable 的案例另用 clock 重現）
  await expect(opener(page)).toBeEnabled({ timeout: 15000 });
}

type Focus = { name: string; focus: (page: Page) => Promise<void>; expected: string };
const focusStarts: Focus[] = [
  { name: '課表格子', focus: async (p) => startInput(p).focus(), expected: 'INPUT:' },
  { name: '確認變更', focus: async (p) => opener(p).focus(), expected: 'BUTTON:確認變更' },
  { name: '取消修改', focus: async (p) => cancelEdit(p).focus(), expected: 'BUTTON:取消修改' },
];

const exits: Array<{ name: string; run: (page: Page) => Promise<void> }> = [
  { name: '繼續編輯按鈕', run: async (p) => keepEditing(p).click() },
  { name: 'Esc', run: async (p) => p.keyboard.press('Escape') },
];

test.describe('離頁確認視窗：關閉後焦點回到開啟前的位置', () => {
  for (const exit of exits) {
    test(`入口＝站內連結（側欄「匯入學生」）× ${exit.name} → 焦點回到該連結`, async ({ page }) => {
      await openDirtySchedule(page);
      const link = sideLink(page, /匯入學生/);
      await link.click();
      await expect(leaveDialog(page)).toBeVisible();
      await exit.run(page);
      await expect(leaveDialog(page)).toHaveCount(0);
      await expect.poll(() => describeActive(page), { message: '離頁確認關閉後焦點落點' }).toContain('匯入學生');
    });

    for (const start of focusStarts) {
      test(`入口＝瀏覽器 Back、焦點起點＝${start.name} × ${exit.name} → 焦點回到${start.name}`, async ({ page }) => {
        await openDirtySchedule(page);
        await start.focus(page);
        await expect.poll(() => describeActive(page), { message: '起點焦點' }).toContain(start.expected);
        await page.goBack();
        await expect(leaveDialog(page)).toBeVisible();
        await exit.run(page);
        await expect(leaveDialog(page)).toHaveCount(0);
        await expect.poll(() => describeActive(page), { message: '離頁確認關閉後焦點落點' }).toContain(start.expected);
      });
    }
  }

  test('late-disable：離頁確認開著時 debounce 讓「確認變更」變 disabled，此刻繼續編輯 → 恢復 enabled 後焦點仍回到「確認變更」', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await sideLink(page, /課表設定/).click();
    await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
    await startInput(page).click();
    await startInput(page).fill('15:45');
    await expect(page.locator('.save-status-dirty')).toBeVisible();
    await opener(page).focus();
    await expect.poll(() => describeActive(page)).toContain('BUTTON:確認變更');

    await page.goBack();
    await expect(leaveDialog(page)).toBeVisible();
    // debounce 到期 → calculating=true → 「確認變更」disabled（response 要 resume 後才會回來）
    await page.clock.runFor(250);
    await expect(opener(page), 'debounce 到期後「確認變更」應為 disabled').toBeDisabled();

    await keepEditing(page).click();
    await expect(leaveDialog(page)).toHaveCount(0);
    await page.clock.resume();
    await expect(opener(page), 'response 回來後應恢復 enabled').toBeEnabled({ timeout: 15000 });
    await expect
      .poll(() => describeActive(page), { message: '恢復 enabled 後焦點落點（期望補還原回「確認變更」）' })
      .toContain('BUTTON:確認變更');
  });
});
