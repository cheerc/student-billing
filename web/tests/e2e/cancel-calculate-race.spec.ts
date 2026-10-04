import { test, expect, type Page, type Route } from '@playwright/test';
import {
  activateFixture,
  dirtyBar,
  keepEditing,
  leaveDialog,
  openSchedule,
  sideLink,
  startInput,
} from './helpers/c-batch';

/**
 * UX31／operator d-20260930101112324336-24：唯讀 calculate 不得阻擋取消草稿。
 * 走真實 SettingsEditor、calculate HTTP、native dialog 與 pointer 事件，不直接呼叫 resetDraft。
 * 可取消 debounce barrier 只延後原 callback；clearTimeout 會刪除 callback，不能將已取消的工作復活。
 * 原 reviewer run3 沒有 trace，本檔驗證新操作契約，不宣稱證實該次失敗的歷史原因。
 */
test.use({ trace: 'on' });

interface Barrier {
  hold: boolean;
  readyCount(): number;
  release(): number;
  events: Array<{ kind: string; id?: number; t: number; dirty?: number; disabled?: boolean }>;
}

type ProbeWindow = Window & { __cancelRace: Barrier };

const cancelButton = (page: Page) => page.getByRole('button', { name: '取消修改', exact: true });
const reviewButton = (page: Page) => page.getByRole('button', { name: '確認變更', exact: true });
// 以欄位意義定位，不用 td 索引（#80 前段插入兩欄後，舊 nth(5) 會指到 col-time）
const overlap = (page: Page) => page.locator('.schedule-table tbody tr').nth(3).locator('[data-calc="anqin-overlap"]');

async function installBarrier(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as ProbeWindow;
    const nativeSet = window.setTimeout.bind(window);
    const nativeClear = window.clearTimeout.bind(window);
    const pending = new Map<number, { callback: () => void; ready: boolean }>();
    const events: Barrier['events'] = [];
    const record = (kind: string, id?: number) => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '取消修改');
      const event = { kind, id, t: performance.now(), dirty: document.querySelectorAll('.save-status-dirty').length, disabled: button?.disabled };
      events.push(event);
      console.log('[cancel-race]' + JSON.stringify(event));
    };
    w.__cancelRace = {
      hold: false,
      events,
      readyCount: () => [...pending.values()].filter(p => p.ready).length,
      release: () => {
        let executed = 0;
        for (const [id, entry] of [...pending]) {
          if (!entry.ready || !pending.has(id)) continue;
          pending.delete(id);
          record('timer-release', id);
          entry.callback();
          executed += 1;
        }
        return executed;
      },
    };
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout !== 250 || typeof handler !== 'function') return nativeSet(handler, timeout, ...args);
      const callback = () => handler(...args);
      const id = nativeSet(() => {
        const entry = pending.get(id);
        if (!entry) return;
        if (w.__cancelRace.hold) {
          entry.ready = true;
          record('timer-ready', id);
        } else {
          pending.delete(id);
          record('timer-run', id);
          callback();
        }
      }, timeout);
      pending.set(id, { callback, ready: false });
      record('timer-schedule', id);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined && pending.delete(id)) record('timer-cancel', id);
      nativeClear(id);
    }) as typeof window.clearTimeout;
    for (const kind of ['pointerdown', 'pointerup', 'click']) {
      document.addEventListener(kind, e => {
        if ((e.target as Element)?.closest('button')?.textContent?.trim() === '取消修改') record(kind);
      }, true);
    }
    let previous = document.querySelectorAll('.save-status-dirty').length;
    new MutationObserver(() => {
      const current = document.querySelectorAll('.save-status-dirty').length;
      if (current !== previous) { previous = current; record('dirty-change'); }
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}

async function holdDebounce(page: Page) {
  await page.evaluate(() => { (window as unknown as ProbeWindow).__cancelRace.hold = true; });
}

async function releaseDebounce(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as ProbeWindow).__cancelRace.release());
}

async function waitReady(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as ProbeWindow).__cancelRace.readyCount())).toBe(1);
}

/** route.fetch 先執行真實 calculate，僅延後配送完整 response，沒有自製計算結果。 */
async function holdCalculate(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0;
  const handler = async (route: Route) => {
    const response = await route.fetch();
    held += 1;
    console.log('[cancel-race] real-calculate-held ' + held);
    await gate;
    await route.fulfill({ response });
  };
  await page.route('**/api/v1/settings/calculate', handler);
  return { release, count: () => held, dispose: () => page.unroute('**/api/v1/settings/calculate', handler) };
}

async function enterFromHome(page: Page) {
  await page.goto('/');
  await sideLink(page, /課表設定/).click();
  await expect(startInput(page)).toBeVisible();
  await expect(overlap(page)).toHaveText(/40/); // seed 15:20 → 安親重疊40分，獨立手算
  await installBarrier(page);
}

