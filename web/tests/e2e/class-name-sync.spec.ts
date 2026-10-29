import { test, expect } from '@playwright/test';
import { FIXTURE } from './helpers/c-batch';

/**
 * D62 Phase 2: 班名同步頁籤 UI (ClassNameSyncPanel) E2E 驗收
 *
 * 驗收範圍：
 *  1. 舊連結 /settings?tab=mapping 相容導向班名同步頁籤
 *  2. 同步既有班級流程（整班改名、ImpactDialog 呈現、儲存後退出差異表）
 *  3. 新增為不排課班級（交通車、退出差異表）
 *  4. 未處理列保留（不提供略過/批次，其餘列持續保留）
 */

test.describe('班名同步（D62 Phase 2）', () => {
  test('舊連結 /settings?tab=mapping 相容開到班名同步頁籤', async ({ page }) => {
    await page.goto('/settings?tab=mapping');
    await expect(page.locator('button[role="tab"]', { hasText: '班名同步' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.locator('[data-class-name-sync-panel]')).toBeVisible();
  });

  test('名單匯入後，於班名同步頁籤同步班級與新增不排課班級，未處理列持續保留', async ({ page }) => {
    // 1. 上傳名單並啟用
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible();
    await useBtn.click();
    await expect(page.locator('text=已更新')).toBeVisible({ timeout: 20000 });

    // 2. 前往課表設定的「班名同步」頁籤
    await page.goto('/settings?tab=sync');
    const panel = page.locator('[data-class-name-sync-panel]');
    await expect(panel).toBeVisible();

    // 驗證摘要資訊
    await expect(panel).toContainText('不一致');

    // 3. 測試未處理列保留與無批次按鈕（Q1 裁決守門）
    await expect(page.locator('button', { hasText: '全部同步' })).toHaveCount(0);
    await expect(page.locator('button', { hasText: '一鍵同步' })).toHaveCount(0);
    await expect(page.locator('button', { hasText: '略過' })).toHaveCount(0);
    await expect(page.locator('button', { hasText: '隱藏' })).toHaveCount(0);

    // 4. 同步「國小數學-一」至「國小數學-一A」
    const mathRow = page.locator('tr[data-mismatch-row="國小數學-一"]');
    await expect(mathRow).toBeVisible();
    await mathRow.locator('button', { hasText: '同步到既有班級' }).click();

    // 展開後選取目標
    const select = mathRow.locator('select[aria-label="選擇同步目標課表班級"]');
    await expect(select).toBeVisible();
    await select.selectOption({ label: /國小數學-一A/ });
    await mathRow.locator('button', { hasText: '暫存同步' }).click();

    await expect(mathRow).toContainText('已暫存：國小數學-一A → 國小數學-一（未儲存）');

    // 5. 新增「交通車」為「不排課」班級
    const busRow = page.locator('tr[data-mismatch-row="交通車"]');
    await expect(busRow).toBeVisible();
    await busRow.locator('button', { hasText: '新增為課表班級' }).click();

    // 選擇不排課
    await busRow.locator('label', { hasText: '不排課' }).click();
    await busRow.locator('button', { hasText: '暫存新增' }).click();

    await expect(busRow).toContainText('已暫存新增課表班級（未儲存）');

    // 6. 點擊「確認變更」並在 ImpactDialog 驗證「班名同步與新增變更」
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-sync-impact-summary]')).toBeVisible();
    await expect(dialog.locator('[data-sync-impact-summary]')).toContainText('國小數學-一A');
    await expect(dialog.locator('[data-sync-impact-summary]')).toContainText('交通車');

    // 7. 儲存變更
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
    await expect(dialog).toBeHidden({ timeout: 15000 });

    // 8. 儲存後就地刷新：已處理列退出差異表，未處理列（如美語等班）依然保留
    await expect(page.locator('tr[data-mismatch-row="國小數學-一"]')).toHaveCount(0);
    await expect(page.locator('tr[data-mismatch-row="交通車"]')).toHaveCount(0);
    await expect(page.locator('tr[data-mismatch-row="美語等班"]')).toBeVisible();
  });
});
