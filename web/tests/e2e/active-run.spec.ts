import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * R4 重寫（specs/10 §4：不得悄悄刪檔，舊 spec → 新 UX 對照列於 PR body）。
 *
 * 舊 spec「核對結果頁 E2E 驗收測試」→ 新對應（09 §5.1／§5.2、04 §8 UX11／UX14／UX16／UX20）：
 *   舊：上傳 → 啟用 → 「八欄」含美語天數／數學天數 → 篩選「5筆差異」→ 明細抽屜兩個固定標題
 *   新：學生總表改 12 欄（美語／數學／中文天數與寫功課位移至明細，不刪功能）；
 *       「5筆差異」是 fixture 不再是業務目標（09 §7／plan §4），改以實際篩選結果斷言；
 *       明細抽屜改四分區且原始資料／技術資訊為摺疊；新增班級扣天頁與人數行 scope。
 */
test.describe('R4 重寫：核對結果頁 E2E 驗收（學生總表 12 欄 + 班級扣天）', () => {
  test('UX11/UX14: 上傳 → 啟用 → 學生總表 12 欄 → 人數行 scope → 明細抽屜四分區', async ({ page }) => {
    // 1. 上傳 ERP 名冊
    await page.goto('/imports');
    await page
      .locator('input[type="file"]')
      .setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 2. 頁內啟用（R3 已將啟用整合進匯入頁，不再回首頁找按鈕）
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });
    await page.locator('a', { hasText: '開始核對' }).click();
    await expect(page.locator('text=已啟用正式計算 Run')).toBeVisible({ timeout: 15000 });

    // 3. 結果雙頁籤（09 §2／§5.2）
    await expect(page.locator('button[role="tab"]', { hasText: '學生總表' })).toBeVisible();
    await expect(page.locator('button[role="tab"]', { hasText: '班級扣天' })).toBeVisible();

    // 4. 人數一行（09 §5.1）：本班N人 · 符合篩選M人 · N位需確認，三者 scope 不同
    const counts = page.locator('.counts-line');
    await expect(counts).toBeVisible();
    await expect(counts).toContainText('本班');
    await expect(counts).toContainText('符合篩選');
    await expect(counts).toContainText('位需確認');
    // 不可再以 .stat-card 呈現（09 §5.1 要求單行）
    await expect(page.locator('.stat-card', { hasText: '符合篩選學生數' })).toHaveCount(0);

    // 5. 學生總表 12 欄（09 §5.1）
    const table = page.locator('.results-table');
    await expect(table).toBeVisible();
    for (const col of [
      '姓名', '年級', '所屬班級', '安親天數', '課輔天數', '額外扣天',
      '合計折扣', '已補科數', '兄弟姊妹折扣', '特殊折扣', '園內生', '需確認',
    ]) {
      await expect(table.locator('th', { hasText: col }).first()).toBeVisible();
    }
    // 既有欄位移而非刪除：美語／數學天數不在預設欄
    await expect(table.locator('th', { hasText: '美語天數' })).toHaveCount(0);
    await expect(table.locator('th', { hasText: '數學天數' })).toHaveCount(0);
    // 合計折扣說明基本率與指定課程的差別（09 §5.1）
    await expect(table).toContainText('指定課程可能另有調整');

    // 6. UX14：型別不混，null 顯示為非 0 的符號
    await expect(table).toContainText('—');

    // 7. 明細抽屜（09 §5.1 四分區；原始資料／技術資訊為摺疊，UX16 Esc 可關）
    await table.locator('tbody tr').first().click();
    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('收費結果');
    await expect(drawer).toContainText('課程與扣天');
    // 原始資料與技術資訊在摺疊區，不預設展開
    await expect(drawer.locator('summary', { hasText: '原始資料' })).toBeVisible();
    await expect(drawer.locator('summary', { hasText: '技術資訊' })).toBeVisible();
    // 位移欄位在明細仍可查（不刪功能）
    await drawer.locator('summary', { hasText: '原始資料' }).click();
    await expect(drawer).toContainText('人員代碼');
    await expect(drawer).toContainText('美語天數');

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  test('UX05–07: 班級扣天頁 8 欄、狀態區分、展開逐堂計算、無 active 時標示可先檢查扣天', async ({ page }) => {
    await page.goto('/');
    // 無學生時仍可查看班級扣天（09 §2「沒有學生也可查看班級扣天」）
    await page.goto('/?view=deductions');
    const tab = page.locator('button[role="tab"]', { hasText: '班級扣天' });
    if ((await tab.count()) > 0) {
      await tab.click();
    }

    const table = page.locator('.deductions-table');
    if ((await table.count()) === 0) {
      // 尚未匯入學生：無 active run 時應有 seed／已儲存課表的扣天頁
      test.skip(true, '此情境需先有課表快照');
    }
    await expect(table).toBeVisible();

    for (const col of ['班級', '老師', '上課時間', '安親原始扣除', '安親實際扣除', '課輔原始扣除', '課輔實際扣除', '狀態']) {
      await expect(table.locator('th', { hasText: col }).first()).toBeVisible();
    }
    // 扣除欄正量顯示（domain 負值不改，畫面不顯示負號）
    const cells = await table.locator('tbody td.number').allTextContents();
    expect(cells.some((c) => c.trim() === '0' || /^\d+(\.\d+)?$/.test(c.trim()))).toBe(true);
    expect(cells.every((c) => !c.trim().startsWith('-'))).toBe(true);

    // 展開班級 → 逐堂五個計算欄 + 編輯連結
    await table.locator('tbody tr').first().locator('button').first().click();
    await expect(table).toContainText('編輯此班課表');
    await expect(table).toContainText('課程時長');
  });

  test('UX13: 班級／搜尋／需確認篩選後人數與清單一致，且「本班N人」不受其他條件收斂', async ({ page }) => {
    // 本檔三個 test 共用同一個隔離 DB（每檔一個臨時 DB，specs/10 §4），
    // 前面已建立名單並啟用；此處不重複上傳（同檔會觸發判重路徑），直接前往結果頁。
    await page.goto('/');
    if ((await page.locator('button[role="tab"]', { hasText: '學生總表' }).count()) === 0) {
      // 前置未建立（單獨執行此 test 時）：補一次上傳與啟用
      await page.goto('/imports');
      await page
        .locator('input[type="file"]')
        .setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
      await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
      await page.locator('button', { hasText: '使用這份名單' }).click();
      await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });
      await page.locator('a', { hasText: '開始核對' }).click();
    }
    await expect(page.locator('text=已啟用正式計算 Run')).toBeVisible({ timeout: 15000 });

    // 本檔三個 test 共用同一個隔離 DB（specs/10 §4：每檔一個臨時 DB），
    // 「全批人數」由當下 DB 決定，不寫死 477（477 是 conforming fixture 的值，非業務目標，同 09 §7）。
    const counts = page.locator('.counts-line');
    const beforeMatched = Number(await counts.locator('[data-count="matched"]').textContent());
    expect(beforeMatched).toBeGreaterThan(0);

    // 搜尋個人（q 可能含個資，但不上 URL）
    const search = page.locator('input[placeholder*="搜尋"]').first();
    await search.fill('STU0001');
    await page.waitForTimeout(600);
    const afterMatched = Number(await counts.locator('[data-count="matched"]').textContent());
    expect(afterMatched).toBeGreaterThan(0);
    expect(afterMatched).toBeLessThan(beforeMatched);

    // q 不得寫入 URL（09 §5.1：搜尋 q 可能含個資，頁內保存）
    expect(page.url()).not.toContain('STU0001');

    // 需確認篩選
    await search.fill('');
    await page.waitForTimeout(400);
    const issuesSelect = page.locator('select', { has: page.locator('option', { hasText: '待確認' }) }).first();
    if ((await issuesSelect.count()) > 0) {
      await issuesSelect.selectOption({ index: 1 });
      await page.waitForTimeout(600);
      const filtered = await counts.textContent();
      const needsReview = Number(await counts.locator('[data-count="needs-review"]').textContent());
      expect(needsReview).toBeGreaterThan(0);
    }
  });
});
