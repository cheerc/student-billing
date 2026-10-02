import { test, expect, type Page, type Route } from '@playwright/test';
import { FIXTURE } from './helpers/c-batch';

/**
 * 課表儲存後「班名比對報告」取得失敗的最短恢復路徑（operator 裁決 d-20261002162913018695-69；specs/04 UX46）。
 *
 * 行為契約：
 *   R1 自動重試：apply 後 GET 失敗自動重試 2 次（約 1s、3s 間隔）；任一次成功即正常顯示，使用者全程不見錯誤畫面。
 *   R2 重試皆失敗：單行「無法取得最新的班名比對報告。」＋［重新載入］；候選表鎖定（disabled＋aria-disabled）；［重新載入］成功後標示消失、解鎖、以最新報告重建。
 *   R3 ［重新載入］再失敗：按鈕改為［重新整理頁面］，按下才整頁 reload；期間不自動 reload。
 *   R4 重試序列仍在前進時再次 apply：新序列作廢舊序列，舊回應不得覆蓋新結果。
 *   負向：任何失敗狀態都不得出現原因解釋文字（不顯示儲存前的舊報告數字、不建議重新匯入）。
 *
 * 真入口：xlsx 匯入 → activate → 課表設定 apply → 頁面發出的 GET class-name-report（以 page.route 注入失敗）。
 * expected 由流程獨立推導：每成功套用一個有效別名，待確認班數減 1；不使用實作輸出回填。
 */

const REPORT_URL = '**/api/v1/settings/class-name-report**';
/**
 * 各案例使用**互不重疊**的米豆奶班名。
 * 隔離 runner 每檔共用一個 DB（同一輪不重置），本檔四個案例都在同一輪依序執行；
 * 一次成功套用的別名會讓該班離開候選清單，故案例間不可重複使用同一個 raw 班名，
 * 否則後續案例會在「候選列不存在」處失敗（那是前案例正確套用的結果，不是本案例的失敗）。
 * 候選清單（tests/fixtures/conforming-erp-fixture.xlsx × seed 課表，12 班）：
 * 交通車／國小國語文-小三四／國小數學-一／國小輔導-四年級A／國小輔導-四年級B／國小輔導-寫功課／
 * 小六國文加強班／小六數學加強班／小六英文加強班／正音A班／正音B班／美語等班。
 */
const R1_ALIAS = { raw: '小六國文加強班', target: '小六加強班-國文' };
const R2_ALIAS = { raw: '國小國語文-小三四', target: '國小國語文-小三小四' };
const R3_ALIAS = { raw: '交通車', target: '兒童美語-Ali' };
const R4_ALIAS = { raw: '小六數學加強班', target: '小六加強班-數學' };

/** 可切換模式的 GET 攔截器：ok（真實回應，順帶保存最後一次成功 body）／fail（500）／gate（等待放行後回應保存的舊 body）。 */
function installReportRoute(page: Page) {
  let mode: 'ok' | 'fail' | 'gate' = 'ok';
  let failCount = 0;
  let lastGoodBody: string | null = null;
  let releaseGate: (() => void) | null = null;
  const gateArrived = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let signalGateArrived: () => void = () => {};
  const gateEntered = new Promise<void>((resolve) => {
    signalGateArrived = resolve;
  });

  page.route(REPORT_URL, async (route: Route) => {
    if (mode === 'fail' && failCount > 0) {
      failCount -= 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server error"}' });
    }
    if (mode === 'gate') {
      mode = 'ok';
      signalGateArrived();
      await gateArrived;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: lastGoodBody ?? '{"rosterOnly":null}',
      });
    }
    const response = await route.fetch();
    const body = await response.text();
    if (response.ok()) lastGoodBody = body;
    return route.fulfill({ response, body });
  });

  return {
    failNext(times: number) {
      mode = 'fail';
      failCount = times;
    },
    failAlways() {
      mode = 'fail';
      failCount = Number.MAX_SAFE_INTEGER;
    },
    gateNext(): { entered: Promise<void>; release: () => void } {
      mode = 'gate';
      return { entered: gateEntered, release: () => releaseGate?.() };
    },
  };
}

/**
 * 匯入並啟用名冊。
 *
 * 隔離 runner 每檔共用一個 DB（同一輪不重置），因此本檔各案例**各自匯入一次**：
 * 候選是依該次名冊 vs 系統現行班級即時盤點，後續案例再匯入不會讓已對應的班復現。
 * 不可用 --keep-db 重現跨輪殘留（那是診斷用 opt-in，會讓本檔的獨立匯入無效）。
 */
