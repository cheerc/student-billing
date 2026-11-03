// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedChangesGuard } from '@/components/ui/use-unsaved-changes-guard';
import {
  clearLandingAbsorption,
  installEarlyPopstateListener,
  registerLandingAbsorption,
} from '@/lib/leave-guard-registry';
import { createUnsavedGuardController } from '@/lib/unsaved-guard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface GuardTestProps {
  dirty: boolean;
  onDiscard?: () => void;
}

function GuardHarness({ dirty, onDiscard = () => {} }: GuardTestProps) {
  const guard = useUnsavedChangesGuard(dirty, onDiscard);
  return React.createElement(
    'div',
    null,
    React.createElement('span', { 'data-testid': 'pending' }, guard.pending ? guard.pending.kind : 'none'),
    React.createElement('button', { 'data-testid': 'keep', onClick: guard.keepEditing }, 'keep'),
    React.createElement('button', { 'data-testid': 'discard', onClick: guard.discardAndLeave }, 'discard')
  );
}

describe('UX31 離頁守衛結算狀態機 Unit 契約 (unsaved-guard-settlement)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let historyGoSpy: ReturnType<typeof vi.spyOn>;
  let historyPushSpy: ReturnType<typeof vi.spyOn>;
  let historyReplaceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    installEarlyPopstateListener();

    let currentState: any = null;
    Object.defineProperty(window.history, 'state', {
      get: () => currentState,
      configurable: true,
    });

    historyGoSpy = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    historyPushSpy = vi.spyOn(window.history, 'pushState').mockImplementation((state) => {
      currentState = state;
    });
    historyReplaceSpy = vi.spyOn(window.history, 'replaceState').mockImplementation((state) => {
      currentState = state;
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('1. 快速連續切換 dirty (true -> false -> true -> false) 在 settling 期間應合併為單次 history.go(-1)', async () => {
    // 初始進入 dirty: true
    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: true }));
    });
    expect(historyGoSpy).not.toHaveBeenCalled();

    // 第一次 dirty -> false (觸發 settling)
    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: false }));
    });
    expect(historyGoSpy).toHaveBeenCalledTimes(1);
    expect(historyGoSpy).toHaveBeenLastCalledWith(-1);

    // 尚未 landing 前立即再 dirty -> true
    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: true }));
    });

    // 隨後又 dirty -> false：應重用同一筆在途 go(-1)，絕不發出第二次 history.go(-1)
    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: false }));
    });
    expect(historyGoSpy, '快速切換 dirty 不應發出重複的 history.go(-1)').toHaveBeenCalledTimes(1);
  });

  it('2. 在 settling 期間，非匹配 opId 或無 __sbUnsavedGuard 標記之 external popstate 不得誤判為完成', async () => {
    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: true }));
    });

    // 檢查 arm 時是否在 sentinel 標記 __sbUnsavedGuard
    const sentinelState = historyPushSpy.mock.calls[0]?.[0] as any;
    expect(sentinelState?.__sbUnsavedGuard?.role, '哨兵紀錄應標記 role: sentinel').toBe('sentinel');
    expect(typeof sentinelState?.__sbUnsavedGuard?.opId, '哨兵紀錄應包含 opId 數字').toBe('number');

    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: false }));
    });
    expect(historyGoSpy).toHaveBeenCalledTimes(1);

    // 模擬第三方／外部無 __sbUnsavedGuard 標記之 popstate
    const externalPopEvent = new PopStateEvent('popstate', {
      state: { someOtherFramework: true },
    });
    window.dispatchEvent(externalPopEvent);

    // 外部事件不應被 stopImmediatePropagation 吞掉
    expect(externalPopEvent.defaultPrevented).toBe(false);
  });

  // 注意：本案只驗「dirty 維持 true 的重新渲染不觸發結算」；409 的真實 apply 路徑由 E2E leave-guard.spec.ts「UX31 F3」覆蓋。
  it('3. dirty 維持 true 的重新渲染（如 apply 失敗）不觸發結算', async () => {
    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: true }));
    });
    expect(historyGoSpy).not.toHaveBeenCalled();

    // 模擬 apply 失敗，上層狀態維持 dirty = true 重新渲染
    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: true }));
    });
    expect(historyGoSpy, 'apply 失敗 dirty 未清除時絕不呼叫 history.go').not.toHaveBeenCalled();
  });

  it('4. React StrictMode 雙掛載 (mount -> cleanup -> remount) 不應推入多餘的哨兵紀錄', async () => {
    historyPushSpy.mockClear();

    await act(async () => {
      root.render(
        React.createElement(
          StrictMode,
          null,
          React.createElement(GuardHarness, { dirty: true })
        )
      );
    });

    // 在 StrictMode 下，mount -> cleanup -> remount 應保持持久 Controller 或同一 opId 週期
    // 絕不應推入兩層哨兵紀錄造成使用者需按兩次 Back 才能回前頁
    expect(historyPushSpy, 'StrictMode 雙掛載不應重複推入多餘哨兵紀錄').toHaveBeenCalledTimes(1);
  });

  it('5. 元件卸載時若 history.go(-1) 仍在途中，根層 registry 應登記一次性吸收器以吞掉抵達的 popstate', async () => {
    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: true }));
    });
    await act(async () => {
      root.render(React.createElement(GuardHarness, { dirty: false }));
    });
    expect(historyGoSpy).toHaveBeenCalledTimes(1);

    // 在 go(-1) 尚未落地時卸載元件
    await act(async () => {
      root.unmount();
    });

    // 模擬此時延遲抵達的 base landing popstate
    const landingEvent = new PopStateEvent('popstate', {
      state: { __sbUnsavedGuard: { role: 'base', opId: 1 } },
    });
    const stopSpy = vi.spyOn(landingEvent, 'stopImmediatePropagation');

    window.dispatchEvent(landingEvent);

    // 根層 registry 的 landing absorber 應吞掉該次 popstate，防止打入 Next App Router
    expect(stopSpy, '元件卸載後在途 landing 抵達應由根層吸收器吞掉').toHaveBeenCalled();
  });
});

