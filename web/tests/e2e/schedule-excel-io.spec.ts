import { test, expect } from '@playwright/test';
import { exportBuffer, importBuffer, readScheduleRows } from './helpers/schedule-excel';import {
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

/** 匯出檔與畫面共用的原始列數（`buildSeedGridRows()` 的平鋪時段數）。 */
function seedScheduleRowCount(): number {
  return buildSeedGridRows().length;
}

/**
 * 逐頁籤的時段列數。
 *
 * `schedule-excel.ts` 的 `appRowCount()` 是 89 列（`classesToGridRows` 的結果）——那是
 * **匯出檔**的資料列數。畫面上安親頁籤每班只顯示 1 列（`displayedTabRows` 對 care 去重），
 * 所以畫面可見的列數是「排課頁籤全部時段 + 每個安親班 1 列」，兩者不可互相比較。
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
    // 89（合併為 88）是匯出檔的資料列數；安親頁籤畫面每班只列 1 列，因此比的是
    // `buildSeedGridRows()` 的原始列數，不是 `classesToGridRows` 的合併結果。
    expect(await displayedScheduleRowCount(page)).toBe(seedScheduleRowCount());  });

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
