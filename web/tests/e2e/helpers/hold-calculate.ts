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
