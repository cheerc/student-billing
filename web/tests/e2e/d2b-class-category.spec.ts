import { test, expect, type Page } from '@playwright/test';

/**
 * D2b 畫面行為（06 D37 1a、Q11 升級、Q9 合併阻擋、Q13 alias 提示、Q14 subject 隱藏）：
 *  - 課表每列顯示自動偵測的類別與固定 5 天旗標；來源標示「自動」／「手動」；
 *  - 手動選類別後來源變手動，「恢復自動」後回到自動偵測值；
 *  - 手動後改班名不再重新偵測；
 *  - 只改類別（不動時段）也會使頁面變 dirty 並產生影響預覽；
 *  - 升級確認：未勾選不帶目標版本；勾選後 preview 記錄 v3 目標版本並產生新 run，舊結果不動；
 *  - 同名合併且設定不同 → 阻擋儲存並說明。
 *
 * 只用合成資料（seed 課表 49 班），不讀 data/。
 */
/**
 * 一次把所有**同時可見**的「from」列改名為「to」。
 * ScheduleGrid 有搜尋／星期篩選，Playwright 的 `fill()` 會捲動到元素，
 * 逐格 fill 會讓「同一班的另一列」被篩選掉（捲動或 focus 觸發重算）→ 系統判為拆班。
 * 以「批次輸入」一次取代全部符合的列，才符合真實使用者的操作。
 */
/**
 * 整班改名：seed 每班有 2 列時段，**兩列都要**改成同一個新名才是「整班改名」；
 * 只改一列會被系統判為拆班（D28 既有語意）。
 *
 * 逐格 Playwright `fill()` 會各自捲動，捲動觸發重算後同一班的另一列可能先被搜尋／星期篩選掉，
 * 結果只改到一列。因此一次批次派發 input 事件（不捲動、不逐格等待），
 * React 的 onChange 仍會兩列都進到 setRows。
 */
