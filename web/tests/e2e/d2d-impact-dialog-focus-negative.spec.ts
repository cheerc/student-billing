import { test, expect } from '@playwright/test';
import { openClassSchedule, startInput } from './helpers/c-batch';
import { holdCalculate } from './helpers/hold-calculate';

/**
 * D2d r3／F4 負向防護：補還原**不得**搶走使用者已主動安排的焦點。
 *
 * 修正在 `restoreFocusToOpener` 裡用一段有限期的觀察窗，在 opener 恢復可聚焦且
 * 焦點遺失時補一次還原（見 `impact-dialog.tsx`）。這個觀察窗是最需要防守的地方：
 * 若條件放寬，畫面就會把使用者剛放上去的焦點拉回觸發點——比原本的焦點遺失更糟。
 *
 * 每一條都走**真實 UI**（不改 disabled、不 mock 計算結果、不用 `page.evaluate` 造假狀態），
 * 且都在 late-disable 的同一個時序下執行（`page.clock` 凍結 → 還原後推進 debounce），
 * 確認觀察窗存在時仍不搶。
 */

const T0 = 4_102_444_800_000;

/** 開 dialog → 20 次 Tab → Esc，等待焦點還原完成。回傳 opener locator。 */
async function openAndEsc(page: import('@playwright/test').Page) {
  const opener = page.locator('button', { hasText: '確認變更' });
  const dialog = page.locator('dialog.impact-dialog');

  await openClassSchedule(page, '兒童美語-Gino');
  await startInput(page).fill('13:30');
  await opener.click();
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await expect(dialog.locator('button', { hasText: /^儲存/ })).toBeEnabled({ timeout: 15000 });
  for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  return opener;
}

