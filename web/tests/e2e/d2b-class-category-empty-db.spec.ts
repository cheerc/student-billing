import { test, expect, type Page } from '@playwright/test';

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
 * D2b：課表設定 UI 中**要求空 DB** 的畫面契約（06 D37 1a、Q11、Q9）。
 *
 * D2c N-1：隔離執行器保證「每 spec 檔全新 DB」，但同檔內案例共用 DB。
 * `d2b-class-category.spec.ts` 的 r2 案例需已啟用名單，因此這三個要求空 DB 的案例獨立成檔。
 */
test.describe('D2b 空 DB 畫面契約：settings_only 影響預覽、Q11 升級動作、Q9 合併阻擋', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    // 前置斷言：本檔每一個案例都必須真的在空 DB 上（若有人在此檔啟用名單，這裡立刻失敗）
    await expect(page.locator('[data-upgrade-banner]')).toHaveCount(0);
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

    // D2c N-1：本案例把「國小數學-四A」的手動類別寫進 DB，若不還原，
    // 同檔後續案例與 `--repeat` 的下一輪會讀到手動值（實測第 2 輪 4 failed）。
    await restoreCategoryToAutoAndSave(page, '國小數學-四A');
  });

  /**
   * D2c N-1：同檔案例共用同一 DB（runner 只保證每檔新 DB），且 `--repeat` 會沿用同一 DB 跑多輪。
   * 因此本檔每個案例結束後都必須把設定還原到 seed 狀態，否則下一個案例／下一輪會讀到殘留
   * （實測：輪次 1 全綠、輪次 2 兩個案例因「確認變更」停用而失敗）。
   *
   * 做法：逐一恢復可能被手動設定的班級為自動，並在真的有變更時儲存。
   * 找不到「恢復自動」按鈕＝該班本來就是自動（按鈕只在手動時出現），不需動作。
   */
  test.afterEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    const clean = page.locator('[data-class-attributes-panel] button[data-restore-auto]');
    const n = await clean.count();
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      await clean.nth(i).click();
    }
    await expect(page.locator('.save-status-dirty')).toBeVisible();
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await dialog.locator('button', { hasText: /儲存並更新結果|儲存課表/ }).click();
    await expect(page.locator('#toast')).toContainText('課表已', { timeout: 15000 });
  });

  test('D2b-4（Q11）: 空 DB 不顯示升級動作（該 run 建立時即為目標版本）', async ({ page }) => {
    // 尚未啟用任何 run → 無升級動作
    await expect(page.locator('[data-upgrade-banner]')).toHaveCount(0);
  });

  test('D2b-5（Q9）: 同名合併且設定不同時阻擋儲存並說明', async ({ page }) => {
    // D2c N-1：本案例必須自足，不依賴前一案例的狀態。
    // 前置：兩班都先確定為「自動」（前一案例可能已把四A 設為手動或已還原），
    // 再只把四A 設為手動 → 兩班有效屬性確定不同 → 合併必然是衝突。
    // 「恢復自動」按鈕只在該項為手動時出現（class-attributes-panel.tsx），故條件式點擊
    for (const cn of ['國小數學-四A', '國小數學-四B']) {
      const btn = page.locator(`[data-restore-auto="${cn}"]`);
      if (await btn.count()) {
        await btn.click();
        await expect(page.locator(`[data-category-source="${cn}"]`)).toHaveText('自動');
      } else {
        await expect(page.locator(`[data-category-source="${cn}"]`)).toHaveText('自動');
      }
    }

    // 把「國小數學-四A」手動設為不列入折扣
    await page.locator('[data-category-select="國小數學-四A"]').selectOption('none');
    await expect(page.locator('[data-category-source="國小數學-四A"]')).toHaveText('手動');

    // D2c N-1：本案例必須自足——把手動設定**先儲存**再改名。
    // 合併衝突的判定基準是各來源班的「有效屬性」（已儲存的手動值優先，未手動者依 baseline 班名
    // 自動偵測，見 settings-editor.tsx:264-268 的註解）。因此只在草稿中設手動不足以產生衝突；
    // D2b r1 的 Q9 案例之所以通過，實際上是靠同一檔前一個案例留下的已儲存手動值。
    await page.locator('button', { hasText: '確認變更' }).click();
    const saveDialog = page.locator('dialog.impact-dialog');
    await expect(saveDialog).toBeVisible({ timeout: 15000 });
    await saveDialog.locator('button', { hasText: /儲存並更新結果|儲存課表/ }).click();
    await expect(page.locator('#toast')).toContainText('課表已', { timeout: 15000 });

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

  test('D2c N-1：本檔要求空 DB，若有案例啟用了名單會立刻被這個斷言抓到', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('[data-upgrade-banner]')).toHaveCount(0);
    const res = await page.request.get('/api/v1/runs/current');
    const body = await res.json().catch(() => null);
    expect(body?.activeRunId ?? null).toBeNull();
  });
});
