import { test, expect } from '@playwright/test';
import { exportBuffer, readScheduleRows } from './helpers/schedule-excel';
import { classesToGridRows, gridRowsToClasses, buildSeedGridRows } from '@/contracts/settings';

/**
 * #81：課表 Excel 全量匯出／匯入（單純一鍵，**不提供任何欄位挑選或勾選對話框**）。
 *
 * 驗收目標（issue #81 Expected Outcome 1–3）：
 *  1. 一鍵匯出完整課表 .xlsx；
 *  2. 一鍵選檔匯入，整批還原班級、時段、折扣類別與固定 5 天；
 *  3. 全程沒有選擇匯出項目的破碎選項。
 *
 * 真實瀏覽器的下載與上傳：用 Playwright 的 `download` 事件取匯出檔，再以
 * `setInputFiles` 把它原樣餵回匯入（真正的 round-trip，不手工重造檔案）。
 *
 * **每列都有可編輯的類別下拉**（#80 併入表格的結果）：同一班的多列各有一顆，值相同。
 * 因此所有「某班的類別」定位都用 `.first()` 收斂到該班第一列 —— 這是刻意的：
 * 同一班多列本來就代表同一個班屬性，改任一列都會改到同一個值。
 */

/**
 * 畫面上的時段列數。
 *
 * **不要寫死 89**：`buildSeedGridRows()` 產 89 列，但課表頁實際載入的是
 * `classesToGridRows(gridRowsToClasses(seed))` = 88 列（國小數學-一B 的 2 列空時段
 * 聚合成 1 個佔位列）。這是實測值（probes），不是推算。
 */
function appRowCount(): number {
  const seed = buildSeedGridRows();
  const flat = classesToGridRows(gridRowsToClasses(seed));
  return flat.length > 0 ? flat.length : seed.length;
}

test.describe('#81：課表 Excel 全量匯出／匯入', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.schedule-table')).toBeVisible();
    await expect(page.locator('[data-schedule-export]')).toBeVisible();
    await expect(page.locator('[data-schedule-import]')).toBeVisible();
  });

  test('#81-1: 工具列只有匯出／匯入兩顆按鈕，沒有任何欄位挑選對話框', async ({ page }) => {
    await expect(page.locator('[data-schedule-export]')).toHaveCount(1);
    await expect(page.locator('[data-schedule-import]')).toHaveCount(1);

    // 點「匯出 Excel」不應彈出任何 modal／dialog（破碎選項的典型形狀）
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-schedule-export]').click();
    const download = await downloadPromise;
    await expect(page.locator('dialog')).toHaveCount(0);
    expect(download.suggestedFilename()).toContain('.xlsx');
  });

  test('#81-2: 匯出檔可被重新匯入且內容一致（真正的 round-trip）', async ({ page }) => {
    // 先改一筆：把「國小數學-四A」手動設成不列入折扣，讓匯出帶著手動值出去
    // （同一班 2 列 → .first()，值是班級層級的，改任一列都一樣）
    await page.locator('[data-category-select="國小數學-四A"]').first().selectOption('none');
    await expect(page.locator('[data-restore-auto="國小數學-四A"]').first()).toBeVisible();

    // 匯出
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-schedule-export]').click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).toBeTruthy();

    // 匯回來（整批取代草稿）
    await page.locator('input[type="file"]').setInputFiles(path!);

    // 匯入完成 → toast 出現、狀態變 dirty
    await expect(page.locator('#toast')).toContainText('已匯入課表', { timeout: 15000 });
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 匯入後手動值仍在（匯入是明確指定，不被自動偵測改回去）
    await expect(page.locator('[data-category-select="國小數學-四A"]').first()).toHaveValue('none');
    await expect(page.locator('[data-restore-auto="國小數學-四A"]').first()).toBeVisible();

    // 表格仍有原本的全部時段（整批取代不是清空）；筆數由 seed 推導，不寫死
    await expect(page.locator('tr.schedule-row')).toHaveCount(appRowCount());
  });

  test('#81-3: 匯出 → 匯入 → 匯出，兩次匯出檔的**資料內容**一致（值層級冪等）', async ({ page }) => {
    // 不比對 zip 位元組：ExcelJS 寫入 zip 會帶檔案時間戳，位元組相同過於嚴格。
    // 這裡比的是「資料」——把兩份檔案的資料列讀出來逐格對照。
    const first = await exportBuffer(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: '課表.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: first,
    });
    await expect(page.locator('#toast')).toContainText('已匯入課表', { timeout: 15000 });

    const second = await exportBuffer(page);

    // 資料列逐格一致（忽略 zip metadata），且不是空資料
    expect((await readScheduleRows(second)).length).toBe(appRowCount());
    expect(await readScheduleRows(second)).toEqual(await readScheduleRows(first));
  });

  test('#81-4: 格式不符的檔案整批拒絕，明說「沒有套用任何資料」，草稿不變', async ({ page }) => {
    const before = await page.locator('tr.schedule-row').count();
    await expect(page.locator('.save-status-clean')).toBeVisible();

    // 上傳一個明顯不是課表的檔案
    await page.locator('input[type="file"]').setInputFiles({
      name: 'not-a-schedule.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('這不是 Excel'),
    });

    await expect(page.locator('[data-schedule-import-error]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-schedule-import-error]')).toContainText('沒有套用任何資料');
    // 草稿完全沒動
    await expect(page.locator('tr.schedule-row')).toHaveCount(before);
    await expect(page.locator('.save-status-clean')).toBeVisible();
  });
});
