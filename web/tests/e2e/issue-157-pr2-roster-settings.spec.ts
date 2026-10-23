import { test, expect } from '@playwright/test';
import { activateFixture } from './helpers/c-batch';
import { reloadSettings, saveSettings } from './helpers/d2c-settings';

const ROSTER_ONLY_CLASS = '國小數學-一';

test.describe('Issue #157 PR-2：從課表頁設定 roster-only 班級', () => {
  test.beforeEach(async ({ page }) => {
    await activateFixture(page);
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
  });

  test('直接加入名單中的新班、明確設定類別、儲存重載後解除未對應警告', async ({ page }) => {
    const rosterOnly = page.getByRole('region', { name: '名單中尚未加入課表設定的班級' });
    await expect(rosterOnly).toBeVisible();
    const rosterRow = rosterOnly.locator(`[data-roster-only-class="${ROSTER_ONLY_CLASS}"]`);
    await expect(rosterRow).toContainText('尚未加入課表設定');

    await rosterRow.getByRole('button', { name: '加入課表設定' }).click();
    const form = page.getByRole('form', { name: '新增班級表單' });
    await expect(form).toBeVisible();
    const className = form.locator('input[type="text"]').first();
    await expect(className).toHaveValue(ROSTER_ONLY_CLASS);

    // 課程類型由使用者透過既有新增表單決定；不由「國小數學」字樣推導。
    await form.getByLabel('新增班級課程類型').selectOption('non_care');
    await form.getByRole('button', { name: '確認新增' }).click();

    const category = page.locator(`[data-category-select="${ROSTER_ONLY_CLASS}"]`).first();
    await expect(category).toHaveValue('unset');
    await category.selectOption('math');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await saveSettings(page);
    await reloadSettings(page);

    await expect(page.locator(`[data-category-select="${ROSTER_ONLY_CLASS}"]`).first()).toHaveValue('math');
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
    expect(run.classCategories).toContainEqual({
      base_name: ROSTER_ONLY_CLASS,
      category: 'math',
      fixed_five_days: 0,
    });

    const issuesResponse = await page.request.get(
      `/api/v1/runs/${encodeURIComponent(runId)}/issues?issueCode=CLASS_NOT_MAPPED&classId=${encodeURIComponent(ROSTER_ONLY_CLASS)}`
    );
    expect(issuesResponse.ok()).toBe(true);
    expect((await issuesResponse.json()).items).toHaveLength(0);
  });
});
