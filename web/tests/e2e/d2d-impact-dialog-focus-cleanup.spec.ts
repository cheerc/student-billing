import { test, expect } from '@playwright/test';
import { scheduleHeading, sideLink, startInput } from './helpers/c-batch';
import { holdCalculate } from './helpers/hold-calculate';

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
    // 扣住 calculate 請求（見 helpers/hold-calculate.ts）：回應約 60–80ms 就回來，disabled 窗口太短，
    // 輪詢去接會被機器負載踩掉；扣住後「計算在途」是穩定可觀察的狀態（N7 同型）。
    const calc = await holdCalculate(page);
    const { opener, base } = await openAndEsc(page);
    await expect(opener, 'Esc 還原當下焦點在觸發點').toBeFocused();

    // 觀察窗已建立：此刻應比基線多出 pointerdown／keydown
    const during = delta(await readCounts(page), base);
    expect(during.pointerdown, '觀察窗期間應多出 pointerdown listener').toBe(1);
    expect(during.keydown, '觀察窗期間應多出 keydown listener').toBe(1);

    // 走完 late-disable：debounce fire → disabled（請求被扣住，持續 disabled）→ 焦點遺失 →
    // 放行後 response 回來 → 恢復 enabled（disabled true→false）→ 補還原 → dispose。
    await page.clock.runFor(250);
    await expect.poll(() => calc.held(), { message: 'debounce 到期後 calculate 請求已送出並被扣住' }).toBe(1);
    await expect(opener, 'debounce 到期後應進入 disabled').toBeDisabled();
    calc.release();
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

  /**
   * N6（PR #51 review NB2）：watchdog 是**資源保險絲**，只能在 5s 到期時收掉觀察窗，不能提早。
   * 上面的 watchdog 案只驗「到期後 listener 已移除」（下界），沒有任何 spec 驗「到期前觀察窗仍在」（上界）；
   * `WATCHDOG_MS` 被縮短（例如 5000→500）時它們全綠。
   *
   * 要讓觀察窗活到 watchdog，必須阻止其他終止路徑搶先：正常情況 debounce→calculate→response 約 300ms
   * 內就走完 `true→false` 並 dispose。這裡用 holdCalculate 把 calculate 扣住（opener 保持 disabled、
   * 狀態轉移永不發生），並用 virtual clock 精確推進：
   *   +2250ms（> 500、< 5000）→ 觀察窗必須仍在（delta 1／1）；縮短到 500 時此刻已是 0／0。
   *   +5250ms（> 5000）→ watchdog 到期，必須已移除（delta 0／0）；沒有到期上限時此刻仍是 1／1。
   */
  test('N6：watchdog 未到期前觀察窗仍在、到期後才移除', async ({ page }) => {
    await installListenerTracker(page);
    await page.clock.install({ time: T0 });
    await page.clock.pauseAt(T0 + 1);
    const calc = await holdCalculate(page);
    const { opener, base } = await openAndEsc(page);
    await expect(opener, 'Esc 還原當下焦點在觸發點').toBeFocused();

    // 讓 debounce 到期 → calculating=true → opener disabled；請求被扣住，opener 持續 disabled
    await page.clock.runFor(250);
    await expect.poll(() => calc.held(), { message: 'debounce 到期後 calculate 請求已送出並被扣住' }).toBe(1);
    await expect(opener, '計算在途：opener 應為 disabled').toBeDisabled();

    await page.clock.runFor(2000); // 觀察窗已存在約 2250ms：> 500、< 5000
    expect(delta(await readCounts(page), base), 'watchdog 未到期（約 2.25s < 5s）：觀察窗必須仍在').toEqual({ pointerdown: 1, keydown: 1 });

    await page.clock.runFor(3000); // 約 5250ms：> 5000
    expect(delta(await readCounts(page), base), 'watchdog 到期（約 5.25s > 5s）：觀察窗必須已移除').toEqual({ pointerdown: 0, keydown: 0 });

    calc.release();
    await page.clock.resume();
  });

  // 第五條終止路徑：opener 從**同一個 document** 消失。
  // 觀察窗只 observe opener 的 `disabled` 屬性，節點被移除不會改屬性 → observer 不觸發 →
  // 原本 `!document.contains(opener)` 的檢查（只在 observer 回呼內）永遠跑不到。
  // 既有負向第 6 條用 `page.goto('/imports')` 是整頁替換（document 一起沒了），沒有走到這條。
  //
  // 真實情境：儲存成功 → dialog 關閉（此時 isDirty=false、opener「確認變更」disabled，觀察窗建立）→
  // 使用者按瀏覽器 Back。Back 是瀏覽器 UI 動作，document 上不會有 pointerdown／keydown，
  // 所以兩個「使用者操作即 dispose」的 listener 都不會幫忙收；Next 以 client-side 導覽把課表頁卸載，
  // opener 在同一個 document 內被移除。
  // 不推進到 5s watchdog：移除後 2.5s 內（< WATCHDOG_MS）就必須已釋放。
  test('opener 在同一 document 內被移除（儲存成功後瀏覽器 Back）→ 不待 watchdog 即移除 listener', async ({ page }) => {
    await installListenerTracker(page);
    // 先有上一頁：首頁 → 側欄進課表設定（站內導覽；Back 才是同一 document 內的 client-side 導覽）
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await sideLink(page, /課表設定/).click();
    await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });

    const opener = page.locator('button', { hasText: '確認變更' });
    const dialog = page.locator('dialog.impact-dialog');
    await startInput(page).fill('14:25');
    await opener.click();
    await expect(dialog).toBeVisible({ timeout: 15000 });
    const save = dialog.locator('button', { hasText: /^儲存/ });
    await expect(save).toBeEnabled({ timeout: 15000 });
    const base = await readCounts(page);   // 觀察窗建立前
    await save.click();
    await expect(dialog).toHaveCount(0, { timeout: 15000 });
    await expect(opener, '儲存成功後已無未儲存變更，opener 為 disabled').toBeDisabled();
    const closedAt = Date.now();

    const during = delta(await readCounts(page), base);
    expect(during, '觀察窗已建立：多出 1 個 pointerdown 與 1 個 keydown').toEqual({ pointerdown: 1, keydown: 1 });

    // 瀏覽器 Back：同一 document 內 client-side 導覽，課表頁（含 opener）被卸載
    await page.goBack();
    await expect(page.locator('h1', { hasText: '課表設定' })).toHaveCount(0);
    await expect(opener, 'opener 已從 DOM 移除').toHaveCount(0);

    await expect
      .poll(async () => delta(await readCounts(page), base), {
        message: 'opener 被移除後（尚未到 5s watchdog）listener 必須已釋放，actual delta 見 Received',
        timeout: 2500,
      })
      .toEqual({ pointerdown: 0, keydown: 0 });
    expect(Date.now() - closedAt, '必須在 watchdog（5000ms）之前釋放，而不是靠 watchdog').toBeLessThan(5000);
  });
});
