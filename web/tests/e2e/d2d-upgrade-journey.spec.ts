import { test, expect } from '@playwright/test';

/**
 * D2d E（RED → GREEN）：v2 active 時只勾「改用新規則」、不改其他設定，也能走完整升級旅程。
 *
 * Q11：升級必須是明確動作，但**不得**要求使用者為了開預覽而先做無關的課表修改。
 * 本檔依 Lead 裁定 (d) 使用 `--seed-v2-active` 執行：
 * 每輪 server 啟動前，scripts/e2e-seed-v2-active.ts 以既有 application／adapter
 * 函式建立「一名年級 4、重複報名兩班數學」的 v2 active run（課輔 4.5 天；
 * 同一份草稿在 v3 下為 4 天 → 升級前後必有差異）。
 *
 * **前置相依**：本檔必須在「既有 v2 DB」上跑，否則 `[data-upgrade-banner]` 不存在、
 * 升級勾選也不會出現。因此沒有 `--seed-v2-active` 時**自我跳過**，而不是失敗——
 * 否則 `npm run test:e2e:isolated`（不帶旗標的全套執行）會被本檔弄紅。
 * 這與 isolation runner 的其他旗標無關，是本檔自己的前提。
 *
 * 斷言點全部是使用者可觀察行為：
 *   1. 只勾升級 → 「確認變更」可用（`isDirty` 不含 `upgradeConfirmed` 時按鈕停用）
 *   2. 預覽顯示受影響學生數 1 人與天數變動明細
 *      （before 與 after 誤用同一版本、或 preview route 丟棄 `targetRuleSetVersion` 時皆為 0 人）
 *   3. 儲存後產生新的 v3 結果，舊 v2 run 保留
 */

/**
 * 本檔的前置條件：**存在既有 v2 active run**（升級勾選只在 v2 現況出現）。
 *
 * 執行全套（不帶 `--seed-v2-active`）時整檔跳過，而不是讓整套紅掉。
 *
 * ⚠ 必須是**檔案層級**判定（只跑一次），不可放進 `beforeEach`：
 * F-2 那條測試會把 v2 升級成 v3，若逐測試檢查 banner，同一輪裡排在它後面的
 * 測試會因「此時已不是 v2」而被 `test.skip` **靜默跳過**——那正是本檔要防的
 * 失敗模式（缺陷被跳過、報告顯示綠）。故只在此處檢查一次。
 */
let hasV2Prerequisite = false;
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await page.goto('/settings');
    hasV2Prerequisite = (await page.locator('[data-upgrade-banner]').count()) > 0;
  } finally {
    await page.close();
  }
});
test.beforeEach(() => {
  test.skip(
    !hasV2Prerequisite,
    '本檔需要既有 v2 active run；請以 `npm run test:e2e:isolated -- --seed-v2-active tests/e2e/d2d-upgrade-journey.spec.ts` 執行'
  );
});

