import { test, expect, type Page, type Route } from '@playwright/test';
import fs from 'fs';
import JSZip from 'jszip';
import { FIXTURE, xlsxUpload } from './helpers/c-batch';
import { resetSeedSettings } from './helpers/d2c-settings';

/**
 * D1 班名比對報告（specs/11 §3 D1、04 §8 UX44–UX47；operator ruling d-20260930112930661160-25 Q12-b）
 * 於 #189 D62 Phase 2 改寫：完整報告併入「班名同步」差異表（specs/09 §3.3）。
 * 使用者實際操作驗證：
 *   1. 匯入預覽在「使用這份名單」之前，仍顯示兩份清單的班數與影響人數，並連到同步頁；
 *   2. 同步頁以單一差異表呈現「名冊有、課表沒有完全同名」的班級，底部收合區列出
 *      「課表有、本次名冊沒有的班級」與其課程類型／時段數／舊別名來源；
 *   3. 儲存後同頁差異表即時刷新（F3），已同步的列立即消失。
 * 全部使用合成 fixture（不含真實名單）；每個 spec 檔用全新隔離 DB（npm run test:e2e:isolated）。
 *
 * fixture 事實（I19 錨點與手動盤點）：ERP 班名 54＝已對應 42＋米豆奶有／系統無 12；seed 49 班中 7 個本次未出現；
 * 12 個待對應班涵蓋 191 位不重複學生（交通車 93 人）；未出現的 7 個 seed 班含「國小數學-一A」「國小輔導-四年級」。
 */

const summaryOf = (page: Page) => page.getByRole('region', { name: '班名比對摘要' });
const panelOf = (page: Page) => page.locator('[data-class-name-sync-panel]');
const syncSummaryOf = (page: Page) => page.locator('.sync-summary-card');
const systemOnlyOf = (page: Page) =>
  page.locator('[data-class-name-sync-panel] details', { hasText: '課表有、本次名冊沒有的班級' });

/** 「不一致 N」取自摘要列；N 由差異表列數決定，不是另一個獨立數字。 */
function mismatchCount(text: string): number {
  const m = /不一致\s*(\d+)/.exec(text);
  expect(m, `摘要列應含「不一致 N」：${text}`).not.toBeNull();
  return Number(m![1]);
}

