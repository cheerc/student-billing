import { test, expect, type Page, type Route } from '@playwright/test';
import { FIXTURE, ensureClassTypeTab } from './helpers/c-batch';
import { resetSeedSettings } from './helpers/d2c-settings';

/**
 * 課表儲存後「班名同步報告」取得失敗的最短恢復路徑（operator 裁決 d-20261002162913018695-69；specs/04 UX46；#189 D62 改寫）。
 *
 * 行為契約（#189 D62 Phase 2：差異表取代舊候選表／班名比對報告）：
 *   R1 自動重試：apply 後 GET 失敗自動重試 2 次（約 1s、3s 間隔）；任一次成功即正常顯示，使用者全程不見錯誤畫面。
 *   R2 重試皆失敗：單行「無法取得最新的班名比對報告。」＋［重新載入］；差異表鎖定並收起重試前的舊數字；［重新載入］成功後標示消失、解鎖、以最新報告重建。
 *   R3 ［重新載入］再失敗：按鈕改為［重新整理頁面］，按下才整頁 reload；期間不自動 reload。
 *   R4 重試序列仍在前進時再次儲存：新序列作廢舊序列，舊回應不得覆蓋新結果。
 *   R5 離開設定頁後，待重試的序列不再發出 GET（卸載清理）。
 *   R6 ［重新整理頁面］階段再次儲存 → 回到「更新中…」並重走自動重試 → 成功恢復。
 *
 * 真入口：xlsx 匯入 → activate → 課表設定「班名同步」暫存改名 → apply → 頁面發出的 GET class-name-report（以 page.route 注入失敗）。
 * expected 由流程獨立推導：每成功同步一個班，差異表列數減 1；頁籤 badge 與差異表同源。
 */

const REPORT_URL = '**/api/v1/settings/class-name-report**';

/**
 * 各案例使用不同的米豆奶班名；每個案例匯入後先以正式 settings API 還原 seed 草稿，
 * 因此目標課表班可重用而不受前一案例的整班改名污染。
 * 候選（conforming-erp-fixture × seed 課表，12 班）：
 * 交通車／國小國語文-小三四／國小數學-一／國小輔導-四年級A／國小輔導-四年級B／國小輔導-寫功課／
 * 小六國文加強班／小六數學加強班／小六英文加強班／正音A班／正音B班／美語等班。
 */
const R1_RENAME = { raw: '小六國文加強班', target: '小六加強班-國文' };
const R2_RENAME = { raw: '國小國語文-小三四', target: '國小國語文-小三小四' };
const R3_RENAME = { raw: '國小數學-一', target: '國小數學-一A' };
const R4_RENAME = { raw: '小六數學加強班', target: '小六加強班-數學' };
/** R4 步驟 2：第二個整班同步（不同列、不同目標）。 */
const R4_SECOND_RENAME = { raw: '國小輔導-四年級A', target: '國小數學-一A' };
const R5_RENAME = { raw: '正音A班', target: '國小數學-一A' };
const R6_RENAME = { raw: '美語等班', target: '國小數學-一A' };

/** 可切換模式的 GET 攔截器：ok（真實回應，順帶保存最後一次成功 body）／fail（500）／gate（等待放行後回應保存的舊 body）。 */
function installReportRoute(page: Page) {
  let mode: 'ok' | 'fail' | 'gate' = 'ok';
  let failNext: number | undefined;
  let failCount = 0;
  let calls = 0;
  let lastGoodBody: string | null = null;
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
        body: gateBody ?? lastGoodBody ?? '{"mismatches":null}',
      });
    }
    const response = await route.fetch();
    const body = await response.text();
    if (response.ok()) lastGoodBody = body;
    await route.fulfill({ response, body });
  });

  return {
    callCount: () => calls,
    lastBody: () => lastGoodBody,
    failNext(n: number) {
      mode = 'fail';
      failCount = n;
      failNext = undefined;
    },
    failAlways() {
      mode = 'fail';
      failCount = Number.POSITIVE_INFINITY;
    },
    failEachSequence(n: number) {
      mode = 'fail';
      failNext = n;
    },
    setSequenceFailCount(n: number) {
      failNext = n;
    },
    gateNext(opts: { body?: string } = {}) {
      mode = 'gate';
      gateBody = opts.body ?? null;
      return { entered: gateEntered, release: () => releaseGate?.() };
    },
  };
}

