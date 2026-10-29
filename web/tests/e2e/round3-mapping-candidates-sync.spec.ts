import { test, expect, type Page, type Route } from '@playwright/test';
import fs from 'fs';
import JSZip from 'jszip';
import { FIXTURE, ensureClassTypeTab, xlsxUpload } from './helpers/c-batch';
import { resetSeedSettings } from './helpers/d2c-settings';

/**
 * N09／R3-F02（issue #55；specs/04 §8 UX70／UX46；#189 D62 Phase 2 改寫）：
 * 課表設定儲存後，「班名同步」差異表、摘要列、頁籤 Badge 必須與班名同步報告同頁即時同步（無 reload）：
 *   1. 成功同步後，該列即時消失；目標班級整班改名後，失效的舊對應使原始米豆奶班名即時重新浮現；
 *   2. 檢視未啟用名單（?import=B）時，保持 B 的檢視範圍，儲存後仍為 B，不跳回現行 A；
 *   3. 重新取得報告持續失敗（500）時，收起重試前的舊數字並鎖定差異表；［重新載入］成功後恢復；
 *   4. 暫存但未儲存的同步不因切換頁籤而遺失。
 */

async function buildVariantRoster(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(FIXTURE));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(sheetPath)!.async('string');
  const row2 = xml.match(/<row [^>]*>[\s\S]*?<\/row>/g)![1];
  expect(row2).toContain('STU0001');
  const changed = row2.replace('兒童美語-KC[團]', '兒童美語-KC[團]\n115國小數學-一A[團]');
  expect(changed).not.toBe(row2);
  xml = xml.replace(row2, changed);
  zip.file(sheetPath, xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const panelOf = (page: Page) => page.locator('[data-class-name-sync-panel]');
const summaryOf = (page: Page) => page.locator('.sync-summary-card');
const syncTab = (page: Page) => page.locator('button[role="tab"]', { hasText: '班名同步' });

function mismatchCount(text: string): number {
  const m = /不一致\s*(\d+)/.exec(text);
  expect(m, `摘要列應含「不一致 N」：${text}`).not.toBeNull();
  return Number(m![1]);
}

async function currentMismatchCount(page: Page): Promise<number> {
  await expect(summaryOf(page)).toBeVisible({ timeout: 15000 });
  return mismatchCount((await summaryOf(page).innerText()) ?? '');
}

async function renameWholeClass(page: Page, from: string, to: string) {
  const inputs = page.locator(`input.input-classname[value="${from}"]`);
  await inputs.first().scrollIntoViewIfNeeded();
  const total = await inputs.count();
  expect(total, `課表應有班級「${from}」可改名`).toBeGreaterThan(0);
  // 每次改完第一列，該列的 value 就不再符合選擇器，因此重算 count 直到全部改完
  for (let remaining = total; remaining > 0; remaining--) {
    await inputs.first().fill(to);
  }
  expect(await inputs.count(), `「${from}」的所有時段都應已改名`).toBe(0);
}

/** 暫存整班同步 → 確認變更 → 儲存並更新結果。 */
async function stageSync(page: Page, raw: string, target: string) {
  const row = page.locator(`tr[data-mismatch-row="${raw}"]`);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator('button', { hasText: '同步到既有班級' }).click();
  await page.locator('select[aria-label="選擇同步目標課表班級"]').selectOption({ value: target });
  await page.locator('button', { hasText: '暫存同步' }).click();
  await expect(row).toContainText('已暫存');
}

async function confirmAndSave(page: Page) {
  await page.locator('button', { hasText: '確認變更' }).click();
  const dialog = page.locator('dialog.impact-dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
  await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
  await expect(dialog).not.toBeVisible();
}

async function activateFixture(page: Page) {
  await page.goto('/imports');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
  await page.locator('button', { hasText: '使用這份名單' }).click();
  await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
  await resetSeedSettings(page);
}

test.describe('N09／R3-F02：儲存後差異表、摘要列與頁籤即時同步', () => {
  test('1. 核心雙向驗證：成功同步同頁消失 → 目標整班改名同頁浮現（無 reload）', async ({ page }) => {
    // 1. 匯入並啟用標準名冊 (477 人)
    await activateFixture(page);

    // 2. 進入課表設定的「班名同步」頁籤
    await page.goto('/settings?tab=sync');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    await expect(panelOf(page)).toBeVisible({ timeout: 15000 });
    const base = await currentMismatchCount(page);
    expect(base).toBe(12);
    await expect(syncTab(page)).toContainText(String(base));

    // 3. 為「國小國語文-小三四」選定既有課表班「國小數學-一A」→ 暫存 → 儲存
    await stageSync(page, '國小國語文-小三四', '國小數學-一A');
    await expect(page.locator('.save-status-dirty')).toBeVisible();
    await confirmAndSave(page);

    // 4. 【驗證向一：成功同步同頁即時消失（無 reload）】
    await expect(summaryOf(page)).toContainText(`不一致 ${base - 1}`);
    await expect(syncTab(page)).toContainText(String(base - 1));
    await expect(page.locator('tr[data-mismatch-row="國小國語文-小三四"]')).toHaveCount(0);

    // 5. 切換至「課表」頁籤，把剛同步過去的整班再改名 → 該同步失效
    await page.locator('button[role="tab"]', { hasText: '課表' }).click();
    await page.locator('#class-type-tab-math').click();
    await expect(page.locator('.schedule-table')).toBeVisible();
    // 同步＝把課表班「國小數學-一A」改名為米豆奶班名「國小國語文-小三四」；
    // 因此改名對象是這班（已落在數學班頁籤），改名後原米豆奶班名再次失去對應。
    await expect(
      page.locator('input.input-classname[value="國小國語文-小三四"]').first(),
      '同步後的班級應在課表頁'
    ).toBeVisible({ timeout: 10000 });
    await renameWholeClass(page, '國小國語文-小三四', 'R3數學班驗收');
    await expect(page.locator('.save-status-dirty')).toBeVisible();
    await confirmAndSave(page);

    // 6. 【驗證向二：目標改名後同頁切回「班名同步」即時重新浮現（無 reload，R3-F02 核心缺陷）】
    await syncTab(page).click();
    await expect(panelOf(page)).toBeVisible({ timeout: 15000 });

    // 舊對應已失效 → 原始米豆奶班名回到差異表，並標為未對應
    await expect(summaryOf(page)).toContainText(`不一致 ${base}`);
    await expect(syncTab(page)).toContainText(String(base));
    const resurfacedRow = page.locator('tr[data-mismatch-row="國小國語文-小三四"]');
    await expect(resurfacedRow).toBeVisible();
    await expect(resurfacedRow.locator('.pill', { hasText: '未對應課表' })).toBeVisible();
    await expect(resurfacedRow.locator('button', { hasText: '同步到既有班級' })).toBeVisible();
  });

  test('2. 檢視未啟用名單（?import=B）時，儲存同步維持 B 範圍', async ({ page }) => {
    // 啟用名單 A
    await activateFixture(page);

    // 上傳未啟用名單 B
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(xlsxUpload('variant-roster.xlsx', await buildVariantRoster()));
    const summary = page.getByRole('region', { name: '班名比對摘要' });
    await expect(summary).toBeVisible({ timeout: 15000 });
    const link = summary.getByRole('link', { name: /完整班名比對報告/ });
    await expect(link).toBeVisible();
    const href = (await link.getAttribute('href'))!;
    const importB = new URL(href, 'http://local.test').searchParams.get('import')!;

    // 開啟 ?import=B
    await page.goto(href);
    await expect(panelOf(page)).toBeVisible({ timeout: 15000 });
    const baseB = await currentMismatchCount(page);

    // 同步「國小輔導-四年級B」→「國小輔導-四年級」
    await stageSync(page, '國小輔導-四年級B', '國小國語文-小三小四');
    await confirmAndSave(page);

    // 驗證 URL 維持 import=B，摘要與差異表同步減少 1 班且該列消失
    await expect(page).toHaveURL(new RegExp(`import=${importB}`));
    await expect(page.locator('tr[data-mismatch-row="國小輔導-四年級B"]')).toHaveCount(0);
    await expect(summaryOf(page)).toContainText(`不一致 ${baseB - 1}`);
  });

  /**
   * 3. 重新取得報告持續失敗（500，連自動重試 2 次皆失敗）→ 單行標示＋［重新載入］、差異表收起重試前的舊數字。
   *
   * PR-G（operator 裁決 d-20261002162913018695-69；#189 UX46 改寫）之後，stale 期間**不顯示**舊數字：
   * 舊報告是儲存前的過期值，顯示它等於讓使用者用過期結果蓋章。自動重試的行為由
   * tests/e2e/report-refresh-recovery.spec.ts R1 驗證。
   */
  test('3. 重新取得報告持續失敗 → 單行標示＋［重新載入］、差異表收起舊數字並鎖定；恢復後解鎖', async ({
    page,
  }) => {
    await activateFixture(page);
    await page.goto('/settings?tab=sync');
    await expect(panelOf(page)).toBeVisible({ timeout: 15000 });
    const base = await currentMismatchCount(page);

    // 注入持續 500：初次嘗試＋2 次自動重試皆失敗（否則會被自動恢復，觀察不到鎖定）
    let reportCalls = 0;
    await page.route('**/api/v1/settings/class-name-report**', async (route: Route) => {
      reportCalls += 1;
      if (reportCalls <= 3) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server error"}' });
      }
      return route.continue();
    });

    // 儲存第一個同步（回到課表頁儲存，避免 stale 提示出現時點到被收起的差異表）
    await stageSync(page, '國小國語文-小三四', '國小國語文-小三小四');
    await confirmAndSave(page);

    // 回到班名同步：驗證出現無法取得最新報告的單行標示（＋［重新載入］按鈕）
    await syncTab(page).click();
    const staleNotice = page.locator('[data-report-stale]');
    await expect(staleNotice).toBeVisible({ timeout: 20000 });
    await expect(staleNotice.locator('button', { hasText: '重新載入' })).toBeVisible();

    // 差異表不得以舊數字冒充最新：摘要列與表格整塊收起，容器標記鎖定
    await expect(page.locator('[data-report-body-hidden]')).toBeVisible();
    await expect(summaryOf(page)).toHaveCount(0);
    await expect(page.locator('.sync-mismatch-table')).toHaveCount(0);
    await expect(panelOf(page)).toHaveAttribute('data-report-locked', 'true');

    // 按［重新載入］→ GET 恢復成功 → 標示消失、差異表解鎖且以最新報告重建（base-1）
    await staleNotice.locator('button', { hasText: '重新載入' }).click();
    await expect(staleNotice).toHaveCount(0, { timeout: 20000 });
    await expect(summaryOf(page)).toContainText(`不一致 ${base - 1}`);
    await expect(panelOf(page)).not.toHaveAttribute('data-report-locked', 'true');
    await expect(syncTab(page)).toContainText(String(base - 1));

    // 恢復後繼續同步第二個班 → 數字再減 1，前兩個班都不在差異表
    await stageSync(page, '國小數學-一', '國小數學-一A');
    await confirmAndSave(page);
    await expect(summaryOf(page)).toContainText(`不一致 ${base - 2}`);
    await expect(page.locator('tr[data-mismatch-row="國小國語文-小三四"]')).toHaveCount(0);
    await expect(page.locator('tr[data-mismatch-row="國小數學-一"]')).toHaveCount(0);
  });

  test('4. 暫存但未儲存的同步不因切換頁籤而遺失', async ({ page }) => {
    await activateFixture(page);
    await page.goto('/settings?tab=sync');
    await expect(panelOf(page)).toBeVisible({ timeout: 15000 });

    // 使用者暫存「交通車」→「國小輔導-四年級」，但尚未按確認變更
    await stageSync(page, '交通車', '國小輔導-四年級');
    const stagedRow = page.locator('tr[data-mismatch-row="交通車"]');
    await expect(stagedRow).toContainText('已暫存：國小輔導-四年級 → 交通車（未儲存）');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 切到課表頁再切回：暫存狀態與未儲存提示都必須還在
    await page.locator('button[role="tab"]', { hasText: '課表' }).click();
    await expect(page.locator('.schedule-table')).toBeVisible();
    await syncTab(page).click();
    await expect(panelOf(page)).toBeVisible();
    await expect(page.locator('tr[data-mismatch-row="交通車"]')).toContainText('已暫存');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 復原後回到未暫存狀態（乾淨的草稿仍保留）
    await page.locator('tr[data-mismatch-row="交通車"]').locator('button', { hasText: '復原' }).click();
    await expect(page.locator('tr[data-mismatch-row="交通車"]')).not.toContainText('已暫存');
  });

  /**
   * B-1（primary review blocking）在 D62 下的等價保證：第 1 次同步成功刷新後，第 2 次儲存時
   * 重新取得報告持續失敗，畫面不得回退到頁面初始值或讓已同步的班重新浮現；恢復後為最新值。
   *
   * UX46 改寫後 stale 期間收起舊數字（見案例 3），因此「維持最後成功值」的斷言改為
   * 「不得顯示任何舊數字」，並在恢復後驗證兩次同步都已生效（base-2）。
   *
   * expected 由流程獨立推導（每成功同步一個班就少一個不一致列），不使用新實作的輸出回填。
   */
  test('5. B-1：第 1 次同步成功後，第 2 次重新取得報告失敗 → 不顯示舊數字也不重新浮現已同步班；恢復後為 base-2', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await activateFixture(page);
    await page.goto('/settings?tab=sync');
    await expect(panelOf(page)).toBeVisible({ timeout: 15000 });
    const base = await currentMismatchCount(page);
    const staleNotice = page.locator('[data-report-stale]');

    // ── 步驟 1：第一次同步成功 → base-1，該列消失
    // 班名選擇避開同檔前案改名過的班（案例 1 曾把「國小國語文-小三小四」整班改名），
    // 確保目標班仍是有效系統班級，不受同檔案例間的 DB 殘留影響。
    await stageSync(page, '小六國文加強班', '小六加強班-國文');
    await confirmAndSave(page);
    await expect(summaryOf(page)).toContainText(`不一致 ${base - 1}`);
    await expect(page.locator('tr[data-mismatch-row="小六國文加強班"]')).toHaveCount(0);
    await expect(staleNotice).toHaveCount(0);

    // ── 步驟 2：第二次儲存，但重新取得報告持續失敗（初次＋2 次自動重試全 500）
    let reportCalls = 0;
    await page.route('**/api/v1/settings/class-name-report**', async (route: Route) => {
      reportCalls += 1;
      if (reportCalls <= 3) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server error"}' });
      }
      return route.continue();
    });

    // 班名避開同檔案例 1／3 已使用或改名的班（案例 3 已同步「小六數學加強班」「國小輔導-四年級A」）
    await stageSync(page, '交通車', '國小數學-一A');
    await confirmAndSave(page);

    await expect(staleNotice).toBeVisible({ timeout: 15000 });

    // 【B-1 核心斷言】不得回退到初始值、不得顯示任何舊數字、也不得操作差異表
    await expect(page.locator('[data-report-body-hidden]')).toBeVisible();
    await expect(summaryOf(page)).toHaveCount(0);
    await expect(panelOf(page)).toHaveAttribute('data-report-locked', 'true');
    await expect(syncTab(page)).toBeVisible();

    // ── 步驟 3：［重新載入］成功 → 標示消失、以最新報告重建（base-2）
    // 注意：第 2 步的同步**已成功套用**（apply 成功，只是報告 GET 失敗），
    // 故此時伺服器端共有 2 個同步生效 → 不一致為 base-2。
    await page.unroute('**/api/v1/settings/class-name-report**');
    await staleNotice.locator('button', { hasText: '重新載入' }).click();

    await expect(staleNotice).toHaveCount(0, { timeout: 20000 });
    await expect(summaryOf(page)).toContainText(`不一致 ${base - 2}`);
    await expect(syncTab(page)).toContainText(String(base - 2));
    await expect(page.locator('tr[data-mismatch-row="小六國文加強班"]')).toHaveCount(0);
    await expect(page.locator('tr[data-mismatch-row="交通車"]')).toHaveCount(0);
    // 「正音A班」未被同步，仍在差異表且可操作（恢復後解鎖）
    const stillPending = page.locator('tr[data-mismatch-row="正音A班"]');
    await expect(stillPending).toBeVisible();
    await expect(stillPending.locator('button', { hasText: '同步到既有班級' })).toBeEnabled();
  });
});
