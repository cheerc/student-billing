import fs from 'fs';
import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { saveSettings } from './helpers/d2c-settings';

test.use({ trace: 'retain-on-failure' });

interface NavigationTelemetryEvent {
  docId: string;
  source: 'browser' | 'playwright';
  type: string;
  time: number;
  wallTime: string;
  href: string;
  detail?: any;
}

async function installNavigationDiagnostics(page: Page) {
  const events: NavigationTelemetryEvent[] = [];
  (page as any).__navigationTelemetry = events;

  await page.exposeFunction('__recordBrowserEvent', (entry: NavigationTelemetryEvent) => {
    events.push(entry);
  });

  await page.addInitScript(() => {
    const docId = 'doc_' + Math.random().toString(36).slice(2, 8);
    (window as any).__DOC_ID = docId;

    const log = (type: string, detail?: any) => {
      const entry = {
        docId,
        source: 'browser' as const,
        type,
        time: performance.now(),
        wallTime: new Date().toISOString(),
        href: window.location.href,
        detail,
      };
      if (!(window as any).__NAV_EVENTS) (window as any).__NAV_EVENTS = [];
      (window as any).__NAV_EVENTS.push(entry);
      if (typeof (window as any).__recordBrowserEvent === 'function') {
        (window as any).__recordBrowserEvent(entry);
      }
    };

    log('document:init', { readyState: document.readyState });
    window.addEventListener('DOMContentLoaded', () => log('document:DOMContentLoaded'));
    window.addEventListener('load', () => log('document:load'));
    window.addEventListener('beforeunload', () => log('window:beforeunload'));
    window.addEventListener('pagehide', (e) => log('window:pagehide', { persisted: e.persisted }));
    window.addEventListener('popstate', (e) => log('window:popstate', { state: e.state }));

    // Wrap history.pushState preserving this, arguments, and return value
    const origPushState = history.pushState;
    history.pushState = function (state, unused, url) {
      log('history.pushState', { state, url: String(url) });
      return origPushState.apply(this, arguments as any);
    };

    // Wrap history.replaceState preserving this, arguments, and return value
    const origReplaceState = history.replaceState;
    history.replaceState = function (state, unused, url) {
      log('history.replaceState', { state, url: String(url) });
      return origReplaceState.apply(this, arguments as any);
    };

    // Controlled barrier state
    const barrier = (window as any).__SENTINEL_BARRIER || {
      enabled: false,
      callCount: 0,
      delayedDelta: null,
      pendingRelease: null,
    };
    (window as any).__SENTINEL_BARRIER = barrier;

    // Wrap history.go preserving this, arguments, and return value
    const origGo = history.go;
    history.go = function (delta) {
      barrier.callCount++;
      log('history.go', { delta, barrierEnabled: barrier.enabled });
      if (barrier.enabled && delta === -1) {
        log('barrier:history.go(-1)_held', { delta, time: performance.now() });
        barrier.delayedDelta = delta;
        barrier.pendingRelease = () => {
          log('barrier:history.go(-1)_released', { delta, time: performance.now() });
          barrier.pendingRelease = null;
          origGo.call(history, delta);
        };
        return;
      }
      return origGo.apply(this, arguments as any);
    };

    // Wrap history.back
    const origBack = history.back;
    history.back = function () {
      log('history.back');
      return origBack.apply(this, arguments as any);
    };

    // Wrap history.forward
    const origForward = history.forward;
    history.forward = function () {
      log('history.forward');
      return origForward.apply(this, arguments as any);
    };
  });

  page.on('request', (req) => {
    if (req.url().includes('/api/v1/settings/apply')) {
      events.push({
        docId: 'playwright',
        source: 'playwright',
        type: 'request:settings_apply',
        time: Date.now(),
        wallTime: new Date().toISOString(),
        href: page.url(),
        detail: { url: req.url(), method: req.method() },
      });
    }
  });

  page.on('response', (res) => {
    if (res.url().includes('/api/v1/settings/apply')) {
      events.push({
        docId: 'playwright',
        source: 'playwright',
        type: 'response:settings_apply',
        time: Date.now(),
        wallTime: new Date().toISOString(),
        href: page.url(),
        detail: { url: res.url(), status: res.status() },
      });
    }
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      events.push({
        docId: 'playwright',
        source: 'playwright',
        type: 'main-frame:navigated',
        time: Date.now(),
        wallTime: new Date().toISOString(),
        href: frame.url(),
      });
    }
  });

  page.on('requestfailed', (req) => {
    events.push({
      docId: 'playwright',
      source: 'playwright',
      type: 'requestfailed',
      time: Date.now(),
      wallTime: new Date().toISOString(),
      href: page.url(),
      detail: { url: req.url(), failure: req.failure()?.errorText },
    });
  });

  page.on('pageerror', (err) => {
    events.push({
      docId: 'playwright',
      source: 'playwright',
      type: 'pageerror',
      time: Date.now(),
      wallTime: new Date().toISOString(),
      href: page.url(),
      detail: { message: err.message, stack: err.stack },
    });
  });
}

