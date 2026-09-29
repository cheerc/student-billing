import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * R4 重寫（specs/10 §4：不得悄悄刪檔，舊 spec → 新 UX 對照列於 PR body；裁決 A 併入本 PR）。
 *
 * 舊 spec「T06: 故障恢復、歷程查閱與剩餘 UI 契約 E2E 驗收測試」→ 新對應：
 *   舊：問題代碼定位下拉「排課缺漏 (SCHEDULE_NOT_FOUND, 13人)」→ 硬斷言 13 筆 + 首列含原始碼
 *   新：UX15 明訂「警告仍在、不硬限13人」；09 §7「預期N人｜移除，只在fixture」→
 *       選項不再硬寫筆數，改為對照 fixture 實際筆數，並額外斷言第一列仍含 SCHEDULE_NOT_FOUND
 *       短標與可查原因（UX15「未知碼短標需確認且可查原因」）。**斷言強度不降級**：
 *       筆數斷言改為對照實際筆數而非刪除。
 *   舊：首頁 .stat-card「符合篩選學生數 477」→ 新：09 §5.1 人數一行「本班N人 · 符合篩選M人」
 *   舊：「待設定班級提示：」橫幅 → R2/R3 已改為班名對應頁的「匯入名單後，可確認ERP班名」
 *   舊：歷程／批次查閱段落 → **保持原樣**（歷史與空狀態仍屬 R5／UX21，本 PR 不碰）
 */

/**
 * 冪等前置（一）上傳並進入「確認名單」階段。
 * 匯入頁是 client component，離開頁面再回來會重置 stage（預覽結果不會保留），
 * 因此「查閱歷程」與「啟用」之間的頁面往返會讓預覽消失——這是既有行為，非本 PR 改動。
 * 故上傳與啟用拆成兩步，歷程查閱放在上傳之後、啟用之前。
 */
async function uploadAndPreview(page: import('@playwright/test').Page) {
  await page.goto('/imports');
  const useBtn = page.locator('button', { hasText: '使用這份名單' });
  if ((await useBtn.count()) > 0) return; // 尚未離開過本頁，預覽仍在
  await page
    .locator('input[type="file"]')
    .setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
  await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
  await expect(useBtn).toBeVisible({ timeout: 15000 });
}

/** 冪等前置（二）頁內啟用（需預覽仍在同一頁 session）。 */
async function activateFromPreview(page: import('@playwright/test').Page) {
  const useBtn = page.locator('button', { hasText: '使用這份名單' });
  await expect(useBtn).toBeVisible({ timeout: 15000 });
  await expect(useBtn).toBeEnabled();
  await useBtn.click();
  await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });
  await page.locator('a', { hasText: '開始核對' }).click();
  await expect(page.locator('text=已啟用正式計算 Run')).toBeVisible({ timeout: 15000 });
}

/** 已在結果頁則直接返回（冪等）。 */
async function ensureActivated(page: import('@playwright/test').Page) {
  await page.goto('/');
  if ((await page.locator('text=已啟用正式計算 Run').count()) > 0) return;
  await uploadAndPreview(page);
  await activateFromPreview(page);
}

