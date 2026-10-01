import { test, expect } from '@playwright/test';

/**
 * D2d r3／F1／F2（04 §8 UX61；Q11）：升級勾選在三條復原路徑都必須清除。
 *
 * ── 缺陷（primary 第 1 輪審出，revert 後在 HEAD 672ca40 重現）────────────
 * `settings-editor.tsx` 的 `resetDraft()`（取消修改與離頁捨棄共用）與 apply 成功後的
 * 版本更新路徑都**沒有**清除 `upgradeConfirmed`，也沒有更新「目前生效的版本」。
 *
 * 1. **F-1 取消修改**：`upgradeConfirmed` 留在 `true` → 畫面仍顯示
 *    「有未儲存的變更 · 請確認變更後儲存」（`isDirty` 含 `upgradeChanged`），
 *    但使用者明明已經取消全部修改，而且**這個 state 無法再從畫面清除**。
 * 2. **F-2 套用成功**：server 已套用 v3，但 client 端 `canUpgrade` 仍看舊的
 *    `currentRuleSetVersion`（v2，server-render prop，session 內不更新）→
 *    `[data-upgrade-banner]` 仍在（錯誤地說「可以升級」）、`isDirty` 仍 true、
 *    「確認變更」仍可點、離頁仍被守衛與 beforeunload 攔截。banner 應消失、狀態列應乾淨。
 *
 * 「捨棄修改」路徑的狀態**不另立測試**，理由見下方 F-1 describe 內的說明。
 *
 * ── 這些是本輪的 tests-only RED ────────────────────────────────────────
 * 上一輪把測試與修正放在同一個 commit（F-3 違反 TDD）。本檔在 `672ca40`
 * （已 append-only 撤回 mixed commit，內容等同 `e2e3547`）上執行**必須失敗**。
 *
 * **前置相依**：同 `d2d-upgrade-journey.spec.ts`，需要既有 v2 active run，
 * 沒有 `--seed-v2-active` 時自我跳過。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/settings');
  const banner = page.locator('[data-upgrade-banner]');
  test.skip(
    (await banner.count()) === 0,
    '本檔需要既有 v2 active run；請以 `npm run test:e2e:isolated -- --seed-v2-active tests/e2e/d2d-upgrade-restore.spec.ts` 執行'
  );
  await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
  await expect(banner).toBeVisible({ timeout: 15000 });
});

test.describe('D2d r3／F1：取消修改必須清除升級勾選', () => {
  // 說明：F-1 缺陷只有 `resetDraft` 一條路徑（「取消修改」按鈕與離頁守衛的「捨棄修改」
  // 都經由 `useUnsavedChangesGuard(dirty, resetDraft)` → `onDiscardRef.current()` 呼叫它），
  // 本檔的「取消修改」一條即涵蓋 `resetDraft` 本身。
  //
  // 「捨棄修改」路徑**無法**用來做 RED／回歸防護：它必須離開 /settings，離開時
  // `settings-editor` 已卸載、`upgradeConfirmed` 的 client state 隨之消失，無論有沒有
  // 修正，回到頁面後勾選都會是 false（實測 `page.goto` 與 `goBack` 皆如此）。
  // 那樣的斷言在缺陷版與修正版上結果相同，屬 characterization 而非 RED，
  // 寫進去只會假裝有防護，所以不寫。

  test('按「取消修改」→ 升級勾選清除、狀態列回到乾淨', async ({ page }) => {
    const checkbox = page.locator('[data-upgrade-confirm]');
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    // 勾選升級本身就是未儲存變更
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await page.getByRole('button', { name: '取消修改' }).click();

    // ★ F-1：取消全部修改後，升級勾選必須一起被清除
    await expect(checkbox, '取消修改後升級勾選必須被清除').not.toBeChecked();
    await expect(page.locator('.save-status-clean'), '取消修改後狀態列應回到乾淨').toBeVisible();
    await expect(page.locator('.save-status-dirty'), '取消修改後不應仍有未儲存變更').toHaveCount(0);
  });

  test('套用失敗 → 升級勾選保留、狀態仍為未儲存、版本仍是 v2', async ({ page }) => {
    const before = await (await page.request.get('/api/v1/runs/current')).json();
    const beforeRunId = before.activeRunId as string;
    expect(beforeRunId).toBeTruthy();

    // 讓 apply 回 500
    await page.route('**/api/v1/settings/apply', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '測試用失敗' }) })
    );

    await page.locator('[data-upgrade-confirm]').check();
    await page.getByRole('button', { name: '確認變更', exact: true }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.locator('button', { hasText: /^儲存/ })).toBeEnabled({ timeout: 15000 });
    await dialog.locator('button', { hasText: /^儲存/ }).click();

    // 失敗必須明確呈現
    await expect(dialog.locator('[data-dialog-error]'), '套用失敗應顯示錯誤').toBeVisible({
      timeout: 15000,
    });

    // ★ 不得冒認成功：升級勾選保留、狀態仍 dirty、active run 未變
    await expect(
      page.locator('[data-upgrade-confirm]'),
      '套用失敗後升級勾選必須保留（使用者意圖未完成）'
    ).toBeChecked();
    await expect(page.locator('[data-upgrade-banner]'), '套用失敗後 banner 應仍在').toBeVisible();
    const after = await (await page.request.get('/api/v1/runs/current')).json();
    expect(after.activeRunId, '套用失敗不得改變 active run').toBe(beforeRunId);
    expect(after.run?.ruleSetVersion, '套用失敗不得冒認 v3').toBe('erp-tag-v2');
  });
});

