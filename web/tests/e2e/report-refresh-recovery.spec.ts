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
/** R4 步驟 2：第二個別名（與 R4_ALIAS 不同，且候選表靠前易操作）。 */
const R4_SECOND_ALIAS = { raw: '國小輔導-四年級A', target: '國小輔導-四年級' };
/** R5 用：只讓一次 GET 失敗即可進入重試等待，不需等到重試耗盡。 */
const R5_PENDING_ALIAS = { raw: '正音A班', target: '兒童美語-Archy' };
/** R6 用：只讓一次 GET 失敗即可進入重試等待；再用 setSequenceFailCount 讓手動序列也失敗，走到［重新整理頁面］階段。 */
const R6_PENDING_ALIAS = { raw: '美語等班', target: '兒童美語-Ali' };

/** 可切換模式的 GET 攔截器：ok（真實回應，順帶保存最後一次成功 body）／fail（500）／gate（等待放行後回應保存的舊 body）。 */
function installReportRoute(page: Page) {
  let mode: 'ok' | 'fail' | 'gate' = 'ok';
  /** failEachSequence 模式：下一個 GET 開始的新序列先失敗 failNext 次（undefined＝未啟用） */
  let failNext: number | undefined;
  let failCount = 0;
  let calls = 0;
  let lastGoodBody: string | null = null;
  /** gate 釋放後要回傳的 body（預設＝lastGoodBody；R4 可設為明確不同的過期 body 以建立可觀察差異） */
  let gateBody: string | null = null;
  let releaseGate: (() => void) | null = null;
  const gateArrived = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let signalGateArrived: () => void = () => {};
  const gateEntered = new Promise<void>((resolve) => {
    signalGateArrived = resolve;
  });

  page.route(REPORT_URL, async (route: Route) => {
    calls += 1;
    if (failCount > 0) {
      failCount -= 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server error"}' });
    }
    if (failNext !== undefined && mode === 'fail') {
      failCount = failNext;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server error"}' });
    }
    if (mode === 'gate') {
      mode = 'ok';
      signalGateArrived();
      await gateArrived;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: gateBody ?? lastGoodBody ?? '{"rosterOnly":null}',
      });
    }
    const response = await route.fetch();
    const body = await response.text();
    if (response.ok()) lastGoodBody = body;
    return route.fulfill({ response, body });
  });

  return {
    /** 頁面發出的 GET 次數（重試與［重新載入］都算）。 */
    callCount: () => calls,
    failNext(times: number) {
      mode = 'fail';
      failCount = times;
      failNext = undefined;
    },
    /** 之後每個新序列都先失敗 `times` 次（［重新載入］重試仍失敗時用；攔截器不解除，計數持續）。 */
    failEachSequence(times: number) {
      mode = 'fail';
      failCount = 0;
      failNext = times;
    },
    /** 調整「每個新序列先失敗幾次」，用於自動重試（多次）與手動［重新載入］（僅一次）不同的情境。 */
    setSequenceFailCount(times: number) {
      failNext = times;
    },
    failAlways() {
      mode = 'fail';
      failCount = Number.MAX_SAFE_INTEGER;
    },
    gateNext(opts?: { body?: string }): { entered: Promise<void>; release: () => void } {
      mode = 'gate';
      gateBody = opts?.body ?? null;
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

/**
 * 課表頁改第一筆時段起訖 → 確認變更 → 儲存（候選表鎖定時仍可走這條路徑）。
 * `minute` 每次不同，確保下一次呼叫一定產生新草稿（同一值不會讓 isDirty 變真）。
 */
async function applyScheduleTimeChange(page: Page, minute: string) {
  await page.locator('button[role="tab"]', { hasText: '課表' }).click();
  await page.locator('#class-type-tab-english').click();
  const start = page.locator('input.input-time').first();
  await start.fill(`09:${minute}`);
  await expect(page.locator('.save-status-dirty')).toBeVisible();
  await confirmAndSave(page);
}

/** 切換到「班名對應」頁籤（候選表可能在可捲動容器內，先把容器捲到頂）。 */
async function switchToMappingTab(page: Page) {
  const tab = page.locator('button[role="tab"]', { hasText: '班名對應' });
  await tab.click();
  await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 15000 });
  await page.locator('.mapping-table').evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
  });
}

