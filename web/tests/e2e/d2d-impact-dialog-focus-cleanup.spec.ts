import { test, expect } from '@playwright/test';

/**
 * D2d r3／F4 cleanup 斷言：補還原的觀察窗**不得**在終止後留下任何 listener。
 *
 * Lead 第 1 點指出的漏洞：舊設計在「補還原成功」路徑上只寫 `settledSince` 就 return，
 * 既沒有排下一個 timer 也沒有呼叫 `stop()`，所以 `pointerdown`／`keydown` listener
 * 會**永久留在 document 上**——宣稱的「條件滿足就 stop、不常駐」與實作不符，
 * 而且既有的 6 條負向測試完全沒有覆蓋 cleanup。
 *
 * 驗證方式：在頁面端攔截 `document.addEventListener`／`removeEventListener`，
 * 以**函式參考**（Set）追蹤仍 active 的 pointerdown／keydown listener。必須用參考
 * 比對而不能只數數量：`removeEventListener` 只有在**同一個函式物件**時才真的移除，
 * 傳錯參考不會移除任何東西、也不會報錯——這正是舊設計漏掉的失效模式。
 *
 * 量的是**相對於基線的 delta**：React 本身在 document 上就註冊了 2 個
 * pointerdown／keydown listener（事件委派），那不是本修正產生的。
 */

const T0 = 4_102_444_800_000;

type Counts = { pointerdown: number; keydown: number };

/** 在頁面載入前安裝追蹤器。 */
async function installListenerTracker(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const w = window as any;
    if (w.__LT) return;
    const active = new Map<string, Set<any>>();
    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    w.__LT = {
      get active(): Counts {
        return {
          pointerdown: (active.get('pointerdown') || new Set()).size,
          keydown: (active.get('keydown') || new Set()).size,
        };
      },
    };
    (document as any).addEventListener = function (ev: any, fn: any, opt: any) {
      if (ev === 'pointerdown' || ev === 'keydown') {
        if (!active.has(ev)) active.set(ev, new Set<any>());
        active.get(ev)!.add(fn);
      }
      return origAdd(ev as any, fn, opt);
    };
    (document as any).removeEventListener = function (ev: any, fn: any, opt: any) {
      if (ev === 'pointerdown' || ev === 'keydown') active.get(ev)?.delete(fn);
      return origRemove(ev as any, fn, opt);
    };
  });
}

const readCounts = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__LT.active as Counts);

/** 相對於基線多出幾個 listener（0 ＝ 完全沒殘留）。 */
const delta = (now: Counts, base: Counts): Counts => ({
  pointerdown: now.pointerdown - base.pointerdown,
  keydown: now.keydown - base.keydown,
});

/**
 * 開 dialog → 20 次 Tab → Esc。
 *
 * 回傳 opener 與 **Esc 之前**的 listener 基線：觀察窗是在 Esc（cleanup）時才建立的，
 * 所以基線必須取在 Esc 之前，之後的讀數才能反映「觀察窗多加了幾個 listener」。
 */
async function openAndEsc(page: import('@playwright/test').Page) {
  const opener = page.locator('button', { hasText: '確認變更' });
  const dialog = page.locator('dialog.impact-dialog');
  await page.goto('/settings');
  await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
  await page.locator('input.input-time').first().fill('13:30');
  await opener.click();
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await expect(dialog.locator('button', { hasText: /^儲存/ })).toBeEnabled({ timeout: 15000 });
  for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
  const base = await readCounts(page);   // 觀察窗建立前
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  return { opener, base };
}

test.describe('D2d r3／F4 cleanup：所有終止路徑都不得殘留 listener', () => {
  test('補還原成功後 → listener 全部移除', async ({ page }) => {
    await installListenerTracker(page);
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const { opener, base } = await openAndEsc(page);
    await expect(opener, 'Esc 還原當下焦點在觸發點').toBeFocused();

    // 觀察窗已建立：此刻應比基線多出 pointerdown／keydown
    const during = delta(await readCounts(page), base);
    expect(during.pointerdown, '觀察窗期間應多出 pointerdown listener').toBe(1);
    expect(during.keydown, '觀察窗期間應多出 keydown listener').toBe(1);

    // 走完 late-disable：debounce fire → disabled → 焦點遺失 → 恢復 enabled。
    // ⚠ `clock.runFor` 只推進**頁面**時鐘，不會讓 Node 端 calculate 的 response 回來。
    //   必須 `resume()` 讓真實網路往返完成，否則按鈕會一直卡在 disabled、
    //   `true→false` 狀態轉移永不發生（實測會這樣）。
    await page.clock.runFor(250);
    await expect(opener, 'debounce 到期後應進入 disabled').toBeDisabled();
    await page.clock.resume();
    await expect(opener, 'response 回來後應恢復 enabled').toBeEnabled({ timeout: 15000 });
    await page.waitForTimeout(200);

    // ★ 補還原成功 → 必須 cleanup，不得殘留
    const after = delta(await readCounts(page), base);
    expect(after.pointerdown, '補還原成功後不得殘留 pointerdown listener').toBe(0);
    expect(after.keydown, '補還原成功後不得殘留 keydown listener').toBe(0);
  });

  test('使用者主動操作 → 立即取消 restore intent 並移除 listener', async ({ page }) => {
    await installListenerTracker(page);
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const { opener, base } = await openAndEsc(page);
    await expect(opener, '還原當下焦點在觸發點').toBeFocused();

    expect(delta(await readCounts(page), base).pointerdown, '觀察窗期間應多出 pointerdown listener').toBe(1);

    // 使用者主動按鍵（在 late-disable 之前）
    await page.keyboard.press('Shift');
    await page.clock.resume();
    await page.waitForTimeout(200);

    const after = delta(await readCounts(page), base);
    expect(after.pointerdown, '使用者主動操作後不得殘留 pointerdown listener').toBe(0);
    expect(after.keydown, '使用者主動操作後不得殘留 keydown listener').toBe(0);
  });

  test('無 late-disable（正常路徑）→ 不得殘留 listener', async ({ page }) => {
    await installListenerTracker(page);
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const { base } = await openAndEsc(page);

    // 使用者主動按鍵 → 同步取消 restore intent
    await page.keyboard.press('Shift');
    await page.clock.resume();
    await page.waitForTimeout(200);

    const after = delta(await readCounts(page), base);
    expect(after.pointerdown, '正常路徑也不得殘留 pointerdown listener').toBe(0);
    expect(after.keydown, '正常路徑也不得殘留 keydown listener').toBe(0);
  });

  test('watchdog 到期（始終沒有 disabled→enabled）→ 必須移除 listener', async ({ page }) => {
    await installListenerTracker(page);
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const { base } = await openAndEsc(page);

    expect(delta(await readCounts(page), base).pointerdown, '觀察窗期間應多出 pointerdown listener').toBe(1);

    // 使用者完全不動作，只讓 watchdog 到期（resume 後是真實時間流逝）
    await page.clock.resume();
    await page.waitForTimeout(5500);

    const after = delta(await readCounts(page), base);
    expect(after.pointerdown, 'watchdog 到期後不得殘留 pointerdown listener').toBe(0);
    expect(after.keydown, 'watchdog 到期後不得殘留 keydown listener').toBe(0);
  });
});
