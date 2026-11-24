// @vitest-environment jsdom
/**
 * Issue #264：ActiveRunView 的網址同步 effect 不得改寫「別的路由」的 history entry。
 *
 * 競態（Investigation Report #264）：reload 後在 hydration commit 與 passive effect flush 之間，
 * 瀏覽器 Forward 已把 window.location 切到 /settings，但 Next 的 popstate 監聽尚未掛上，
 * 本元件（render 時仍是 `/`）的 effect 用「當下」window.location.pathname 組 target，
 * replaceState 就把 /settings 那一格改寫成 /settings?view=deductions…。
 *
 * 預期值依規格手算：
 *  - render 時路徑 `/`、effect 跑時 window.location.pathname 已是 `/settings`
 *    → 不得呼叫 replaceState（元件只擁有自己路由的 history entry），/settings 網址保持原樣。
 *  - 對照組：路徑相同（`/`）時仍須把 view=deductions 寫進網址（既有行為不變）。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let renderPathname = '/';
let renderSearch = 'view=deductions';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(renderSearch),
  usePathname: () => renderPathname,
}));

import ActiveRunView from '@/components/active-run-view';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = {
  runId: 'run_264',
  items: [],
  totalStudents: 0,
  noCourseTotal: 0,
  nextCursor: null,
  stats: { totalStudents: 0, mismatchCount: 0, issuesCount: 0, classScopeTotal: 0, filteredNoCourseCount: 0 },
};
const OPTIONS = {
  runId: 'run_264',
  importId: 'imp_264',
  totalStudents: 0,
  noCourseTotal: 0,
  options: {},
  columnOptions: {},
  applicableRateContext: { classKey: null, status: 'requires_class' as const },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  act(() => {
    root.render(
      <ActiveRunView
        runId="run_264"
        revision={1}
        asOfDate="2026-01-01"
        initialData={DATA as never}
        initialOptions={OPTIONS as never}
        deductionsUnavailable={{ code: 'X', message: 'synthetic' }}
      />,
    );
  });
}

describe('ActiveRunView URL-sync (#264)', () => {
  it('render 時路徑與 effect 時 window.location 不同（Forward 已切到 /settings）→ 不得 replaceState 改寫該 entry', () => {
    renderPathname = '/';
    window.history.replaceState(null, '', '/settings');
    const spy = vi.spyOn(window.history, 'replaceState');
    mount();
    expect(spy).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search).toBe('/settings');
  });

  it('對照組：路徑相同時仍把頁籤寫入網址（既有行為不變）', () => {
    renderPathname = '/';
    window.history.replaceState(null, '', '/');
    const spy = vi.spyOn(window.history, 'replaceState');
    mount();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/');
    expect(new URLSearchParams(window.location.search).get('view')).toBe('deductions');
  });
});
