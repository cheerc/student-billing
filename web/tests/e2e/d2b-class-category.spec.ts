import { test, expect, type Page } from '@playwright/test';
import { activateFixture } from './helpers/c-batch';
import { classRow } from './helpers/d2c-settings';

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

/**
 * 改「某班」第一列的起始時間。
 * 不能用 `tr:has-text(...)` 定位：班名在受控 input 的 value 屬性上，文字比對抓不到；
 * 逐格 `fill()` 也會捲動觸發重算（同 renameWholeClass 的理由）。因此一次批次派發 input 事件。
 */
async function setFirstStartTimeOfClass(page: Page, className: string, value: string) {
  const changed = await page.locator('input.input-time').evaluateAll((inputs, args) => {
    const [className, value] = args as [string, string];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    for (const el of inputs) {
      const row = el.closest('tr');
      const name = row?.querySelector<HTMLInputElement>('input.input-classname')?.value;
      if (name !== className) continue;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }, [className, value]);
  expect(changed, `課表上找不到班「${className}」的起始時間欄位`).toBe(true);
}

/**
 * D2b：課表設定 UI（不要求空 DB 的案例）。
 *
 * D2c N-1：要求空 DB 的三個案例（settings_only 影響預覽、Q11 升級動作、Q9 合併阻擋）
 * 已移至 `d2b-class-category-empty-db.spec.ts`——隔離執行器只保證「每 spec 檔全新 DB」，
 * 與已啟用名單的案例同檔會使 settings_only 永遠觀察不到空 DB 狀態。
 */
test.describe('D2b：班級類別與固定 5 天設定 UI、升級確認', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
  });

  test('D2b-2: 已儲存的類別與固定 5 天旗標逐班顯示，且沒有「恢復自動」按鈕', async ({ page }) => {
    // #80 & specs/14：雙頁籤分離，非安親包含列入多科折扣，安親包含天數固定 5 天
    await expect(page.locator('[data-class-attributes-panel]')).toHaveCount(0);
    const nonCareTable = page.locator('table.schedule-table-non-care');
    await expect(nonCareTable).toContainText('列入多科折扣');
    await expect(nonCareTable).not.toContainText('天數固定 5 天');

    // 國小數學-四A：seed 草稿帶的是**使用者明確指定**的數學班（#157 Ruling 1 起不再依班名推導）
    const row = classRow(page, '國小數學-四A');
    await expect(row).toBeVisible();
    await expect(row.locator('[data-category-select="國小數學-四A"]').first()).toHaveValue('math');
    // #157 Ruling 4：沒有「恢復自動」按鈕（auto 來源與其路徑已拆除）
    await expect(row.locator('[data-restore-auto="國小數學-四A"]')).toHaveCount(0);

    // 切至安親頁籤：包含天數固定 5 天，國小輔導-四年級 → 安親課輔班
    await page.locator('#class-type-tab-care').click();
    const careTable = page.locator('table.schedule-table-care');
    await expect(careTable).toContainText('天數固定 5 天');
    await expect(page.locator('[data-category-select="國小輔導-四年級"]').first()).toHaveValue('care');

    // 固定 5 天：確認旗標未誤開（false）
    await expect(page.locator('[data-fixed-five-toggle="國小輔導-四年級"]').first()).not.toBeChecked();
  });

  test('D2b-2（#157 改寫）: 手動選類別 → 可選回「（未設定）」撤回決定', async ({ page }) => {
    const row = classRow(page, '國小數學-四A');
    await row.locator('[data-category-select="國小數學-四A"]').first().selectOption('none');
    await expect(row.locator('[data-category-select="國小數學-四A"]').first()).toHaveValue('none');

    // 選回「（未設定）」＝撤回決定（取代舊的「恢復自動」）
    await row.locator('[data-category-select="國小數學-四A"]').first().selectOption('unset');
    await expect(row.locator('[data-category-select="國小數學-四A"]').first()).toHaveValue('unset');
  });

  test('D2b-2: 固定 5 天可手動開啟與關閉（安親課輔班專屬）', async ({ page }) => {
    await page.locator('#class-type-tab-care').click();
    const row = classRow(page, '國小輔導-四年級');
    await row.locator('[data-fixed-five-toggle="國小輔導-四年級"]').first().check();
    await expect(row.locator('[data-fixed-five-toggle="國小輔導-四年級"]').first()).toBeChecked();
    await row.locator('[data-fixed-five-toggle="國小輔導-四年級"]').first().uncheck();
    await expect(row.locator('[data-fixed-five-toggle="國小輔導-四年級"]').first()).not.toBeChecked();
  });

  test('D2b-2（#157 改寫）: 手動指定的值隨改名帶走；未指定者改名後仍是未指定', async ({ page }) => {
    // 先手動把「國小數學-四A」設為不列入折扣
    const row = classRow(page, '國小數學-四A');
    await row.locator('[data-category-select="國小數學-四A"]').first().selectOption('care');

    // 整班改名為「國小數學-四A改名」
    await renameWholeClass(page, '國小數學-四A', '國小數學-四A改名');

    // 使用者的指定帶著走：仍是 care
    const renamed = classRow(page, '國小數學-四A改名');
    await expect(renamed.locator('[data-category-select="國小數學-四A改名"]')).toHaveValue('care');

    // #157 Ruling 1：未指定者改名後**不得**依新名重新判定。
    // 先把「國小數學-四B」撤回成未設定，再改名 → 仍是未設定（不是數學班）。
    await classRow(page, '國小數學-四B').locator('[data-category-select="國小數學-四B"]').first().selectOption('unset');
    await renameWholeClass(page, '國小數學-四B', '國小數學-四B改名');
    const bRow = classRow(page, '國小數學-四B改名');
    await expect(bRow.locator('[data-category-select="國小數學-四B改名"]')).toHaveValue('unset');
  });

  test('D2b-6: 只改類別（不動時段）也會變更狀態為 dirty', async ({ page }) => {
    await expect(page.locator('.save-status-clean')).toBeVisible();
    const row = classRow(page, '國小數學-四A');
    await row.locator('[data-category-select="國小數學-四A"]').first().selectOption('none');
    await expect(page.locator('.save-status-dirty')).toBeVisible();
  });

  test('D2b-6: 取消修改會把類別還原（回到未儲存狀態）', async ({ page }) => {
    const row = classRow(page, '國小數學-四A');
    await row.locator('[data-category-select="國小數學-四A"]').first().selectOption('none');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await page.locator('button', { hasText: '取消修改' }).click();
    await expect(page.locator('.save-status-clean')).toBeVisible();
    await expect(page.locator('[data-category-select="國小數學-四A"]').first()).toHaveValue('math');
  });

  test.describe('D2b r2：影響預覽的受影響人數（去重）與別名提示（#157 已廢除）', () => {
    // 這三個案例需要已啟用的名單（候選班名與受影響人數都來自名冊），故不共用外層 beforeEach 的空 DB。
    test.beforeEach(async ({ page }) => {
      await activateFixture(page);
      await page.goto('/settings');
      await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });

      // D2c N-1：同檔案例共用 DB，因此每個案例開始前都必須確認「班名對應」是乾淨的。
      // 若前一案例留下了 alias，這裡就會失敗——這是刻意的：相依性必須被看見，不可被藏起來。
      await page.locator('button', { hasText: '班名對應' }).click();
      await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.pill', { hasText: '已對應' })).toHaveCount(0);
      await page.locator('button', { hasText: '課表' }).click();
      // #80：屬性欄已併入時段表格，改等那張表
      await expect(page.locator('table.schedule-table')).toBeVisible();
    });

    test('R2-1: 只有科數／折扣變化、天數不變時，受影響學生數仍正確（不得為 0）', async ({ page }) => {
      // 「國小輔導-一A」在 seed 無時段且為安親課輔班 → 切換至安親頁籤：手動改類別是純類別變化
      await page.locator('#class-type-tab-care').click();
      await page.locator('[data-category-select="國小輔導-一A"]').first().selectOption('none');
      await expect(page.locator('.save-status-dirty')).toBeVisible();

      await page.locator('button', { hasText: '確認變更' }).click();
      const dialog = page.locator('dialog.impact-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });

      const metric = dialog.locator('.metric-card', { hasText: '受影響學生數' });
      await expect(metric).toBeVisible();
      // 合成名單手算：科數差異 21 人、折扣差異 13 人、天數差異 0 人 → 聯集去重 21 人
      await expect(metric.locator('.metric-value')).toHaveText('21 人');
      // 顯示的已含科數／折扣變化，metric-sub 不得再寫「天數發生變化」
      await expect(metric.locator('.metric-sub')).not.toContainText('天數發生變化');
    });

    test('R2-1: 同一人同時有天數與科數變化時，受影響學生數不得為兩者相加', async ({ page }) => {
      // 同一個班同時改「類別」與「時段」→ 天數與科數差異落在同一批學生身上。
      // 逐格捲動會讓系統誤判拆班，因此一次批次派發。
      await page.locator('[data-category-select="國小數學-三A"]').first().selectOption('none');
      await setFirstStartTimeOfClass(page, '國小數學-三A', '09:45');
      await expect(page.locator('.save-status-dirty')).toBeVisible();


      await page.locator('button', { hasText: '確認變更' }).click();
      const dialog = page.locator('dialog.impact-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });

      // 天數確實有變化（否則本例不構成 R2-1 的 (a) 情境）
      await expect(dialog).toContainText('天數變動明細');
      // 合成名單手算：天數差異 12 人、科數差異 12 人、折扣差異 7 人，三者聯集去重 = 12 人；
      // 相加寫法會得到 12 + max(12, 7) = 24 人。畫面必須是去重後的 12 人。
      await expect(dialog.locator('.metric-card', { hasText: '受影響學生數' }).locator('.metric-value')).toHaveText('12 人');
    });

    test('R2-2（#157 改寫）: 別名不再產生「類別將改由系統班決定」的提示', async ({ page }) => {
      await page.locator('button', { hasText: '班名對應' }).click();
      await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

      // 「國小輔導-四年級A」對應到「國小輔導-一A」
      const row = page.locator('tr', { hasText: '國小輔導-四年級A' });
      await expect(row).toBeVisible();
      await row.locator('input.input-target-classname').fill('國小輔導-一A');
      await row.locator('input[type="checkbox"]').check();
      await expect(row.locator('.pill', { hasText: '已對應' })).toBeVisible();

      await page.locator('button', { hasText: '確認變更' }).click();
      const dialog = page.locator('dialog.impact-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });
      // #157 Ruling 4：跨類別別名提示整組廢除（其內容是兩側的班名自動偵測結果，
      // 而自動偵測已不存在）。別名機制本身不受影響，仍可正常對應與儲存。
      await expect(dialog.locator('[data-alias-category-notice]')).toHaveCount(0);
    });
  });
});
