/**
 * 未儲存修改的離頁守衛（specs/09 §3.2；11 C；D38 F07；Issue #207 Phase 2）。
 *
 * 只在「有未儲存修改」時啟用（arm），儲存成功、取消修改或元件卸載時結算解除；
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
 * Phase 2 狀態機 Controller 升級（Issue #207）：
 *   - 持久 Controller 狀態機：clean / armed / settling / armed_pending_landing / leaving_back / disposed
 *   - 命名空間歷史標記：__sbUnsavedGuard: { role: 'base' | 'sentinel', opId: number }
 *   - 結算期間保護：Save/Cancel 使 dirty->false 時轉為 settling 並發起單次 history.go(-1)；
 *     若期間點擊站內連結則以單槽 queuedHref 排隊並阻止 Next 競爭路由，待 base 落地後以 queueMicrotask 單次派送；
 *     若期間立即再編輯則轉入 armed_pending_landing，待落地後同步 URL 並重推哨兵，合併在途 go(-1) 且不誤跳離頁確認視窗；
 *     base 落地時以 replaceState 同步 latestHref，防止 dirty 期間清除的 ?class= 焦點參數復活。
 */

import {
  clearLandingAbsorption,
  registerLandingAbsorption,
  setPopstateHandler,
} from '@/lib/leave-guard-registry';

export type LeaveRequest = { kind: 'link'; href: string } | { kind: 'back' };

export type UnsavedGuardState =
  | 'clean'
  | 'armed'
  | 'settling'
  | 'armed_pending_landing'
  | 'leaving_back'
  | 'disposed';

export interface UnsavedGuardOptions {
  /** 使用者嘗試離開；由呼叫端顯示確認並決定是否 leave()。 */
  onAttempt: (request: LeaveRequest) => void;
  /** 可選導航回呼（通常為 router.push 或 window.location.assign）。 */
  navigate?: (href: string) => void;
  /** 狀態變更回呼（供內部監控或單元測試）。 */
  onStateChange?: (state: UnsavedGuardState) => void;
}

export interface UnsavedGuardController {
  getState(): UnsavedGuardState;
  syncDirty(dirty: boolean): void;
  discardAndLeave(request: LeaveRequest, navigate: (href: string) => void): void;
  setNavigate(navigate: (href: string) => void): void;
  keepEditing(): void;
  dispose(): void;
  getPendingRequest(): LeaveRequest | null;
}

/** 舊版相容介面（若有既有呼叫端）。 */
export interface UnsavedGuard {
  arm(): void;
  leave(request: LeaveRequest, navigate: (href: string) => void): Promise<void>;
  release(): boolean;
}

/** 還原歷史紀錄：退回一步，讓哨兵紀錄不再擋住下一次 Back。 */
export function unwindSentinel(): void {
  if (typeof window !== 'undefined') {
    window.history.go(-1);
  }
}

function extractState(state: unknown): Record<string, unknown> {
  if (state && typeof state === 'object') {
    return { ...(state as Record<string, unknown>) };
  }
  return {};
}