/** 候選列填入一個不存在的目標（保留值）→ 確認變更 → 儲存。apply 成功，該班因目標無效而離開候選表。 */
async function applyCandidateWithInvalidTarget(page: Page, raw: string) {
  const row = page.locator('.mapping-table tr', { hasText: raw });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  await row.locator('input.input-target-classname').fill('不存在的目標班級-XYZ');
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
/**
 * 決定的重試次數（初版＋2 次重試 ＝ 3 次 GET）。
 *
 * **不是**硬編碼：案例依此推導注入的失敗次數並斷言實際 GET 數，
 * 因此把實作的 `[1000, 3000]` 改成 `[1000]`（只重試 1 次）時，R2／R3 必然失敗——
 * 這是 review B-2 M1 要求鑑別力。
 *
 * （本段自 PR #64／UX46 建立以來就帶著 review B-2 的註記；其中一個字元在 ad0fee2 引入時
 * 損毀成 U+FFFD 替換字元，已於 #92 修復為正常文字。）
 */
const DECIDED_GET_ATTEMPTS = 3;
const RETRY_COUNT = DECIDED_GET_ATTEMPTS - 1;
/** R4-F01：［重新載入］不帶自動重試 → 手動序列只有 1 次 GET。 */
const MANUAL_GET_ATTEMPTS = 1;

test.describe('報告刷新失敗的最短恢復路徑（UX46／operator 裁決 d-…-69）', () => {
  test('R1：apply 後第一次 GET 失敗、自動重試第 2 次成功 → 無錯誤畫面、候選為最新', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    const { tab, base } = await openMappingTab(page);
    const toolbar = page.locator('.toolbar', { hasText: '待確認米豆奶班名' });
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });
    const reportRegion = page.getByRole('region', { name: '米豆奶有／系統無' });

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
    // 復原後報告區回來，且是新值
    await expect(reportRegion).toContainText(`${base - 1} 個班`, { timeout: 20000 });
  });

  test('R2：重試皆失敗 → 單行標示＋［重新載入］＋候選表鎖定；［重新載入］成功後復原', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    const { tab, base } = await openMappingTab(page);
    const toolbar = page.locator('.toolbar', { hasText: '待確認米豆奶班名' });
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });

    const report = installReportRoute(page);
    // 失敗次數＝1＋裁決的重試次數：每次嘗試皆失敗，故必須走到「請按［重新載入］」階段
    report.failNext(DECIDED_GET_ATTEMPTS);

    await applyAlias(page, R2_ALIAS.raw, R2_ALIAS.target);

    await expect(notice).toBeVisible({ timeout: 30000 });
    await expectNoExplanationText(notice);
    expect(report.callCount(), '重試耗盡時 GET 應為初版＋2 次重試').toBe(DECIDED_GET_ATTEMPTS);

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
    // R4-F01（裁決 d-…-3）：［重新載入］＝恰好一次 GET、不帶自動重試，故手動序列只需失敗 1 次。
    report.failEachSequence(DECIDED_GET_ATTEMPTS);
    // 手動序列開始前把失敗數降為 1：等第一序列用盡後，下一個 GET 只再失敗一次。
    report.setSequenceFailCount(MANUAL_GET_ATTEMPTS);

    const documentRequests = documentRequestCount(page);

    await applyAlias(page, R3_ALIAS.raw, R3_ALIAS.target);
    await expect(notice).toBeVisible({ timeout: 30000 });
    await expectNoExplanationText(notice);
    expect(report.callCount(), '儲存後序列：初版＋2 次重試').toBe(DECIDED_GET_ATTEMPTS);

    const beforeDocuments = documentRequests();

    // ［重新載入］只發一次 GET，這次失敗即轉［重新整理頁面］，不自動整頁 reload
    await notice.locator('button', { hasText: '重新載入' }).click();
    const refreshPageBtn = notice.locator('button', { hasText: '重新整理頁面' });
    await expect(refreshPageBtn).toBeVisible({ timeout: 30000 });
    await expect(notice.locator('button', { hasText: '重新載入' })).toHaveCount(0);
    await expect(documentRequests()).toBe(beforeDocuments);
    // 總數＝儲存後序列 3 次 ＋ 手動序列 1 次＝4；不得有第 5 次（手動不得帶自動重試）。
    expect(report.callCount(), '［重新載入］只有一次 GET').toBe(DECIDED_GET_ATTEMPTS + MANUAL_GET_ATTEMPTS);

    // 按下［重新整理頁面］才整頁 reload
    const navigated = page.waitForEvent('load', { timeout: 30000 });
    await refreshPageBtn.click();
    await navigated;

    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 20000 });
    await expect(tab).toBeVisible();
  });

  /**
   * R4：重試序列進行中再次 apply → 舊序列回應不得覆蓋新結果。
   *
   * 舊序列的回應必須**晚於**新序列的結果送達，且兩者內容**必然不同**：
   * 舊序列在步驟 2 暫停前保存的 body 是 base-1 的報告；步驟 3 另讓一個候選以無效目標離開候選表，
   * 新序列取得的是 base-2 的報告。若 seq guard 失效，畫面會退回 base-1，斷言必然失敗
   * （review B-2 M2 要求：變異必須使測試失敗）。
   */
  test('R4：重試序列進行中再次 apply → 舊序列的過期回應不得覆蓋新結果', async ({ page }) => {
    test.setTimeout(240_000);
    await importRoster(page);
    const { tab, base } = await openMappingTab(page);
    const toolbar = page.locator('.toolbar', { hasText: '待確認米豆奶班名' });

    const report = installReportRoute(page);

    // 步驟 1：套用第一個別名 → base-1
    await applyAlias(page, R4_ALIAS.raw, R4_ALIAS.target);
    await expect(toolbar).toContainText(`(${base - 1})`, { timeout: 20000 });

    // 取得此刻的真實報告 body 作為 gate 釋放後的「過期回應」。
    // 判斷 M2 是否有鑑別力的關鍵：舊 body（base-1 的報告）與新結果（base-2 的報告）
    // 必須在畫面上可區分。若兩者相同，seq guard 失效時畫面不變、斷言 vacuous——
    // 因此 M2 實跑後若仍綠，即表示此處仍需強化（見 rework 報告）。
    const staleBody = (await (await page.request.get('/api/v1/settings/class-name-report')).json()) as {
      rosterOnly: Array<{ baseName: string; students: number; tokens: number }>;
    };

    // 步驟 2：再套用一個別名（伺服器端候選降為 base-2），但重新取得報告失敗 →
    // 第 1 次重試被 gate 暫停（釋放時回傳 staleBody）。畫面仍顯示 base-1，候選表鎖定。
    report.failNext(1);
    const gate = report.gateNext({ body: JSON.stringify(staleBody) });
    await applyAlias(page, R4_SECOND_ALIAS.raw, R4_SECOND_ALIAS.target);
    await gate.entered;

    // 舊序列被暫停時，報告區不得顯示過期值（UX46：重試期間不顯示儲存前的舊數字）
    await expect(page.getByRole('region', { name: '米豆奶有／系統無' })).toHaveCount(0);
    await expect(page.locator('[data-report-pending]')).toBeVisible();
    await expect(candidatesLocked(page).container).toHaveAttribute('aria-disabled', 'true');

    // 步驟 3：舊序列仍在暫停時，在課表頁改時段再套用 → 新序列立即 GET 成功 → base-2。
    // 鎖定只涵蓋「依過期報告確認班名」，課表頁的草稿不受影響。
    await applyScheduleTimeChange(page, '37');
    await switchToMappingTab(page);
    await expect(toolbar).toContainText(`(${base - 2})`, { timeout: 20000 });

    // 步驟 4：放行舊序列的回應（body 為 base-1 的過期報告）→ 不得覆蓋新結果。
    // 若 seq guard 失效，畫面會退回 base-1，本斷言失敗（review B-2 M2 的鑑別力來源）。
    const lockAfterNewSequence = await candidatesLocked(page).container.count();
    const countAfterNewSequence = await toolbar.textContent();
    const reportSnippetAfterNewSequence = await page
      .getByRole('region', { name: '米豆奶有／系統無' })
      .textContent()
      .catch(() => null);

    gate.release();
    await page.waitForTimeout(1500);

    // 舊序列若未被作廢：onSuccess 會把 staleBody（改過的過期報告）當成最新結果渲染。
    // 這裡比對畫面與快照，確認舊回應未改變任何可觀察狀態。
    expect(await candidatesLocked(page).container.count(), '舊序列回應不得重新鎖定候選表').toBe(
      lockAfterNewSequence
    );
    expect(await toolbar.textContent(), '舊序列回應不得把候選數退回').toBe(countAfterNewSequence);
    expect(
      await page.getByRole('region', { name: '米豆奶有／系統無' }).textContent().catch(() => null),
      '舊序列回應不得覆蓋報告區'
    ).toBe(reportSnippetAfterNewSequence);

    await switchToMappingTab(page);
    await expect(toolbar).toContainText(`(${base - 2})`);
    await expect(tab).toContainText(String(base - 2));
    await expect(page.locator('.mapping-table tr', { hasText: R4_ALIAS.raw })).toHaveCount(0);
    await expect(page.locator('.mapping-table tr', { hasText: R4_SECOND_ALIAS.raw })).toHaveCount(0);
    await expect(candidatesLocked(page).container).toHaveCount(0);
  });

  /**
   * R5（N2）：元件卸載（離開設定頁）後，重試序列不得再發出 GET、不得再 setState。
   *
   * 卸載後仍有 pending 的 setTimeout：若沒有 cleanup 作廢序列並清除計時器，
   * 逾時器會喚醒 fetchReportWithRetry 再發一次 GET。
   */
  test('R5：離開設定頁後，待重試的序列不再發出 GET（卸載清理）', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    await openMappingTab(page);

    const report = installReportRoute(page);
    report.failAlways();

    // 啟動一個會進入重試等待的序列
    await applyAlias(page, R5_PENDING_ALIAS.raw, R5_PENDING_ALIAS.target);
    const callsBeforeLeave = report.callCount();
    expect(callsBeforeLeave).toBeGreaterThanOrEqual(1);

    // 以站內導覽離開（next/link client-side → SettingsEditor 卸載，document 不重新載入）；
    // 此時第一次失敗的重試等待中
    await page.locator('aside[aria-label="主要導覽"] a', { hasText: '匯入學生' }).click();
    await expect(page).toHaveURL(/\/imports/, { timeout: 20000 });

    // 等待超過所有重試間隔總和（1s＋3s ＝ 4s，再加緩衝）
    await page.waitForTimeout(6000);

    expect(report.callCount(), '卸載後不得再發出 GET').toBe(callsBeforeLeave);
  });

  /**
   * R6（UX46 末段「重試中再次套用時舊序列回應不得覆蓋新結果」的前置路徑）：
   * 走**已經進入［重新整理頁面］階段**之後，使用者再次儲存。
   *
   * 現行行為（第五輪驗收 §3.3 已於瀏覽器確認）：再次 apply 會啟動**新的**刷新序列——
   * 先回到「更新中…」（中性佔位、不顯示過期數字、候選表仍鎖定）並重新走自動重試，
   * 這次成功後恢復正常：復原標示消失、候選表解鎖、報告以最新結果重建。
   *
   * expected 依 UX46 與 decision d-20261002162913018695-69 手寫，不使用實作輸出回填。
   */
  test('R6：［重新整理頁面］階段再次儲存 → 回到「更新中…」並重走自動重試 → 成功恢復', async ({ page }) => {
    test.setTimeout(240_000);
    await importRoster(page);
    const { tab, base } = await openMappingTab(page);
    const toolbar = page.locator('.toolbar', { hasText: '待確認米豆奶班名' });
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });
    const reportRegion = page.getByRole('region', { name: '米豆奶有／系統無' });

    const report = installReportRoute(page);

    // 步驟 1：套用一個有效別名（候選降為 base-1），並讓這次儲存後序列的 GET 失敗。
    // 之後靠 setSequenceFailCount 把下一個序列（［重新載入］）也壓成失敗，走到［重新整理頁面］階段。
    report.failEachSequence(DECIDED_GET_ATTEMPTS);
    report.setSequenceFailCount(MANUAL_GET_ATTEMPTS);
    await applyAlias(page, R6_PENDING_ALIAS.raw, R6_PENDING_ALIAS.target);

    await expect(notice).toBeVisible({ timeout: 30000 });
    await notice.locator('button', { hasText: '重新載入' }).click();
    await expect(notice.locator('button', { hasText: '重新整理頁面' })).toBeVisible({ timeout: 30000 });
    await expect(reportRegion).toHaveCount(0);
    expect(report.callCount(), '儲存後序列 3 次＋手動序列 1 次').toBe(
      DECIDED_GET_ATTEMPTS + MANUAL_GET_ATTEMPTS
    );

    // 步驟 2：在［重新整理頁面］階段再次儲存（課表時段變更）。候選表此刻鎖定，
    // 但鎖定只涵蓋「依過期報告確認班名」，課表頁草稿不受影響，故走這條 apply 路徑。
    // 重裝攔截器以清掉上一個手動序列留下的剩餘失敗狀態，再用 failNext(1)：
    // 新序列首次 GET 失敗（因此看得到回到「更新中…」），自動重試的第 2 次即成功。
    // 注意不能用 failEachSequence —— 它的 failNext 是常駐的，該序列會永遠失敗而進不到成功。
    await page.unroute(REPORT_URL);
    const report2 = installReportRoute(page);
    report2.failNext(1);
    await applyScheduleTimeChange(page, '43');
    await switchToMappingTab(page);

    await expect(page.locator('[data-report-pending]')).toBeVisible({ timeout: 15000 });
    await expect(notice).toHaveCount(0);
    await expect(reportRegion).toHaveCount(0);
    await expect(candidatesLocked(page).container).toHaveAttribute('aria-disabled', 'true');
    // 新序列必須真的重新發出 GET 並走自動重試（首次失敗、第 2 次成功）
    await expect(page.locator('[data-report-pending]')).toHaveCount(0, { timeout: 30000 });
    expect(report2.callCount(), '再次儲存後新序列應至少發出 2 次 GET（首次＋重試）').toBeGreaterThanOrEqual(2);

    // 步驟 3：重試成功 → 恢復正常：復原標示消失、候選表解鎖、以最新報告重建（base-1）。
    await expect(notice).toHaveCount(0);
    await expect(toolbar).toContainText(`(${base - 1})`);
    await expect(tab).toContainText(String(base - 1));
    await expect(reportRegion).toContainText(`${base - 1} 個班`, { timeout: 20000 });
    await expect(page.locator('.mapping-table tr', { hasText: R6_PENDING_ALIAS.raw })).toHaveCount(0);
    const unlocked = candidatesLocked(page);
    await expect(unlocked.container).toHaveCount(0);
    await expect(unlocked.firstTarget).toBeEnabled();
    // 註：checkbox 的 enabled 由該列自身是否已填目標決定（不是候選表鎖定），
    // 故沿用 R2 的斷言範圍，只驗鎖定容器消失與目標欄可編輯。
  });
});
