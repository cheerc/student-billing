import { test, expect } from '@playwright/test';

/**
 * D2d r3／F4（04 §8 UX61；09 §6「Esc 關閉後焦點回到觸發點」）：
 * late-disable 焦點還原的確定性 E2E。
 *
 * ── 缺陷（analysis t-20261001080131853832-21323-28 已實測）────────────────
 * `settings-editor.tsx` 的「確認變更」按鈕 `disabled={!isDirty || calculating || …}`，
 * 而 `calculating` 由 250ms debounce 的 effect 驅動（deps `[rows, draft, effectiveManualAttrs]`）。
 * Esc 關閉 dialog 時 `impact-dialog.tsx` 的 cleanup 執行 `opener.focus()` **成功**，
 * 但頁面載入時就 arm 的那顆 250ms 定時器會在**還原之後**才 fire → `setCalculating(true)`
 * → opener 變 disabled → 瀏覽器把已聚焦的 disabled 按鈕 blur 掉 → 焦點掉到 `<body>`。
 * 之後 `setCalculating(false)` 讓按鈕恢復 enabled，**但沒有任何機制再還原一次焦點**。
 *
 * ── 為什麼這裡用 virtual clock（不是固定 sleep、不是失敗率）──────────────
 * 缺陷只在「debounce 到期時刻落在 Esc 還原之後、且 response 回來之前」這個窄窗口觸發。
 * 真實時鐘下它是間歇的（實測 head 3/11 失敗），**不能**用來當 RED。
 * 本檔用 `page.clock` 凍結時間並用 `runFor(250)` **精確**推進到 debounce 到期點，
 * 讓「Esc 還原 → debounce fire → disabled → 焦點遺失 → enabled 但不復焦」這個事件順序
 * **必然發生**。沒有固定 wall-clock 等待、沒有期望失敗率。
 *
 * 時鐘安裝於 2100-01-01（遠離真實時間）並立即 `pauseAt(T0+1)`：
 * 避免 `pauseAt(Date.now())` 在 page clock 落後真實時鐘時報
 * 「Cannot fast-forward to the past」（實測會發生，見 evidence-D2d/r3-clock-explore*.log）。
 *
 * 對照組（下方 `對照`）不推進 debounce → 不觸發 late-disable → 焦點必須維持。
 * 這證明失敗不是「本 case 在任何情況下都會失敗」，而是 late-disable 這條路徑特有。
 */

const T0 = 4_102_444_800_000; // 2100-01-01T00:00:00Z

/** 走完 a11y.spec.ts:249 的完整 UI 流程（填時間 → 開 dialog → 20 次 Tab → Esc）。 */
async function openAndEsc(page: import('@playwright/test').Page) {
  const opener = page.locator('button', { hasText: '確認變更' });
  const dialog = page.locator('dialog.impact-dialog');

  await page.goto('/settings');
  await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
  await page.locator('input.input-time').first().fill('13:30');
  await opener.click();

  await expect(dialog).toBeVisible({ timeout: 15000 });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toHaveAttribute('aria-labelledby', 'impactDialogTitle');
  await expect(dialog.locator('button', { hasText: /^儲存/ })).toBeEnabled({ timeout: 15000 });

  const escaped = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return !!a && a !== document.body && !a.closest('dialog');
    });
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    expect(await escaped(), `Tab 第 ${i + 1} 次後焦點落到 dialog 外的頁面元素`).toBe(false);
  }
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest('dialog') || document.activeElement === document.body
    )
  ).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  return opener;
}

test.describe('D2d r3／F4：確認變更視窗 late-disable 後焦點仍須還原', () => {
  test('debounce 在 Esc 還原後 fire → opener 恢復 enabled 時焦點必須回來', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);

    const opener = await openAndEsc(page);

    // 前置確認 1：Esc 還原當下確實成功（否則本 case 測的是別的東西）
    await expect(opener, 'Esc 關閉後焦點應先回到觸發點').toBeFocused();

    // 精確推進到 250ms debounce 到期 → setCalculating(true) → opener 變 disabled
    await page.clock.runFor(250);
    await expect(opener, 'debounce 到期後「確認變更」應進入 disabled').toBeDisabled();

    // 前置確認 2：disabled 期間焦點確實遺失（這是被修的行為，不是測試造成的）
    await expect(opener, 'disabled 期間焦點不應停在 disabled 按鈕上').not.toBeFocused();

    // 放行 calculate response → setCalculating(false) → opener 恢復 enabled
    await page.clock.runFor(1000);
    await expect(opener, 'response 回來後「確認變更」應恢復 enabled').toBeEnabled();

    // ★ 核心斷言：09 §6「Esc 關閉後焦點回到觸發點」——焦點遺失是這次還原造成的，必須補回
    await expect(opener, 'late-disable 造成焦點遺失後，opener 恢復可用時焦點必須還原').toBeFocused();
  });

  test('對照：debounce 未在還原後 fire（無 late-disable）時焦點必須維持', async ({ page }) => {
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);

    const opener = await openAndEsc(page);

    // 不推進 debounce → opener 不會變 disabled
    await expect(opener, 'Esc 後焦點應維持在觸發點').toBeFocused();
    expect(await opener.isDisabled(), '未推進 debounce 時 opener 不應變 disabled').toBe(false);
    await expect(opener, '無 late-disable 時焦點應仍在觸發點').toBeFocused();
  });
});