function sanitizeState(state: unknown): Record<string, unknown> {
  const s = extractState(state);
  delete s.__sbUnsavedGuard;
  return s;
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

export function createUnsavedGuardController(options: UnsavedGuardOptions): UnsavedGuardController {
  let state: UnsavedGuardState = 'clean';
  let opId = 0;
  let activeOpId = 0;
  let guardPath = '';
  let guardHref = '';
  let guardState: unknown = null;
  let latestHref = '';
  let latestState: unknown = null;
  let queuedHref: string | null = null;
  let queuedNavigate: ((href: string) => void) | null = null;
  let pendingRequest: LeaveRequest | null = null;

  const setState = (next: UnsavedGuardState) => {
    state = next;
    options.onStateChange?.(next);
  };

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  };

  const onClick = (event: MouseEvent) => {
    if (state === 'clean' || state === 'leaving_back' || state === 'disposed') return;

    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const url = isInternalLeaveClick(event, anchor, window.location);
    if (!url) return;

    if (state === 'armed' || state === 'armed_pending_landing') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const href = `${url.pathname}${url.search}${url.hash}`;
      if (!pendingRequest) {
        pendingRequest = { kind: 'link', href };
      }
      options.onAttempt(pendingRequest);
      return;
    }

    if (state === 'settling') {
      // 結算期間排隊該連結，阻止 Next.js 提前啟動競爭路由
      event.preventDefault();
      event.stopImmediatePropagation();
      queuedHref = `${url.pathname}${url.search}${url.hash}`;
    }
  };

  const onPopState = (event: PopStateEvent) => {
    if (state === 'clean' || state === 'disposed' || state === 'leaving_back') return;

    const guardMeta =
      (event.state as Record<string, unknown> | null)?.__sbUnsavedGuard ||
      (window.history.state as Record<string, unknown> | null)?.__sbUnsavedGuard;

    const metaRole = (guardMeta as { role?: string; opId?: number } | undefined)?.role;
    const metaOpId = (guardMeta as { role?: string; opId?: number } | undefined)?.opId;

    if (state === 'armed') {
      // 使用者按瀏覽器 Back
      event.stopImmediatePropagation();
      const atGuardPage = window.location.pathname === guardPath;
      const href = atGuardPage ? window.location.href : guardHref;

      const baseState = extractState(guardState || latestState || window.history.state);
      baseState.__sbUnsavedGuard = { role: 'base', opId: activeOpId };

      const sentinelState = extractState(guardState || latestState || window.history.state);
      sentinelState.__sbUnsavedGuard = { role: 'sentinel', opId: activeOpId };

      if (atGuardPage) {
        window.history.replaceState(baseState, '', href);
        window.history.pushState(sentinelState, '', href);
      } else {
        // 連按兩次 Back 跳過哨兵退到前一頁：在前一頁之上依序重新推入 base 與 sentinel
        window.history.pushState(baseState, '', guardHref);
        window.history.pushState(sentinelState, '', guardHref);
      }

      if (!pendingRequest) {
        pendingRequest = { kind: 'back' };
      }
      options.onAttempt(pendingRequest);
      return;
    }

    if (state === 'settling') {
      // 檢查是否為相符的 base 紀錄落地
      if (metaRole === 'base' && metaOpId === activeOpId) {
        event.stopImmediatePropagation();
        clearLandingAbsorption(activeOpId);

        // 阻斷 Next 過期還原並同步最新同頁 URL（清除 class 等 query）
        const cleanState = sanitizeState(latestState || event.state || window.history.state);
        window.history.replaceState(cleanState, '', latestHref);

        teardownListeners();
        setState('clean');

        if (queuedHref) {
          const dest = queuedHref;
          const nav = queuedNavigate || options.navigate;
          queuedHref = null;
          queuedNavigate = null;
          queueMicrotask(() => {
            if (nav) nav(dest);
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            else if (typeof window !== 'undefined') window.location.href = dest;
          });
        }
        return;
      }
      // 非匹配 opId 或無標記之 external popstate：放行，不吞掉
      return;
    }

    if (state === 'armed_pending_landing') {
      // 在途 go(-1) 落地至 base
      if (metaRole === 'base' && metaOpId === activeOpId) {
        event.stopImmediatePropagation();
        clearLandingAbsorption(activeOpId);

        // 落地至 base，現在安全推進新 opId 並補推新 sentinel
        // 以 settling 當下記錄的 latestHref／latestState 重新 arm；不可改讀落地後的 location.href
        // （base 紀錄保留 arm 當時的網址，例如已被清除的 ?class=，改讀會讓它復活）
        opId++;
        activeOpId = opId;
        guardHref = latestHref;
        guardPath = new URL(latestHref, window.location.href).pathname;

        const cleanState = sanitizeState(latestState || event.state || window.history.state);
        guardState = cleanState;
        const newBaseState = { ...cleanState, __sbUnsavedGuard: { role: 'base', opId: activeOpId } };
        window.history.replaceState(newBaseState, '', latestHref);

        const newSentinelState = { ...cleanState, __sbUnsavedGuard: { role: 'sentinel', opId: activeOpId } };
        window.history.pushState(newSentinelState, '', latestHref);

        setState('armed');
        return;
      }
      return;
    }
  };

  const setupListeners = () => {
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('click', onClick, true);
    if (!setPopstateHandler(onPopState)) {
      window.addEventListener('popstate', onPopState, true);
    }
  };

  const teardownListeners = () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('click', onClick, true);
    setPopstateHandler(null);
    window.removeEventListener('popstate', onPopState, true);
  };

  const armInternal = () => {
    guardState = window.history.state;
    const currentMeta = (window.history.state as Record<string, unknown> | null)?.__sbUnsavedGuard as
      | { role?: string; opId?: number }
      | undefined;
    if (currentMeta?.role === 'sentinel') {
      // 哨兵紀錄已存在於歷史頂層（例如 StrictMode 雙掛載）：重用既有紀錄，不重複 pushState
      activeOpId = currentMeta.opId || opId;
      guardPath = window.location.pathname;
      guardHref = window.location.href;
      latestHref = guardHref;
      latestState = window.history.state;
      setupListeners();
      setState('armed');
      return;
    }

    opId++;
    activeOpId = opId;
    guardPath = window.location.pathname;
    guardHref = window.location.href;
    latestHref = guardHref;
    latestState = window.history.state;

    const baseState = extractState(latestState);
    baseState.__sbUnsavedGuard = { role: 'base', opId: activeOpId };
    window.history.replaceState(baseState, '', guardHref);

    const sentinelState = extractState(latestState);
    sentinelState.__sbUnsavedGuard = { role: 'sentinel', opId: activeOpId };
    window.history.pushState(sentinelState, '', guardHref);

    setupListeners();
    setState('armed');
  };

  return {
    getState: () => state,
    getPendingRequest: () => pendingRequest,

    syncDirty(dirty: boolean) {
      if (typeof window === 'undefined') return;

      if (dirty) {
        if (state === 'clean' || state === 'disposed' || state === 'leaving_back') {
          // leaving_back：go(-2) 超出範圍（例如分頁只有本頁）時仍停在原頁，新草稿必須重新受保護
          armInternal();
          return;
        }
        if (state === 'settling') {
          // 結算在途期間使用者立即再編輯
          queuedHref = null;
          queuedNavigate = null;
          window.addEventListener('beforeunload', onBeforeUnload);
          setState('armed_pending_landing');
          return;
        }
        // armed 或 armed_pending_landing：保持現況
        return;
      }

      // dirty === false
      if (state === 'armed') {
        setState('settling');
        window.removeEventListener('beforeunload', onBeforeUnload);
        latestHref = window.location.href;
        latestState = window.history.state;
        registerLandingAbsorption(activeOpId);
        window.history.go(-1);
        return;
      }

      if (state === 'armed_pending_landing') {
        // 再編輯後又再次取消：共用同一筆在途 go(-1)，絕不發出第二次 history.go(-1)
        // 在途期間仍停在哨兵紀錄，同步最新同頁網址供落地使用
        setState('settling');
        window.removeEventListener('beforeunload', onBeforeUnload);
        latestHref = window.location.href;
        latestState = window.history.state;
        return;
      }
    },

    discardAndLeave(request: LeaveRequest, navigate: (href: string) => void) {
      pendingRequest = null;
      if (typeof window === 'undefined') {
        if (request.kind === 'link') navigate(request.href);
        return;
      }

      if (request.kind === 'back') {
        // 只在守衛中才離開；重複呼叫（已 leaving_back）或已結算時不得再發 go(-2)
        if (state !== 'armed' && state !== 'armed_pending_landing') return;
        setState('leaving_back');
        teardownListeners();
        clearLandingAbsorption(activeOpId);
        window.history.go(-2);
        return;
      }

      // request.kind === 'link'
      if (state === 'armed' || state === 'armed_pending_landing') {
        const inFlight = state === 'armed_pending_landing';
        queuedHref = request.href;
        queuedNavigate = navigate;
        setState('settling');
        window.removeEventListener('beforeunload', onBeforeUnload);
        latestHref = window.location.href;
        latestState = window.history.state;
        if (!inFlight) {
          // armed_pending_landing 已有在途 go(-1)，共用它，不發第二次
          registerLandingAbsorption(activeOpId);
          window.history.go(-1);
        }
        return;
      }

      if (state === 'clean') {
        navigate(request.href);
      }
    },

    keepEditing() {
      pendingRequest = null;
    },

    setNavigate(nav: (href: string) => void) {
      options.navigate = nav;
    },

    dispose() {
      if (state === 'disposed') return;
      setState('disposed');
      teardownListeners();
      queuedHref = null;
      queuedNavigate = null;
      pendingRequest = null;
    },
  };
}

/** 舊版薄相容函式。 */
export function createUnsavedGuard(options: UnsavedGuardOptions): UnsavedGuard {
  const ctrl = createUnsavedGuardController(options);
  return {
    arm() {
      ctrl.syncDirty(true);
    },
    async leave(request: LeaveRequest, navigate: (href: string) => void) {
      ctrl.discardAndLeave(request, navigate);
    },
    release() {
      const had = ctrl.getState() === 'armed' || ctrl.getState() === 'armed_pending_landing';
      ctrl.dispose();
      return had;
    },
  };
}