/**
 * D61 Phase 3（specs/06 D61；UX106）：課表設定 5 頁籤 UI、欄位徹底分離與簡化操作 E2E 驗收
 *
 * 驗收條件涵蓋：
 *  - 5 個課程類型頁籤固定順序：[安親課輔班]、[美語班]、[數學班]、[其他班]、[不排課]
 *  - 預設開啟 [安親課輔班] (8)
 *  - 欄位徹底分離：
 *    - 安親課輔班：6 欄，無星期／時間／不計扣天
 *    - 美語班、數學班：12 欄，含是否有多科折扣、不計扣天、星期、起訖時間
 *    - 其他班：11 欄，不出現多科折扣與固定 5 天，僅顯示不計扣天（預設是）
 *    - 不排課：4 欄，僅顯示班名、老師、狀態（不排課）、操作
 *  - 新增班級表單動態支援 5 種選項
 *  - 不包含舊版轉班切換按鈕，操作單純新增與刪除
 */

test.describe('D61 UX106: 課表設定 5 頁籤與簡化操作 E2E 驗收', () => {
  test.beforeEach(async ({ page }) => {
    await installNavigationDiagnostics(page);
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.schedule-grid-container')).toBeVisible();
  });

  test.afterEach(async ({ page }, testInfo) => {
    try {
      const allEvents = (page as any).__navigationTelemetry || [];
      await testInfo.attach('navigation-telemetry.json', {
        body: Buffer.from(JSON.stringify(allEvents, null, 2)),
        contentType: 'application/json',
      });
      fs.mkdirSync(testInfo.outputDir, { recursive: true });
      fs.writeFileSync(path.join(testInfo.outputDir, 'navigation-telemetry.json'), JSON.stringify(allEvents, null, 2));
    } catch {
      // ignore
    }
  });

  test('UX106: 初始狀態預設開啟「安親課輔班」，5 頁籤依固定順序呈現正確統計', async ({ page }) => {
    const careTab = page.locator('#class-type-tab-care');
    const englishTab = page.locator('#class-type-tab-english');
    const mathTab = page.locator('#class-type-tab-math');
    const otherTab = page.locator('#class-type-tab-other');
    const unscheduledTab = page.locator('#class-type-tab-unscheduled');

    // 1. 5 個頁籤存在
    await expect(careTab).toBeVisible();
    await expect(englishTab).toBeVisible();
    await expect(mathTab).toBeVisible();
    await expect(otherTab).toBeVisible();
    await expect(unscheduledTab).toBeVisible();

    // 2. 預設選中頁籤為 [安親課輔班]
    await expect(careTab).toHaveAttribute('aria-selected', 'true');
    await expect(englishTab).toHaveAttribute('aria-selected', 'false');

    // 3. 標籤數字統計：安親 8、美語 24、數學 12、其他 5、不排課 0
    await expect(careTab).toContainText('安親課輔班 (8)');
    await expect(englishTab).toContainText('美語班 (24');
    await expect(mathTab).toContainText('數學班 (12');
    await expect(otherTab).toContainText('其他班 (5');
    await expect(unscheduledTab).toContainText('不排課 (0)');

    // 4. 安親表格內：恰好 8 個班級，全部為「國小輔導-*」
    const careTable = page.locator('table.schedule-table-care');
    await expect(careTable).toBeVisible();
    const careRows = careTable.locator('tr.schedule-row');
    await expect(careRows).toHaveCount(8);
  });

  test('Issue #203/#205 + UX115: 課表頁籤密度、局部橫捲與鍵盤焦點可見', async ({ page }, testInfo) => {
    const readGeometry = () =>
      page.evaluate(() => {
        const header = document.querySelector<HTMLElement>('.page-header');
        const card = document.querySelector<HTMLElement>('.schedule-grid-container');
        const controls = document.querySelector<HTMLElement>('.schedule-type-controls');
        const scroller = document.querySelector<HTMLElement>('.schedule-type-tabs');
        const tablist = scroller?.querySelector<HTMLElement>('[role="tablist"]');
        const toolbar = document.querySelector<HTMLElement>('.schedule-grid-container .toolbar');
        const mainRow = document.querySelector<HTMLElement>('.settings-main-tabs-row');
        const actions = mainRow?.querySelector<HTMLElement>('[data-schedule-actions]');
        const tableScroll = document.querySelector<HTMLElement>('.schedule-grid-container .schedule-table-scroll');
        const careTab = document.querySelector<HTMLElement>('#class-type-tab-care');
        const careLabel = careTab?.querySelector<HTMLElement>('.schedule-type-tab-label');
        const careCount = careTab?.querySelector<HTMLElement>('.schedule-type-tab-count');
        if (!header || !card || !scroller || !tablist || !tableScroll || !careTab) {
          throw new Error('UX115 geometry frame is missing');
        }
        const cardRect = card.getBoundingClientRect();
        const controlRowRect = (controls ?? scroller).getBoundingClientRect();
        const tableRect = tableScroll.getBoundingClientRect();
        const mainRowRect = mainRow?.getBoundingClientRect();
        const actionsRect = actions?.getBoundingClientRect();
        return {
          leftInset: controlRowRect.left - cardRect.left,
          rightInset: cardRect.right - controlRowRect.right,
          tableTop: tableRect.top,
          tabTableGap: tableRect.top - controlRowRect.bottom,
          scrollWidth: scroller.scrollWidth,
          clientWidth: scroller.clientWidth,
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          tabPaddingLeft: getComputedStyle(careTab).paddingLeft,
          tabPaddingRight: getComputedStyle(careTab).paddingRight,
          labelWeight: careLabel ? Number(getComputedStyle(careLabel).fontWeight) : null,
          countWeight: careCount ? Number(getComputedStyle(careCount).fontWeight) : null,
          countColor: careCount ? getComputedStyle(careCount).color : null,
          subtitleCount: header.querySelectorAll('p.note').length,
          gridToolbarCount: toolbar ? 1 : 0,
          actionCount: actions ? 1 : 0,
          actionsOutsideTablist: actions !== null && actions?.closest('[role="tablist"]') === null,
          actionsRightInset: mainRowRect && actionsRect ? mainRowRect.right - actionsRect.right : null,
        };
      });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    const desktop = await readGeometry();
    if (process.env.ISSUE_208_SCREENSHOTS === '1') {
      await page.screenshot({ path: testInfo.outputPath('issue-208-desktop.png') });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    const mobile = await readGeometry();
    if (process.env.ISSUE_208_SCREENSHOTS === '1') {
      await page.screenshot({ path: testInfo.outputPath('issue-208-mobile.png') });
    }
    await testInfo.attach('ux115-geometry.json', {
      body: Buffer.from(JSON.stringify({ desktop, mobile }, null, 2)),
      contentType: 'application/json',
    });
    expect(desktop.subtitleCount).toBe(0);
    expect(mobile.subtitleCount).toBe(0);
    expect(desktop.gridToolbarCount).toBe(0);
    expect(mobile.gridToolbarCount).toBe(0);
    expect(desktop.actionCount).toBe(1);
    expect(mobile.actionCount).toBe(1);
    expect(desktop.actionsOutsideTablist).toBe(true);
    expect(mobile.actionsOutsideTablist).toBe(true);
    expect(desktop.actionsRightInset).toBeLessThanOrEqual(2);
    expect(Math.round(desktop.leftInset)).toBe(20);
    expect(Math.round(desktop.rightInset)).toBe(20);
    expect(Math.round(mobile.leftInset)).toBe(16);
    expect(Math.round(mobile.rightInset)).toBe(16);
    expect(desktop.tabPaddingLeft).toBe('12px');
    expect(desktop.tabPaddingRight).toBe('12px');
    expect(mobile.tabPaddingLeft).toBe('12px');
    expect(mobile.tabPaddingRight).toBe('12px');
    expect(desktop.labelWeight ?? 0).toBeGreaterThan(desktop.countWeight ?? 0);
    expect(desktop.countColor).toBe('rgb(100, 116, 139)');
    expect(desktop.tabTableGap).toBeLessThanOrEqual(16);
    expect(mobile.tabTableGap).toBeLessThanOrEqual(16);
    expect(mobile.scrollWidth).toBeGreaterThan(mobile.clientWidth);
    expect(desktop.pageWidth).toBeLessThanOrEqual(desktop.viewportWidth);
    expect(mobile.pageWidth).toBeLessThanOrEqual(mobile.viewportWidth);

    for (const viewport of ['desktop', 'mobile'] as const) {
      await page.setViewportSize(viewport === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
      await page.locator('#class-type-tab-english').click();
      const weekdayAlignment = await page.evaluate(() => {
        const tabs = document.querySelector<HTMLElement>('.schedule-type-tabs [role="tablist"]');
        const filter = document.querySelector<HTMLElement>('#schedule-weekday-filter');
        if (!tabs || !filter) return null;
        const tabsRect = tabs.getBoundingClientRect();
        const filterRect = filter.getBoundingClientRect();
        return Math.abs((tabsRect.top + tabsRect.bottom) / 2 - (filterRect.top + filterRect.bottom) / 2);
      });
      expect(weekdayAlignment).not.toBeNull();
      expect(weekdayAlignment ?? Infinity).toBeLessThanOrEqual(2);
    }

    await page.locator('#class-type-tab-care').focus();
    await page.keyboard.press('End');
    const unscheduledTab = page.locator('#class-type-tab-unscheduled');
    await expect(unscheduledTab).toHaveAttribute('aria-selected', 'true');
    const endFocus = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.schedule-type-tabs');
      const focused = document.activeElement as HTMLElement | null;
      if (!scroller || !focused) return { visible: false, reason: 'missing scroll region or focused tab' };
      const viewport = scroller.getBoundingClientRect();
      const target = focused.getBoundingClientRect();
      const outline = getComputedStyle(focused);
      return {
        visible: target.left >= viewport.left && target.right <= viewport.right && outline.outlineStyle !== 'none',
        focusedId: focused.id,
        targetLeft: target.left,
        targetRight: target.right,
        viewportLeft: viewport.left,
        viewportRight: viewport.right,
        outlineStyle: outline.outlineStyle,
        outlineWidth: outline.outlineWidth,
        scrollLeft: scroller.scrollLeft,
      };
    });
    expect(endFocus.visible, JSON.stringify(endFocus)).toBe(true);

    await page.keyboard.press('Home');
    await expect(page.locator('#class-type-tab-care')).toHaveAttribute('aria-selected', 'true');
  });

  test('UX115: 搜尋與課程類型在課表／班名同步主頁籤切換後保留', async ({ page }) => {
    await page.locator('#class-type-tab-math').click();
    const search = page.getByLabel('搜尋課表班級');
    await search.fill('國小數學-四A');
    await expect(page.locator('table.schedule-table-math tr.schedule-row')).toHaveCount(2);

    const actions = page.locator('[data-schedule-actions]');
    await page.locator('#settings-tab-sync').click();
    await expect(actions).toHaveCount(0);
    await page.locator('#settings-tab-schedule').click();

    await expect(page.locator('#class-type-tab-math')).toHaveAttribute('aria-selected', 'true');
    await expect(search).toHaveValue('國小數學-四A');
    await expect(page.locator('table.schedule-table-math tr.schedule-row')).toHaveCount(2);
  });

  test('UX106: 各頁籤欄位徹底分離，排他性嚴格成立', async ({ page }) => {
    // 1. [安親課輔班] 頁籤（6 欄）
    const careThead = page.locator('table.schedule-table-care thead');
    await expect(careThead).toContainText('班級名稱');
    await expect(careThead).toContainText('是否有多科折扣');
    await expect(careThead).toContainText('天數固定 5 天');
    await expect(careThead).toContainText('帶班老師');
    await expect(careThead).toContainText('狀態');
    await expect(careThead).toContainText('操作');

    await expect(careThead).not.toContainText('不計扣天');
    await expect(careThead).not.toContainText('星期');
    await expect(careThead).not.toContainText('上課時間');
    await expect(careThead).not.toContainText('課程時長');

    // 2. 切換至 [美語班] 頁籤（12 欄）
    await page.locator('#class-type-tab-english').click();
    const englishThead = page.locator('table.schedule-table-english thead');
    await expect(englishThead).toContainText('班級名稱');
    await expect(englishThead).toContainText('是否有多科折扣');
    await expect(englishThead).toContainText('不計扣天');
    await expect(englishThead).toContainText('帶班老師');
    await expect(englishThead).toContainText('星期');
    await expect(englishThead).toContainText('上課時間');
    await expect(englishThead).toContainText('課程時長');
    await expect(englishThead).not.toContainText('天數固定 5 天');

    // 3. 切換至 [其他班] 頁籤（11 欄）
    await page.locator('#class-type-tab-other').click();
    const otherThead = page.locator('table.schedule-table-other thead');
    await expect(otherThead).toContainText('班級名稱');
    await expect(otherThead).toContainText('不計扣天');
    await expect(otherThead).toContainText('帶班老師');
    await expect(otherThead).toContainText('星期');
    await expect(otherThead).toContainText('上課時間');
    await expect(otherThead).not.toContainText('是否有多科折扣');
    await expect(otherThead).not.toContainText('天數固定 5 天');

    // 4. 切換至 [不排課] 頁籤（4 欄）
    await page.locator('#class-type-tab-unscheduled').click();
    const unschThead = page.locator('table.schedule-table-unscheduled thead');
    await expect(unschThead).toContainText('班級名稱');
    await expect(unschThead).toContainText('帶班老師');
    await expect(unschThead).toContainText('狀態');
    await expect(unschThead).toContainText('操作');
    await expect(unschThead).not.toContainText('是否有多科折扣');
    await expect(unschThead).not.toContainText('天數固定 5 天');
    await expect(unschThead).not.toContainText('不計扣天');
    await expect(unschThead).not.toContainText('上課時間');
  });

  test('UX106 & A1: 新增班級表單支援五種課程類型動態切換', async ({ page }) => {
    await page.locator('#class-type-tab-other').click();
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const dialog = page.locator('dialog.add-class-dialog');
    const addForm = dialog.locator('form.add-session-panel');
    await expect(addForm).toBeVisible();

    await expect(addForm.locator('select[aria-label="新增班級課程類型"]')).toHaveCount(0);

    // 選定頁籤是唯一課程類型來源；其他班顯示逐時段選項與完整排課欄位。
    await expect(addForm.locator('text=是否有多科折扣')).toHaveCount(0);
    await expect(addForm.locator('text=天數固定 5 天')).toHaveCount(0);
    await expect(addForm.locator('text=不計扣天')).toBeVisible();
    await expect(addForm.locator('select[aria-label="新增星期"]')).toBeVisible();
    await expect(addForm.getByRole('textbox', { name: '新增起始時間' })).toBeVisible();
    await expect(addForm.getByRole('textbox', { name: '新增結束時間' })).toBeVisible();
    await dialog.getByRole('button', { name: '取消新增' }).click();

    // 切到不排課頁籤後重開，新增視窗依該頁籤顯示欄位。
    await page.locator('#class-type-tab-unscheduled').click();
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const unscheduledDialog = page.locator('dialog.add-class-dialog');
    const unscheduledForm = unscheduledDialog.locator('form.add-session-panel');
    await expect(addForm.locator('text=是否有多科折扣')).toHaveCount(0);
    await expect(unscheduledForm.locator('text=天數固定 5 天')).toHaveCount(0);
    await expect(unscheduledForm.locator('text=不計扣天')).toHaveCount(0);
    await expect(unscheduledForm.locator('select[aria-label="新增星期"]')).toHaveCount(0);
    await expect(unscheduledForm.locator('input[aria-label="新增起始時間"]')).toHaveCount(0);

    // 填寫班級名稱新增一班不排課班級
    const testUnschName = `下午交通車-測試${Date.now().toString().slice(-4)}`;
    await unscheduledForm.locator('input[aria-label="新增班級名稱"]').fill(testUnschName);
    await unscheduledForm.getByRole('button', { name: '確認新增' }).click();

    // 表單關閉，[不排課] 頁籤保持選取，新增班已在列表中
    await expect(unscheduledDialog).toBeHidden();
    await expect(page.locator('#class-type-tab-unscheduled')).toHaveAttribute('aria-selected', 'true');
    const newRow = page.locator('table.schedule-table-unscheduled tr.schedule-row', {
      has: page.locator(`input[value="${testUnschName}"]`),
    });
    await expect(newRow).toBeVisible();
    await expect(newRow.locator('span[data-status="unscheduled"]')).toHaveText('不排課');
  });

  test('Issue #155 & D61: 徹底移除轉班按鈕，操作單純新增與刪除，持久化穩定', async ({ page }) => {
    // 1. 各頁籤均不包含「轉為安親／非安親課輔班」按鈕
    await expect(page.locator('button[data-switch-type]')).toHaveCount(0);
    await expect(page.locator('button[data-switch-to-care]')).toHaveCount(0);
    await expect(page.locator('dialog.switch-class-type-dialog')).toHaveCount(0);

    // 2. 新增安親班與刪除班級後存檔，驗證持久化
    await page.locator('#class-type-tab-care').click();
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const addForm = page.locator('dialog.add-class-dialog form.add-session-panel');
    const testCareName = `國小輔導-持久化${Date.now().toString().slice(-4)}`;
    await addForm.locator('input[aria-label="新增班級名稱"]').fill(testCareName);
    await addForm.getByRole('button', { name: '確認新增' }).click();

    await expect(page.locator('#class-type-tab-care')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('table.schedule-table-care tr.schedule-row')).toHaveCount(9);

    // 刪除一個班級（國小輔導-六年級）
    const grade6Row = page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator('input[value="國小輔導-六年級"]'),
    });
    await grade6Row.getByRole('button', { name: '刪除班級 國小輔導-六年級' }).click();
    await expect(page.locator('table.schedule-table-care tr.schedule-row')).toHaveCount(8);

    // 儲存變更
    await saveSettings(page);

    // 重新載入頁面驗證持久化
    await page.reload();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#class-type-tab-care')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('table.schedule-table-care tr.schedule-row')).toHaveCount(8);
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${testCareName}"]`),
    })).toBeVisible();
  });

  test('Issue #207 受控診斷（Save 路徑）：未延後對照與受控延後放行時序觀測', async ({ page }) => {
    // 1. 未延後對照（原生預設流程）：編輯草稿 → 儲存 → 立即 reload
    await page.locator('#class-type-tab-care').click();
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const addForm1 = page.locator('dialog.add-class-dialog form.add-session-panel');
    const nameUnheld = `國小輔導-未延後${Date.now().toString().slice(-4)}`;
    await addForm1.locator('input[aria-label="新增班級名稱"]').fill(nameUnheld);
    await addForm1.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameUnheld}"]`),
    })).toBeVisible();

    await saveSettings(page);
    await page.reload();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameUnheld}"]`),
    })).toBeVisible();

    // 2. 受控延後放行：在真實 UI save 期間啟用 barrier 攔截延後 history.go(-1)，驗證後放行原生 traversal
    await page.evaluate(() => {
      const b = (window as any).__SENTINEL_BARRIER;
      if (b) {
        b.enabled = true;
        b.delayedDelta = null;
        b.pendingRelease = null;
      }
    });

    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const addForm2 = page.locator('dialog.add-class-dialog form.add-session-panel');
    const nameHeldRelease = `國小輔導-延後放行${Date.now().toString().slice(-4)}`;
    await addForm2.locator('input[aria-label="新增班級名稱"]').fill(nameHeldRelease);
    await addForm2.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameHeldRelease}"]`),
    })).toBeVisible();

    // 儲存變更：dirty -> false 觸發 unwindSentinel()，被 barrier 延後
    await saveSettings(page);

    // 檢查 barrier 狀態：確認 history.go(-1) 確實處於 held 狀態
    const statusBeforeRelease = await page.evaluate(() => {
      const b = (window as any).__SENTINEL_BARRIER;
      return {
        enabled: b?.enabled,
        hasPendingRelease: typeof b?.pendingRelease === 'function',
        delayedDelta: b?.delayedDelta,
        callCount: b?.callCount,
      };
    });
    expect(statusBeforeRelease.hasPendingRelease).toBe(true);
    expect(statusBeforeRelease.delayedDelta).toBe(-1);

    // 受控放行原生 traversal：呼叫 pendingRelease()，執行原生 history.go(-1)
    await page.evaluate(() => {
      const b = (window as any).__SENTINEL_BARRIER;
      if (b && typeof b.pendingRelease === 'function') {
        b.pendingRelease();
      }
    });

    // 等待原生 popstate 事件實際抵達瀏覽器
    await page.waitForFunction(() => {
      const events = (window as any).__NAV_EVENTS || [];
      const currentDocId = (window as any).__DOC_ID;
      return events.some((e: any) => e.type === 'window:popstate' && e.docId === currentDocId);
    });

    // 驗證 barrier 狀態已轉為 released (hasPendingRelease === false)
    const statusAfterRelease = await page.evaluate(() => {
      const b = (window as any).__SENTINEL_BARRIER;
      return {
        hasPendingRelease: typeof b?.pendingRelease === 'function',
      };
    });
    expect(statusAfterRelease.hasPendingRelease).toBe(false);

    // 原生 traversal 完成後執行 reload
    await page.reload();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameHeldRelease}"]`),
    })).toBeVisible();
  });

  test('Issue #207 受控診斷（Cancel 路徑）：取消修改之未延後對照與受控延後放行', async ({ page }) => {
    // 1. 未延後取消對照：新增草稿產生 dirty → 按「取消修改」回到 clean → 立即 page.reload()
    await page.locator('#class-type-tab-care').click();
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const addForm1 = page.locator('dialog.add-class-dialog form.add-session-panel');
    const nameCancelUnheld = `國小輔導-未延後取消${Date.now().toString().slice(-4)}`;
    await addForm1.locator('input[aria-label="新增班級名稱"]').fill(nameCancelUnheld);
    await addForm1.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameCancelUnheld}"]`),
    })).toBeVisible();
    await expect(page.locator('button', { hasText: '取消修改' })).toBeEnabled();

    // 點擊「取消修改」：dirty 轉 false，觸發 unwindSentinel() -> 原生 history.go(-1)
    await page.locator('button', { hasText: '取消修改' }).click();
    await expect(page.locator('button', { hasText: '取消修改' })).toBeDisabled();
    await expect(page.locator('.save-status-dirty')).toHaveCount(0);
    await expect(page.locator('.save-status-clean')).toBeVisible();
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameCancelUnheld}"]`),
    })).toHaveCount(0);

    // 立即重新載入
    await page.reload();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameCancelUnheld}"]`),
    })).toHaveCount(0);

    // 2. 受控延後放行取消：啟用 barrier → 新增草稿產生 dirty → 按「取消修改」→ 攔截驗證後受控放行原生 traversal
    await page.evaluate(() => {
      const b = (window as any).__SENTINEL_BARRIER;
      if (b) {
        b.enabled = true;
        b.delayedDelta = null;
        b.pendingRelease = null;
      }
    });

    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const addForm2 = page.locator('dialog.add-class-dialog form.add-session-panel');
    const nameCancelHeld = `國小輔導-延後取消${Date.now().toString().slice(-4)}`;
    await addForm2.locator('input[aria-label="新增班級名稱"]').fill(nameCancelHeld);
    await addForm2.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameCancelHeld}"]`),
    })).toBeVisible();
    await expect(page.locator('button', { hasText: '取消修改' })).toBeEnabled();

    // 點擊「取消修改」：dirty 轉 false，觸發 unwindSentinel()，被 barrier 攔截
    await page.locator('button', { hasText: '取消修改' }).click();
    await expect(page.locator('button', { hasText: '取消修改' })).toBeDisabled();
    await expect(page.locator('.save-status-dirty')).toHaveCount(0);
    await expect(page.locator('.save-status-clean')).toBeVisible();
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameCancelHeld}"]`),
    })).toHaveCount(0);

    // 驗證 barrier 確實攔截到 cancel 觸發之 history.go(-1) (held 狀態)
    const statusCancel = await page.evaluate(() => {
      const b = (window as any).__SENTINEL_BARRIER;
      return {
        enabled: b?.enabled,
        hasPendingRelease: typeof b?.pendingRelease === 'function',
        delayedDelta: b?.delayedDelta,
      };
    });
    expect(statusCancel.hasPendingRelease).toBe(true);
    expect(statusCancel.delayedDelta).toBe(-1);

    // 受控放行原生 traversal
    await page.evaluate(() => {
      const b = (window as any).__SENTINEL_BARRIER;
      if (b && typeof b.pendingRelease === 'function') {
        b.pendingRelease();
      }
    });

    // 等待原生 popstate 事件實際抵達瀏覽器
    await page.waitForFunction(() => {
      const events = (window as any).__NAV_EVENTS || [];
      const currentDocId = (window as any).__DOC_ID;
      return events.some((e: any) => e.type === 'window:popstate' && e.docId === currentDocId);
    });

    // 驗證 barrier 狀態已轉為 released
    const statusCancelAfter = await page.evaluate(() => {
      const b = (window as any).__SENTINEL_BARRIER;
      return {
        hasPendingRelease: typeof b?.pendingRelease === 'function',
      };
    });
    expect(statusCancelAfter.hasPendingRelease).toBe(false);

    // 接續 reload 驗證頁面與草稿狀態
    await page.reload();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${nameCancelHeld}"]`),
    })).toHaveCount(0);
  });
});
