import { test, expect } from '@playwright/test';
import { exportBuffer, importBuffer, readScheduleRows } from './helpers/schedule-excel';
import {
  ensureClassTypeTab,
  multiDiscountGroup,
  selectClassTypeTab,
  setMultiDiscount,
  type ClassTypeTab,
} from './helpers/d2c-settings';
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
 * **D61 之後沒有「類別下拉」**：既有班級的類別由「是否有多科折扣」單選投影
 * （`deriveEffectiveCategory`），其他班/不排課頁籤甚至沒有那個欄位。
 * 因此本檔用「四A 多科折扣＝否」表達 category none，並以 `input[value="false"]` 被勾選驗證。
 */

/**
 * 匯出檔的資料列數。**匯出實作**走的是 `classesToGridRows(initialDraft.classes)`
 * （`settings-editor.tsx:247`），這裡的 `classesToGridRows(gridRowsToClasses(buildSeedGridRows()))`
 * 只是對本 fixture 得到同一個數字的算法，不是匯出的那條路徑——實測兩者皆 89。
 * `buildSeedDraft()` 內部也呼叫 `buildSeedGridRows()`（`settings-repository.ts:266`），
 * 所以兩條路徑同源；若哪天有人改動其中一邊，這段註解就過期了，要重跑 #81-3。
 *
 * 本 tree 實測 `buildSeedGridRows()` 89、`gridRowsToClasses()` 49、`classesToGridRows(...)` 89
 * —— 來回轉換不改變列數（含「國小數學-一B」的 2 列空時段，轉換後仍是 2 列）。
 * 這個函式只給「匯出檔應該有幾列」用，不要拿它當畫面的列數（見下）。
 */
function appRowCount(): number {
  const seed = buildSeedGridRows();
  const flat = classesToGridRows(gridRowsToClasses(seed));
  return flat.length > 0 ? flat.length : seed.length;
}

/**
 * seed fixture 的定義列數（`buildSeedGridRows()` 的平鋪時段數）—— 這是**輸入 fixture**
 * 的定義，不是被測函式的輸出，所以可作為「畫面逐頁籤加總」比對的另一端
 * （R-192-2）。seed 改了就跟著改，這是預期行為。
 */
function seedScheduleRowCount(): number {
  return buildSeedGridRows().length;
}

/**
 * 畫面五個頁籤的時段列數加總。
 *
 * 與 `appRowCount()`（匯出檔列數）不可互相比較：安親頁籤的列數是 `displayedTabRows` 的結果
 * （`schedule-grid.tsx` 對 care／unscheduled 每班去重 1 列），匯出檔的列數則是
 * `classesToGridRows(initialDraft.classes)`（`settings-editor.tsx:247`：`buildSeedDraft()` 的
 * 49 個班展開成 89 列）。兩者**來源不同**（draft classes vs seed fixture），只是本 tree 同值：
 * 實測 `classesToGridRows(buildSeedDraft().classes)` = 89、`buildSeedGridRows()` = 89
 * （`buildSeedDraft` 內部也用 `buildSeedGridRows()`，`settings-repository.ts:266`）。
 */
const SCHEDULABLE_TABS: ClassTypeTab[] = ['english', 'math', 'other', 'unscheduled'];

async function displayedScheduleRowCount(page: import('@playwright/test').Page): Promise<number> {
  let total = 0;
  await selectClassTypeTab(page, 'care');
  total += await page.locator('tr.schedule-row').count();
  for (const tab of SCHEDULABLE_TABS) {
    await selectClassTypeTab(page, tab);
    total += await page.locator('tr.schedule-row').count();
  }
  return total;
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
    // 先改一筆：把「國小數學-四A」設成多科折扣＝否（D61：category none 的 UI 表達）
    await setMultiDiscount(page, '國小數學-四A', false);

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

    // 匯入後使用者的指定仍在（匯入是明確指定，不被任何自動判定改回去）
    await ensureClassTypeTab(page, '國小數學-四A');
    await expect(multiDiscountGroup(page, '國小數學-四A').locator('input[value="false"]')).toBeChecked();
    // #157 Ruling 4：沒有「恢復自動」按鈕
    await expect(page.locator('[data-restore-auto]')).toHaveCount(0);

    // 表格仍有原本的全部時段（整批取代不是清空）；逐頁籤加總驗證全量筆數（Reviewer 1 要求，D61 五頁籤）
    // 右側是 seed fixture 的定義列數（R-192-2），不是被測函式的輸出。
    expect(await displayedScheduleRowCount(page)).toBe(seedScheduleRowCount());
  });

  test('#81-3: 匯出 → 匯入 → 匯出，兩次匯出檔的**資料內容**一致（值層級冪等）', async ({ page }) => {
    // 不比對 zip 位元組：ExcelJS 寫入 zip 會帶檔案時間戳，位元組相同過於嚴格。
    // 這裡比的是「資料」——把兩份檔案的資料列讀出來逐格對照。
    const first = await exportBuffer(page);

    await importBuffer(page, first);

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
