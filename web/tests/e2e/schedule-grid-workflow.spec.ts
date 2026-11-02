import { test, expect } from '@playwright/test';
import { ensureClassTypeTab, selectClassTypeTab, resetSeedSettings } from './helpers/d2c-settings';
import { activateFixture, classRows, openClassSchedule } from './helpers/c-batch';
import { buildSeedGridRows } from '../../src/contracts/settings';

/**
 * 04 §8 UX01／UX05–08／UX24：
 * 空 DB 先課表後匯入工作流程（#203：不顯示窗口摘要列或重複同步橫幅）：
 * 進入設定頁（不阻擋）→ 課程類型頁籤 → 搜尋／篩選工具列 → 平鋪網格 → 編輯時段 → 確認變更 → 儲存課表 (settings_only)。
 *
 * D61（09 §3.1）起課表是「一頁籤一張表」，預設頁籤是**安親課輔班**：
 *  - 安親頁籤沒有時段欄，數量摘要只有 `共 N 個班級`；
 *  - 排課頁籤（美語／數學／其他／不排課）才顯示 `共 N 個班級 · M 個時段`。
 * 因此「編輯時段」必須先切到排課頁籤，並以班名定位該列（見 helpers）。
 */
test.describe('R2 展示一：空 DB 先課表後匯入排課工作流程 E2E', () => {
  test('UX01/UX24: 空 DB 進入 /settings → 無窗口摘要列／同步橫幅 → 編輯時段 → 確認變更 → 儲存課表 (settings_only)', async ({
    page,
  }) => {
    // 1. 空 DB 狀態下直接存取 /settings（UX01：解除先匯入名單之阻擋）
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });

    // 2. #203／UX24：固定窗口仍是計算依據，但不在課表頁重複顯示摘要列；
    //    班名同步入口留在上層頁籤，空 DB 時不出現 ScheduleGrid 橫幅。
    await expect(page.locator('.windows-bar')).toHaveCount(0);
    await expect(page.locator('[data-schedule-sync-banner]')).toHaveCount(0);
    await expect(page.locator('#settings-tab-sync')).toContainText('班名同步');

    // 3. 安親頁籤（預設）：平鋪網格正常載入，摘要只有班級數、不含時段（09 §3.1）
    //    8 個安親班（seed-manifest.ts 的 SEED_CLASS_TYPES），每班只列 1 列
    const scheduleTable = page.locator('.schedule-table');
    await expect(scheduleTable).toBeVisible();
    await expect(page.locator('#class-type-tab-care')).toHaveAttribute('aria-selected', 'true');
    const footer = page.locator('.tablefoot');
    const totalSummary = footer.locator('.count-summary');
    await expect(totalSummary).toHaveText('共 8 個班級');
    expect(await page.locator('.schedule-table-scroll').evaluate((scroller) =>
      !scroller.contains(document.querySelector('.tablefoot'))
    )).toBe(true);

    // 4. 切到排課頁籤：全量統計位於 footer，不受搜尋影響；篩選顯示量另列。
    //    數學班 12 班、24 個時段（來源為 seed fixture 的 math 班時段數）。
    await selectClassTypeTab(page, 'math');
    await expect(page.locator('#schedule-weekday-filter')).toBeVisible();
    await expect(totalSummary).toHaveText('共 12 個班級 · 24 個時段');
    await page.getByLabel('搜尋課表班級').fill('國小數學-四A');
    await expect(totalSummary).toHaveText('共 12 個班級 · 24 個時段');
    await expect(footer.locator('.count-filter-summary')).toHaveText('目前顯示 1 個班級 · 2 個時段');

    // 5. 編輯一列時間觸發 dirty 狀態（以班名定位，不用整表第一個時段）
    //    四A 首列 seed 值為週三 13:30–15:00，因此這裡必須填「不同的值」才會真的改到草稿
    const row = await ensureClassTypeTab(page, '國小數學-四A');
    await row.locator('input.input-time').first().fill('14:10');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 6. 點擊「確認變更」開啟 ImpactDialog
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    // 7. 驗證 settings_only 專屬呈現（提示尚未匯入學生、主按鈕為「儲存課表」）
    await expect(dialog).toContainText('尚未匯入學生');
    const saveBtn = dialog.locator('button', { hasText: '儲存課表' });
    await expect(saveBtn).toBeVisible();

    // 8. 點擊「儲存課表」完成 settings_only 儲存
    await saveBtn.click();
    await expect(page.locator('#toast')).toContainText('課表已成功儲存', { timeout: 15000 });
    await expect(dialog).not.toBeVisible();
  });

  test('UX115: 深連結類型正確，搜尋可解除焦點且切換主頁籤後不復活', async ({ page }) => {
    await openClassSchedule(page, '國小數學-四A');
    await expect(page.locator('#class-type-tab-math')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-focus-class]')).toContainText('國小數學-四A');

    const search = page.getByLabel('搜尋課表班級');
    await search.fill('國小數學-四B');
    await expect(page.locator('[data-focus-class]')).toHaveCount(0);
    await expect(page.locator('[data-focus-class-missing]')).toHaveCount(0);
    await expect(await ensureClassTypeTab(page, '國小數學-四B')).toBeVisible();
    await expect(page.locator('table.schedule-table-math tr.schedule-row', {
      has: page.locator('input[value="國小數學-四A"]'),
    })).toHaveCount(0);

    await search.fill('');
    await expect(page.locator('[data-focus-class]')).toHaveCount(0);
    await expect(page.locator('table.schedule-table-math tr.schedule-row')).toHaveCount(24);
    await page.locator('#settings-tab-sync').click();
    await page.locator('#settings-tab-schedule').click();
    await expect(page.locator('#class-type-tab-math')).toHaveAttribute('aria-selected', 'true');
    await expect(search).toHaveValue('');
    await expect(page.locator('[data-focus-class]')).toHaveCount(0);
    await expect(page.locator('table.schedule-table-math tr.schedule-row')).toHaveCount(24);
  });

  test('UX115: focused row identity survives rename and primary-tab remount', async ({ page }) => {
    const firstFocusedRow = await openClassSchedule(page, '國小數學-四A');
    const focusedRows = page.locator('table.schedule-table-math tbody tr.schedule-row');
    await expect(focusedRows).toHaveCount(2);

    await firstFocusedRow.locator('input.input-classname').fill('國小數學-四B');
    await expect(focusedRows).toHaveCount(2);
    await expect(page.locator('[data-focus-class]')).toContainText('2 個時段');
    await expect(page.locator('#class-type-tab-math')).toHaveAttribute('aria-selected', 'true');
    await expect(
      focusedRows.getByRole('radiogroup', { name: '國小數學-四B 的是否有多科折扣' })
    ).toBeVisible();

    await page.locator('#settings-tab-sync').click();
    await page.locator('#settings-tab-schedule').click();
    await expect(page.locator('#class-type-tab-math')).toHaveAttribute('aria-selected', 'true');
    await expect(focusedRows).toHaveCount(2);
    await expect(page.locator('[data-focus-class]')).toContainText('2 個時段');
    await expect.poll(async () =>
      focusedRows.locator('input.input-classname').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
    ).toEqual(['國小數學-四B', '國小數學-四A']);

    await page.getByRole('button', { name: '顯示全部班級' }).click();
    await expect(page.locator('[data-focus-class]')).toHaveCount(0);
    await expect(page.locator('table.schedule-table-math tbody tr.schedule-row')).toHaveCount(24);
  });

  test('UX115: focus identity handles added/deleted rows and a successful whole-draft Excel replacement', async ({ page }) => {
    const className = '國小數學-四A';
    await openClassSchedule(page, className);

    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const addForm = page.getByRole('form', { name: '新增班級表單' });
    await addForm.getByLabel('新增班級名稱').fill(className);
    await addForm.getByRole('button', { name: '確認新增' }).click();
    await expect(classRows(page, className)).toHaveCount(3);
    await expect(page.locator('[data-focus-class]')).toContainText('3 個時段');

    const deleteRows = page.getByRole('button', { name: `刪除時段 ${className}` });
    await expect(deleteRows).toHaveCount(3);
    for (let remaining = 3; remaining > 0; remaining -= 1) {
      await deleteRows.first().click();
      await expect(deleteRows).toHaveCount(remaining - 1);
    }
    await expect(page.locator('[data-focus-class]')).toHaveCount(0);
    await expect(page.locator('[data-focus-class-missing]')).toBeVisible();

    const importedRows = buildSeedGridRows()
      .filter((row) => row.className === className)
      .map((row, index) => ({ ...row, rowId: `synthetic-import-${index + 1}` }));
    await page.route('**/api/v1/settings/schedule-table', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rows: importedRows,
          classAttrs: [{
            className,
            classType: 'math',
            hasMultiSubjectDiscount: true,
            category: 'math',
            categorySource: 'manual',
            fixedFiveDays: false,
          }],
        }),
      });
    });
    await page.getByLabel('選擇課表 Excel 檔案').setInputFiles({
      name: 'synthetic-schedule.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('synthetic schedule replacement'),
    });
    await expect(page.locator('#toast')).toContainText('已匯入課表');
    await expect(classRows(page, className)).toHaveCount(2);
    await expect(page.locator('[data-focus-class]')).toContainText('2 個時段');
  });

  test('UX115: an explicit sync destination replaces prior focus identity and clear removes it', async ({ page }) => {
    await activateFixture(page);
    await resetSeedSettings(page);
    await openClassSchedule(page, '國小數學-四A');
    await expect(page.locator('[data-focus-class]')).toContainText('國小數學-四A');

    const replacementRows = [
      ...buildSeedGridRows()
        .filter((row) => row.className === '國小數學-四A')
        .map((row, index) => ({ ...row, rowId: `async-import-math-${index + 1}` })),
      {
        rowId: 'async-import-traffic-1',
        className: '交通車',
        teacher: null,
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
    ];
    let resumeImport: () => void = () => {};
    const importGate = new Promise<void>((resolve) => {
      resumeImport = resolve;
    });
    await page.route('**/api/v1/settings/schedule-table', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      await importGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rows: replacementRows,
          classAttrs: [
            {
              className: '國小數學-四A',
              classType: 'math',
              hasMultiSubjectDiscount: true,
              category: 'math',
              categorySource: 'manual',
              fixedFiveDays: false,
            },
            {
              className: '交通車',
              classType: 'unscheduled',
              hasMultiSubjectDiscount: false,
              category: 'none',
              categorySource: 'manual',
              fixedFiveDays: false,
            },
          ],
        }),
      });
    });
    const importRequest = page.waitForRequest((request) =>
      request.url().endsWith('/api/v1/settings/schedule-table') && request.method() === 'POST'
    );
    await page.getByLabel('選擇課表 Excel 檔案').setInputFiles({
      name: 'synthetic-schedule.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('synthetic schedule replacement'),
    });
    await importRequest;

    await page.locator('#settings-tab-sync').click();
    const trafficRow = page.locator('tr[data-mismatch-row="交通車"]');
    await expect(trafficRow).toBeVisible();
    await trafficRow.getByRole('button', { name: '新增為課表班級' }).click();
    await page.locator('input[type="radio"][value="unscheduled"]').check();
    await page.getByRole('button', { name: '暫存新增' }).click();
    await expect(trafficRow).toContainText('已暫存新增課表班級');

    await trafficRow.getByRole('button', { name: '到課表填時段 →' }).click();
    await expect(page.locator('#class-type-tab-unscheduled')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-focus-class]')).toContainText('交通車');
    await expect(page.locator('table.schedule-table-unscheduled tbody tr.schedule-row')).toHaveCount(1);
    await expect.poll(async () =>
      page.locator('table.schedule-table-unscheduled input.input-classname').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
    ).toEqual(['交通車']);

    resumeImport();
    await expect(page.locator('#toast')).toContainText('已匯入課表');
    await expect(page.locator('[data-focus-class]')).toContainText('交通車');
    await expect(page.locator('table.schedule-table-unscheduled tbody tr.schedule-row')).toHaveCount(1);
    await expect.poll(async () =>
      page.locator('table.schedule-table-unscheduled input.input-classname').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
    ).toEqual(['交通車']);

    await page.getByRole('button', { name: '顯示全部班級' }).click();
    await expect(page.locator('[data-focus-class]')).toHaveCount(0);
    await expect(page.locator('table.schedule-table-unscheduled tbody tr.schedule-row')).toHaveCount(1);
  });
});