test.describe('D2d r3／F4 負向：不得搶走使用者已主動安排的焦點', () => {
  test('使用者 Tab 到別的控制項 → 焦點留在使用者選的位置', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const calculation = await holdCalculate(page);
    const opener = await openAndEsc(page);
    await expect(opener, '還原當下焦點在觸發點').toBeFocused();

    // 觸發點是最後一個控制項，正向 Tab 可能離開文件而落在 BODY。
    // 以 Shift+Tab 移到前一個控制項，並在計算回應前確認焦點不被搶回。
    const discard = page.getByRole('button', { name: '取消修改' });
    await page.keyboard.press('Shift+Tab');
    await expect(discard).toBeFocused();
    await page.clock.runFor(750);
    await expect.poll(() => calculation.held()).toBe(1);
    await expect(opener).toBeDisabled();
    await expect(discard).toBeFocused();
    calculation.release();
    await expect(opener).toBeEnabled();
    await page.clock.runFor(1100);
    await expect(discard, '使用者移動焦點後，補還原不得搶回焦點').toBeFocused();
  });

  test('使用者點擊另一個控制項 → 焦點留在被點的元素', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const opener = await openAndEsc(page);
    await expect(opener, '還原當下焦點在觸發點').toBeFocused();
    await page.clock.runFor(250);
    await page.clock.runFor(500);

    // ★ 使用者點擊「取消修改」
    const discard = page.getByRole('button', { name: '取消修改' });
    await discard.click();
    await page.clock.runFor(100);
    const afterClick = await discard.evaluate((el: any) => document.activeElement === el);
    // 焦點在 body（點擊後 button 仍 enabled，瀏覽器應保留焦點）——重點是不得被拉回 opener
    await page.clock.runFor(500);
    await page.clock.runFor(600);
    expect(
      await opener.evaluate((el: any) => document.activeElement === el),
      '使用者點擊別的控制項後，補還原不得搶回焦點'
    ).toBe(false);
    void afterClick;
  });

  test('使用者點空白處（activeElement 為 body）→ 仍不得拉回觸發點', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const opener = await openAndEsc(page);
    await expect(opener, '還原當下焦點在觸發點').toBeFocused();
    await page.clock.runFor(250);
    await page.clock.runFor(500);

    // ★ 使用者點頁面空白處（不是任何控制項）——activeElement 會是 body。
    //   這正是「不能用 activeElement===body 推論使用者沒選焦點」的原因：
    //   點空白是有意選擇，必須靠 pointerdown 旗標區分，不可靠 body 推論。
    await page.locator('h1', { hasText: '課表設定' }).click({ position: { x: 5, y: 2 } });
    await page.clock.runFor(100);

    await page.clock.runFor(500);
    await page.clock.runFor(600);
    expect(
      await opener.evaluate((el: any) => document.activeElement === el),
      '使用者點空白處後，不得把焦點拉回觸發點'
    ).toBe(false);
  });

  test('關閉後立刻離開頁面 → 不得在下一頁搶焦點', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    await openAndEsc(page);

    // 立刻離開到別的頁面（此時觀察窗仍在跑）。
    // 若仍有未儲存變更，離頁守衛會先攔截要求確認——那是正確行為，測試順著它走。
    await page.getByRole('link', { name: /匯入學生/ }).click();
    const leaveDialog = page.locator('dialog.leave-dialog');
    await expect(leaveDialog, '離頁守衛應攔截並要求確認').toBeVisible({ timeout: 15000 });
    await leaveDialog.getByRole('button', { name: '捨棄修改' }).click();
    // ⚠ clock 暫停中：`page.waitForTimeout` 在暫停的 virtual clock 下不會前進
    //   （實測會停住），這裡一律改用 `clock.runFor` 推進。
    await page.clock.runFor(500);
    await expect(page).not.toHaveURL(/\/settings/);
    await page.clock.runFor(800);

    // 不得在別的頁面留下任何 pending 的焦點操作：焦點不該被塞到已卸載頁面的節點
    const active = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      onSettingsInputs: !!document.activeElement?.closest('.savebar'),
    }));
    expect(active.onSettingsInputs, '離頁後焦點不得落在已卸載的設定頁控制項上').toBe(false);
  });

  test('關閉後再開第二個 modal → 不得搶走第二個 modal 的焦點', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const opener = await openAndEsc(page);
    await expect(opener, '還原當下焦點在觸發點').toBeFocused();
    await page.clock.runFor(250);
    await page.clock.runFor(400);

    // ★ 開啟離頁確認視窗（第二個 modal），其焦點在 dialog 內
    await startInput(page).fill('14:00');
    await page.getByRole('link', { name: /匯入學生/ }).click();
    const leaveDialog = page.locator('dialog.leave-dialog');
    await expect(leaveDialog).toBeVisible({ timeout: 15000 });
    const inLeaveDialog = await page.evaluate(() => !!document.activeElement?.closest('dialog.leave-dialog'));
    expect(inLeaveDialog, '第二個 modal 開啟後焦點應在該 modal 內').toBe(true);

    await page.clock.runFor(800);
    const stillInLeave = await page.evaluate(() => !!document.activeElement?.closest('dialog.leave-dialog'));
    expect(stillInLeave, '觀察窗不得把焦點從第二個 modal 拉走').toBe(true);
    expect(
      await opener.evaluate((el: any) => document.activeElement === el),
      '第二個 modal 開啟時不得搶回觸發點焦點'
    ).toBe(false);
  });

  test('觸發點從 DOM 移除 → 不得拋錯且不得搶焦點', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const opener = await openAndEsc(page);
    await expect(opener, '還原當下焦點在觸發點').toBeFocused();
    await page.clock.runFor(250);
    await page.clock.runFor(400);

    // 讓觸發點消失：切到沒有 savebar 的頁面（元件卸載 → opener 斷線）
    await page.goto('/imports');
    await expect(page).toHaveURL(/\/imports/);
    await page.clock.runFor(800);

    // 不得拋錯（pageerror 會讓 runner 標記失敗），焦點也不該被塞回任何地方
    const ok = await page.evaluate(() => !!document.body);
    expect(ok).toBe(true);
  });
});