async function renameWholeClass(page: Page, from: string, to: string) {
  await page
    .locator('input.input-classname')
    .evaluateAll((inputs, args) => {
      const [from, to] = args as [string, string];
      // React 受控 input 不吃直接賦 value，必須走原生 setter 再派發 input 事件
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      for (const el of inputs) {
        if ((el as HTMLInputElement).value !== from) continue;
        setter?.call(el, to);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, [from, to]);
}

test.describe('D2b：班級類別與固定 5 天設定 UI、升級確認', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
  });

  test('D2b-2: 自動偵測的類別與固定 5 天旗標逐班顯示，來源標「自動」', async ({ page }) => {
    const panel = page.locator('[data-class-attributes-panel]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('折扣類別與固定 5 天');

    // 國小數學-四A 自動偵測為數學班
    const row = page.locator('[data-class-attribute-row="國小數學-四A"]');
    await expect(row).toBeVisible();
    await expect(row.locator('[data-category-select="國小數學-四A"]')).toHaveValue('math');
    await expect(row.locator('[data-category-source="國小數學-四A"]')).toHaveText('自動');
    await expect(row.locator('[data-fixed-source="國小數學-四A"]')).toHaveText('自動');

    // 國小輔導-四年級 → 安親課輔班
    await expect(page.locator('[data-category-select="國小輔導-四年級"]')).toHaveValue('care');

    // 固定 5 天：seed 中沒有寫功課班，改以「兒童美語-Gino」（自動偵測非固定）確認旗標未誤開
    await expect(page.locator('[data-fixed-five-toggle="兒童美語-Gino"]')).not.toBeChecked();
  });

  test('D2b-2: 手動選類別 → 來源變「手動」；恢復自動 → 回到自動偵測值', async ({ page }) => {
    const row = page.locator('[data-class-attribute-row="國小數學-四A"]');
    await row.locator('[data-category-select="國小數學-四A"]').selectOption('none');
    await expect(row.locator('[data-category-source="國小數學-四A"]')).toHaveText('手動');

    // 「恢復自動」後回到自動偵測（數學班）
    await row.locator('[data-restore-auto="國小數學-四A"]').click();
    await expect(row.locator('[data-category-select="國小數學-四A"]')).toHaveValue('math');
    await expect(row.locator('[data-category-source="國小數學-四A"]')).toHaveText('自動');
  });

  test('D2b-2: 固定 5 天可手動開啟並恢復自動', async ({ page }) => {
    const row = page.locator('[data-class-attribute-row="兒童美語-Gino"]');
    await row.locator('[data-fixed-five-toggle="兒童美語-Gino"]').check();
    await expect(row.locator('[data-fixed-source="兒童美語-Gino"]')).toHaveText('手動');
    await row.locator('[data-restore-auto="兒童美語-Gino"]').click();
    await expect(row.locator('[data-fixed-five-toggle="兒童美語-Gino"]')).not.toBeChecked();
    await expect(row.locator('[data-fixed-source="兒童美語-Gino"]')).toHaveText('自動');
  });

  test('D2b-2: 手動後改班名不再重新偵測（未手動者會跟著新名重偵測）', async ({ page }) => {
    // 先手動把「國小數學-四A」設為不列入折扣
    const row = page.locator('[data-class-attribute-row="國小數學-四A"]');
    await row.locator('[data-category-select="國小數學-四A"]').selectOption('care');
    await expect(row.locator('[data-category-source="國小數學-四A"]')).toHaveText('手動');

    // 整班改名為「國小數學-四A改名」
    await renameWholeClass(page, '國小數學-四A', '國小數學-四A改名');

    // 手動值帶著走：新名自動偵測本來是 math，但因為是 manual，仍顯示 care
    const renamed = page.locator('[data-class-attribute-row="國小數學-四A改名"]');
    await expect(renamed.locator('[data-category-select="國小數學-四A改名"]')).toHaveValue('care');
    await expect(renamed.locator('[data-category-source="國小數學-四A改名"]')).toHaveText('手動');

    // 未手動的「國小數學-四B」改名後依新名重新偵測（仍是數學班，來源仍自動）
    await renameWholeClass(page, '國小數學-四B', '國小數學-四B改名');
    const bRow = page.locator('[data-class-attribute-row="國小數學-四B改名"]');
    await expect(bRow.locator('[data-category-select="國小數學-四B改名"]')).toHaveValue('math');
    await expect(bRow.locator('[data-category-source="國小數學-四B改名"]')).toHaveText('自動');
  });

  test('D2b-6: 只改類別（不動時段）也會變更狀態為 dirty', async ({ page }) => {
    await expect(page.locator('.save-status-clean')).toBeVisible();
    const row = page.locator('[data-class-attribute-row="國小數學-四A"]');
    await row.locator('[data-category-select="國小數學-四A"]').selectOption('none');
    await expect(page.locator('.save-status-dirty')).toBeVisible();
  });

  test('D2b-6: 取消修改會把類別還原（回到未儲存狀態）', async ({ page }) => {
    const row = page.locator('[data-class-attribute-row="國小數學-四A"]');
    await row.locator('[data-category-select="國小數學-四A"]').selectOption('none');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await page.locator('button', { hasText: '取消修改' }).click();
    await expect(page.locator('.save-status-clean')).toBeVisible();
    await expect(page.locator('[data-category-select="國小數學-四A"]')).toHaveValue('math');
    await expect(page.locator('[data-category-source="國小數學-四A"]')).toHaveText('自動');
  });

  test('D2b-6: 類別變更進影響預覽（科數／折扣差異）並可儲存', async ({ page }) => {
    const row = page.locator('[data-class-attribute-row="國小數學-四A"]');
    await row.locator('[data-category-select="國小數學-四A"]').selectOption('none');
    await page.locator('button', { hasText: '確認變更' }).click();

    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    // settings_only（尚未匯入學生）：顯示「尚未匯入學生」而非 0 人
    await expect(dialog).toContainText('尚未匯入學生');

    await dialog.locator('button', { hasText: '儲存課表' }).click();
    await expect(page.locator('#toast')).toContainText('課表已成功儲存', { timeout: 15000 });
  });

  test('D2b-4（Q11）: 空 DB 不顯示升級動作（該 run 建立時即為目標版本）', async ({ page }) => {
    // 尚未啟用任何 run → 無升級動作
    await expect(page.locator('[data-upgrade-banner]')).toHaveCount(0);
  });

  test('D2b-5（Q9）: 同名合併且設定不同時阻擋儲存並說明', async ({ page }) => {
    // 把「國小數學-四A」手動設為不列入折扣，再把兩班所有列都改名成同一個新名 → 合併衝突
    await page.locator('[data-category-select="國小數學-四A"]').selectOption('none');
    await expect(page.locator('[data-category-source="國小數學-四A"]')).toHaveText('手動');

    // 兩班的所有時段列都改名成同一個新名 → 同名合併
    await renameWholeClass(page, '國小數學-四A', '國小數學-四');
    await renameWholeClass(page, '國小數學-四B', '國小數學-四');

    const alert = page.locator('[data-merge-conflict]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('無法儲存');
    await expect(alert).toContainText('國小數學-四');

    // 「確認變更」被阻擋
    await expect(page.locator('button', { hasText: '確認變更' })).toBeDisabled();
  });
});