async function importRoster(page: Page) {
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 20000 });
  await page.locator('button', { hasText: '使用這份名單' }).click();
  await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 20000 });
  await resetSeedSettings(page);
}

async function openSyncTab(page: Page) {
  await page.goto('/settings?tab=sync');
  await expect(page.locator('[data-class-name-sync-panel]')).toBeVisible({ timeout: 15000 });
  const tab = page.locator('button[role="tab"]', { hasText: '班名同步' });
  const text = (await tab.textContent()) || '';
  const m = text.match(/\d+/);
  expect(m, '頁籤 badge 應帶不一致班名數').not.toBeNull();
  return { tab, base: parseInt(m![0], 10) };
}

/** 差異表列：暫存整班改名 → 確認變更 → 儲存並更新結果（真實使用者路徑）。 */
async function stageAndSaveRename(page: Page, raw: string, target: string) {
  const row = page.locator(`tr[data-mismatch-row="${raw}"]`);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator('button', { hasText: '同步到既有班級' }).click();
  await page.locator('select[aria-label="選擇同步目標課表班級"]').selectOption({ value: target });
  await page.locator('button', { hasText: '暫存同步' }).click();
  await expect(row).toContainText('已暫存');
  await confirmAndSave(page);
}

/**
 * 課表頁改第一筆時段起訖 → 確認變更 → 儲存（差異表鎖定時仍可走這條路徑）。
 * `minute` 每次不同，確保下一次呼叫一定產生新草稿（同一值不會讓 isDirty 變真）。
 */
