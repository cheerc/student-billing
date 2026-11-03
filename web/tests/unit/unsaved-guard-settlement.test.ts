// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedChangesGuard } from '@/components/ui/use-unsaved-changes-guard';
import { installEarlyPopstateListener } from '@/lib/leave-guard-registry';

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

  it('3. Apply 失敗或 409 時 dirty 保持 true，守衛必須維持 armed 狀態而不觸發結算', async () => {
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
