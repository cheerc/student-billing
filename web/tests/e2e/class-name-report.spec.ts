import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import JSZip from 'jszip';
import { FIXTURE, xlsxUpload } from './helpers/c-batch';

/**
 * D1 班名比對報告（specs/11 §3 D1、04 §8 UX44–UX47；S manifest §8；operator ruling d-20260930112930661160-25 Q12-b）。
 * 使用者實際操作驗證：
 *   1. 匯入預覽在「使用這份名單」之前，顯示兩份清單（米豆奶有／系統無、系統有／本次名冊無）的班數與影響人數，
 *      並提供完整報告連結；
 *   2. 完整報告在課表設定「班名對應」：兩份清單並排、預設展開；系統有／名冊無 顯示上一份名單該班人數並註明來源；
 *      別名不對稱在畫面上說明；D1 不顯示任何「類別」。
 * 全部使用合成 fixture（不含真實名單）；每個 spec 檔用全新隔離 DB（npm run test:e2e:isolated）。
 *
 * fixture 事實（I19 錨點與手動盤點）：ERP 班名 54＝已對應 42＋米豆奶有／系統無 12；seed 49 班中 7 個本次未出現；
 * 12 個待對應班涵蓋 191 位不重複學生（交通車 93 人）；未出現的 7 個 seed 班含「國小數學-一A」「國小輔導-四年級」。
 */

const summaryOf = (page: Page) => page.getByRole('region', { name: '班名比對摘要' });
const reportOf = (page: Page) => page.getByRole('region', { name: '班名比對報告' });
const rosterOnlyOf = (page: Page) => page.getByRole('region', { name: '米豆奶有／系統無' });
const systemOnlyOf = (page: Page) => page.getByRole('region', { name: '系統有／本次名冊無' });

/** 變體名單：STU0001 多報 seed 班「國小輔導-四年級」（本次 fixture 沒有的 seed 班），當作「上一份名單」。 */
async function buildPreviousRoster(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(FIXTURE));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let xml = await zip.file(sheetPath)!.async('string');
  const row2 = xml.match(/<row [^>]*>[\s\S]*?<\/row>/g)![1];
  expect(row2).toContain('STU0001');
  const changed = row2.replace('兒童美語-KC[團]', '兒童美語-KC[團]\n115國小輔導-四年級[團]');
  expect(changed).not.toBe(row2);
  xml = xml.replace(row2, changed);
  zip.file(sheetPath, xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

test.describe('班名比對報告（D1）', () => {
  test('匯入預覽：使用這份名單之前先看到兩份清單的班數與影響人數，並連到完整報告；完整報告兩份清單並排、預設展開、不含類別', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 摘要在「使用這份名單」按鈕之前（DOM 順序），且不用展開就看得到
    const summary = summaryOf(page);
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('米豆奶有／系統無');
    await expect(summary).toContainText('12 個班');
    await expect(summary).toContainText('191 位學生');
    await expect(summary).toContainText('系統有／本次名冊無');
    await expect(summary).toContainText('7 個班');
    await expect(summary).toContainText('沒有上一份名單可參考');
    await expect(summary).not.toContainText('類別');

    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible();
    const summaryBeforeButton = await page.evaluate(
      ([s, b]) => Boolean((s as Node).compareDocumentPosition(b as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
      [await summary.elementHandle(), await useBtn.elementHandle()] as const
    );
    expect(summaryBeforeButton, '班名比對摘要要出現在「使用這份名單」之前').toBe(true);

    // 既有的「N 個班名待確認」提示不變（跨頁一致 E2E 依賴它）
    await expect(page.locator('text=/12\\s*個班名待確認/').first()).toBeVisible();

    // 連到完整報告（尚未啟用的這批名單也能看）
    const link = summary.getByRole('link', { name: /完整班名比對報告/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /^\/settings\?tab=mapping&import=.+/);
    await link.click();

    // 完整報告：課表設定「班名對應」
    await expect(page).toHaveURL(/\/settings\?tab=mapping&import=/);
    const report = reportOf(page);
    await expect(report).toBeVisible({ timeout: 15000 });
    const left = rosterOnlyOf(page);
    const right = systemOnlyOf(page);
    // 預設展開（不需要點任何東西就看得到內容）
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    await expect(left).toContainText('12 個班');
    await expect(left).toContainText('191 位學生');
    await expect(left.getByRole('row', { name: /交通車/ })).toContainText('93 人');
    await expect(right).toContainText('7 個班');
    await expect(right.getByRole('row', { name: /國小數學-一A/ })).toBeVisible();
    await expect(right.getByRole('row', { name: /國小輔導-四年級/ })).toBeVisible();
    // 沒有上一份名單：不顯示人數，也不顯示 0
    await expect(right).toContainText('沒有上一份名單可參考');

    // 並排：同一橫列、左清單在右清單左邊
    const a = (await left.boundingBox())!;
    const b = (await right.boundingBox())!;
    expect(Math.abs(a.y - b.y), '兩份清單頂端對齊（並排）').toBeLessThan(8);
    expect(a.x + a.width, '米豆奶有／系統無 在左、系統有／本次名冊無 在右').toBeLessThanOrEqual(b.x + 2);

    // 別名不對稱說明、D1 不顯示類別
    await expect(report).toContainText('別名');
    await expect(report).toContainText('直接');
    await expect(report).not.toContainText('類別');
  });

  test('有上一份名單：摘要與完整報告的「系統有／本次名冊無」顯示上一份名單該班的人數，並註明來源檔名', async ({ page }) => {
    // 先把變體（STU0001 多報「國小輔導-四年級」）當成目前使用的名單
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(xlsxUpload('previous-roster.xlsx', await buildPreviousRoster()));
    await expect(page.locator('button', { hasText: '使用這份名單' })).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    // 再上傳標準 fixture（本次沒有「國小輔導-四年級」）
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    const summary = summaryOf(page);
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('7 個班');
    await expect(summary).toContainText('previous-roster.xlsx');
    await expect(summary).toContainText('共有 1 位學生');
    await expect(summary).not.toContainText('沒有上一份名單可參考');

    await summary.getByRole('link', { name: /完整班名比對報告/ }).click();
    const right = systemOnlyOf(page);
    await expect(right).toBeVisible({ timeout: 15000 });
    await expect(right).toContainText('previous-roster.xlsx');
    await expect(right.getByRole('row', { name: /國小輔導-四年級/ })).toContainText('1 人');
    // 上一份名單沒有學生的 seed 班：人數 0（有上一份名單，所以是 0 而不是「沒有資料」）
    await expect(right.getByRole('row', { name: /國小數學-一A/ })).toContainText('0 人');
  });
});
