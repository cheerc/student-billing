import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * R5：匯入紀錄（/history）與歷史唯讀檢視 E2E（specs/09 §2／§5.2／§7／§8.3；specs/04 UX21）。
 *
 * 四態：有資料／空篩選（可清除）在此以真瀏覽器驗證；空狀態、loading、失敗以元件層測試驗證
 * （tests/unit/history-ui.test.ts），原因是 E2E 無法在不寫 DB 的前提下造出空 DB 之外的失敗與載入中。
 * 空 DB 的空狀態由本檔第一個 test 涵蓋（每個 spec 檔使用全新臨時 DB）。
 * 每個 spec 檔共用一個隔離 DB，測試依序執行，資料由前一個 test 累積。
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

test.describe('R5 匯入紀錄與歷史唯讀檢視', () => {
  test('UX21 空狀態：全新資料庫沒有任何紀錄 → 說明＋主動作，不顯示空表格', async ({ page }) => {
    await page.goto('/history');

    await expect(page.locator('h1')).toHaveText('匯入紀錄');
    await expect(page.locator('.history-current')).toHaveText('目前尚未使用任何名單。');
    await expect(page.getByText('還沒有匯入紀錄')).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    const action = page.locator('a', { hasText: '匯入學生名單' });
    await expect(action).toBeVisible();
    await action.click();
    await expect(page).toHaveURL(/\/imports$/);
  });

  test('UX21 有資料：上傳但未使用 → 尚未使用；使用後 → 目前使用；日期與人數清楚、技術資訊在摺疊區', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 尚未使用
    await page.goto('/history');
    const unused = page.locator('tbody tr[data-status="unused"]');
    await expect(unused).toHaveCount(1);
    await expect(unused).toContainText('尚未使用');
    await expect(unused).toContainText('477 人');
    await expect(unused.locator('a', { hasText: '查看當時結果' })).toHaveCount(0);

    // 使用這份名單
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('button', { hasText: '使用這份名單' })).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    await page.goto('/history');
    const current = page.locator('tbody tr[data-status="current"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText('目前使用');
    await expect(current).toContainText('477 人');
    // 日期格式固定為 YYYY-MM-DD HH:mm（Asia/Taipei），核對基準日另列
    await expect(current).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    await expect(page.locator('.history-current')).toContainText(/目前使用的資料：.+核對基準日 \d{4}-\d{2}-\d{2}/);

    // 技術資訊預設收合，展開後才看得到長 ID／規則版本／雜湊
    const tech = current.locator('details.tech-info');
    await expect(tech).not.toHaveAttribute('open', '');
    await expect(tech.getByText('erp-tag-v2')).toBeHidden();
    await tech.locator('summary').click();
    await expect(tech.getByText('erp-tag-v2')).toBeVisible();
    await expect(tech).toContainText('檔案雜湊');
  });

  test('UX21 空篩選：篩選到沒有符合 → 明說沒有符合並可清除；不假裝成功', async ({ page }) => {
    await page.goto('/history');
    const rows = page.locator('tbody tr');
    const total = await rows.count();
    expect(total).toBeGreaterThan(0);

    // 檔名關鍵字沒有符合
    await page.getByLabel('檔名').fill('不存在的檔名關鍵字');
    await expect(page.getByText('沒有符合的紀錄')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await expect(page.locator('.history-toolbar [role="status"]')).toHaveText('共 0 筆');

    // 清除篩選 → 回到完整清單，輸入框一併清空
    await page.locator('button', { hasText: '清除篩選' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(total);
    await expect(page.getByLabel('檔名')).toHaveValue('');

    // 狀態篩選：只看「尚未使用」時，目前資料只有「目前使用」與「歷史資料」，可能沒有符合者
    await page.getByLabel('狀態').selectOption('current');
    await expect(page.locator('tbody tr[data-status="current"]')).toHaveCount(1);
    await expect(page.locator('tbody tr[data-status="unused"]')).toHaveCount(0);
    await page.getByLabel('狀態').selectOption('all');
    await expect(page.locator('tbody tr')).toHaveCount(total);
  });

  test('唯讀歷史檢視：查看當時結果 → 標明歷史資料（唯讀），學生總表與班級扣天讀當時快照，沒有任何寫入動作', async ({ page }) => {
    await page.goto('/history');
    const view = page.locator('tbody tr[data-status="current"]').locator('a', { hasText: '查看當時結果' });
    await view.click();

    await expect(page).toHaveURL(/\/history\/[^/]+$/);
    await expect(page.locator('h1')).toHaveText('歷史資料（唯讀）');
    const banner = page.locator('.data-banner-history');
    await expect(banner).toContainText('conforming-erp-fixture.xlsx');
    await expect(banner).toContainText('名單匯入於');
    await expect(banner).toContainText('資料更新於');
    await expect(banner).toContainText('核對基準日');
    await expect(banner).not.toContainText(/Run|rev/);

    // 學生總表：與現行資料同一份 run 結果
    await expect(page.locator('.counts-line [data-count="matched"]')).toHaveText('477');
    await expect(page.locator('.results-table tbody tr').first()).toBeVisible();

    // 班級扣天：讀 run 當時快照（此 run 用 seed 課表，快照存在 → 顯示表格）
    await page.locator('button[role="tab"]', { hasText: '班級扣天' }).click();
    await expect(page.locator('.deductions-table')).toBeVisible();

    // 唯讀：沒有「匯入新名單」「恢復」「還原」「設為現行」等寫入動作，只有離開路徑
    await expect(page.locator('main a, main button', { hasText: /匯入新名單|恢復|還原|設為現行/ })).toHaveCount(0);
    const back = page.locator('a', { hasText: '回到匯入紀錄' }).first();
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/history$/);
  });

  test('找不到這筆歷史紀錄 → 白話說明與離開路徑（不白屏）', async ({ page }) => {
    // 有 loading.tsx 時 Next 先串流外殼（HTTP 200）再於頁內顯示 not-found，所以驗證使用者看到的內容，不驗狀態碼。
    await page.goto('/history/run_does_not_exist');

    await expect(page.locator('h1')).toHaveText('找不到這筆紀錄');
    await expect(page.getByText('這筆匯入紀錄不存在，或已經被移除')).toBeVisible();
    const back = page.locator('main a', { hasText: '回到匯入紀錄' });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/history$/);
  });
});
