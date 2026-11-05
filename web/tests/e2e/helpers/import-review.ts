import { expect, type Locator, type Page } from '@playwright/test';

/** 匯入預覽的「異動／名單」浮動視窗（D64 G3，UX124）。 */
export const reviewDialog = (page: Page): Locator => page.locator('dialog.import-review-dialog');

/** 以確認卡上的觸發鈕開啟浮動視窗；回傳視窗 locator。 */
export async function openReviewDialog(page: Page, tab: 'changes' | 'list'): Promise<Locator> {
  const name = tab === 'changes' ? '查看異動' : '預覽名單';
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = reviewDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function closeReviewDialog(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(reviewDialog(page)).toHaveCount(0);
}

/**
 * 上傳並等待預覽 API 回應，回傳預覽批次的班名同步報告路徑（`/settings?tab=sync&import=<批次>`）。
 * 啟用前畫面不再提供連結（UX121），需要「檢視未啟用名單」的測試改由 API 回應取得路徑。
 */
export async function uploadPreviewAndGetReportPath(
  page: Page,
  files: Parameters<Locator['setInputFiles']>[0],
): Promise<string> {
  const responded = page.waitForResponse(
    (r) => r.url().includes('/api/v1/imports/preview') && r.request().method() === 'POST',
  );
  await page.locator('input[type="file"]').setInputFiles(files);
  const json = await (await responded).json();
  const reportPath = json?.classNameReport?.reportPath ?? json?.data?.classNameReport?.reportPath;
  expect(typeof reportPath, '預覽回應應帶 classNameReport.reportPath').toBe('string');
  return reportPath as string;
}
