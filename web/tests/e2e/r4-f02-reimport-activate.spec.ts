import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { XLSX_MIME } from './helpers/c-batch';

/**
 * R4-F02：同一個瀏覽器 session 內連續啟用兩份名單時，第二份的啟用因 expectedRevision 過期而 409。
 *
 * #84 移除「再匯入其他名單」後，完成畫面只剩一個導向 `/` 的 <Link>，沒有任何按鈕能把頁面
 * 帶回上傳階段；而檔案 input 只存在於 `{stage === 'upload' && ...}` 區塊。兩者合起來，
 * 「不重整頁面就啟用第二份」的產品路徑已完全不存在：
 * 唯一的回程出口是到 `/`，而 app shell 會在 pathname 改變時重掛載整棵元件樹，
 * `revision` 因此回到 server render 的最新值。所以本檔第一個 test 改以重新載入匯入頁
 * 走完整流程，斷言「第二份在新的頁面 session 中正常啟用」。
 *
 * 覆蓋現況（如實記錄，不宣稱不存在的覆蓋）:
 *   - **R4-F02 原先守護的「同 session 第二次啟用成功」在 #84 後已不可達且無守護。**
 *     若未來重新提供同頁連續啟用的入口（例如下載狀態、或讓完成畫面回到 preview 階段），
 *     `if (typeof json?.revision === 'number') setRevision(json.revision);` 必須重新被測試，
 *     否則該行等同死碼。此事實與其處置需由產品決策確認，本檔不宣稱已覆蓋。
 *   - 單元層不覆蓋 handleActivate：tests/unit/imports-workflow-ui.test.ts 全以
 *     renderToStaticMarkup 做 SSR 靜態渲染（vitest environment: 'node'），從不執行
 *     fetch 與狀態轉移。
 *   - imports.spec.ts 第二次啟用前有 page.goto('/imports')，同樣由 server render 重取
 *     revision，結構上不可能驗證「本頁持有的 revision 會隨啟用回應更新」。
 *   - 本檔第二個 test（另一個視窗造成的真衝突仍須 409 ＋ 訊息逐字比對）才是 CAS 保護
 *     目前的實際守護，且未受本次改動影響。
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

test.describe('R4-F02：同 session 連續匯入兩份名單，第二份啟用不得因 revision 過期而 409', () => {
  test.setTimeout(180_000);

  test('啟用第一份後重新載入匯入頁再啟用第二份，應成功啟用第二份（#84：完成畫面已無返回上傳階段的動作）', async ({ page }) => {
    await page.goto('/imports');

    // 第一次：baseline 啟用成功。
    await uploadAndActivate(page, 'baseline.xlsx', await workbook(false));
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.success-stage-card')).toContainText('2 位學生資料已備妥');
    // #84：完成畫面只有導向 03 的主 CTA，沒有再匯入按鈕
    await expect(page.locator('.success-stage-card button')).toHaveCount(0);

    // #84 後的第二次匯入路徑：回到 02 匯入頁（revision 由 server render 重取，見檔頭說明）。
    await page.goto('/imports');
    await expect(page.locator('.step-item.step-active .step-text')).toHaveText('選擇檔案', { timeout: 10_000 });

    // 第二次：variant 啟用必須成功。
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