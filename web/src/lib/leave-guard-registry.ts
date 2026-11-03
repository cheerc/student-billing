/**
 * popstate 攔截的「先手」登記處（specs/09 §3.2；11 C；D38 F07；Issue #207 Phase 2）。
 *
 * Next App Router 在掛載時登記自己的 popstate 處理器；同一個目標（window）上的監聽器依登記順序執行，
 * 所以守衛若在「有未儲存修改」時才登記，一定排在 Next 之後——Next 會先處理返回、把頁面換掉，守衛來不及攔截
 * （連按兩次 Back 直接跳過哨兵時就會發生）。
 *
 * 解法：由根版面的元件（AppNav）在模組載入時、也就是 Next 掛載之前，先登記一個固定的 popstate 捕獲監聽器；
 * 它只是把事件轉交給目前登記的處理器（沒有登記就什麼都不做，不影響 Next）。守衛啟用時登記處理器、解除時取消，
 * 因此守衛的處理器永遠排在 Next 前面，可用 stopImmediatePropagation 讓 Next 不執行。
 *
 * Phase 2 擴充：
 * 增加根層單次 landing 吸收器（absorbedOpId）：若元件在 history.go(-1) 尚未落地前卸載，
 * 根層先手監聽器在接收到匹配 { role: 'base', opId } 的 popstate 時，自動調用 stopImmediatePropagation()
 * 吞掉事件並清理標記，防止卸載後的孤兒歷史步進打入 Next App Router。
 */

type PopHandler = (event: PopStateEvent) => void;

interface Registry {
  popHandler: PopHandler | null;
  absorbedOpId: number | null;
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
  const reg: Registry = { popHandler: null, absorbedOpId: null };
  w[KEY] = reg;
  window.addEventListener(
    'popstate',
    (event) => {
      // 1. 若有活動中的處理器，交由處理器處理
      if (reg.popHandler) {
        reg.popHandler(event);
        return;
      }
      // 2. 若無活動處理器（例如元件卸載），檢查是否為已登記的根層 landing 吸收器
      const guardMeta = (event.state as any)?.__sbUnsavedGuard;
      if (reg.absorbedOpId !== null && guardMeta?.role === 'base' && guardMeta?.opId === reg.absorbedOpId) {
        event.stopImmediatePropagation();
        reg.absorbedOpId = null;
        return;
      }
    },
    true
  );
}

/** 登記（或以 null 取消）目前的 popstate 處理器。先手監聽器沒安裝時回傳 false。 */
export function setPopstateHandler(handler: PopHandler | null): boolean {
  const reg = registry();
  if (!reg) return false;
  reg.popHandler = handler;
  return true;
}

/** 登記根層單次 landing 吸收器（opId）。若在途 go(-1) 於元件卸載後才抵達，由此吸收器吞掉。 */
export function registerLandingAbsorption(opId: number): void {
  const reg = registry();
  if (!reg) return;
  reg.absorbedOpId = opId;
}

/** 清理根層 landing 吸收器。 */
export function clearLandingAbsorption(opId?: number): void {
  const reg = registry();
  if (!reg) return;
  if (opId === undefined || reg.absorbedOpId === opId) {
    reg.absorbedOpId = null;
  }
}
