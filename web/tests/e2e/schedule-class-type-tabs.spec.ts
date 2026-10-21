import { test, expect } from '@playwright/test';

/**
 * Issue #112 / specs/14 / Issue #155：課表設定雙頁籤 UI 與簡化操作 E2E 驗收
 *
 * 驗收條件涵蓋：
 *  - A1: 新增班級時可選課程類型「非安親課輔班」或「安親課輔班」，選安親時只填班名與老師
 *  - A2: 兩頁籤僅顯示各自適用的欄位，非安親無固定5天，安親無時段與不計扣天
 *  - A3: 預設開啟非安親課輔班；seed 8 個 care 班位於安親頁籤，其餘 41 班位於非安親頁籤
 *  - A4: 專屬欄位不並列
 *  - Issue #155: 徹底移除「轉為安親／非安親課輔班」按鈕與切換對話框，操作回歸單純新增與刪除
 */

test.describe('Issue #112 / #155: 課表設定雙頁籤與簡化操作 E2E 驗收', () => {
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

  test('Issue #155: 兩頁籤均不包含「轉為安親／非安親課輔班」按鈕與切換對話框，回歸單純新增與刪除', async ({ page }) => {
    // 1. [非安親課輔班] 頁籤：不含轉為安親課輔班按鈕
    await expect(page.locator('button[data-switch-type]')).toHaveCount(0);
    await expect(page.locator('button[data-switch-to-care]')).toHaveCount(0);
    await expect(page.locator('button', { hasText: '轉為安親課輔班' })).toHaveCount(0);

    // 2. 切換至 [安親課輔班] 頁籤：不含轉為非安親課輔班按鈕
    await page.locator('#class-type-tab-care').click();
    await expect(page.locator('button[data-switch-type]')).toHaveCount(0);
    await expect(page.locator('button[data-switch-to-non-care]')).toHaveCount(0);
    await expect(page.locator('button', { hasText: '轉為非安親課輔班' })).toHaveCount(0);

    // 3. 全頁不存在切換確認對話框
    await expect(page.locator('dialog.switch-class-type-dialog')).toHaveCount(0);
  });

  test('Issue #155: 新增安親班與刪除班級後存檔，重新整理頁面後設定持久化不回退', async ({ page }) => {
    // 1. 新增安親課輔班
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const addForm = page.locator('form.add-session-panel');
    await addForm.locator('select[aria-label="新增班級課程類型"]').selectOption('care');
    const testCareName = `國小輔導-持久化${Date.now().toString().slice(-4)}`;
    await addForm.locator('input[required]').fill(testCareName);
    await addForm.getByRole('button', { name: '確認新增' }).click();

    // 自動切換到安親頁籤，共有 8 + 1 = 9 班
    await expect(page.locator('#class-type-tab-care')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('table.schedule-table-care tr.schedule-row')).toHaveCount(9);

    // 2. 刪除一個班級（例如國小輔導-六年級）
    const grade6Row = page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator('input[value="國小輔導-六年級"]'),
    });
    await expect(grade6Row).toBeVisible();
    await grade6Row.getByRole('button', { name: '刪除班級 國小輔導-六年級' }).click();
    await expect(page.locator('table.schedule-table-care tr.schedule-row')).toHaveCount(8);

    // 3. 儲存變更
    await page.getByRole('button', { name: '確認變更' }).click();
    const impactDialog = page.locator('dialog.impact-dialog');
    await expect(impactDialog).toBeVisible();
    await impactDialog.locator('button', { hasText: /儲存並更新結果|儲存課表/ }).click();
    await expect(impactDialog).toHaveCount(0);

    // 4. 重新載入頁面驗證持久化
    await page.reload();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });

    // 切到安親頁籤：仍為 8 班，新班在、被刪除的班不在
    await page.locator('#class-type-tab-care').click();
    await expect(page.locator('table.schedule-table-care tr.schedule-row')).toHaveCount(8);
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator(`input[value="${testCareName}"]`),
    })).toBeVisible();
    await expect(page.locator('table.schedule-table-care tr.schedule-row', {
      has: page.locator('input[value="國小輔導-六年級"]'),
    })).toHaveCount(0);
  });
});
