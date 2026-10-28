import { test, expect } from '@playwright/test';
import { activateFixture, editStart } from './helpers/c-batch';
import { reloadSettings, resetSeedSettings, saveSettings } from './helpers/d2c-settings';

const ROSTER_ONLY_CLASS = '國小數學-一';

test.describe('Issue #157 PR-2：從課表頁設定 roster-only 班級', () => {
  test.beforeEach(async ({ page }) => {
    await activateFixture(page);
    await resetSeedSettings(page);
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
  });

  test('直接加入名單中的新班、明確設定類別、儲存重載後解除未對應警告', async ({ page }) => {
    const reportBeforeResponse = await page.request.get('/api/v1/settings/class-name-report');
    expect(reportBeforeResponse.ok()).toBe(true);
    const aliasCoveredCountBefore = (await reportBeforeResponse.json()).aliasCoveredCount as number;

    const rosterOnly = page.getByRole('region', { name: '名單中尚未加入課表設定的班級' });
    await expect(rosterOnly).toBeVisible();
    await rosterOnly.locator('summary').click();
    const rosterRow = rosterOnly.locator(`[data-roster-only-class="${ROSTER_ONLY_CLASS}"]`);
    await expect(rosterRow).toContainText('尚未加入課表設定');

    await rosterRow.getByRole('button', { name: '加入課表設定' }).click();
    const form = page.getByRole('form', { name: '新增班級表單' });
    await expect(form).toBeVisible();
    const className = form.locator('input[type="text"]').first();
    await expect(className).toHaveValue(ROSTER_ONLY_CLASS);

    // D61：新增表單直接選擇「數學班」，支援五種類型精確建立
    await form.getByLabel('新增班級課程類型').selectOption('math');
    await form.getByRole('button', { name: '確認新增' }).click();

    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await saveSettings(page);
    await reloadSettings(page);

    await page.locator('#class-type-tab-math').click();
    await expect(
      page.locator('table.schedule-table-math tr.schedule-row', {
        has: page.locator(`input[value="${ROSTER_ONLY_CLASS}"]`),
      })
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: '名單中尚未加入課表設定的班級' })
        .locator(`[data-roster-only-class="${ROSTER_ONLY_CLASS}"]`)
    ).toHaveCount(0);

    const current = await page.request.get('/api/v1/runs/current');
    expect(current.ok()).toBe(true);
    const currentBody = await current.json();
    const runId = currentBody.activeRunId as string;
    expect(runId).toBeTruthy();

    const runResponse = await page.request.get(`/api/v1/runs/${encodeURIComponent(runId)}`);
    expect(runResponse.ok()).toBe(true);
    const run = await runResponse.json();
    expect(run.classCategories).toContainEqual(
      expect.objectContaining({
        base_name: ROSTER_ONLY_CLASS,
        category: 'math',
        fixed_five_days: 0,
      })
    );

    const studentsResponse = await page.request.get(
      `/api/v1/runs/${encodeURIComponent(runId)}/students`
    );
    expect(studentsResponse.ok()).toBe(true);
    const studentsData = await studentsResponse.json();
    const students = (studentsData.items || []) as Array<{ issues?: Array<{ code: string; message: string }> }>;
    const issues = students.flatMap((s) => s.issues || []);
    expect(issues.filter((issue) => issue.code === 'CLASS_NOT_MAPPED' && issue.message.includes(`「${ROSTER_ONLY_CLASS}」`))).toHaveLength(0);

    const reportAfterResponse = await page.request.get('/api/v1/settings/class-name-report');
    expect(reportAfterResponse.ok()).toBe(true);
    expect((await reportAfterResponse.json()).aliasCoveredCount).toBe(aliasCoveredCountBefore);
  });

  test('報告在待新增表單開啟後過期時，不能提交舊清單中的班級', async ({ page }) => {
    await editStart(page);
    const rosterOnly = page.getByRole('region', { name: '名單中尚未加入課表設定的班級' });
    await rosterOnly.locator('summary').click();
    const rosterRow = rosterOnly.locator(`[data-roster-only-class="${ROSTER_ONLY_CLASS}"]`);
    await rosterRow.getByRole('button', { name: '加入課表設定' }).click();

    const form = page.getByRole('form', { name: '新增班級表單' });
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: '確認新增' })).toBeEnabled();

    // Save the unrelated edit while the roster-only form remains open.
    await page.route('**/api/v1/settings/class-name-report**', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' })
    );
    await saveSettings(page);

    await expect(page.locator('[data-roster-only-stale]')).toBeVisible({ timeout: 10000 });
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: '確認新增' })).toBeDisabled();

    // Exercise the submit handler too: a scripted submit must not bypass the disabled control.
    await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
    await expect(page.locator(`[data-category-select="${ROSTER_ONLY_CLASS}"]`)).toHaveCount(0);
  });
});
