import { test, expect, type Page } from '@playwright/test';
import { activateFixture } from './helpers/c-batch';

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
 * 把手動覆寫恢復為自動並儲存，使同檔後續案例與 `--repeat` 的下一輪都從乾淨狀態開始。
 * D2c N-1：隔離執行器只保證「每 spec 檔全新 DB」，同檔內案例共用同一 DB 且跨輪沿用。
 */
async function restoreCategoryToAutoAndSave(page: Page, className: string) {
  const row = page.locator(`[data-class-attribute-row="${className}"]`);
  await expect(row).toBeVisible();
  await row.locator(`[data-restore-auto="${className}"]`).click();
  await expect(row.locator(`[data-category-source="${className}"]`)).toHaveText('自動');
  await page.locator('button', { hasText: '確認變更' }).click();
  const dialog = page.locator('dialog.impact-dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await dialog.locator('button', { hasText: /儲存並更新結果|儲存課表/ }).click();
  await expect(page.locator('#toast')).toContainText('課表已', { timeout: 15000 });
}

/**
 * D2c N-1（D2b r2 secondary finding）：E2E 案例間狀態隔離性。
 *
 * 隔離執行器（`npm run test:e2e:isolated`）保證的是「每個 spec 檔各用全新 DB」，
 * **同一檔內的案例共用同一個 DB**，資料由前一個案例累積。D2b r2 曾因此踩到：
 * 跨類別別名案例儲存的 alias 留在草稿裡，使「非跨類別不產生提示」的案例誤判
 * （當時靠調換執行順序解開，但那只是把相依性藏起來，不是真的隔離）。
 *
 * 本 helper 讓會寫入設定的案例**自我清理**：把該案例建立的 alias 取消勾選後再儲存，
 * 使下一個案例從乾淨狀態開始。斷言寫在 helper 內，任何案例忘記清理都會失敗。
 */
async function removeAlias(page: Page, rawBaseName: string) {
  await page.locator('button', { hasText: '班名對應' }).click();
  await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });
  const row = page.locator('tr', { hasText: rawBaseName });
  await expect(row).toBeVisible();
  const checkbox = row.locator('input[type="checkbox"]');
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(page.locator('.save-status-dirty')).toBeVisible();
  await page.locator('button', { hasText: '確認變更' }).click();
  const dialog = page.locator('dialog.impact-dialog');
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await dialog.locator('button', { hasText: /儲存並更新結果|儲存課表/ }).click();
  await expect(page.locator('#toast')).toContainText('課表已', { timeout: 15000 });
  // 清理完成：回到「待確認」
  await page.locator('button', { hasText: '班名對應' }).click();
  await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });
  await expect(row.locator('.pill', { hasText: '已對應' })).toHaveCount(0);
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

  test.describe('D2b r2：影響預覽的受影響人數（去重）與 Q13 跨類別別名提示', () => {
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
      await expect(page.locator('[data-class-attributes-panel]')).toBeVisible();
    });

    test('R2-1: 只有科數／折扣變化、天數不變時，受影響學生數仍正確（不得為 0）', async ({ page }) => {
      // 「國小輔導-一A」在 seed 無時段 → 手動改類別是**純類別**變化：天數不變，只有科數與折扣變化。
      // 這筆資料下「相加」與「聯集去重」同值（皆 21），因此本例是回歸保護：
      // 確保這條路徑不會因只算天數而顯示 0。能區分兩種算法的斷言在下一個案例。
      await page.locator('[data-category-select="國小輔導-一A"]').selectOption('none');
      await expect(page.locator('[data-category-source="國小輔導-一A"]')).toHaveText('手動');
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
      await page.locator('[data-category-select="國小數學-三A"]').selectOption('none');
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

    test('R2-2: 兩側自動偵測相同的別名不產生提示', async ({ page }) => {
      await page.locator('button', { hasText: '班名對應' }).click();
      await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

      // 「國小輔導-四年級A」自動偵測為安親課輔班（care）→ 對應到同為 care 的班 ＝ 非跨類別
      const row = page.locator('tr', { hasText: '國小輔導-四年級A' });
      await expect(row).toBeVisible();
      await row.locator('input.input-target-classname').fill('國小輔導-一A');
      await row.locator('input[type="checkbox"]').check();
      await expect(row.locator('.pill', { hasText: '已對應' })).toBeVisible();

      await page.locator('button', { hasText: '確認變更' }).click();
      const dialog = page.locator('dialog.impact-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });
      await expect(dialog.locator('[data-alias-category-notice]')).toHaveCount(0);
    });
    test('R2-2: 跨類別別名在影響預覽提示「類別將改由系統班決定」，可展開且不阻擋儲存', async ({ page }) => {
      await page.locator('button', { hasText: '班名對應' }).click();
      await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

      // 「交通車」自動偵測為不列入折扣（none）→ 對應到美語班（english）＝跨類別
      const row = page.locator('tr', { hasText: '交通車' });
      await expect(row).toBeVisible();
      await row.locator('input.input-target-classname').fill('兒童美語-Gino');
      await row.locator('input[type="checkbox"]').check();
      await expect(row.locator('.pill', { hasText: '已對應' })).toBeVisible();
      // 勾選別名本身就是一項草稿變更 → 必須變 dirty，否則「確認變更」會是停用的
      await expect(page.locator('.save-status-dirty')).toBeVisible();
      if (process.env.D2C_PROBE) {
        let reqs = 0;
        page.on('request', (r) => { if (r.url().includes('/calculate')) reqs++; });
        for (let i = 0; i < 8; i++) {
          console.log(
            `PROBE13 t=${i * 500}ms disabled=` +
              (await page.locator('button', { hasText: '確認變更' }).isDisabled()) +
              ` calcReqs=` + reqs
          );
          await page.waitForTimeout(500);
        }
      }

      await page.locator('button', { hasText: '確認變更' }).click();
      const dialog = page.locator('dialog.impact-dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });

      const notice = dialog.locator('[data-alias-category-notice]');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('1 個別名的類別將改由系統班決定');
      await expect(notice).toContainText('交通車');
      await expect(notice).toContainText('兒童美語-Gino');
      // 可展開：預設收合，展開後列出（rawBaseName → targetBaseName）
      await notice.locator('summary').click();
      await expect(notice).toContainText('不列入折扣');
      await expect(notice).toContainText('美語班');

      // 提示不得阻擋儲存（D37：提示非阻擋，與 Q9 同名合併衝突阻擋不同）
      const save = dialog.locator('button', { hasText: '儲存並更新結果' });
      await expect(save).toBeEnabled();
      await save.click();
      await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });

      // D2c N-1：本案例是本檔最後一個會寫入設定的案例 → 清理它建立的 alias，
      // 使同檔後續（若新增）案例從乾淨狀態開始。
      await removeAlias(page, '交通車');
    });

  });
});
