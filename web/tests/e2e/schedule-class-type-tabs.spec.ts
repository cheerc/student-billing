import { test, expect } from '@playwright/test';

/**
 * Issue #112 / specs/14：課表設定雙頁籤 UI 重構與課程類型切換防呆（PR-1C）
 *
 * 驗收條件涵蓋：
 *  - A1: 新增班級時可選課程類型「非安親課輔班」或「安親課輔班」，選安親時只填班名與老師
 *  - A2: 兩頁籤僅顯示各自適用的欄位，非安親無固定5天，安親無時段與不計扣天
 *  - A3: 預設開啟非安親課輔班；seed 8 個 care 班位於安親頁籤，其餘 41 班位於非安親頁籤
 *  - A4: 專屬欄位不並列
 *  - A9/A10: 既有班級切換課程類型事前確認對話框，時段清空警示與固定5天重置提示，切換後焦點合理跟隨
 */

test.describe('Issue #112 PR-1C: 課表設定雙頁籤與課程類型切換防呆 E2E 驗收', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.schedule-grid-container')).toBeVisible();
  });

  test('A3: 初始狀態預設開啟「非安親課輔班」，8 個 care 班分流至「安親課輔班」', async ({ page }) => {
    const nonCareTab = page.locator('#class-type-tab-non_care');
    const careTab = page.locator('#class-type-tab-care');

    // 1. 預設選中頁籤為 [非安親課輔班]
    await expect(nonCareTab).toHaveAttribute('aria-selected', 'true');
    await expect(careTab).toHaveAttribute('aria-selected', 'false');

    // 2. 標籤數字統計：非安親 41 個班級、安親 8 個班級
    await expect(nonCareTab).toContainText('41');
    await expect(careTab).toContainText('8');

    // 3. 非安親表格內：無任何「國小輔導-*」班級
    const nonCareTable = page.locator('table.schedule-table-non-care');
    await expect(nonCareTable).toBeVisible();
    await expect(nonCareTable.locator('input.input-classname[value^="國小輔導-"]')).toHaveCount(0);

    // 4. 切換至 [安親課輔班] 頁籤
    await careTab.click();
    await expect(careTab).toHaveAttribute('aria-selected', 'true');
    await expect(nonCareTab).toHaveAttribute('aria-selected', 'false');

    const careTable = page.locator('table.schedule-table-care');
    await expect(careTable).toBeVisible();

    // 5. 安親表格內：恰好 8 個班級，且全部為「國小輔導-*」
    const careRows = careTable.locator('tr.schedule-row');
    await expect(careRows).toHaveCount(8);
    for (let i = 0; i < 8; i++) {
      const nameVal = await careRows.nth(i).locator('input.input-classname').inputValue();
      expect(nameVal.startsWith('國小輔導-')).toBe(true);
    }
  });

  test('A2 & A4: 兩頁籤欄位徹底分離，專屬欄位不並列也不保留反灰欄', async ({ page }) => {
    // 1. [非安親課輔班] 頁籤
    const nonCareThead = page.locator('table.schedule-table-non-care thead');
    await expect(nonCareThead).toContainText('班級名稱');
    await expect(nonCareThead).toContainText('列入多科折扣');
    await expect(nonCareThead).toContainText('不計扣天');
    await expect(nonCareThead).toContainText('帶班老師');
    await expect(nonCareThead).toContainText('星期');
    await expect(nonCareThead).toContainText('上課時間');
    await expect(nonCareThead).toContainText('安親窗口');
    await expect(nonCareThead).toContainText('課輔窗口');
    // 嚴格排他：非安親表格無「天數固定 5 天」
    await expect(nonCareThead).not.toContainText('天數固定 5 天');
    await expect(page.locator('table.schedule-table-non-care [data-fixed-five-toggle]')).toHaveCount(0);

    // 2. 切換至 [安親課輔班] 頁籤
    await page.locator('#class-type-tab-care').click();
    const careThead = page.locator('table.schedule-table-care thead');
    await expect(careThead).toContainText('班級名稱');
    await expect(careThead).toContainText('列入多科折扣');
    await expect(careThead).toContainText('天數固定 5 天');
    await expect(careThead).toContainText('帶班老師');
    await expect(careThead).toContainText('狀態');
    await expect(careThead).toContainText('操作');

    // 嚴格排他：安親表格無時段、無不計扣天、無時長窗口
    await expect(careThead).not.toContainText('不計扣天');
    await expect(careThead).not.toContainText('星期');
    await expect(careThead).not.toContainText('上課時間');
    await expect(careThead).not.toContainText('課程時長');
    await expect(careThead).not.toContainText('安親窗口');
    await expect(careThead).not.toContainText('課輔窗口');
    await expect(page.locator('table.schedule-table-care [data-skip-deduction-toggle]')).toHaveCount(0);

    // 狀態為「安親課輔班（不計時段）」短標
    const statusBadges = page.locator('table.schedule-table-care [data-status-label]');
    await expect(statusBadges).toHaveCount(8);
    await expect(statusBadges.first()).toHaveText('安親課輔班（不計時段）');
  });

  test('A1: 新增班級支援選擇課程類型，選安親班時不顯示星期與時間', async ({ page }) => {
    // 展開新增班級表單
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const addForm = page.locator('form.add-session-panel');
    await expect(addForm).toBeVisible();

    const typeSelect = addForm.locator('select[aria-label="新增班級課程類型"]');
    await expect(typeSelect).toBeVisible();
    // 預設跟隨當前開啟之頁籤（非安親）
    await expect(typeSelect).toHaveValue('non_care');
    await expect(addForm.locator('select', { hasText: '週一' })).toBeVisible();
    await expect(addForm.locator('input[type="time"]').first()).toBeVisible();

    // 切換選「安親課輔班」
    await typeSelect.selectOption('care');
    // 星期與時間起迄被隱藏
    await expect(addForm.locator('select', { hasText: '週一' })).toHaveCount(0);
    await expect(addForm.locator('input[type="time"]')).toHaveCount(0);
    await expect(addForm.locator('span.note')).toContainText('安親課輔班不需輸入上課星期與時間。');

    // 填寫班級名稱並確認新增
    const testCareName = `國小輔導-測試新增${Date.now().toString().slice(-4)}`;
    await addForm.locator('input[required]').fill(testCareName);
    await addForm.getByRole('button', { name: '確認新增' }).click();

    // 表單關閉，自動切換至 [安親課輔班] 頁籤，且該班已在列表中
    await expect(addForm).toHaveCount(0);
    await expect(page.locator('#class-type-tab-care')).toHaveAttribute('aria-selected', 'true');
    const newClassRow = page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${testCareName}"]`),
    });
    await expect(newClassRow).toBeVisible();
    await expect(newClassRow.locator('[data-status-label]')).toHaveText('安親課輔班（不計時段）');
  });

  test('A9, A10: 切換課程類型事前確認對話框、時段清空警示、固定5天重置與焦點管理', async ({ page }) => {
    // 1. [非安親課輔班 → 安親課輔班] 切換
    // 找一個有時段的班級（例如兒童美語-Gino）
    const ginoRow = page.locator('table.schedule-table-non-care tr.schedule-row', {
      has: page.locator('input[value="兒童美語-Gino"]'),
    }).first();
    await expect(ginoRow).toBeVisible();

    // 點擊「轉為安親課輔班」
    await ginoRow.locator('button[data-switch-to-care="兒童美語-Gino"]').click();

    // 彈出確認對話框
    const dialog = page.locator('dialog.switch-class-type-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#switch-dialog-title')).toHaveText('切換為安親課輔班');
    // 明確顯示時段清空警示
    await expect(dialog).toContainText('該班時段將被清空，且不再進入衝堂扣天計算。');

    // 點擊「確認切換」
    await dialog.locator('button[data-confirm-switch]').click();
    await expect(dialog).toHaveCount(0);

    // 自動切換到 [安親課輔班] 頁籤，焦點合理跟隨至 active tab
    await expect(page.locator('#class-type-tab-care')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#class-type-tab-care')).toBeFocused();

    // Gino 班級已在安親頁籤，且只有 1 列，狀態為安親課輔班（不計時段）
    const ginoCareRow = page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator('input[value="兒童美語-Gino"]'),
    });
    await expect(ginoCareRow).toHaveCount(1);
    await expect(ginoCareRow.locator('[data-status-label]')).toHaveText('安親課輔班（不計時段）');

    // 2. [安親課輔班 → 非安親課輔班] 切換
    // 先勾選固定 5 天
    await ginoCareRow.locator('[data-fixed-five-toggle="兒童美語-Gino"]').check();
    await expect(ginoCareRow.locator('[data-fixed-five-toggle="兒童美語-Gino"]')).toBeChecked();

    // 點擊「轉為非安親課輔班」
    await ginoCareRow.locator('button[data-switch-to-non-care="兒童美語-Gino"]').click();

    // 彈出確認對話框
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#switch-dialog-title')).toHaveText('切換為非安親課輔班');
    // 明確提示天數固定 5 天將重置為不勾選
    await expect(dialog).toContainText('「天數固定 5 天」將重置為不勾選，改由逐時段設定。');

    // 點擊「確認切換」
    await dialog.locator('button[data-confirm-switch]').click();
    await expect(dialog).toHaveCount(0);

    // 自動切換回 [非安親課輔班] 頁籤，焦點跟隨
    await expect(page.locator('#class-type-tab-non_care')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#class-type-tab-non_care')).toBeFocused();

    // Gino 班級回到非安親頁籤，可輸入時段
    const ginoNonCareRow = page.locator('table.schedule-table-non-care tr.schedule-row', {
      has: page.locator('input[value="兒童美語-Gino"]'),
    });
    await expect(ginoNonCareRow).toBeVisible();
  });

  test('Reviewer 1 驗證點：切換課程類型後存檔，重新整理頁面後設定持久化不回退', async ({ page }) => {
    // 切換至 [安親課輔班]
    await page.locator('#class-type-tab-care').click();

    // 將 seed care 班「國小輔導-六年級」轉為非安親課輔班
    const grade6Row = page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator('input[value="國小輔導-六年級"]'),
    });
    await expect(grade6Row).toBeVisible();
    await grade6Row.locator('button[data-switch-to-non-care="國小輔導-六年級"]').click();

    const dialog = page.locator('dialog.switch-class-type-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('button[data-confirm-switch]').click();
    await expect(dialog).toHaveCount(0);

    // 確認變更按鈕點擊，開啟儲存對話框
    await page.getByRole('button', { name: '確認變更' }).click();
    const impactDialog = page.locator('dialog.impact-dialog');
    await expect(impactDialog).toBeVisible();
    await impactDialog.locator('button', { hasText: /儲存並更新結果|儲存課表/ }).click();
    await expect(impactDialog).toHaveCount(0);

    // 重新載入頁面
    await page.reload();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });

    // 預設非安親頁籤中，國小輔導-六年級 依然在非安親列表內，沒有被靜默還原
    const nonCareRows = page.locator('table.schedule-table-non-care tr.schedule-row', {
      has: page.locator('input[value="國小輔導-六年級"]'),
    });
    await expect(nonCareRows).toBeVisible();

    // 安親頁籤中只剩下 7 班
    await page.locator('#class-type-tab-care').click();
    await expect(page.locator('table.schedule-table-care tr.schedule-row')).toHaveCount(7);
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator('input[value="國小輔導-六年級"]'),
    })).toHaveCount(0);
  });
});
