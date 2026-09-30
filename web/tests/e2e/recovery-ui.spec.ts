import { test, expect } from '@playwright/test';
import path from 'path';
import { openFilter, applyFilter } from './helpers/header-filter';

/** conforming-erp-fixture 的值（09 §7：筆數只在測試/fixture，不進產品文案）。 */
const FIXTURE_TOTAL_STUDENTS = 477;
const FIXTURE_SCHEDULE_NOT_FOUND = 13;

/**
 * R4 重寫（specs/10 §4：不得悄悄刪檔，舊 spec → 新 UX 對照列於 PR body；裁決 A 併入本 PR）。
 *
 * 筆數斷言的原則（Lead rework 裁決，09 §7「預期N人｜移除，只在fixture」）：
 *   「避免 fixture 變業務目標」是**產品文案**的限制，不是**測試**的限制。
 *   13／477 是 conforming fixture 的值，寫在測試裡是對的；只是不能出現在產品下拉標籤。
 *
 * 舊 spec「T06: 故障恢復、歷程查閱與剩餘 UI 契約 E2E 驗收測試」→ 新對應（斷言強度不降級）：
 *   舊：選「排課缺漏 (SCHEDULE_NOT_FOUND, 13人)」→ toHaveCount(13) ＋ 首列含 SCHEDULE_NOT_FOUND
 *   新：選項標籤不含筆數（產品端）；選同一問題碼後 toHaveCount(13) ＋ 人數行「符合篩選」= 13
 *       ＋ 每一列都含 SCHEDULE_NOT_FOUND（比舊版更嚴）
 *   舊：抽屜 `來源試算表第` 與 `排課缺漏，採相容 fallback 數值比較` → 新：仍斷言（來源列在「原始資料」摺疊區，先展開）
 *   舊：`重置篩選 ✕` 必須可見並可點 → 新：同（不是「有才點」的條件式）；重置後「共 477 人」
 *   舊：首頁 .stat-card「符合篩選學生數 477」→ 新：09 §5.1 人數一行 data-count="matched"
 *
 * R5 更新（UX21、09 §7／§8.3；Lead 裁決：斷言不得刪，改為驗證動態判斷本身）：
 *   舊：選班級「國小數學-一」→「待設定班級提示：」＋「前往課程設定」連結（靠 active-run-view 12 個硬寫班名才會過）
 *   新：待設定班級改由該 run 課表快照＋班名對應動態判斷，斷言兩種情境——
 *       ① 選一個**不在**課表快照的班級（國小數學-一）→ 提示出現，連結導向課表設定
 *       ② 選一個**在**課表快照的班級（國小數學-三A）→ 提示**不**出現
 *       （班名對應解析後的情境由 tests/integration/unmapped-classes.test.ts 涵蓋）
 *   舊：「已啟用正式計算 Run」→ 新：橫幅「目前使用的資料」（09 §7：Run／rev／長ID 降層）
 *   舊：/history「批次清單與歷史 Run 查閱」、批次表 `ready`、Run 表「現行 Active」
 *   新：/history「匯入紀錄」；狀態改中文「尚未使用」「目前使用」；技術資訊收摺疊區（完整流程見 history.spec.ts）
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
  await expect(page.locator('.data-banner-current', { hasText: '目前使用的資料' })).toBeVisible({ timeout: 15000 });
}

/** 已在結果頁則直接返回（冪等）。 */
async function ensureActivated(page: import('@playwright/test').Page) {
  await page.goto('/');
  if ((await page.locator('.data-banner-current', { hasText: '目前使用的資料' }).count()) > 0) return;
  await uploadAndPreview(page);
  await activateFromPreview(page);
}

