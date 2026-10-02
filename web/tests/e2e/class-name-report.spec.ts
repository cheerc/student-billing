import { test, expect, type Page, type Route } from '@playwright/test';
import fs from 'fs';
import JSZip from 'jszip';
import { FIXTURE, xlsxUpload } from './helpers/c-batch';

/**
 * D1 班名比對報告（specs/11 §3 D1、04 §8 UX44–UX47；S manifest §8；operator ruling d-20260930112930661160-25 Q12-b）。
 * 使用者實際操作驗證：
 *   1. 匯入預覽在「使用這份名單」之前，顯示兩份清單（米豆奶有／系統無、系統有／本次名冊無）的班數與影響人數，
 *      並提供完整報告連結；
 *   2. 完整報告在課表設定「班名對應」：兩份清單並排、預設展開；系統有／名冊無 顯示上一份名單該班人數並註明來源；
 *      別名不對稱在畫面上說明；D1 不顯示任何「類別」。
 * 全部使用合成 fixture（不含真實名單）；每個 spec 檔用全新隔離 DB（npm run test:e2e:isolated）。
 *
 * fixture 事實（I19 錨點與手動盤點）：ERP 班名 54＝已對應 42＋米豆奶有／系統無 12；seed 49 班中 7 個本次未出現；
 * 12 個待對應班涵蓋 191 位不重複學生（交通車 93 人）；未出現的 7 個 seed 班含「國小數學-一A」「國小輔導-四年級」。
 */

const summaryOf = (page: Page) => page.getByRole('region', { name: '班名比對摘要' });
const reportOf = (page: Page) => page.getByRole('region', { name: '班名比對報告' });
const rosterOnlyOf = (page: Page) => page.getByRole('region', { name: '米豆奶有／系統無' });
const systemOnlyOf = (page: Page) => page.getByRole('region', { name: '系統有／本次名冊無' });

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

