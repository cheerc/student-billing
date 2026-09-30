/**
 * popstate 攔截的「先手」登記處（specs/09 §3.2；11 C；D38 F07）。
 *
 * Next App Router 在掛載時登記自己的 popstate 處理器；同一個目標（window）上的監聽器依登記順序執行，
 * 所以守衛若在「有未儲存修改」時才登記，一定排在 Next 之後——Next 會先處理返回、把頁面換掉，守衛來不及攔截
 * （連按兩次 Back 直接跳過哨兵時就會發生）。
 *
 * 解法：由根版面的元件（AppNav）在模組載入時、也就是 Next 掛載之前，先登記一個固定的 popstate 捕獲監聽器；
 * 它只是把事件轉交給目前登記的處理器（沒有登記就什麼都不做，不影響 Next）。守衛啟用時登記處理器、解除時取消，
 * 因此守衛的處理器永遠排在 Next 前面，可用 stopImmediatePropagation 讓 Next 不執行。
 */

type PopHandler = (event: PopStateEvent) => void;

interface Registry {
  popHandler: PopHandler | null;
}

const KEY = '__sbLeaveGuardRegistry';

function registry(): Registry | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, Registry | undefined>;
  return w[KEY] ?? null;
}

/** 安裝先手監聽器（可重複呼叫；只會安裝一次）。必須在根版面的模組載入階段呼叫。 */
export function installEarlyPopstateListener(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, Registry | undefined>;
  if (w[KEY]) return;
  const reg: Registry = { popHandler: null };
  w[KEY] = reg;
  window.addEventListener('popstate', (event) => reg.popHandler?.(event), true);
}

/** 登記（或以 null 取消）目前的 popstate 處理器。先手監聽器沒安裝時回傳 false。 */
export function setPopstateHandler(handler: PopHandler | null): boolean {
  const reg = registry();
  if (!reg) return false;
  reg.popHandler = handler;
  return true;
}
