import { test, expect, type Page, type Route } from '@playwright/test';
import fs from 'fs';
import JSZip from 'jszip';
import { FIXTURE, xlsxUpload } from './helpers/c-batch';

/**
 * N09／R3-F02（issue #55；specs/04 §8 UX70／UX46）：
 * 課表設定儲存後，待確認候選表、標題計數、頁籤 Badge 必須與班名比對報告同頁即時同步（無 reload）：
 *   1. 成功套用別名後，同頁從候選表中消失（非 reload 才消失）；
 *   2. 目標班級改名後，失效別名之米豆奶 raw 班即時重新浮現於候選表（含輸入欄位與計數），與上方比對報告一致；
 *   3. 檢視未啟用名單（?import=B）時，保持 B 的檢視範圍，儲存後報告與候選表皆為 B，不跳回現行 A；
 *   4. 重新取得報告失敗（500）時，保留最後已知候選表供繼續操作，明示資料未更新，下一次成功儲存後恢復；
 *   5. 未儲存之輸入草稿（candidateTargets）不因報告更新被覆寫。
 */

async function buildVariantRoster(): Promise<Buffer> {
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

async function renameWholeClass(page: Page, from: string, to: string) {
  await page.locator('input.input-classname').evaluateAll((inputs, args) => {
    const [from, to] = args as [string, string];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    for (const el of inputs) {
      if ((el as HTMLInputElement).value !== from) continue;
      setter?.call(el, to);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [from, to]);
}

test.describe('N09／R3-F02: 儲存後候選表、標題、頁籤與報告同步', () => {
  test('1. 核心雙向驗證：成功套用別名同頁消失 → 目標整班改名同頁浮現（無 reload）', async ({ page }) => {
    // 1. 匯入並啟用標準名冊 (477 人)
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    const useBtn = page.locator('button', { hasText: '使用這份名單' });
    await expect(useBtn).toBeVisible({ timeout: 15000 });
    await useBtn.click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    // 2. 進入課表設定的「班名對應」頁籤
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    const mappingTab = page.locator('button[role="tab"]', { hasText: '班名對應' });
    await mappingTab.click();
    await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

    const reportRosterOnly = page.getByRole('region', { name: '米豆奶有／系統無' });
    await expect(reportRosterOnly).toBeVisible({ timeout: 15000 });
    await expect(reportRosterOnly).toContainText('12 個班');
    await expect(mappingTab).toContainText('12');
    await expect(page.locator('.toolbar', { hasText: '待確認米豆奶班名' })).toContainText('(12)');

    // 3. 在候選表中為「國小國語文-小三四」填目標「國小國語文-小三小四」並勾選
    const targetRow = page.locator('tr', { hasText: '國小國語文-小三四' });
    await expect(targetRow).toBeVisible();
    await targetRow.locator('input.input-target-classname').fill('國小國語文-小三小四');
    await targetRow.locator('input[type="checkbox"]').check();
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 4. 點擊「確認變更」並儲存
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
    await expect(dialog).not.toBeVisible();

    // 5. 【驗證向一：成功套用別名同頁即時消失（無 reload）】
    // 頂部報告減少 1 班
    await expect(reportRosterOnly).toContainText('11 個班');
    await expect(reportRosterOnly.getByRole('row', { name: /國小國語文-小三四/ })).toHaveCount(0);
    // 頁籤 badge 即時更新為 11
    await expect(mappingTab).toContainText('11');
    // 工具列標題即時更新為 (11)
    await expect(page.locator('.toolbar', { hasText: '待確認米豆奶班名' })).toContainText('(11)');
    // 候選表格中「國小國語文-小三四」列即時消失
    await expect(page.locator('.mapping-table tr', { hasText: '國小國語文-小三四' })).toHaveCount(0);

    // 6. 切換至「課表」頁籤，整班改名使剛建立的別名失效
    await page.locator('button[role="tab"]', { hasText: '課表' }).click();
    await expect(page.locator('[data-class-attributes-panel]')).toBeVisible();
    await renameWholeClass(page, '國小國語文-小三小四', 'R3國文班驗收');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 7. 儲存改名變更
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });
    await expect(dialog).not.toBeVisible();

    // 8. 【驗證向二：目標改名後同頁切回「班名對應」即時重新浮現（無 reload，R3-F02 核心缺陷）】
    await mappingTab.click();
    await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

    // 頂部報告列出 12 個班，包含「國小國語文-小三四」12 人
    await expect(reportRosterOnly).toContainText('12 個班');
    await expect(reportRosterOnly.getByRole('row', { name: /國小國語文-小三四/ })).toBeVisible();

    // 頁籤 badge 即時同步為 12
    await expect(mappingTab).toContainText('12');
    // 工具列標題即時同步為 (12)
    await expect(page.locator('.toolbar', { hasText: '待確認米豆奶班名' })).toContainText('(12)');
    // 下方候選表格即時浮現「國小國語文-小三四」，且包含輸入欄位
    const resurfacedRow = page.locator('.mapping-table tr', { hasText: '國小國語文-小三四' });
    await expect(resurfacedRow).toBeVisible();
    await expect(resurfacedRow.locator('input.input-target-classname')).toBeVisible();
    await expect(resurfacedRow.locator('.pill', { hasText: '待確認' })).toBeVisible();
  });

  test('2. 檢視未啟用名單（?import=B）時，儲存別名維持 B 範圍與候選同步', async ({ page }) => {
    // 啟用名單 A
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    // 上傳未啟用名單 B
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(xlsxUpload('variant-roster.xlsx', await buildVariantRoster()));
    const summary = page.getByRole('region', { name: '班名比對摘要' });
    await expect(summary).toBeVisible({ timeout: 15000 });
    const link = summary.getByRole('link', { name: /完整班名比對報告/ });
    await expect(link).toBeVisible();
    const href = (await link.getAttribute('href'))!;
    const importB = new URL(href, 'http://local.test').searchParams.get('import')!;

    // 開啟 ?import=B
    await page.goto(href);
    const mappingTab = page.locator('button[role="tab"]', { hasText: '班名對應' });
    await expect(mappingTab).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

    // 建立別名「國小輔導-四年級B」->「國小輔導-四年級」
    const row = page.locator('.mapping-table tr', { hasText: '國小輔導-四年級B' });
    await expect(row).toBeVisible();
    await row.locator('input.input-target-classname').fill('國小輔導-四年級');
    await row.locator('input[type="checkbox"]').check();

    // 儲存
    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });

    // 驗證 URL 維持 import=B，候選表與報告同步減少 1 班且該班消失
    await expect(page).toHaveURL(new RegExp(`import=${importB}`));
    await expect(page.locator('.mapping-table tr', { hasText: '國小輔導-四年級B' })).toHaveCount(0);
  });

  test('3. 重新取得報告失敗（500）時，候選表保留最後已知狀態，明示資料未更新，且可繼續操作下一個 alias', async ({
    page,
  }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    await page.goto('/settings');
    const mappingTab = page.locator('button[role="tab"]', { hasText: '班名對應' });
    await mappingTab.click();
    await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

    // 注入一次 500 失敗
    let reportCalls = 0;
    await page.route('**/api/v1/settings/class-name-report**', async (route: Route) => {
      reportCalls += 1;
      if (reportCalls === 1) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server error"}' });
      }
      return route.continue();
    });

    // 儲存第一個 alias
    const row1 = page.locator('.mapping-table tr', { hasText: '小六數學加強班' });
    await expect(row1).toBeVisible();
    await row1.locator('input.input-target-classname').fill('小六加強班-數學');
    await row1.locator('input[type="checkbox"]').check();

    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });

    // 驗證出現無法取得最新報告的 Alert
    const staleNotice = page.getByRole('alert').filter({ hasText: '無法取得最新的班名比對報告' });
    await expect(staleNotice).toBeVisible({ timeout: 15000 });

    // 候選表格不得清空消失！依然可以操作第二個 alias
    const row2 = page.locator('.mapping-table tr', { hasText: '國小輔導-四年級A' });
    await expect(row2).toBeVisible();
    await row2.locator('input.input-target-classname').fill('國小輔導-四年級');
    await row2.locator('input[type="checkbox"]').check();

    // 第二次儲存（此時 GET 成功）
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });

    // 警示消失，數字與候選表同步減少 2 班
    await expect(staleNotice).toHaveCount(0, { timeout: 15000 });
    await expect(mappingTab).toContainText('10');
    await expect(page.locator('.toolbar', { hasText: '待確認米豆奶班名' })).toContainText('(10)');
    await expect(page.locator('.mapping-table tr', { hasText: '小六數學加強班' })).toHaveCount(0);
    await expect(page.locator('.mapping-table tr', { hasText: '國小輔導-四年級A' })).toHaveCount(0);
  });

  test('4. 未儲存之輸入草稿（candidateTargets）不因報告更新被覆寫', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    await page.goto('/settings');
    const mappingTab = page.locator('button[role="tab"]', { hasText: '班名對應' });
    await mappingTab.click();
    await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });

    // 使用者在「交通車」輸入了目標，但未勾選（保留為草稿）
    const row = page.locator('.mapping-table tr', { hasText: '交通車' });
    await expect(row).toBeVisible();
    await row.locator('input.input-target-classname').fill('兒童美語-Gino');

    // 切到課表頁改時段並儲存
    await page.locator('button[role="tab"]', { hasText: '課表' }).click();
    const startTimeInput = page.locator('input.input-time').first();
    await startTimeInput.fill('09:30');
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    await page.locator('button', { hasText: '確認變更' }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await dialog.locator('button', { hasText: '儲存並更新結果' }).click();
    await expect(page.locator('#toast')).toContainText('課表已套用並完成重算', { timeout: 15000 });

    // 切回班名對應，確認「交通車」輸入的草稿目標值完好保留
    await mappingTab.click();
    const targetInput = page.locator('.mapping-table tr', { hasText: '交通車' }).locator('input.input-target-classname');
    await expect(targetInput).toHaveValue('兒童美語-Gino');
  });
});