test.describe('班名比對報告（D1）', () => {
  test('匯入預覽：使用這份名單之前先看到兩份清單的班數與影響人數，並連到完整報告；完整報告兩份清單並排、預設展開、不含類別', async ({ page }) => {
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
    await expect(summary).toContainText('沒有上一份名單可參考');
    await expect(summary).not.toContainText('類別');

    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible();
    const summaryBeforeButton = await page.evaluate(
      ([s, b]) => Boolean((s as Node).compareDocumentPosition(b as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
      [await summary.elementHandle(), await useBtn.elementHandle()] as const
    );
    expect(summaryBeforeButton, '班名比對摘要要出現在「使用這份名單」之前').toBe(true);

    // 既有的「N 個班名待確認」提示不變（跨頁一致 E2E 依賴它）
    await expect(page.locator('text=/12\\s*個班名待確認/').first()).toBeVisible();

    // 連到完整報告（尚未啟用的這批名單也能看）
    const link = summary.getByRole('link', { name: /完整班名比對報告/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /^\/settings\?tab=mapping&import=.+/);
    await link.click();

    // 完整報告：課表設定「班名對應」
    await expect(page).toHaveURL(/\/settings\?tab=mapping&import=/);
    const report = reportOf(page);
    await expect(report).toBeVisible({ timeout: 15000 });
    const left = rosterOnlyOf(page);
    const right = systemOnlyOf(page);
    // 預設展開（不需要點任何東西就看得到內容）
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    await expect(left).toContainText('12 個班');
    await expect(left).toContainText('191 位學生');
    await expect(left.getByRole('row', { name: /交通車/ })).toContainText('93 人');
    await expect(right).toContainText('7 個班');
    await expect(right.getByRole('row', { name: /國小數學-一A/ })).toBeVisible();
    await expect(right.getByRole('row', { name: /國小輔導-四年級/ })).toBeVisible();
    // 沒有上一份名單：不顯示人數，也不顯示 0
    await expect(right).toContainText('沒有上一份名單可參考');

    // 並排：同一橫列、左清單在右清單左邊
    const a = (await left.boundingBox())!;
    const b = (await right.boundingBox())!;
    expect(Math.abs(a.y - b.y), '兩份清單頂端對齊（並排）').toBeLessThan(8);
    expect(a.x + a.width, '米豆奶有／系統無 在左、系統有／本次名冊無 在右').toBeLessThanOrEqual(b.x + 2);

    // 別名不對稱說明、D1 不顯示類別
    await expect(report).toContainText('別名');
    await expect(report).toContainText('直接');
    await expect(report).not.toContainText('類別');
  });

  test('有上一份名單：摘要與完整報告的「系統有／本次名冊無」顯示上一份名單該班的人數，並註明來源檔名', async ({ page }) => {
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
    await expect(summary).toContainText('previous-roster.xlsx');
    await expect(summary).toContainText('共有 1 位學生');
    await expect(summary).not.toContainText('沒有上一份名單可參考');

    await summary.getByRole('link', { name: /完整班名比對報告/ }).click();
    const right = systemOnlyOf(page);
    await expect(right).toBeVisible({ timeout: 15000 });
    await expect(right).toContainText('previous-roster.xlsx');
    await expect(right.getByRole('row', { name: /國小輔導-四年級/ })).toContainText('1 人');
    // 上一份名單沒有學生的 seed 班：人數 0（有上一份名單，所以是 0 而不是「沒有資料」）
    await expect(right.getByRole('row', { name: /國小數學-一A/ })).toContainText('0 人');
  });

  test('成功儲存 alias 後，班名比對報告同頁即時刷新，已對應的班級從米豆奶有／系統無中消失（F3）', async ({ page }) => {
    // 1. 進入 /imports，上傳 FIXTURE 並啟用為現行名單
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible({ timeout: 15000 });
    await useBtn.click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    // 2. 到課表設定的「班名對應」頁籤
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    await page.locator('button', { hasText: '班名對應' }).click();
    await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

    const left = rosterOnlyOf(page);
    await expect(left).toBeVisible({ timeout: 15000 });
    await expect(left).toContainText('12 個班');
    await expect(left.getByRole('row', { name: /國小數學-一/ })).toBeVisible();

    // 3. 在待確認清單為「國小數學-一」填目標「國小數學-一A」並勾選對應
    const row = page.locator('tr', { hasText: '國小數學-一' });
    await expect(row).toBeVisible();
    await row.locator('input.input-target-classname').fill('國小數學-一A');
    await row.locator('input[type="checkbox"]').check();

    // 4. 點擊底部操作列「確認變更」開啟 ImpactDialog
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();

    // 5. 等待 Toast 成功訊息且對話框關閉
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
    await expect(dialog).not.toBeVisible();

    // 6. 核心驗證（F3）：同頁上的班名比對報告必須立即刷新！
    // 米豆奶有／系統無應即時更新為 11 個班，且「國小數學-一」應消失！
    await expect(left).toContainText('11 個班');
    await expect(left.getByRole('row', { name: /國小數學-一/ })).not.toBeVisible();
  });

  /**
   * D1 r2 B1／B2：F3 儲存後刷新的兩條邊界（r1 brief 明列，primary round-1 REJECTED 的 B1／B2）。
   * 走真實 preview／apply，不注入任何狀態；每個 spec 檔用全新隔離 DB（npm run test:e2e:isolated）。
   */

  /** 上傳標準 fixture 並啟用為現行名單（現行名單＝A）。 */
  async function activateFixtureAsCurrent(page: Page) {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible({ timeout: 15000 });
    await useBtn.click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
  }

  /** 在「班名對應」為某個待確認班名填目標並勾選，經確認視窗儲存並更新結果，等到成功 toast。 */
  async function mapAliasAndApply(page: Page, raw: string, target: string) {
    const row = page.locator('tr', { hasText: raw });
    await expect(row).toBeVisible();
    await row.locator('input.input-target-classname').fill(target);
    await row.locator('input[type="checkbox"]').check();
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
    return (await res.json()) as { rosterOnly: unknown[]; systemOnly: unknown[] };
  }

  test('B1：檢視另一份尚未啟用的名單（?import=B）時，儲存 alias 後同頁報告仍是 B 的內容，不跳成現行名單 A 的報告', async ({ page }) => {
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
    expect(apiA0.systemOnly.length, 'A 與 B 的系統有／名冊無班數要不同（變體多報一個 seed 班）').not.toBe(apiB0.systemOnly.length);

    // 以 ?import=B 開啟課表設定：頁面報告是 B 的內容
    await page.goto(href);
    const right = systemOnlyOf(page);
    const left = rosterOnlyOf(page);
    await expect(right).toBeVisible({ timeout: 15000 });
    await expect(right).toContainText(`${apiB0.systemOnly.length} 個班`);
    await expect(left).toContainText(`${apiB0.rosterOnly.length} 個班`);

    // 在這一頁儲存 alias（真實 preview／apply）
    await mapAliasAndApply(page, '國小國語文-小三四', '國小國語文-小三小四');

    // 刷新後同頁報告必須仍是 B 的內容，並與同 scope 的 API 一致（不是現行名單 A 的班數）
    const apiB1 = await reportApi(page, importB);
    expect(apiB1.rosterOnly.length, '儲存 alias 後 B 的米豆奶有／系統無少一個班').toBe(apiB0.rosterOnly.length - 1);
    await expect(left).toContainText(`${apiB1.rosterOnly.length} 個班`, { timeout: 15000 });
    await expect(right).toContainText(`${apiB1.systemOnly.length} 個班`);
    await expect(right).not.toContainText(`${apiA0.systemOnly.length} 個班`);
    await expect(page).toHaveURL(new RegExp(`import=${importB}`));
  });

  for (const [label, failRefresh, firstPair, secondPair] of [
    [
      '伺服器回 500',
      (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }),
      ['國小輔導-四年級B', '國小輔導-四年級'],
      ['小六國文加強班', '小六加強班-國文'],
    ],
    [
      '連線中斷',
      (route: Route) => route.abort('failed'),
      ['小六數學加強班', '小六加強班-數學'],
      ['國小輔導-四年級A', '國小輔導-四年級'],
    ],
  ] as const) {
    /**
     * PR-G（operator 裁決 d-20261002162913018695-69）後：第一次失敗會**自動重試 2 次**，
     * 因此只讓單次 GET 失敗將被自動恢復、觀察不到任何標示。本案例改為讓初次＋2 次重試皆失敗，
     * 再以［重新載入］恢復——仍驗證原 B2 保證：已成功的儲存不被說成失敗、舊數字不冒充最新、
     * 恢復後標示消失且數字為新值。自動重試本身由 report-refresh-recovery.spec.ts R1 驗證。
     */
    test(`B2：儲存成功後重新取得報告持續失敗（${label}）→ 明確標示無法取得最新報告，不以舊數字冒充最新；［重新載入］成功後標示消失、數字為新值`, async ({ page }) => {
      test.setTimeout(90_000);
      await activateFixtureAsCurrent(page);
      const before = await reportApi(page);
      await page.goto('/settings');
      await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
      await page.locator('button', { hasText: '班名對應' }).click();
      const left = rosterOnlyOf(page);
      await expect(left).toContainText(`${before.rosterOnly.length} 個班`, { timeout: 15000 });

      // 讓初次嘗試＋2 次自動重試（1s、3s）皆失敗；apply 本身成功
      let reportCalls = 0;
      await page.route('**/api/v1/settings/class-name-report**', async (route) => {
        reportCalls += 1;
        if (reportCalls <= 3) return failRefresh(route);
        return route.continue();
      });

      await mapAliasAndApply(page, firstPair[0], firstPair[1]);

      // 已成功的儲存不能被說成儲存失敗；要由儲存成功 toast 表達，報告區只給最短恢復路徑
      // （operator 裁決 d-20261002162913018695-69：標示不解釋原因，單行＋一顆按鈕）
      await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
      const notice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });
      await expect(notice).toBeVisible({ timeout: 15000 });
      await expect(notice).toContainText('無法取得最新的班名比對報告。');
      await expect(notice).not.toContainText('儲存失敗');
      await expect(notice).not.toContainText('建議重新匯入');
      // 舊數字不得再以「目前設定的比對結果」出現：兩份清單（含儲存前的班數與影響人數）都不再顯示
      await expect(rosterOnlyOf(page)).toHaveCount(0);
      await expect(systemOnlyOf(page)).toHaveCount(0);
      expect(reportCalls, '初次嘗試＋2 次自動重試皆失敗').toBe(3);

      // 按［重新載入］：只重新取得報告 → 標示消失，數字是新值（比儲存前少 1 個班）
      await notice.locator('button', { hasText: '重新載入' }).click();
      await expect(notice).toHaveCount(0, { timeout: 20000 });
      await expect(rosterOnlyOf(page)).toContainText(`${before.rosterOnly.length - 1} 個班`, { timeout: 15000 });
      expect(reportCalls, '［重新載入］是第 4 次重新取得且成功').toBe(4);

      // 恢復後再儲存另一個 alias：這次重新取得也成功 → 數字是新值（比儲存前少 2 個班）
      await mapAliasAndApply(page, secondPair[0], secondPair[1]);
      await expect(notice).toHaveCount(0, { timeout: 15000 });
      await expect(rosterOnlyOf(page)).toContainText(`${before.rosterOnly.length - 2} 個班`, { timeout: 15000 });
      expect(reportCalls, '第二次儲存的重新取得成功').toBe(5);
    });
  }
});