test.describe('D2d r3／F2：套用成功後升級狀態必須收斂', () => {
  test('升級套用成功 → banner 消失、狀態乾淨、確認變更停用', async ({ page }) => {
    await page.locator('[data-upgrade-confirm]').check();
    await page.getByRole('button', { name: '確認變更', exact: true }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.locator('button', { hasText: /^儲存/ })).toBeEnabled({ timeout: 15000 });

    const applied = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/settings/apply') && r.request().method() === 'POST'
    );
    await dialog.locator('button', { hasText: /^儲存/ }).click();
    expect((await applied).ok()).toBe(true);
    await expect(dialog).toBeHidden();

    // server 端已是 v3
    const after = await (await page.request.get('/api/v1/runs/current')).json();
    expect(after.run?.ruleSetVersion).toBe('erp-tag-v3');

    // ★ F-2：client 端也必須收斂
    await expect(
      page.locator('[data-upgrade-banner]'),
      '套用成功後升級 banner 必須消失（畫面已是 v3）'
    ).toHaveCount(0);
    await expect(page.locator('.save-status-clean'), '套用成功後狀態列應為乾淨').toBeVisible();
    await expect(
      page.getByRole('button', { name: '確認變更', exact: true }),
      '套用成功後「確認變更」應停用（沒有未儲存變更）'
    ).toBeDisabled();

    // ── 同一條旅程的延伸：再次編輯 → 取消 → 重載，狀態必須維持 v3 ──
    // （與上面的套用成功合併成同一條：兩者共用同一個 v2 前置 DB，
    //   拆成兩條會讓後者在前者把 DB 升成 v3 之後被 beforeEach 靜默 skip。）
    await page.locator('input.input-time').first().fill('14:45');
    await expect(page.locator('.save-status-dirty'), '再次編輯應顯示未儲存變更').toBeVisible();
    await expect(
      page.locator('[data-upgrade-banner]'),
      '再次編輯時 banner 不得復原（版本已是 v3）'
    ).toHaveCount(0);
    await page.getByRole('button', { name: '取消修改' }).click();
    await expect(page.locator('.save-status-clean'), '再次編輯後取消應回到乾淨').toBeVisible();

    await page.reload();
    const reloaded = await (await page.request.get('/api/v1/runs/current')).json();
    expect(reloaded.run?.ruleSetVersion, '重載後仍是 v3').toBe('erp-tag-v3');
    await expect(
      page.locator('[data-upgrade-banner]'),
      '重載後 banner 不得復原'
    ).toHaveCount(0);
  });
});