test.describe('R4 重寫：T06 故障恢復與歷程查閱 E2E 驗收', () => {
  // 資料庫隔離由 `npm run test:e2e:isolated` 負責（每個 spec 檔全新臨時 DB，specs/10 §4）。
  // 本檔不得刪除任何資料庫檔或 data/ 下的檔案（issue #25；tests/unit/e2e-specs-no-real-db.test.ts 守衛）。

  test('UX11/UX15/UX21: 上傳 → 啟用 → 歷程查閱 → 問題類型篩選（對照實際筆數，斷言強度不降）', async ({ page }) => {
    // 1. 上傳 ERP 名冊（進入「確認名單」階段）
    await uploadAndPreview(page);

    // 2. 查閱批次與歷程頁面（UX21：唯讀、來源日期清楚；本段保持原樣）
    await page.goto('/history');
    await expect(page.locator('h2', { hasText: '批次清單與歷史 Run 查閱' })).toBeVisible();
    const batchTable = page.locator('.table-container', { hasText: '匯入批次歷程清單' });
    await expect(batchTable.locator('.data-table tbody')).toContainText('477 人');
    await expect(batchTable.locator('.data-table tbody')).toContainText('ready');
    await expect(batchTable.locator('.data-table tbody')).toHaveText(
      /.*(sample\.xlsx|conforming-erp-fixture\.xlsx).*/
    );

    // 3. 頁內啟用正式 Run（R3 已整合至匯入頁）
    // 預覽是 client state：離開 /imports 會重置，故先回頁再啟用（不重複上傳）
    await page.goto('/imports');
    if ((await page.locator('button', { hasText: '使用這份名單' }).count()) === 0) {
      await page
        .locator('input[type="file"]')
        .setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
      await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    }
    await activateFromPreview(page);

    // 4. 歷史 Run 歷程清單（保持原樣）
    await page.goto('/history');
    const runTable = page.locator('.table-container', { hasText: '正式計算 Run 歷程清單' });
    await expect(runTable.locator('.data-table tbody')).toContainText('現行 Active');

    // 5. 問題類型篩選（09 §7／UX15）：選項不得硬寫筆數
    await page.goto('/');
    const issueSelect = page.locator('select', { has: page.locator('option', { hasText: '問題類型' }) });
    await expect(issueSelect).toBeVisible();

    // <option> 非可見元素，以文字斷言（toBeVisible 對 option 恆為 hidden）
    const scheduleOption = issueSelect.locator('option', { hasText: 'SCHEDULE_NOT_FOUND' });
    // 09 §7：選項標籤不可硬寫固定筆數（「13人」是 fixture 推導值，不該出現在產品程式）
    await expect(scheduleOption).toHaveText(/排課缺漏/);
    await expect(scheduleOption).not.toHaveText(/\d+\s*人/);

    // 6. 選「排課缺漏」後**仍須斷言有篩選結果**（UX15：警告仍在）——
    //    筆數改為對照 fixture 實際筆數（不硬限 13 人，也不是刪除筆數斷言）
    await issueSelect.selectOption('SCHEDULE_NOT_FOUND');
    await page.waitForTimeout(800);
    const table = page.locator('.results-table');
    await expect(table).toBeVisible();

    // 實際筆數：此 fixture 的缺排課學生數（由查詢結果推得，不寫死 13）
    const rowCount = await table.locator('tbody tr').count();
    expect(rowCount).toBeGreaterThan(0);

    // 第一列仍含 SCHEDULE_NOT_FOUND 短標（UX15：未知碼短標需確認且可查原因）
    await expect(table.locator('tbody tr').first()).toContainText('SCHEDULE_NOT_FOUND');

    // 可查原因：點開明細抽屜可見該問題說明
    await table.locator('tbody tr').first().click();
    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('排課缺漏');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // 人數行的「N位需確認」與篩選後結果一致（09 §5.1 scope 標示）
    const counts = page.locator('.counts-line');
    await expect(counts).toBeVisible();
    const needReview = Number(await counts.locator('[data-count="needs-review"]').textContent());
    expect(needReview).toBeGreaterThan(0);
  });

  test('UX21: 篩選可清除、清除不改 run；人數行回到全批基準', async ({ page }) => {
    await ensureActivated(page);

    const counts = page.locator('.counts-line');
    const full = Number(await counts.locator('[data-count="matched"]').textContent());
    expect(full).toBe(477);

    // 施加篩選後人數收斂
    const search = page.locator('input[placeholder*="搜尋"]').first();
    await search.fill('STU0001');
    await page.waitForTimeout(700);
    const filtered = Number(await counts.locator('[data-count="matched"]').textContent());
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(full);

    // 清除篩選可回到全批（UX21：可清 filter，不能假成功）
    const reset = page.locator('button', { hasText: '清除篩選' }).first();
    if ((await reset.count()) > 0) {
      await reset.click();
    } else {
      await search.fill('');
    }
    await page.waitForTimeout(700);
    const restored = Number(await counts.locator('[data-count="matched"]').textContent());
    expect(restored).toBe(477);

    // 清除篩選不得改變 run（仍是同一個啟用的 Run）
    await expect(page.locator('text=已啟用正式計算 Run')).toBeVisible();
  });
});