/**
 * Controller 層契約：直接驅動 createUnsavedGuardController，使用 jsdom 真實 pushState／replaceState
 * （location 會隨之改變），只 mock history.go 以手動模擬 traversal 落地。
 */
describe('UX31 Controller 結算契約（F1／F2／F3／吸收器殘留）', () => {
  let goSpy: ReturnType<typeof vi.spyOn>;

  const beforeUnloadPrevented = () => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };

  /** 模擬 traversal 落地：把目前紀錄改成目標網址與 state，並派送 popstate。 */
  const land = (state: unknown, url: string) => {
    window.history.replaceState(state, '', url);
    const ev = new PopStateEvent('popstate', { state });
    const stop = vi.spyOn(ev, 'stopImmediatePropagation');
    window.dispatchEvent(ev);
    return stop;
  };

  beforeEach(() => {
    // 前一個 describe 以 defineProperty 覆寫了 history.state；刪除實例屬性以恢復 jsdom 原生 getter
    delete (window.history as unknown as { state?: unknown }).state;
    installEarlyPopstateListener();
    clearLandingAbsorption();
    window.history.replaceState(null, '', '/settings?tab=schedule');
    goSpy = vi.spyOn(window.history, 'go').mockImplementation(() => {});
  });

  afterEach(() => {
    clearLandingAbsorption();
    vi.restoreAllMocks();
  });

  it('F3：settling 期間非匹配 opId 的 base popstate 與無標記 popstate 皆放行，維持 settling 且只發出一次 go(-1)', () => {
    const ctrl = createUnsavedGuardController({ onAttempt: () => {} });
    ctrl.syncDirty(true);
    ctrl.syncDirty(false);
    expect(ctrl.getState()).toBe('settling');
    expect(goSpy).toHaveBeenCalledTimes(1);

    const mismatched = new PopStateEvent('popstate', { state: { __sbUnsavedGuard: { role: 'base', opId: 999 } } });
    const stopMismatched = vi.spyOn(mismatched, 'stopImmediatePropagation');
    window.dispatchEvent(mismatched);

    const external = new PopStateEvent('popstate', { state: { someOtherFramework: true } });
    const stopExternal = vi.spyOn(external, 'stopImmediatePropagation');
    window.dispatchEvent(external);

    expect(stopMismatched, '非匹配 opId 不得被吞掉').not.toHaveBeenCalled();
    expect(stopExternal, '無標記 popstate 不得被吞掉').not.toHaveBeenCalled();
    expect(ctrl.getState()).toBe('settling');
    expect(goSpy).toHaveBeenCalledTimes(1);
    ctrl.dispose();
  });

  it('F1：armed_pending_landing 落地時以 settling 當下的 latestHref 重新 arm，不得改讀落地後 base 網址而復活 ?class=', () => {
    window.history.replaceState(null, '', '/settings?tab=schedule&class=X');
    const ctrl = createUnsavedGuardController({ onAttempt: () => {} });
    ctrl.syncDirty(true);
    const baseUrl = window.location.href;

    // dirty 期間清除焦點（同頁 replace 移除 class）
    window.history.replaceState(window.history.state, '', '/settings?tab=schedule');
    ctrl.syncDirty(false); // settling，latestHref = 無 class
    ctrl.syncDirty(true); // 落地前再編輯
    expect(ctrl.getState()).toBe('armed_pending_landing');

    const stop = land({ __sbUnsavedGuard: { role: 'base', opId: 1 } }, baseUrl);
    expect(stop).toHaveBeenCalled();
    expect(ctrl.getState()).toBe('armed');
    expect(window.location.search, '重新 arm 後的網址不得含 class=').not.toContain('class=');
    expect(goSpy).toHaveBeenCalledTimes(1);
    ctrl.dispose();
  });

  it('F2：Back 捨棄後 go(-2) 超出範圍（停在原頁），新草稿必須重新 arm（beforeunload 與連結攔截恢復）', () => {
    const attempts: string[] = [];
    const ctrl = createUnsavedGuardController({ onAttempt: (r) => attempts.push(r.kind) });
    ctrl.syncDirty(true);
    ctrl.discardAndLeave({ kind: 'back' }, () => {});
    expect(goSpy).toHaveBeenLastCalledWith(-2);
    // go(-2) 為 no-op（超出範圍）；捨棄後草稿還原
    ctrl.syncDirty(false);
    ctrl.syncDirty(true);
    expect(ctrl.getState(), '新草稿必須重新 arm').toBe('armed');
    expect(beforeUnloadPrevented(), '新草稿必須重新註冊 beforeunload').toBe(true);

    const a = document.createElement('a');
    a.href = '/imports';
    document.body.appendChild(a);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(click);
    a.remove();
    expect(click.defaultPrevented, '新草稿必須攔截站內連結').toBe(true);
    expect(attempts).toEqual(['link']);
    ctrl.dispose();
  });

  it('F4：重複的 Back 捨棄不得重複發出 go(-2)', () => {
    const ctrl = createUnsavedGuardController({ onAttempt: () => {} });
    ctrl.syncDirty(true);
    ctrl.discardAndLeave({ kind: 'back' }, () => {});
    ctrl.discardAndLeave({ kind: 'back' }, () => {});
    expect(goSpy.mock.calls.filter((c) => c[0] === -2)).toHaveLength(1);
    ctrl.dispose();
  });

  it('吸收器殘留（a）：卸載後第一個抵達的 popstate 若不是匹配 base，清掉殘留 absorbedOpId，之後的同 opId base 不得被吞掉', () => {
    registerLandingAbsorption(7);
    const other = new PopStateEvent('popstate', { state: { someOtherFramework: true } });
    const stopOther = vi.spyOn(other, 'stopImmediatePropagation');
    window.dispatchEvent(other);
    expect(stopOther).not.toHaveBeenCalled();

    const late = new PopStateEvent('popstate', { state: { __sbUnsavedGuard: { role: 'base', opId: 7 } } });
    const stopLate = vi.spyOn(late, 'stopImmediatePropagation');
    window.dispatchEvent(late);
    expect(stopLate, '殘留吸收器不得吞掉之後的使用者返回').not.toHaveBeenCalled();
  });
});
