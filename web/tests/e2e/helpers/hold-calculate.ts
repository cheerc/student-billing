import type { Page } from '@playwright/test';

/**
 * 把課表頁的 calculate 請求（POST /api/v1/settings/calculate）「扣住」，直到呼叫 `release()`。
 *
 * 為什麼需要：課表頁的 250ms debounce 一到就 `setCalculating(true)`（「確認變更」變 disabled），
 * 回應回來才 `setCalculating(false)`。實測回應約 60–80ms 就回來，連 `page.clock` 凍結時也一樣
 * （clock 只凍頁面 timer，不影響網路），所以「計算在途」只存在一個很短的窗口；測試若用
 * `expect(...).toBeDisabled()` 輪詢去接這個窗口，輪詢稍慢（機器負載）就會錯過、收到 enabled。
 * 扣住請求後，「計算在途」變成可觀察的穩定狀態：按鈕保持 disabled 直到測試主動放行。
 *
 * - `held()`：目前被扣住的請求數（可用來等待「請求已送出」這個可觀察事實）。
 * - `release()`：放行所有已扣住與之後的請求（冪等）；測試結束前一定要呼叫，避免請求懸置。
 */
export async function holdCalculate(page: Page) {
  let released = false;
  let held = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await page.route('**/api/v1/settings/calculate', async (route) => {
    held += 1;
    await gate;
    await route.continue().catch(() => {
      // 頁面已關閉或導覽離開：請求已無人等待，不算失敗
    });
  });
  return {
    held: () => held,
    release: () => {
      if (released) return;
      released = true;
      open();
    },
  };
}

/**
 * 在「按下確認變更」的瞬間，決定性地重現 debounce 翻轉（Issue #271）。
 *
 * 真實競態：編輯後 250ms，debounce 計時器觸發 `setCalculating(true)`，「確認變更」變 disabled。
 * 若翻轉剛好落在 Playwright 的 actionability 檢查與 click 之間，Chromium 對 disabled 按鈕不送
 * `click`，點擊遺失、對話框不開。實機只有約 15ms 的窗口（機率性）。
 *
 * 這個 helper 把窗口變成必然：init script 把課表頁唯一的 250ms debounce 計時器
 * （`settings-editor.tsx` 的 calculate effect）扣住，直到「確認變更」收到 `pointerdown` 才在該事件內放行。
 * 在 pointerdown 事件期間呼叫 setState 會取得 React 的 discrete（sync）優先權並於 microtask 內提交，
 * 所以按鈕在 `click` 之前就已經 disabled；效果等同真實競態（click 被 disabled 按鈕吞掉）。
 * 沒人按時，`fallbackMs` 後自行放行，所以「先等 calculate 回應再點」的正確流程不會卡死。
 *
 * 必須在 `page.goto` 之前呼叫。只供回歸測試使用，不改產品行為。
 */
export async function flipCalculateOnConfirmHover(page: Page, fallbackMs = 800): Promise<void> {
  await page.addInitScript((fallback: number) => {
    const realSet = window.setTimeout.bind(window);
    const realClear = window.clearTimeout.bind(window);
    const pending = new Map<number, () => void>();
    window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay !== 250 || typeof fn !== 'function') return realSet(fn, delay, ...args);
      let id = 0;
      const fire = () => {
        if (!pending.delete(id)) return;
        realClear(id);
        (fn as (...a: unknown[]) => void)(...args);
      };
      id = realSet(fire, fallback);
      pending.set(id, fire);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) pending.delete(id);
      realClear(id);
    }) as typeof window.clearTimeout;
    document.addEventListener(
      'pointerdown',
      (event) => {
        const button = (event.target as Element | null)?.closest('button');
        if (!button || !button.textContent?.includes('確認變更')) return;
        for (const fire of [...pending.values()]) fire();
      },
      true
    );
  }, fallbackMs);
}
