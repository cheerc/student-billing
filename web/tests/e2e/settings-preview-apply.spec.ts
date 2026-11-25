import { test, expect } from '@playwright/test';
import path from 'path';
import { flipCalculateOnConfirmHover, holdCalculate } from './helpers/hold-calculate';
import { openClassSchedule, startInput } from './helpers/c-batch';
import { awaitCalculateAfter, clickConfirmChanges } from './helpers/d2c-settings';

/**
 * specs/10 §4（T05 重寫對照 R2 UX03／UX09／UX10；#189 D62 改寫）：
 * 舊 spec（T05：勾選數學一→一A → preview 13人/-0.5/5→18 → 套用）對齊新版「班名同步」工作流程：
 * - 舊版在同一頁面展開待設定清單並以「預覽影響」／「套用並重算」按鈕提交；
 * - R2 曾以「班名對應」頁籤建立別名；D62 改為「班名同步」——逐列選目標課表班級、整班改名，
 *   由底部操作列「確認變更」開啟 ImpactDialog，在確認視窗內顯示 13 人天數變化與
 *   「系統計算天數與米豆奶入班天數不符：4 人 → 17 人」（D39；單位是人），再點擊「儲存並更新結果」完成原子套用與重算。
 */
test.describe('T05 設定 preview→apply E2E（R2 課表與班名同步工作流程）', () => {
  test('T05 (UX03/UX09/UX10): 上傳 → 啟用 → 班名同步「國小數學-一A」改名為「國小數學-一」 → ImpactDialog 預覽 13人/18筆差異 → 儲存並更新結果', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // 1. 上傳 ERP 名冊
    await page.goto('/imports');
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 2. 匯入頁啟用為正式 run 並前往核對結果
    const activateBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(activateBtn).toBeVisible({ timeout: 15000 });
    await activateBtn.click();
    await page.locator('a', { hasText: '前往核對結果' }).click();
    await expect(page.locator('.data-banner-current', { hasText: '目前使用的資料' })).toBeVisible({ timeout: 15000 });

    // 3. 進入課表設定頁（R2 新標題：課表設定）
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });

    // 4. 切換至「班名同步」頁籤
    await page.locator('button[role="tab"]', { hasText: '班名同步' }).click();
    await expect(page.locator('[data-class-name-sync-panel]')).toBeVisible({ timeout: 10000 });

    // 5. D62 逐列同步：把「國小數學-一A」整班改名為米豆奶班名「國小數學-一」
    const row = page.locator('tr[data-mismatch-row="國小數學-一"]');
    await expect(row).toBeVisible();
    await row.locator('button', { hasText: '同步到既有班級' }).click();
    await page
      .locator('select[aria-label="選擇同步目標課表班級"]')
      .selectOption({ value: '國小數學-一A' });
    // 暫存會改草稿並排程 calculate；等該次計算完成（#271）再點「確認變更」，點擊才不會撞上 debounce 翻轉
    await awaitCalculateAfter(page, () => page.locator('button', { hasText: '暫存同步' }).click());
    await expect(row).toContainText('已暫存：國小數學-一A → 國小數學-一（未儲存）');

    // 6. 點擊底部操作列「確認變更」開啟 ImpactDialog 預覽影響 (D18)
    await clickConfirmChanges(page);
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // 斷言 D18 預期結果：13 人天數變化、天數不符 4 人 → 17 人（D39 定稿文案；單位是人，不是筆）
    await expect(dialog).toContainText('13 人');
    await expect(dialog).toContainText('系統計算天數與米豆奶入班天數不符：4 人 → 17 人', { useInnerText: true });
    await expect(dialog).not.toContainText('mismatch', { useInnerText: true });

    // 7. 點擊確認視窗內主按鈕「儲存並更新結果」完成套用與重算
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();

    // 驗證套用成功 toast 通知且確認視窗已關閉
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
    await expect(dialog).not.toBeVisible();
  });
  // Issue #271：編輯後立刻點「確認變更」，點擊落在 debounce 翻轉瞬間會遺失。
  // flipCalculateOnConfirmHover 讓翻轉必然發生在「確認變更」被按下的當下（見 helpers/hold-calculate.ts）。
  test('#271: 編輯後以 awaitCalculateAfter + clickConfirmChanges 點「確認變更」，debounce 翻轉不影響開啟確認視窗', async ({ page }) => {
    await flipCalculateOnConfirmHover(page);
    await openClassSchedule(page, '兒童美語-Gino');
    await awaitCalculateAfter(page, async () => (await startInput(page)).fill('15:45'));
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await clickConfirmChanges(page);
    await expect(page.locator('dialog.impact-dialog')).toBeVisible({ timeout: 5000 });
  });

  // 對照組：同一個翻轉 harness 下，不等 calculate 就點，點擊會被吞掉。
  // 證明 harness 真的重現競態（不是上一個測試恰好沒撞上），也鎖住 specs/09 的 gate 契約：計算中不可確認。
  // 計算請求用 holdCalculate 扣住，「計算在途、按鈕 disabled、對話框沒開」變成穩定可斷言的狀態，
  // 不會因為回應太快而空洞通過。
  test('#271 對照組: 不等 calculate 就點「確認變更」，翻轉時點擊遺失（確認視窗不開）', async ({ page }) => {
    // fallback 拉長：本案例不等計算，絕不能因機器負載讓計時器先自行放行而漏掉翻轉（否則對照組會偶發變綠）
    await flipCalculateOnConfirmHover(page, 60_000);
    await openClassSchedule(page, '兒童美語-Gino');
    // 翻轉 harness 把 debounce 計時器扣到 pointerdown，所以此刻沒有任何 calculate 在途；
    // 之後唯一送出的那一筆就是點擊觸發的，用 holdCalculate 扣住它。
    const hold = await holdCalculate(page);
    await (await startInput(page)).fill('15:45');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    const confirmButton = page.getByRole('button', { name: '確認變更', exact: true });
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect.poll(() => hold.held(), { message: '點擊當下翻轉：calculate 請求已送出並被扣住' }).toBe(1);
    await expect(confirmButton, '計算在途：確認變更 disabled').toBeDisabled();
    await expect(page.locator('dialog.impact-dialog'), '點擊被 disabled 按鈕吞掉：視窗沒開').toBeHidden();

    // 放行計算後按鈕恢復可點：此時才點得開（正式流程用 awaitCalculateAfter 避免這次遺失）
    hold.release();
    await clickConfirmChanges(page);
    await expect(page.locator('dialog.impact-dialog')).toBeVisible({ timeout: 5000 });
  });

  // r2：awaitCalculateAfter 不得被「編輯之前就送出」的 calculate（掛載時那一筆、cancelEdits 那一筆）的回應滿足。
  // 扣住掛載時的 calculate → 呼叫 awaitCalculateAfter → 編輯後放行它：舊 helper 在編輯自己的 debounce 請求送出前
  // 就用這筆舊回應返回（確認變更的翻轉競態重新打開）；新 helper 只認編輯之後送出的請求。決定性，不靠時間差。
  test('#271 r2: awaitCalculateAfter 不被編輯前已在途的 calculate 回應滿足', async ({ page }) => {
    const hold = await holdCalculate(page);
    await openClassSchedule(page, '兒童美語-Gino');
    await expect.poll(() => hold.held(), { message: '掛載時的 calculate 應已送出並被扣住' }).toBe(1);

    let sentAfterRegistration = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/settings/calculate' && request.method() === 'POST') {
        sentAfterRegistration += 1;
      }
    });
    await awaitCalculateAfter(page, async () => {
      await (await startInput(page)).fill('15:45');
      hold.release(); // 掛載時的舊回應此刻回來；編輯自己的請求要 250ms debounce 後才會送出
    });
    expect(sentAfterRegistration, '必須等到這次編輯自己的 calculate 請求送出並回應').toBeGreaterThanOrEqual(1);
  });
});