/** 變體名單：STU0001 多報 seed 班「國小輔導-四年級」（本次 fixture 沒有的 seed 班），當作「上一份名單」。 */
async function buildPreviousRoster(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(FIXTURE));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(sheetPath)!.async('string');
  const row2 = xml.match(/<row [^>]*>[\s\S]*?<\/row>/g)![1];
  expect(row2).toContain('STU0001');
  const changed = row2.replace('兒童美語-KC[團]', '兒童美語-KC[團]\n115國小輔導-四年級[團]');
  expect(changed).not.toBe(row2);
  xml = xml.replace(row2, changed);
  zip.file(sheetPath, xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** 上傳標準 fixture 並啟用為現行名單。 */
async function activateFixtureAsCurrent(page: Page) {
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
  const useBtn = page.locator('button', { hasText: '使用這份名單' });
  await expect(useBtn).toBeVisible({ timeout: 15000 });
  await useBtn.click();
  await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
  await resetSeedSettings(page);
}

/** 在「班名同步」為某個待確認班名選定既有課表班 → 暫存 → 確認變更 → 儲存，等到成功 toast。 */
async function syncAndApply(page: Page, raw: string, target: string) {
  const row = page.locator(`tr[data-mismatch-row="${raw}"]`);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator('button', { hasText: '同步到既有班級' }).click();
  await page.locator('select[aria-label="選擇同步目標課表班級"]').selectOption({ value: target });
  await page.locator('button', { hasText: '暫存同步' }).click();
  await expect(row).toContainText('已暫存');

  await page.locator('button', { hasText: '確認變更' }).click();
  const dialog = page.locator('dialog.impact-dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
  await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
  await expect(dialog).not.toBeVisible();
}

/** 讀報告 API 的當前值（不帶 importId＝現行名單；帶 importId＝該批名單），當作「同 scope 的真實值」對照 UI。 */
async function reportApi(page: Page, importId?: string) {
  const q = importId ? `?importId=${encodeURIComponent(importId)}` : '';
  const res = await page.request.get(`/api/v1/settings/class-name-report${q}`);
  expect(res.ok(), '報告 API 應回 200').toBe(true);
  return (await res.json()) as { mismatches: unknown[]; systemOnly: unknown[] };
}

test.describe('班名比對報告（D1，D62 併入「班名同步」）', () => {
  test('匯入預覽：使用這份名單之前先看到兩份清單的班數與影響人數，並連到班名同步；同步頁差異表與收合清單呈現同一批事實', async ({
    page,
  }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 摘要在「使用這份名單」按鈕之前（DOM 順序），且不用展開就看得到
    const summary = summaryOf(page);
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('米豆奶有／系統無');
    await expect(summary).toContainText('12 個班');
    await expect(summary).toContainText('191 位學生');
    await expect(summary).toContainText('系統有／本次名冊無');
    await expect(summary).toContainText('7 個班');

    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible();
    const summaryBeforeButton = await page.evaluate(
      ([s, b]) => Boolean((s as Node).compareDocumentPosition(b as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
      [await summary.elementHandle(), await useBtn.elementHandle()] as const
    );
    expect(summaryBeforeButton, '班名比對摘要要出現在「使用這份名單」之前').toBe(true);

    // 既有的「N 個班名待確認」提示不變（跨頁一致 E2E 依賴它）
    await expect(page.locator('text=/12\\s*個班名待確認/').first()).toBeVisible();

    // 連到完整清單（尚未啟用的這批名單也能看；D62 路由改為 ?tab=sync）
    const link = summary.getByRole('link', { name: /完整班名比對報告/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /^\/settings\?tab=sync&import=.+/);
    await link.click();

    // 完整清單：課表設定「班名同步」
    await expect(page).toHaveURL(/\/settings\?tab=sync&import=/);
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 15000 });

    // 摘要列：54 個班名、一致 42、不一致 12（未對應 12，影響 191 位學生）
    const card = syncSummaryOf(page);
    await expect(card).toContainText('54 個班名');
    await expect(card).toContainText('一致 42');
    await expect(card).toContainText('不一致 12');
    await expect(card).toContainText('未對應 12');
    await expect(card).toContainText('影響 191 位學生');
    expect(mismatchCount((await card.innerText()) ?? ''), '差異表列數＝摘要的不一致數').toBe(
      await panel.locator('.sync-mismatch-table tbody tr[data-mismatch-row]').count()
    );

    // 差異表欄位與交通車的學生數（fixture 手動盤點：93 人）
    await expect(panel.locator('.sync-mismatch-table thead th', { hasText: '米豆奶班名' })).toBeVisible();
    await expect(panel.locator('.sync-mismatch-table thead th', { hasText: '現況' })).toBeVisible();
    await expect(panel.locator('tr[data-mismatch-row="交通車"]')).toContainText('93 位');

    // 底部收合區：課表有、本次名冊沒有的 7 個班，含課程類型／時段數／舊別名來源
    const details = systemOnlyOf(page);
    await expect(details.locator('summary')).toContainText('(7)');
    await details.locator('summary').click();
    await expect(details).toContainText('國小數學-一A');
    await expect(details).toContainText('國小輔導-四年級');
    await expect(details.locator('thead th', { hasText: '課程類型' })).toBeVisible();
    await expect(details.locator('thead th', { hasText: '舊別名來源' })).toBeVisible();
    await expect(syncSummaryOf(page)).not.toContainText('類別');
  });

  test('名冊班名比對：啟用名單後再上傳另一份名單，摘要與同步頁能正確呈現系統有／本次名冊無之設定班級', async ({
    page,
  }) => {
    // 先把變體（STU0001 多報「國小輔導-四年級」）當成目前使用的名單
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(xlsxUpload('previous-roster.xlsx', await buildPreviousRoster()));
    await expect(page.locator('button', { hasText: '使用這份名單' })).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    // 再上傳標準 fixture（本次沒有「國小輔導-四年級」）
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    const summary = summaryOf(page);
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('7 個班');

    await summary.getByRole('link', { name: /完整班名比對報告/ }).click();
    const details = systemOnlyOf(page);
    await expect(details).toBeVisible({ timeout: 15000 });
    await details.locator('summary').click();
    await expect(details).toContainText('國小輔導-四年級');
    await expect(details).toContainText('國小數學-一A');
  });

  test('成功同步後，差異表同頁即時刷新，已同步的班級立即消失（F3）', async ({ page }) => {
    // 1. 進入 /imports，上傳 FIXTURE 並啟用為現行名單
    await activateFixtureAsCurrent(page);

    // 2. 到課表設定的「班名同步」頁籤
    await page.goto('/settings?tab=sync');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    const panel = panelOf(page);
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(syncSummaryOf(page)).toContainText('不一致 12');
    await expect(page.locator('tr[data-mismatch-row="國小數學-一"]')).toBeVisible();

    // 3. 該列同步到既有課表班「國小數學-一A」→ 暫存 → 確認變更 → 儲存
    await syncAndApply(page, '國小數學-一', '國小數學-一A');

    // 4. 核心驗證（F3）：同頁的差異表必須立即刷新為 11 列，且「國小數學-一」消失
    await expect(syncSummaryOf(page)).toContainText('不一致 11', { timeout: 15000 });
    await expect(page.locator('tr[data-mismatch-row="國小數學-一"]')).toHaveCount(0);
    await expect(panel).not.toHaveAttribute('data-report-locked', 'true');
  });

  /**
   * D1 r2 B1／B2：F3 儲存後刷新的兩條邊界（r1 brief 明列，primary round-1 REJECTED 的 B1／B2）。
   * 走真實 preview／apply，不注入任何狀態；每個 spec 檔用全新隔離 DB（npm run test:e2e:isolated）。
   */
  test('B1：檢視另一份尚未啟用的名單（?import=B）時，儲存同步後同頁報告仍是 B 的內容，不跳成現行名單 A 的報告', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await activateFixtureAsCurrent(page); // 現行名單 A＝標準 fixture

    // 再上傳變體（STU0001 多報 seed 班「國小輔導-四年級」）當作尚未啟用的預覽批次 B，取其完整報告連結
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(xlsxUpload('variant-roster.xlsx', await buildPreviousRoster()));
    const link = summaryOf(page).getByRole('link', { name: /完整班名比對報告/ });
    await expect(link).toBeVisible({ timeout: 15000 });
    const href = (await link.getAttribute('href'))!;
    const importB = new URL(href, 'http://local.test').searchParams.get('import')!;
    expect(importB, '完整報告連結要帶預覽批次 B 的 import').toBeTruthy();

    // 鑑別力前提：同一時間 A（現行）與 B（預覽）的「系統有／本次名冊無」班數不同，否則跳成 A 看不出來
    const apiA0 = await reportApi(page);
    const apiB0 = await reportApi(page, importB);
    expect(apiA0.systemOnly.length, 'A 與 B 的系統有／名冊無班數要不同（變體多報一個 seed 班）').not.toBe(
      apiB0.systemOnly.length
    );

    // 以 ?import=B 開啟課表設定：頁面報告是 B 的內容
    await page.goto(href);
    const summary = syncSummaryOf(page);
    const details = systemOnlyOf(page);
    await expect(summary).toBeVisible({ timeout: 15000 });
    expect(mismatchCount((await summary.innerText()) ?? '')).toBe(apiB0.mismatches.length);
    await expect(details.locator('summary')).toContainText(`(${apiB0.systemOnly.length})`);

    // 在這一頁儲存同步（真實 preview／apply）
    await syncAndApply(page, '國小國語文-小三四', '國小國語文-小三小四');

    // 刷新後同頁報告必須仍是 B 的內容，並與同 scope 的 API 一致（不是現行名單 A 的班數）
    const apiB1 = await reportApi(page, importB);
    expect(apiB1.mismatches.length, '儲存同步後 B 的不一致列少一個').toBe(apiB0.mismatches.length - 1);
    await expect(summary).toContainText(`不一致 ${apiB1.mismatches.length}`, { timeout: 15000 });
    await expect(details.locator('summary')).toContainText(`(${apiB1.systemOnly.length})`);
    expect(mismatchCount((await summary.innerText()) ?? '')).not.toBe(apiA0.mismatches.length);
    await expect(page).toHaveURL(new RegExp(`import=${importB}`));
  });

  for (const [label, failRefresh, firstPair, secondPair] of [
    [
      '伺服器回 500',
      (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }),
      ['國小輔導-四年級B', '國小國語文-小三小四'],
      ['小六國文加強班', '小六加強班-國文'],
    ],
    [
      '連線中斷',
      (route: Route) => route.abort('failed'),
      ['小六數學加強班', '小六加強班-數學'],
      ['國小輔導-四年級A', '國小數學-一A']
    ],
  ] as const) {
    /**
     * PR-G（operator 裁決 d-20261002162913018695-69）後：第一次失敗會**自動重試 2 次**，
     * 因此只讓單次 GET 失敗將被自動恢復、觀察不到任何標示。本案例改為讓初次＋2 次重試皆失敗，
     * 再以［重新載入］恢復——仍驗證原 B2 保證：已成功的儲存不被說成失敗、舊數字不冒充最新、
     * 恢復後標示消失且數字為新值。自動重試本身由 report-refresh-recovery.spec.ts R1 驗證。
     */
    test(`B2：儲存成功後重新取得報告持續失敗（${label}）→ 明確標示無法取得最新報告，不以舊數字冒充最新；［重新載入］成功後標示消失、數字為新值`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await activateFixtureAsCurrent(page);
      const before = await reportApi(page);
      await page.goto('/settings?tab=sync');
      await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
      const summary = syncSummaryOf(page);
      await expect(summary).toBeVisible({ timeout: 15000 });
      expect(mismatchCount((await summary.innerText()) ?? '')).toBe(before.mismatches.length);

      // 讓初次嘗試＋2 次自動重試（1s、3s）皆失敗；apply 本身成功
      let reportCalls = 0;
      await page.route('**/api/v1/settings/class-name-report**', async (route) => {
        reportCalls += 1;
        if (reportCalls <= 3) return failRefresh(route);
        return route.continue();
      });

      await syncAndApply(page, firstPair[0], firstPair[1]);

      // 已成功的儲存不能被說成儲存失敗；要由儲存成功 toast 表達，報告區只給最短恢復路徑
      // （operator 裁決 d-20261002162913018695-69：標示不解釋原因，單行＋一顆按鈕）
      await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
      const notice = page.locator('[data-report-stale]');
      await expect(notice).toBeVisible({ timeout: 15000 });
      await expect(notice).toContainText('無法取得最新的班名比對報告。');
      await expect(notice).not.toContainText('儲存失敗');
      await expect(notice).not.toContainText('建議重新匯入');
      // 舊數字不得再以「目前設定」出現：摘要列與差異表整塊收起
      await expect(page.locator('[data-report-body-hidden]')).toBeVisible();
      await expect(page.locator('.sync-mismatch-table')).toHaveCount(0);
      expect(reportCalls, '初次嘗試＋2 次自動重試皆失敗').toBe(3);

      // 按［重新載入］：只重新取得報告 → 標示消失，數字是新值（比儲存前少 1 個班）
      await notice.locator('button', { hasText: '重新載入' }).click();
      await expect(notice).toHaveCount(0, { timeout: 20000 });
      await expect(summary).toContainText(`不一致 ${before.mismatches.length - 1}`, { timeout: 15000 });
      expect(reportCalls, '［重新載入］是第 4 次重新取得且成功').toBe(4);

      // 恢復後再儲存另一個同步：這次重新取得也成功 → 數字是新值（比儲存前少 2 個班）
      await syncAndApply(page, secondPair[0], secondPair[1]);
      await expect(notice).toHaveCount(0, { timeout: 15000 });
      await expect(summary).toContainText(`不一致 ${before.mismatches.length - 2}`, { timeout: 15000 });
      expect(reportCalls, '第二次儲存的重新取得成功').toBe(5);
    });
  }
});
