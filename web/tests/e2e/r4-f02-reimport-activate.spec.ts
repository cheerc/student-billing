import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { XLSX_MIME } from './helpers/c-batch';

/**
 * R4-F02：同頁連續匯入兩份名單時，第二份的啟用因 expectedRevision 過期而 409。
 *
 * 重現步驟即第四輪驗收的操作序列，全程不重整頁面：
 *   /imports → 上傳 baseline → 使用這份名單 →（回匯入頁）→ 上傳 variant → 使用這份名單
 *
 * #84：完成畫面的「再匯入其他名單」按鈕已被移除（會讓人誤以為支援疊加匯入），
 * 本測試改以完整頁面載入（page.goto('/imports)）重啟流程——revision 由 server render 重取，
 * 故這個測試現在守的是「revision 過期就必須 409」這條不變式；
 * 「本頁剛完成的啟用要更新本頁持有的 revision」則由單元層與 imports.spec.ts 的
 * 先備條件路徑覆蓋（第二份名單必須先成為 active 才能量到異動統計）。
 *
 * 既有 E2E（roster-changes-details.spec.ts:42）第二次匯入前都 page.goto('/imports')
 * 重整，正是這條路徑先前無覆蓋的原因。
 *
 * 預期（依 R4-F02 驗收契約，非引用產品實作）：第二份名單正常啟用，
 * 畫面顯示第二份名單的人數，不顯示 ACTIVATE_CONFLICT_MESSAGE。
 */

/** 全合成名單；保留米豆奶 OOXML 原形：inlineStr、無 sharedStrings、無 dimension。 */
async function workbook(variant: boolean): Promise<Buffer> {
  const rows = [
    ['人員代碼', '姓名', '所屬分校', '所屬班級', '年級', '標籤', '備註'],
    ['BASE', '合成基準生', '合成分校', '國小數學-三A[團]', '小三', '', ''],
    [variant ? 'VAR1' : 'BASE2', '合成第二名單生', '合成分校', '兒童美語-EA[團]', '小三', '', ''],
  ];
  const escape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  const sheetRows = rows
    .map(
      (row, index) =>
        `<row r="${index + 1}">${row
          .map((value, column) => `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`)
          .join('')}</row>`,
    )
    .join('');
  const xml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  zip.file('xl/worksheets/sheet1.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** 以頁面內按鈕走完一次上傳→啟用，全程不重整。 */
async function uploadAndActivate(page: import('@playwright/test').Page, name: string, buffer: Buffer): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: XLSX_MIME, buffer });
  const useBtn = page.getByRole('button', { name: '使用這份名單', exact: true });
  await expect(useBtn).toBeVisible({ timeout: 20_000 });
  await useBtn.click();
}

test.describe('R4-F02：同頁連續匯入兩份名單，第二份啟用不得因 revision 過期而 409', () => {
  test.setTimeout(180_000);

  test('啟用第一份後重新載入匯入頁再啟用第二份，應成功啟用第二份（#84：完成畫面已無「再匯入其他名單」）', async ({ page }) => {
    await page.goto('/imports');

    // 第一次：baseline 啟用成功。
    await uploadAndActivate(page, 'baseline.xlsx', await workbook(false));
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.success-stage-card')).toContainText('2 位學生資料已備妥');
    // #84：完成畫面只有導向 03 的主 CTA，沒有再匯入按鈕
    await expect(page.locator('.success-stage-card button')).toHaveCount(0);

    // #84 後的第二次匯入路徑：回到 02 匯入頁。
    await page.goto('/imports');
    await expect(page.locator('.step-item.step-active .step-text')).toHaveText('選擇檔案', { timeout: 10_000 });

    // 第二次：variant 啟用必須成功（這是 R4-F02 的失敗點）。
    await uploadAndActivate(page, 'variant.xlsx', await workbook(true));

    // 預期結果：進入完成階段，顯示第二份名單的人數。
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.success-stage-card')).toContainText('2 位學生資料已備妥');
    // 不得出現產品錯誤提示（.error-notice 為產品 ErrorNotice 元件的類別；
    // 不用 [role="alert"]，否則會誤抓 Next.js Dev Tools 的空 alert 容器）。
    await expect(page.locator('.error-notice')).toHaveCount(0);
  });

  test('真正的並行衝突仍必須 409 並顯示同一訊息（CAS 保護未被削弱）', async ({ page, browser }) => {
    // 先讓本頁處於可啟用的預覽狀態。
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'conflict.xlsx', mimeType: XLSX_MIME, buffer: await workbook(true),
    });
    await expect(page.getByRole('button', { name: '使用這份名單', exact: true })).toBeVisible({ timeout: 20_000 });

    // 另一個視窗在伺服器端完成另一次啟用，使 active.revision 前進。
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto('/imports');
    await otherPage.locator('input[type="file"]').setInputFiles({
      name: 'other.xlsx', mimeType: XLSX_MIME, buffer: await workbook(false),
    });
    await otherPage.getByRole('button', { name: '使用這份名單', exact: true }).click();
    await expect(otherPage.locator('.success-stage-card')).toBeVisible({ timeout: 20_000 });
    await other.close();

    // 本頁仍持有舊 revision：啟用必須被拒。
    await page.getByRole('button', { name: '使用這份名單', exact: true }).click();

    const notice = page.locator('.error-notice').first();
    await expect(notice).toBeVisible({ timeout: 20_000 });
    // user-messages.ts 的 ACTIVATE_CONFLICT_MESSAGE 文案不得被更動（整句比對）。
    await expect(notice.locator('.error-notice-message')).toHaveText(
      '資料已被其他操作更新（例如在另一個視窗使用了名單）。請重新整理頁面，確認目前的資料後再試一次。',
    );
    await expect(page.locator('.success-stage-card')).toHaveCount(0);
  });
});