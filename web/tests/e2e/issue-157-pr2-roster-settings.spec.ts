import { test, expect } from '@playwright/test';
import { activateFixture, editStart, ensureClassTypeTab, openSchedule } from './helpers/c-batch';
import { reloadSettings, resetSeedSettings, saveSettings } from './helpers/d2c-settings';

const ROSTER_ONLY_CLASS = '國小數學-一';

/**
 * #189 D62 Phase 2：名單未對應班級改由「班名同步」處理（取代課表頁 roster-only 表與班名對應候選表）。
 * 保留 #157 PR-2 的核心不變式：新增後明確設定類別、儲存重載後解除未對應警告、不得新增 alias。
 */
test.describe('#189 D62：「班名同步」新增名單班級並持久化設定', () => {
  test.beforeEach(async ({ page }) => {
    await activateFixture(page);
    await resetSeedSettings(page);
    await page.goto('/settings?tab=sync');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-class-name-sync-panel]')).toBeVisible({ timeout: 15000 });
  });

  test('新增名單班級為數學班、儲存重載後退出差異表且解除未對應警告', async ({ page }) => {
    const reportBeforeResponse = await page.request.get('/api/v1/settings/class-name-report');
    expect(reportBeforeResponse.ok()).toBe(true);
    const aliasCoveredCountBefore = (await reportBeforeResponse.json()).aliasCoveredCount as number;

    const row = page.locator(`tr[data-mismatch-row="${ROSTER_ONLY_CLASS}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('未對應課表');

    await row.getByRole('button', { name: '新增為課表班級' }).click();
    // 班名唯讀＝米豆奶班名
    await expect(page.locator('[data-class-name-sync-panel] input[type="text"]')).toHaveValue(ROSTER_ONLY_CLASS);
    // D61：五種類型單選，選「數學班」
    await page.locator('input[type="radio"][value="math"]').check();
    await page.getByRole('button', { name: '暫存新增' }).click();

    await expect(row).toContainText('已暫存新增課表班級（未儲存）');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await saveSettings(page);
    await reloadSettings(page);

    await page.goto('/settings?tab=sync');
    await expect(page.locator('[data-class-name-sync-panel]')).toBeVisible({ timeout: 15000 });
    // 已新增的班名與課表完全同名 → 退出差異表
    await expect(page.locator(`tr[data-mismatch-row="${ROSTER_ONLY_CLASS}"]`)).toHaveCount(0);

    // UX95：重載後該班真的成為課表班級（出現在數學班頁籤，且是使用者選定的類型）
    await page.getByRole('tab', { name: /^課表/ }).click();
    await ensureClassTypeTab(page, ROSTER_ONLY_CLASS);
    const classInputs = page.locator('table.schedule-table-math input.input-classname');
    const names = await classInputs.evaluateAll((els) =>
      els.map((el) => (el as HTMLInputElement).value)
    );
    expect(names, '重載後數學班頁籤應含新班級').toContain(ROSTER_ONLY_CLASS);

    const reportAfterResponse = await page.request.get('/api/v1/settings/class-name-report');
    expect(reportAfterResponse.ok()).toBe(true);
    expect((await reportAfterResponse.json()).aliasCoveredCount).toBe(aliasCoveredCountBefore);

    const current = await page.request.get('/api/v1/runs/current');
    expect(current.ok()).toBe(true);
    const currentBody = await current.json();
    const runId = currentBody.activeRunId as string;
    expect(runId).toBeTruthy();

    const runResponse = await page.request.get(`/api/v1/runs/${encodeURIComponent(runId)}`);
    expect(runResponse.ok()).toBe(true);
    const run = await runResponse.json();
    // UX95／specs/17 §2.2：新增只問課程類型，折扣類別維持 unset（系統不得替使用者決定類別）。
    expect(run.classCategories).toContainEqual(
      expect.objectContaining({
        base_name: ROSTER_ONLY_CLASS,
        category: 'unset',
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
    expect(
      issues.filter(
        (issue) => issue.code === 'CLASS_NOT_MAPPED' && issue.message.includes(`「${ROSTER_ONLY_CLASS}」`)
      )
    ).toHaveLength(0);
  });

  test('報告刷新失敗後差異表鎖定，不能依過期清單暫存同步或新增', async ({ page }) => {
    await openSchedule(page);
    await editStart(page);

    await page.route('**/api/v1/settings/class-name-report**', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' })
    );
    await saveSettings(page);

    // 儲存發生在課表頁；切到「班名同步」才看得到報告復原狀態（鎖定只涵蓋差異表）
    await page.getByRole('tab', { name: /班名同步/ }).click();

    // UX46：重試用盡 → 顯示復原提示；舊報告內容收起，復原按鈕保持可用。
    await expect(page.locator('[data-report-stale]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-report-body-hidden]')).toBeVisible();
    await expect(page.locator('[data-report-locked="true"]')).toBeVisible();
    await expect(page.locator('[data-report-stale] button', { hasText: '重新載入' })).toBeEnabled();
    await expect(page.locator(`tr[data-mismatch-row="${ROSTER_ONLY_CLASS}"]`)).toHaveCount(0);
  });
});