async function importRoster(page: Page) {
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 20000 });
  await page.locator('button', { hasText: '使用這份名單' }).click();
  await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 20000 });
}

async function openMappingTab(page: Page) {
  await page.goto('/settings');
  const tab = page.locator('button[role="tab"]', { hasText: '班名對應' });
  await expect(tab).toBeVisible({ timeout: 15000 });
  await tab.click();
  await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 15000 });
  const text = (await tab.textContent()) || '';
  const m = text.match(/\d+/);
  expect(m, '頁籤 badge 應帶待確認班數').not.toBeNull();
  return { tab, base: parseInt(m![0], 10) };
}

/** 候選表填目標 → 勾選 → 確認變更 → 儲存並更新結果（真實使用者路徑）。 */
async function applyAlias(page: Page, raw: string, target: string) {
  const row = page.locator('.mapping-table tr', { hasText: raw });
  await expect(row).toBeVisible();
  await row.locator('input.input-target-classname').fill(target);
  await row.locator('input[type="checkbox"]').check();
  await confirmAndSave(page);
}

/** 課表頁改第一筆時段起訖 → 確認變更 → 儲存（候選表鎖定時仍可走這條路徑）。 */
async function applyScheduleTimeChange(page: Page) {
  await page.locator('button[role="tab"]', { hasText: '課表' }).click();
  const start = page.locator('input.input-time').first();
  await start.fill('09:40');
  await expect(page.locator('.save-status-dirty')).toBeVisible();
  await confirmAndSave(page);
}

async function confirmAndSave(page: Page) {
  await page.locator('button', { hasText: '確認變更' }).click();
  const dialog = page.locator('dialog.impact-dialog');
  await expect(dialog).toBeVisible({ timeout: 20000 });
  await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
  await expect(page.locator('#toast')).toContainText('課表已', { timeout: 20000 });
  await expect(dialog).not.toBeVisible();
}

function candidatesLocked(page: Page) {
  return {
    container: page.locator('[data-candidates-locked]'),
    firstTarget: page.locator('.mapping-table input.input-target-classname').first(),
    firstCheckbox: page.locator('.mapping-table input[type="checkbox"]').first(),
  };
}

/** 整頁導覽（document 請求）計數：［重新載入］不得觸發、［重新整理頁面］必須觸發。 */
function documentRequestCount(page: Page): () => number {
  let count = 0;
  page.on('request', (req) => {
    if (req.resourceType() === 'document') count += 1;
  });
  return () => count;
}

async function expectNoExplanationText(alert: ReturnType<Page['getByRole']>) {
  await expect(alert).toContainText('無法取得最新的班名比對報告');
  await expect(alert).not.toContainText('因此暫不顯示');
  await expect(alert).not.toContainText('請重新整理頁面後查看');
  await expect(alert).not.toContainText('建議重新匯入');
}