test.describe('R4 重寫：T06 故障恢復與歷程查閱 E2E 驗收', () => {
  // 資料庫隔離由 `npm run test:e2e:isolated` 負責（每個 spec 檔全新臨時 DB，specs/10 §4）。
  // 本檔不得刪除任何資料庫檔或 data/ 下的檔案（issue #25；tests/unit/e2e-specs-no-real-db.test.ts 守衛）。

  test('UX11/UX15/UX21: 上傳 → 啟用 → 歷程查閱 → 問題類型篩選（對照實際筆數，斷言強度不降）', async ({ page }) => {
    // 1. 上傳 ERP 名冊（進入「確認名單」階段）
    await uploadAndPreview(page);

    // 2. 查閱匯入紀錄（UX21：唯讀、來源日期清楚）：剛上傳、尚未啟用 → 「尚未使用」
    await page.goto('/history');
    await expect(page.locator('h1')).toHaveText('匯入紀錄');
    const unusedRow = page.locator('tbody tr[data-status="unused"]');
    await expect(unusedRow).toHaveCount(1);
    await expect(unusedRow).toContainText('477 人');
    await expect(unusedRow).toContainText('尚未使用');
    // 檔名：瀏覽器可能以原檔名或 sample.xlsx 呈現
    await expect(unusedRow).toHaveText(/.*(sample\.xlsx|conforming-erp-fixture\.xlsx).*/);
    // 尚未使用者沒有核對結果可看
    await expect(unusedRow.locator('a', { hasText: '查看當時結果' })).toHaveCount(0);

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

    // 4. 啟用後：同一份名單成為「目前使用」，摘要一行說明目前使用的資料
    await page.goto('/history');
    const currentRow = page.locator('tbody tr[data-status="current"]');
    await expect(currentRow).toHaveCount(1);
    await expect(currentRow).toContainText('目前使用');
    await expect(page.locator('.history-current')).toContainText('目前使用的資料：');

    // 5. 問題類型篩選（09 §7／UX15）：表頭篩選「需確認」；選項只顯示中文名稱、不硬寫筆數（產品端），測試可斷言 fixture 的實際值
    await page.goto('/');
    const issuePanel = await openFilter(page, '需確認');
    const scheduleOption = issuePanel.locator('[data-filter-section="issueCode"] [data-filter-option="排課缺漏"]');
    await expect(scheduleOption).toBeVisible();
    await expect(scheduleOption.locator('[data-filter-count]')).toHaveText(String(FIXTURE_SCHEDULE_NOT_FOUND));
    // 選項名稱只有中文（工程代碼不出現在主畫面；代碼移至明細技術資訊）
    await expect(issuePanel.locator('[data-filter-section="issueCode"]')).not.toContainText('SCHEDULE_NOT_FOUND');
    await page.keyboard.press('Escape');

    // 6. 選「排課缺漏」後：筆數 ＝ fixture 值 13（舊版 toHaveCount(13)，斷言強度不降），
    //    並且人數行「符合篩選」、列數、每一列的問題碼三者一致（比舊版更嚴）
    await applyFilter(page, '需確認', { pick: ['排課缺漏'] });
    const counts = page.locator('.counts-line');
    await expect(counts.locator('[data-count="matched"]')).toHaveText(String(FIXTURE_SCHEDULE_NOT_FOUND));

    const table = page.locator('.results-table');
    await expect(table).toBeVisible();
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(FIXTURE_SCHEDULE_NOT_FOUND);
    for (let i = 0; i < FIXTURE_SCHEDULE_NOT_FOUND; i++) {
      // 每一列都是「排課缺漏」（中文名稱；英文代碼不出現在主畫面，D39 (4)）
      await expect(rows.nth(i)).toContainText('排課缺漏');
      await expect(rows.nth(i)).not.toContainText('SCHEDULE_NOT_FOUND', { useInnerText: true });
    }

    // 7. 點擊學生列展開明細抽屜：來源列座標與排課問題說明（舊版斷言，恢復）
    await rows.first().click();
    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('排課缺漏');
    await expect(drawer.locator('text=排課缺漏，暫以相容數值比較，請核對課表設定。').first()).toBeVisible();
    // 抽屜的比對結果與問題類型都是白話中文，不帶英文標籤或代碼（D39）
    await expect(drawer).not.toContainText(/\(Match\)|\(Mismatch\)|fallback|SCHEDULE_NOT_FOUND/, { useInnerText: true });
    // 來源列座標在「原始資料」摺疊區（09 §5.1），展開後可見
    await drawer.locator('summary', { hasText: '原始資料' }).click();
    await expect(drawer.locator('text=來源試算表第')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // 8. 「清除全部」必須存在並可用（舊版「重置篩選 ✕」斷言，不是「有才點」）
    const resetBtn = page.getByRole('button', { name: '清除全部' });
    await expect(resetBtn).toBeVisible();
    await resetBtn.click();

    // 恢復為全體學生：分頁區顯示「共 477 人」，人數行回到全批
    await expect(page.locator('text=共 477 人')).toBeVisible();
    await expect(counts.locator('[data-count="matched"]')).toHaveText(String(FIXTURE_TOTAL_STUDENTS));

    // 9. 待設定班級提示（09 §8.3：動態判斷，不是寫死班名）。兩種情境都要驗：
    const unmappedNotice = page.locator('.notice-warn', { hasText: '待設定班級提示：' });

    //   ① 不在課表快照的班級（fixture 有「國小數學-一」，課表只有一A／一B…）→ 提示出現，且導向課表設定
    await applyFilter(page, '所屬班級', { pick: ['國小數學-一'] });
    await expect(unmappedNotice).toBeVisible();
    await expect(unmappedNotice).toContainText('國小數學-一');
    const goSettings = unmappedNotice.locator('a', { hasText: '前往課表設定' });
    await expect(goSettings).toBeVisible();
    await expect(goSettings).toHaveAttribute('href', '/settings');

    //   ② 在課表快照的班級（課表有「國小數學-三A」）→ 提示不出現
    await applyFilter(page, '所屬班級', { none: true, pick: ['國小數學-三A'] });
    await expect(counts.locator('[data-count="class-scope"]')).not.toHaveText(String(FIXTURE_TOTAL_STUDENTS));
    await expect(unmappedNotice).toHaveCount(0);
  });

  test('UX21: 篩選可清除、清除不改 run；人數行回到全批基準', async ({ page }) => {
    await ensureActivated(page);

    const counts = page.locator('.counts-line');
    const full = Number(await counts.locator('[data-count="matched"]').textContent());
    expect(full).toBe(FIXTURE_TOTAL_STUDENTS);

    // 施加篩選後人數收斂
    const search = page.locator('input[placeholder*="搜尋"]').first();
    await search.fill('STU0001');
    await expect(counts.locator('[data-count="matched"]')).not.toHaveText(String(full));
    const filtered = Number(await counts.locator('[data-count="matched"]').textContent());
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(full);

    // 清除篩選可回到全批（UX21：可清 filter，不能假成功）——「清除全部」必須存在（不是有才點）
    const reset = page.getByRole('button', { name: '清除全部' });
    await expect(reset).toBeVisible();
    await reset.click();
    await expect(counts.locator('[data-count="matched"]')).toHaveText(String(FIXTURE_TOTAL_STUDENTS));
    await expect(search).toHaveValue('');

    // 清除篩選不得改變 run（仍是同一個啟用的 Run）
    await expect(page.locator('.data-banner-current', { hasText: '目前使用的資料' })).toBeVisible();
  });
});