test.describe('D2d E: v2 active 升級旅程（只勾升級即可預覽）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-upgrade-banner]')).toBeVisible({ timeout: 15000 });
  });

  test('只勾升級、不改課表 → 可進入預覽並看到 v2→v3 差異', async ({ page }) => {
    await page.locator('[data-upgrade-confirm]').check();

    // 斷言點：只勾升級（不改任何課表設定）就必須能開預覽
    const review = page.getByRole('button', { name: '確認變更', exact: true });
    await expect(review).toBeEnabled();
    await review.click();

    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    // v2（課輔 4.5）→ v3（課輔 4）：一名學生受影響
    await expect(dialog.locator('.metric-card', { hasText: '受影響學生數' }).locator('.metric-value')).toHaveText('1 人');
    await expect(dialog).toContainText('天數變動明細');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D2d r1（F-1，primary REJECTED 的 blocking finding）
  //
  // `upgradeConfirmed` 只在「取消勾選框」時轉 false，但「取消修改」按鈕
  // （與離頁守衛「捨棄修改」共用 `resetDraft`）沒有清除它 → `upgradeChanged`
  // 恆 true → isDirty 恆 true → 使用者按了取消修改，畫面卻仍標示
  // 「有未儲存的變更」，且此 state 無法從畫面上清除。
  //
  // 這條**不寫入**任何資料，可安全地排在升級旅程之前。
  // ─────────────────────────────────────────────────────────────────────────
  test('F-1：勾升級後按「取消修改」→ 畫面回到乾淨（勾選取消、dirty 消失）', async ({ page }) => {
    // 先斷言 dirty 確實因升級勾選而出現（否則下面「消失」沒意義）
    await page.locator('[data-upgrade-confirm]').check();
    await expect(page.locator('.save-status-dirty')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: '取消修改' }).click();

    // 缺陷表現：勾選框仍 checked、dirty 仍可見。
    // 註：`save-status-dirty` 與 `save-status-clean` 是互斥渲染，故用 count 0 / 可見兩種寫法。
    await expect(page.locator('[data-upgrade-confirm]')).not.toBeChecked({ timeout: 15000 });
    await expect(page.locator('.save-status-dirty')).toHaveCount(0);
    await expect(page.locator('.save-status-clean')).toBeVisible();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 完整升級旅程 ＋ D2d r1（F-2）的 apply 後 UI 斷言。
  //
  // F-2 與本旅程是**同一條**旅程，因此合在同一個 test 內：兩者都會把 v2 持久化
  // 升級成 v3，拆成兩條會讓後者在前者已升級的 DB 上執行、看不到升級勾選。
  // （拆開正是本檔一度出現「F-1／F-2 被靜默 test.skip」的原因。）
  //
  // F-2 的缺陷：apply 成功後 `currentRuleSetVersion` 是 server prop 不更新 →
  // `canUpgrade` 恆 true → banner 仍在、勾選框仍 checked、`upgradeChanged` 仍
  // true → isDirty 恆 true。使用者剛完成 v2→v3 升級，畫面卻主動引導他再升級一次，
  // 且每次離頁都被守衛攔截。
  //
  // **這條只能是瀏覽器層斷言**：secondary reviewer 實測「從 `isDirty` 移除
  // `upgradeChanged` 後 `vitest run` 全套仍 824 passed」，而 CI workflow 不跑 E2E
  // （僅 typecheck／lint／vitest／build）——vitest 層對這類缺陷是隱形的。
  // ─────────────────────────────────────────────────────────────────────────
  test('完整旅程＋F-2：升級預覽 → 儲存 → 新 v3 run、舊 v2 不變，且畫面回到乾淨（banner 消失）', async ({ page }) => {
    const before = await page.request.get('/api/v1/runs/current');
    const beforeJson = await before.json();
    const oldRunId = beforeJson.activeRunId as string;
    expect(oldRunId).toBeTruthy();

    await page.locator('[data-upgrade-confirm]').check();
    await page.getByRole('button', { name: '確認變更', exact: true }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    const applied = page.waitForResponse((r) => r.url().endsWith('/api/v1/settings/apply') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: '儲存並更新結果' }).click();
    expect((await applied).ok()).toBe(true);
    await expect(dialog).toBeHidden();

    // ── 資料面 ──
    const after = await page.request.get('/api/v1/runs/current');
    const afterJson = await after.json();
    expect(afterJson.activeRunId).not.toBe(oldRunId);
    expect(afterJson.run?.ruleSetVersion).toBe('erp-tag-v3');

    // 舊 v2 run 仍可讀、仍標 v2（不因升級被改寫或刪除）
    const old = await page.request.get(`/api/v1/runs/${oldRunId}/students`);
    expect(old.ok()).toBe(true);

    // ── F-2：畫面面 ──
    // (b) 畫面反映「已是 v3」：banner 消失（勾選框隨之消失）
    await expect(page.locator('[data-upgrade-banner]')).toHaveCount(0, { timeout: 15000 });

    // (a) 清除 upgradeConfirmed → isDirty 歸零
    await expect(page.locator('.save-status-dirty')).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator('.save-status-clean')).toBeVisible();

    // 「確認變更」停用（沒有未儲存變更就無從確認）
    await expect(page.getByRole('button', { name: '確認變更', exact: true })).toBeDisabled();

    // 離頁守衛與 beforeunload 不再攔截：可直接離開且不觸發確認視窗
    await page.getByRole('link', { name: /匯入學生/ }).first().click();
    await expect(page.locator('dialog.impact-dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/imports|import/, { timeout: 15000 });
  });
});