async function applyScheduleTimeChange(page: Page, minute: string) {
  await page.locator('button[role="tab"]', { hasText: '課表' }).click();
  // D61：預設安親頁籤沒有時段欄，先切到該班所在頁籤（整張表，不進聚焦模式）。
  const row = await ensureClassTypeTab(page, '兒童美語-Gino');
  const start = row.locator('input.input-time').first();
  await start.fill(`09:${minute}`);
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

function syncLocked(page: Page) {
  return {
    container: page.locator('[data-class-name-sync-panel][data-report-locked="true"]'),
    firstSyncButton: page.locator('.sync-mismatch-table button', { hasText: '同步到既有班級' }).first(),
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
 * 決定的重試次數（初版＋2 次重試 ＝ 3 次 GET）。把實作 `[1000, 3000]` 改成 `[1000]` 時 R2／R3 必然失敗。
 */
const DECIDED_GET_ATTEMPTS = 3;
/** R4-F01：［重新載入］不帶自動重試 → 手動序列只有 1 次 GET。 */
const MANUAL_GET_ATTEMPTS = 1;

test.describe('報告刷新失敗的最短恢復路徑（UX46／operator 裁決 d-…-69）', () => {
  test('R1：apply 後第一次 GET 失敗、自動重試第 2 次成功 → 無錯誤畫面、差異表為最新', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    const { tab, base } = await openSyncTab(page);
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });

    const report = installReportRoute(page);
    report.failNext(1);

    await stageAndSaveRename(page, R1_RENAME.raw, R1_RENAME.target);

    // 自動重試成功：不留下任何錯誤畫面，差異表同步為最新（base-1）
    await expect(tab).toContainText(String(base - 1), { timeout: 20000 });
    await expect(page.locator(`tr[data-mismatch-row="${R1_RENAME.raw}"]`)).toHaveCount(0);
    await expect(notice).toHaveCount(0);

    // 重試期間與結束後差異表都可操作
    await expect(syncLocked(page).container).toHaveCount(0);
    await expect(syncLocked(page).firstSyncButton).toBeEnabled();
  });

  test('R2：重試皆失敗 → 單行標示＋［重新載入］＋差異表鎖定；［重新載入］成功後復原', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    const { tab, base } = await openSyncTab(page);
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });

    const report = installReportRoute(page);
    report.failNext(DECIDED_GET_ATTEMPTS);

    await stageAndSaveRename(page, R2_RENAME.raw, R2_RENAME.target);

    await expect(notice).toBeVisible({ timeout: 30000 });
    await expectNoExplanationText(notice);
    expect(report.callCount(), '重試耗盡時 GET 應為初版＋2 次重試').toBe(DECIDED_GET_ATTEMPTS);

    const reloadBtn = notice.locator('button', { hasText: '重新載入' });
    await expect(reloadBtn).toBeVisible();

    // 差異表鎖定，且不顯示儲存前的舊數字
    await expect(syncLocked(page).container).toHaveAttribute('data-report-locked', 'true');
    await expect(page.locator('.sync-mismatch-table')).toHaveCount(0);

    // ［重新載入］只重新取得報告（不整頁 reload）：以 document 請求計數驗證沒有整頁導覽
    const documentRequests = documentRequestCount(page);
    await page.unroute(REPORT_URL);
    const documentsBeforeReload = documentRequests();
    await reloadBtn.click();

    await expect(notice).toHaveCount(0, { timeout: 20000 });
    await expect(tab).toContainText(String(base - 1));
    await expect(page.locator(`tr[data-mismatch-row="${R2_RENAME.raw}"]`)).toHaveCount(0);
    await expect(syncLocked(page).container).toHaveCount(0);
    await expect(syncLocked(page).firstSyncButton).toBeEnabled();
    await expect(documentRequests()).toBe(documentsBeforeReload);
  });

  test('R3：［重新載入］再失敗 → 按鈕改［重新整理頁面］；按下才整頁 reload（期間不自動 reload）', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    const { tab } = await openSyncTab(page);
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });

    const report = installReportRoute(page);
    report.failEachSequence(DECIDED_GET_ATTEMPTS);
    report.setSequenceFailCount(MANUAL_GET_ATTEMPTS);

    const documentRequests = documentRequestCount(page);

    await stageAndSaveRename(page, R3_RENAME.raw, R3_RENAME.target);
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
   * 舊序列在步驟 2 暫停前保存的 body 是 base-1；步驟 3 同步另一個班，新序列取得 base-2。
   * 若 seq guard 失效，畫面會退回 base-1，斷言必然失敗。
   */
  test('R4：重試序列進行中再次 apply → 舊序列的過期回應不得覆蓋新結果', async ({ page }) => {
    test.setTimeout(240_000);
    await importRoster(page);
    const { tab, base } = await openSyncTab(page);

    const report = installReportRoute(page);

    // 步驟 1：同步第一個班 → base-1
    await stageAndSaveRename(page, R4_RENAME.raw, R4_RENAME.target);
    await expect(tab).toContainText(String(base - 1), { timeout: 20000 });

    // 取得此刻的真實報告 body 作為 gate 釋放後的「過期回應」（與 base-2 必須可區分）。
    const staleBody = (await (await page.request.get('/api/v1/settings/class-name-report')).json()) as {
      mismatches: Array<{ erpBaseName: string; students: number; tokens: number; legacyAliasTarget: string | null }>;
    };

    // 步驟 2：再同步一個班（伺服器端差異表降為 base-2），但重新取得報告失敗 →
    // 第 1 次重試被 gate 暫停（釋放時回傳 staleBody）。畫面仍顯示 base-1，差異表鎖定。
    report.failNext(1);
    const gate = report.gateNext({ body: JSON.stringify(staleBody) });
    await stageAndSaveRename(page, R4_SECOND_RENAME.raw, R4_SECOND_RENAME.target);
    await gate.entered;

    // 舊序列被暫停時，差異表不得顯示過期值（UX46：重試期間不顯示儲存前的舊數字）
    await expect(page.locator('[data-report-pending]')).toBeVisible();
    await expect(page.locator('.sync-mismatch-table')).toHaveCount(0);
    await expect(syncLocked(page).container).toHaveAttribute('data-report-locked', 'true');

    // 步驟 3：舊序列仍在暫停時，在課表頁改時段再儲存 → 新序列立即 GET 成功 → base-2。
    await applyScheduleTimeChange(page, '37');
    await page.locator('button[role="tab"]', { hasText: '班名同步' }).click();
    await expect(tab).toContainText(String(base - 2), { timeout: 20000 });

    // 步驟 4：放行舊序列的回應（body 為 base-1 的過期報告）→ 不得覆蓋新結果。
    const lockAfterNewSequence = await syncLocked(page).container.count();
    const countAfterNewSequence = await tab.textContent();

    gate.release();
    await page.waitForTimeout(1500);

    expect(await syncLocked(page).container.count(), '舊序列回應不得重新鎖定差異表').toBe(
      lockAfterNewSequence
    );
    expect(await tab.textContent(), '舊序列回應不得把差異表數字退回').toBe(countAfterNewSequence);

    await page.locator('button[role="tab"]', { hasText: '班名同步' }).click();
    await expect(tab).toContainText(String(base - 2));
    await expect(page.locator(`tr[data-mismatch-row="${R4_RENAME.raw}"]`)).toHaveCount(0);
    await expect(page.locator(`tr[data-mismatch-row="${R4_SECOND_RENAME.raw}"]`)).toHaveCount(0);
    await expect(syncLocked(page).container).toHaveCount(0);
  });

  /**
   * R5（N2）：元件卸載（離開設定頁）後，重試序列不得再發出 GET、不得再 setState。
   */
  test('R5：離開設定頁後，待重試的序列不再發出 GET（卸載清理）', async ({ page }) => {
    test.setTimeout(180_000);
    await importRoster(page);
    await openSyncTab(page);

    const report = installReportRoute(page);
    report.failAlways();

    // 啟動一個會進入重試等待的序列
    await stageAndSaveRename(page, R5_RENAME.raw, R5_RENAME.target);
    const callsBeforeLeave = report.callCount();
    expect(callsBeforeLeave).toBeGreaterThanOrEqual(1);

    // 以站內導覽離開（next/link client-side → SettingsEditor 卸載，document 不重新載入）
    await page.locator('aside[aria-label="主要導覽"] a', { hasText: '匯入學生' }).click();
    await expect(page).toHaveURL(/\/imports/, { timeout: 20000 });

    await page.waitForTimeout(6000);

    expect(report.callCount(), '卸載後不得再發出 GET').toBe(callsBeforeLeave);
  });

  test('R6：［重新整理頁面］階段再次儲存 → 回到「更新中…」並重走自動重試 → 成功恢復', async ({ page }) => {
    test.setTimeout(240_000);
    await importRoster(page);
    const { tab, base } = await openSyncTab(page);
    const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });

    const report = installReportRoute(page);

    report.failEachSequence(DECIDED_GET_ATTEMPTS);
    report.setSequenceFailCount(MANUAL_GET_ATTEMPTS);
    await stageAndSaveRename(page, R6_RENAME.raw, R6_RENAME.target);

    await expect(notice).toBeVisible({ timeout: 30000 });
    await notice.locator('button', { hasText: '重新載入' }).click();
    await expect(notice.locator('button', { hasText: '重新整理頁面' })).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.sync-mismatch-table')).toHaveCount(0);
    expect(report.callCount(), '儲存後序列 3 次＋手動序列 1 次').toBe(
      DECIDED_GET_ATTEMPTS + MANUAL_GET_ATTEMPTS
    );

    // 步驟 2：在［重新整理頁面］階段再次儲存（課表時段變更）。重裝攔截器，新序列首次 GET 失敗（看得到「更新中…」），
    // 自動重試第 2 次即成功。
    await page.unroute(REPORT_URL);
    const report2 = installReportRoute(page);
    report2.failNext(1);
    await applyScheduleTimeChange(page, '43');
    await page.locator('button[role="tab"]', { hasText: '班名同步' }).click();

    await expect(page.locator('[data-report-pending]')).toBeVisible({ timeout: 15000 });
    await expect(notice).toHaveCount(0);
    await expect(page.locator('.sync-mismatch-table')).toHaveCount(0);
    await expect(syncLocked(page).container).toHaveAttribute('data-report-locked', 'true');
    await expect(page.locator('[data-report-pending]')).toHaveCount(0, { timeout: 30000 });
    expect(report2.callCount(), '再次儲存後新序列應至少發出 2 次 GET（首次＋重試）').toBeGreaterThanOrEqual(2);

    // 步驟 3：重試成功 → 恢復正常：復原標示消失、差異表解鎖、以最新報告重建（base-1）。
    await expect(notice).toHaveCount(0);
    await expect(tab).toContainText(String(base - 1));
    await expect(page.locator(`tr[data-mismatch-row="${R6_RENAME.raw}"]`)).toHaveCount(0);
    await expect(syncLocked(page).container).toHaveCount(0);
    await expect(syncLocked(page).firstSyncButton).toBeEnabled();
  });
});
