import { test, expect } from '@playwright/test';
import {
  DATETIME_RE,
  FIXTURE,
  formatTaipei,
  openSchedule,
  startInput,
} from './helpers/c-batch';

/**
 * specs/04 UX33／09 §7（11 C；D38 O02）：全站日期時間一律 Asia/Taipei、`YYYY-MM-DD HH:mm`，不混用瀏覽器 locale。
 *
 * 用「美國英文＋洛杉磯時區」的瀏覽器：舊實作的 toLocale*String() 會在這裡顯示成 `9/30/2026, 3:04 PM`（且是洛杉磯時間），
 * 一眼就能分辨有沒有混用瀏覽器 locale。核對基準日這類純日期維持 `YYYY-MM-DD`。
 * 會寫入課表與啟用名單的案例依序排列（同一個 spec 共用一份臨時資料庫）。
 */
test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });

const NOT_LOCALE = /\b(?:AM|PM)\b|\d{1,2}\/\d{1,2}\/\d{2,4}/;

test.describe('UX33 日期時間格式', () => {
  test('課表儲存時間：儲存後立即顯示新時間（台北時間、YYYY-MM-DD HH:mm）；重新整理後仍是同格式', async ({ page }) => {
    await openSchedule(page);
    await (await startInput(page)).click();
    await (await startInput(page)).fill('15:45');
    await page.waitForTimeout(500);
    await page.locator('button', { hasText: '確認變更' }).click();
    const impact = page.locator('dialog.impact-dialog');
    await expect(impact).toBeVisible({ timeout: 15000 });

    const applyResponse = page.waitForResponse((r) => r.url().includes('/api/v1/settings/apply'));
    await impact.getByRole('button', { name: /^儲存/ }).click();
    const applied = await (await applyResponse).json();
    expect(typeof applied.appliedAt).toBe('string');
    await expect(page.locator('#toast')).toContainText('課表已', { timeout: 15000 });

    // 儲存後不必重新整理：狀態列就是新的儲存時間（以 appliedAt 換算台北時間）
    const status = page.locator('.save-status-clean');
    await expect(status).toContainText(`課表已為最新儲存狀態 · ${formatTaipei(applied.appliedAt)}`);
    expect(await status.innerText()).not.toMatch(NOT_LOCALE);

    await page.reload();
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    const reloaded = await page.locator('.save-status-clean').innerText();
    expect(reloaded).toMatch(new RegExp(`課表已為最新儲存狀態 · ${DATETIME_RE.source}$`));
    expect(reloaded).not.toMatch(NOT_LOCALE);
  });

  test('匯入頁「目前課表」的儲存時間', async ({ page }) => {
    await page.goto('/imports');
    const note = page.locator('.schedule-meta-note');
    await expect(note).toBeVisible();
    const text = (await note.innerText()).replace(/\s+/g, ' ');
    expect(text).toMatch(new RegExp(`目前課表：${DATETIME_RE.source} 已儲存`));
    expect(text).not.toMatch(NOT_LOCALE);
  });

  test('首頁（只有課表）的儲存時間', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main')).toContainText(new RegExp(`課表已儲存（${DATETIME_RE.source}）`));
  });

  test('匯入預覽的「核對基準日」預設是台北的今天（不是 UTC 或瀏覽器時區的今天）', async ({ page }) => {
    // 固定時間 2026-09-30T17:30:00Z：台北 2026-10-01 01:30；UTC 與洛杉磯都還是 2026-09-30
    await page.clock.setFixedTime(new Date('2026-09-30T17:30:00Z'));
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    const asOf = page.locator('input[aria-label="核對基準日"]');
    await expect(asOf).toBeVisible({ timeout: 15000 });
    await expect(asOf).toHaveValue('2026-10-01');
  });

  test('啟用名單：核對基準日也是台北的今天；核對橫幅時間格式正確', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-30T17:30:00Z'));
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('button', { hasText: '使用這份名單' })).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await page.locator('a', { hasText: '前往核對結果' }).click();
    const banner = page.locator('.data-banner-current');
    await expect(banner).toBeVisible({ timeout: 30000 });
    const bannerText = (await banner.innerText()).replace(/\s+/g, ' ');
    // 匯入時間與更新時間在同一分鐘時橫幅只寫「資料更新於」；兩者都出現時，兩個時間都是同一格式
    expect(bannerText).toMatch(new RegExp(`資料更新於 ${DATETIME_RE.source}`));
    if (bannerText.includes('名單匯入於')) {
      expect(bannerText).toMatch(new RegExp(`名單匯入於 ${DATETIME_RE.source} · 資料更新於 ${DATETIME_RE.source}`));
    }
    expect(bannerText).toContain('核對基準日 2026-10-01');
    expect(bannerText).not.toMatch(NOT_LOCALE);


  });
});