async function expectCleanHistoryAndClose(page: Page) {
  await expect(dirtyBar(page)).toHaveCount(0);
  console.log('[cancel-race] events-before-navigation ' + JSON.stringify(await page.evaluate(() => (window as unknown as ProbeWindow).__cancelRace.events)));
  await sideLink(page, /匯入學生/).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/imports');
  await expect(leaveDialog(page)).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/settings');
  await expect(startInput(page)).toHaveValue('15:20');
  await expect(dirtyBar(page)).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  const dialogs: string[] = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.type());
    await d.accept().catch(() => {});
  });
  const closePromise = page.waitForEvent('close');
  await page.close({ runBeforeUnload: true });
  await closePromise;
  expect(page.isClosed()).toBe(true);
  expect(dialogs).toEqual([]);
}

test.afterEach(async ({ page }, info) => {
  try {
    if (!page.isClosed()) {
      const events = await page.evaluate(() => (window as unknown as Partial<ProbeWindow>).__cancelRace?.events ?? []);
      console.log('[cancel-race] events-after-test ' + JSON.stringify(events));
      await info.attach('cancel-race-events', {
        body: JSON.stringify(events, null, 2),
        contentType: 'application/json',
      });
    }
  } catch {
    // 頁面已關閉或正在關閉中（如關頁測試），忽略 evaluate 競態
  }
});

test('calculate已在途仍可取消；baseline與dirty還原，舊回應不能冒充目前值，守衛／歷史／關頁清理', async ({ page }) => {
  await enterFromHome(page);
  await expect(cancelButton(page)).toBeDisabled(); // 無dirty不開放取消
  const held = await holdCalculate(page);
  try {
    await startInput(page).fill('14:20');
    await expect.poll(held.count).toBe(1);
    await expect(reviewButton(page)).toBeDisabled(); // 只解除取消，不解除確認gate
    await expect(cancelButton(page)).toBeEnabled();
    await holdDebounce(page); // 讓取消後baseline的新請求暫不開始，刻意保留舊requestKey為latest
    await cancelButton(page).click();
    await expect(startInput(page)).toHaveValue('15:20');
    await expect(dirtyBar(page)).toHaveCount(0);
    await waitReady(page);
    const delivered = page.waitForResponse(r => r.url().includes('/settings/calculate'));
    held.release();
    await (await delivered).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(overlap(page)).not.toHaveText(/100/); // 舊14:20→100分不可當15:20的結果
    await expect(startInput(page)).toHaveValue('15:20');
    await expect(dirtyBar(page)).toHaveCount(0);
    await held.dispose();
    expect(await releaseDebounce(page)).toBe(1);
    await expect(overlap(page)).toHaveText(/40/);
    await expectCleanHistoryAndClose(page);
  } finally { held.release(); }
});

test('完整F1前置：calculate在pointerdown/up間啟動，一次原生取消仍還原baseline／dirty0', async ({ page }) => {
  await enterFromHome(page);
  const row = page.locator('.schedule-table tbody tr').nth(3);
  await row.locator('input.input-weekday').fill('八');
  await expect(page.locator('[data-unknown-weekday-notice]')).toBeVisible();
  await page.locator('main').innerText();
  await row.locator('input.input-weekday').fill('');
  await expect(page.locator('[data-unknown-weekday-notice]')).toContainText('沒有填星期');
  await page.locator('main').innerText();
  await cancelButton(page).click();
  await expect(dirtyBar(page)).toHaveCount(0);
  await page.route('**/api/v1/settings/calculate', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'SQLITE_ERROR: internal failure' }) }));
  await startInput(page).fill('14:10');
  await expect(page.locator('[data-calculate-error]')).toBeVisible();
  await page.locator('main').innerText();
  await page.unroute('**/api/v1/settings/calculate');
  await cancelButton(page).click();
  await expect(dirtyBar(page)).toHaveCount(0);
  await holdDebounce(page);
  await startInput(page).fill('14:20');
  await sideLink(page, /匯入學生/).click();
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).innerText();
  await keepEditing(page).click();
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(startInput(page)).toHaveValue('14:20');
  await waitReady(page);
  const held = await holdCalculate(page);
  try {
    const button = cancelButton(page);
    await expect(button).toBeEnabled();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    expect(await releaseDebounce(page)).toBe(1); // 只執行未被clearTimeout取消、且已到期的真callback
    await expect.poll(held.count).toBe(1);
    await expect(reviewButton(page)).toBeDisabled();
    await page.mouse.up();
    await expect(dirtyBar(page)).toHaveCount(0); // RED應是取消契約的Expected0/Received1，而非actionability假紅
    await expect(startInput(page)).toHaveValue('15:20');
    const events = await page.evaluate(() => (window as unknown as ProbeWindow).__cancelRace.events);
    const lastDown = events.findLastIndex(e => e.kind === 'pointerdown');
    expect(events.slice(lastDown).filter(e => e.kind === 'click')).toHaveLength(1);
    held.release();
    await expectCleanHistoryAndClose(page);
  } finally { held.release(); await page.mouse.up().catch(() => {}); }
});