test.describe('報告刷新失敗的最短恢復路徑（UX46／operator 裁決 d-…-69）', () => {
  test('R1：apply 後第一次 GET 失敗、自動重試第 2 次成功 → 全程無錯誤標示、候選為最新', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    const { tab, base } = await openMappingTab(page);
    const toolbar = page.locator('.toolbar', { hasText: '待確認米豆奶班名' });
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });

    const report = installReportRoute(page);
    report.failNext(1);

    await applyAlias(page, R1_ALIAS.raw, R1_ALIAS.target);

    // 自動重試成功：不留下任何錯誤畫面，候選同步為最新（base-1）
    await expect(toolbar).toContainText(`(${base - 1})`, { timeout: 20000 });
    await expect(tab).toContainText(String(base - 1));
    await expect(page.locator('.mapping-table tr', { hasText: R1_ALIAS.raw })).toHaveCount(0);
    await expect(notice).toHaveCount(0);

    // 重試期間與結束後候選表都可操作
    const locked = candidatesLocked(page);
    await expect(locked.container).toHaveCount(0);
    await expect(locked.firstTarget).toBeEnabled();
  });

  test('R2：連續 3 次失敗 → 單行標示＋［重新載入］＋候選表鎖定；重試成功後復原', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    const { tab, base } = await openMappingTab(page);
    const toolbar = page.locator('.toolbar', { hasText: '待確認米豆奶班名' });
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });

    const report = installReportRoute(page);
    report.failAlways();

    await applyAlias(page, R2_ALIAS.raw, R2_ALIAS.target);

    await expect(notice).toBeVisible({ timeout: 20000 });
    await expectNoExplanationText(notice);

    const reloadBtn = notice.locator('button', { hasText: '重新載入' });
    await expect(reloadBtn).toBeVisible();

    // 候選表鎖定：控制項 disabled 且有等價可及性標記
    const locked = candidatesLocked(page);
    await expect(locked.container).toHaveAttribute('aria-disabled', 'true');
    await expect(locked.firstTarget).toBeDisabled();
    await expect(locked.firstCheckbox).toBeDisabled();

    // 不顯示儲存前的舊報告數字
    await expect(page.getByRole('region', { name: '米豆奶有／系統無' })).toHaveCount(0);

    // ［重新載入］只重新取得報告（不整頁 reload）：以 document 請求計數驗證沒有整頁導覽
    const documentRequests = documentRequestCount(page);
    await page.unroute(REPORT_URL);
    const documentsBeforeReload = documentRequests();
    await reloadBtn.click();

    await expect(notice).toHaveCount(0, { timeout: 20000 });
    await expect(toolbar).toContainText(`(${base - 1})`);
    await expect(tab).toContainText(String(base - 1));
    await expect(page.locator('.mapping-table tr', { hasText: R2_ALIAS.raw })).toHaveCount(0);
    const unlocked = candidatesLocked(page);
    await expect(unlocked.container).toHaveCount(0);
    await expect(unlocked.firstTarget).toBeEnabled();
    await expect(documentRequests()).toBe(documentsBeforeReload);
  });

  test('R3：［重新載入］再失敗 → 按鈕改［重新整理頁面］；按下才整頁 reload（期間不自動 reload）', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    const { tab } = await openMappingTab(page);
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });

    const report = installReportRoute(page);
    report.failAlways();

    const documentRequests = documentRequestCount(page);

    await applyAlias(page, R3_ALIAS.raw, R3_ALIAS.target);
    await expect(notice).toBeVisible({ timeout: 20000 });
    await expectNoExplanationText(notice);

    const beforeDocuments = documentRequests();

    // ［重新載入］仍失敗 → 只換按鈕，不自動整頁 reload
    await notice.locator('button', { hasText: '重新載入' }).click();
    const refreshPageBtn = notice.locator('button', { hasText: '重新整理頁面' });
    await expect(refreshPageBtn).toBeVisible({ timeout: 20000 });
    await expect(notice.locator('button', { hasText: '重新載入' })).toHaveCount(0);
    await expect(documentRequests()).toBe(beforeDocuments);

    // 按下［重新整理頁面］才整頁 reload
    const navigated = page.waitForEvent('load', { timeout: 30000 });
    await refreshPageBtn.click();
    await navigated;

    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 20000 });
    await expect(tab).toBeVisible();
  });

  test('R4：重試序列進行中再次 apply → 舊序列回應不得覆蓋新結果', async ({ page }) => {
    test.setTimeout(240_000);
    await importRoster(page);
    const { tab, base } = await openMappingTab(page);
    const toolbar = page.locator('.toolbar', { hasText: '待確認米豆奶班名' });

    const report = installReportRoute(page);

    // 步驟 1：正常套用第一個別名 → base-1（同時讓攔截器保存「最後成功報告」body 作為過期回應）
    await applyAlias(page, R4_ALIAS.raw, R4_ALIAS.target);
    await expect(toolbar).toContainText(`(${base - 1})`, { timeout: 20000 });

    // 步驟 2：第 2 次 apply 失敗 → 第 1 次重試被 gate 暫停（舊序列仍在進行）
    report.failNext(1);
    const gate = report.gateNext();
    await applyScheduleTimeChange(page);
    await gate.entered;

    // 重試序列進行中：候選表鎖定
    const locked = candidatesLocked(page);
    await expect(locked.container).toHaveAttribute('aria-disabled', 'true');

    // 步驟 3：鎖定期間再 apply 一次（走課表頁）→ 新序列立即取得報告成功
    await applyScheduleTimeChange(page);
    await expect(page.locator('.mapping-table tr', { hasText: R4_ALIAS.raw })).toHaveCount(0, { timeout: 20000 });

    // 步驟 4：放行舊序列的回應（內容為 base-1 的舊報告）→ 不得覆蓋新結果
    gate.release();
    await page.waitForTimeout(1000);

    await expect(toolbar).toContainText(`(${base - 1})`);
    await expect(tab).toContainText(String(base - 1));
    await expect(page.locator('.mapping-table tr', { hasText: R4_ALIAS.raw })).toHaveCount(0);
  });
});
