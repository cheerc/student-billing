/**
 * 未儲存修改的離頁守衛（specs/09 §3.2；11 C；D38 F07）。
 *
 * 只在「有未儲存修改」時啟用（arm），儲存成功、取消修改或元件卸載時解除（dispose）；
 * 已儲存與沒有修改的頁面不會安裝任何監聽或歷史紀錄。
 *
 * 攔截三種離開方式：
 *   1. 站內連結（側欄、品牌連結、頁內連結，含 next/link 與一般 <a>）：window 捕獲階段攔截點擊，
 *      通用於「任何導向不同網址的同源連結」，不逐一元件特判。網址完全相同時不動作（沒有要離開）。
 *   2. 瀏覽器 Back／Forward：啟用時多推一筆同網址的哨兵紀錄，使用者按返回只會退到同一頁；
 *      popstate 由根版面預先安裝的先手監聽器轉交（見 leave-guard-registry.ts：必須排在 Next 的處理器前面，
 *      stopImmediatePropagation 才能讓 Next 不執行，連按兩次 Back 跳過哨兵也攔得住），並重新補上哨兵，
 *      因此可以反覆攔截。捨棄修改時以 history.go(-2) 回到使用者原本要去的那一頁。
 *      限制：跨文件的返回（例如重新整理後才產生的舊紀錄）是整頁載入，只能靠 beforeunload 的原生提醒。
 *   3. reload／關閉分頁／輸入網址：beforeunload 觸發瀏覽器原生提醒（瀏覽器要求使用者對頁面有過互動才會顯示，
 *      這是瀏覽器規定，不是本守衛的限制；不自訂文案）。
 *
 * 用 history.pushState 時一律帶入啟用當下的 history.state（內含 Next 的 __NA 標記與路由樹），
 * Next 對 __NA 標記的 pushState 直接放行、不更動它的路由狀態，避免哨兵紀錄干擾 App Router。
 */

import { setPopstateHandler } from '@/lib/leave-guard-registry';

export type LeaveRequest = { kind: 'link'; href: string } | { kind: 'back' };

export interface UnsavedGuardOptions {
  /** 使用者嘗試離開；由呼叫端顯示確認並決定是否 leave()。 */
  onAttempt: (request: LeaveRequest) => void;
}

export interface UnsavedGuard {
  /** 啟用：安裝監聽並推入哨兵紀錄。 */
  arm(): void;
  /** 使用者確認捨棄：解除守衛並離開（back 為 history.go(-2)，link 為呼叫 navigate 一次）。 */
  leave(request: LeaveRequest, navigate: (href: string) => void): Promise<void>;
  /**
   * 解除守衛的監聽（儲存成功、取消修改或卸載）；不動歷史紀錄。
   * 回傳哨兵紀錄是否仍在：呼叫端在「仍停留在此頁」（儲存成功、取消修改）時要呼叫 unwindSentinel()，
   * 卸載時則不要（頁面正在被取代，不能再退一步）。
   */
  release(): boolean;
}

/** 還原歷史紀錄：退回一步，讓哨兵紀錄不再擋住下一次 Back。 */
export function unwindSentinel(): void {
  window.history.go(-1);
}

/** 純函式：這次點擊是不是「站內離開」（供元件與單元測試使用）。 */
export function isInternalLeaveClick(
  event: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>,
  anchor: Pick<HTMLAnchorElement, 'href' | 'target'> & { hasAttribute?: (name: string) => boolean },
  current: Pick<Location, 'origin' | 'pathname' | 'search'>
): URL | null {
  if (event.defaultPrevented) return null;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  if (anchor.target && anchor.target !== '_self') return null;
  if (anchor.hasAttribute?.('download')) return null;
  let url: URL;
  try {
    url = new URL(anchor.href, `${current.origin}${current.pathname}${current.search}`);
  } catch {
    return null;
  }
  if (url.origin !== current.origin) return null; // 站外連結由 beforeunload 處理
  if (url.pathname === current.pathname && url.search === current.search) return null; // 同網址（含只有 hash 不同）：不會離開
  return url;
}

export function createUnsavedGuard(options: UnsavedGuardOptions): UnsavedGuard {
  let armed = false;
  let sentinel = false;
  let guardPath = '';
  let guardHref = '';
  let guardState: unknown = null;

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // 部分瀏覽器需要設定 returnValue 才會顯示原生提醒
    event.returnValue = '';
  };

  const onClick = (event: MouseEvent) => {
    if (!armed) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const url = isInternalLeaveClick(event, anchor, window.location);
    if (!url) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    options.onAttempt({ kind: 'link', href: `${url.pathname}${url.search}${url.hash}` });
  };

  const onPopState = (event: PopStateEvent) => {
    if (!armed) return; // 已解除：放行給 Next 處理
    // 讓 Next 的 popstate 處理器不執行：頁面內容維持在課表頁，草稿不受影響
    event.stopImmediatePropagation();
    const atGuardPage = window.location.pathname === guardPath;
    const href = atGuardPage ? window.location.href : guardHref;
    // 補回哨兵：回到「課表頁＋哨兵」的狀態，下一次 Back 仍會被攔截
    window.history.pushState(guardState, '', href);
    if (!atGuardPage) window.history.pushState(guardState, '', href);
    sentinel = true;
    options.onAttempt({ kind: 'back' });
  };

  const teardown = () => {
    armed = false;
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('click', onClick, true);
    setPopstateHandler(null);
    window.removeEventListener('popstate', onPopState, true);
  };

  /** 退回一步並等瀏覽器處理完 popstate（含 Next 的處理器）後才 resolve。 */
  const goBackOne = () =>
    new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('popstate', onceHandler, true);
        // 等同一次 popstate 的其餘監聽器（Next）跑完，再繼續導覽，避免兩個導覽動作互相覆蓋
        setTimeout(resolve, 0);
      };
      const onceHandler = () => finish();
      window.addEventListener('popstate', onceHandler, true);
      setTimeout(finish, 500); // 保險：沒有收到 popstate 也不卡住
      window.history.go(-1);
    });

  return {
    arm() {
      if (armed) return;
      armed = true;
      guardPath = window.location.pathname;
      guardHref = window.location.href;
      guardState = window.history.state;
      window.history.pushState(guardState, '', guardHref);
      sentinel = true;
      window.addEventListener('beforeunload', onBeforeUnload);
      window.addEventListener('click', onClick, true);
      // 登記到根版面預先安裝的先手監聽器（排在 Next 的 popstate 處理器前面）；沒有它就退而在此登記（僅能攔截單步返回）
      if (!setPopstateHandler(onPopState)) window.addEventListener('popstate', onPopState, true);
    },

    async leave(request, navigate) {
      const hadSentinel = sentinel;
      teardown();
      sentinel = false;
      if (request.kind === 'back') {
        // 哨兵之上再退一步＝使用者原本要去的那一頁
        window.history.go(-2);
        return;
      }
      if (hadSentinel) await goBackOne();
      navigate(request.href);
    },

    release() {
      if (!armed) return false;
      const hadSentinel = sentinel;
      teardown();
      sentinel = false;
      return hadSentinel;
    },
  };
}