test('timer barrier尊重clearTimeout：重新編輯與取消不得釋放已取消callback', async ({ page }) => {
  await enterFromHome(page);
  await holdDebounce(page);
  await startInput(page).fill('14:20');
  await waitReady(page);
  const firstReady = await page.evaluate(() => (window as unknown as ProbeWindow).__cancelRace.events.findLast(e => e.kind === 'timer-ready')!.id);
  await startInput(page).fill('14:30');
  await waitReady(page);
  const held = await holdCalculate(page);
  try {
    expect(await releaseDebounce(page)).toBe(1);
    await expect.poll(held.count).toBe(1);
    const events = await page.evaluate(() => (window as unknown as ProbeWindow).__cancelRace.events);
    expect(events.some(e => e.id === firstReady && e.kind === 'timer-cancel')).toBe(true);
    expect(events.some(e => e.id === firstReady && e.kind === 'timer-release')).toBe(false);
    held.release();
    await expect(reviewButton(page)).toBeEnabled();
    await holdDebounce(page);
    await startInput(page).fill('14:40');
    await waitReady(page);
    const cancelledId = await page.evaluate(() => (window as unknown as ProbeWindow).__cancelRace.events.findLast(e => e.kind === 'timer-ready')!.id);
    await cancelButton(page).click();
    await expect(dirtyBar(page)).toHaveCount(0);
    await waitReady(page); // reset產生的新baseline callback，舊14:40 callback已clear
    await held.dispose();
    expect(await releaseDebounce(page)).toBe(1);
    const after = await page.evaluate(() => (window as unknown as ProbeWindow).__cancelRace.events);
    expect(after.some(e => e.id === cancelledId && e.kind === 'timer-cancel')).toBe(true);
    expect(after.some(e => e.id === cancelledId && e.kind === 'timer-release')).toBe(false);
    await expect(overlap(page)).toHaveText(/40/);
  } finally { held.release(); }
});

test('取消不放寬儲存gate：送出中仍disabled且只有一次apply', async ({ page }) => {
  await openSchedule(page);
  await startInput(page).fill('15:45');
  await expect(reviewButton(page)).toBeEnabled();
  await reviewButton(page).click();
  const dialog = page.locator('dialog.impact-dialog');
  await expect(dialog).toBeVisible();
  const apply = dialog.getByRole('button', { name: /^儲存/ });
  await expect(apply).toBeEnabled();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route('**/api/v1/settings/apply', async route => {
    calls += 1;
    await gate;
    await route.continue();
  });
  try {
    await apply.click();
    await expect.poll(() => calls).toBe(1);
    await expect(apply).toBeDisabled();
    expect(calls).toBe(1);
    release();
    await expect(page.locator('#toast')).toContainText('課表已', { timeout: 30000 });
    await expect(dirtyBar(page)).toHaveCount(0);
    await expect(cancelButton(page)).toBeDisabled();
  } finally { release(); }
});

test('calculate在途取消也還原aliases；不修改伺服器課表', async ({ page }) => {
  await activateFixture(page);
  await openSchedule(page);
  await expect(overlap(page)).toBeVisible();
  await page.getByRole('tab', { name: /班名對應/ }).click();
  const mapping = page.locator('tr', { hasText: '國小數學-一' });
  const target = mapping.locator('input.input-target-classname');
  const enabled = mapping.locator('input[type="checkbox"]');
  const original = await target.inputValue();
  const checked = await enabled.isChecked();
  const held = await holdCalculate(page);
  try {
    await target.fill('國小數學-一A');
    await enabled.setChecked(!checked);
    await expect.poll(() => held.count() > 0).toBe(true);
    await expect(reviewButton(page)).toBeDisabled();
    await expect(cancelButton(page)).toBeEnabled();
    await cancelButton(page).click();
    await expect(target).toHaveValue('國小數學-一A');
    await expect(enabled).toBeChecked({ checked });
    await expect(dirtyBar(page)).toHaveCount(0);
    held.release();
    await page.reload();
    await page.getByRole('tab', { name: /班名對應/ }).click();
    await expect(enabled).toBeChecked({ checked });
    await expect(dirtyBar(page)).toHaveCount(0);
  } finally { held.release(); }
});
