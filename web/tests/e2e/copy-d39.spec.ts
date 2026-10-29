import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  activateFixture,
  brokenXlsx,
  classRow,
  classRows,
  duplicateCodeXlsx,
  missingHeadersXlsx,
  openClassSchedule,
  openSchedule,
  xlsxUpload,
} from './helpers/c-batch';

/**
 * specs/04 UX32／09 §7（11 C；D39）：使用者實際會走到的四處定稿文案，以及空白星期的 preview／儲存契約。
 *
 * 每個案例都走真實操作（上傳損毀檔、改課表、兩個視窗互相覆蓋…），不是只看靜態字串；
 * 工程代碼（INVALID_XLSX、INVALID_DRAFT…）只允許出現在可展開的「詳細資訊」裡，收合時看不到。
 * 會寫入課表的案例放在最後。
 */

const FOOTER_TEXT = '整班重疊加總後，不足 0.3 天不扣、0.3～0.8 天扣半天、0.8 天以上扣 1 天';
const CORRUPT_TEXT = '無法讀取這個 Excel 檔案，請重新從米豆奶匯出後再上傳。';
const MISSING_HEADERS_TEXT = '這個 Excel 檔案缺少必要的欄位，請確認是從米豆奶匯出的名單後再上傳。';
const DUPLICATE_CODE_TEXT = '名單裡有重複的人員代碼（同一個人員代碼只能出現一列），請確認匯出的名單後再上傳。';
const CONFLICT_TEXT = '資料已更新（例如在另一個視窗儲存了課表）。請重新整理頁面，再重新確認變更。';
const EXPIRED_TEXT = '預覽已逾期，請關閉視窗後重新按「確認變更」。';
const FAILED_TEXT = '暫時無法完成，請稍後再試；您的修改還在畫面上，沒有遺失。';
const impactSentence = (before: number, after: number) => `系統計算天數與米豆奶入班天數不符：${before} 人 → ${after} 人`;

/** 用 innerText 判斷「使用者看得到的文字」：收合的 <details> 內容不算。 */
const visibleText = async (l: Locator): Promise<string> => (await l.innerText()).replace(/\s+/g, ' ');

/** 錯誤區塊：白話主文＋可展開的「詳細資訊」（預設收合；展開後才看得到代碼）。 */
async function expectPlainErrorWithDetails(block: Locator, plain: string, code: string, forbidden: RegExp) {
  await expect(block).toContainText(plain, { useInnerText: true });
  const shown = await visibleText(block);
  expect(shown, `主畫面不得外露：${shown}`).not.toMatch(forbidden);
  expect(shown).not.toContain(code);
  const details = block.locator('details');
  await expect(details).toHaveCount(1);
  await expect(details.locator('summary')).toHaveText('詳細資訊');
  await expect(details).toHaveJSProperty('open', false);
  await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', true);
  await expect(details).toContainText(code, { useInnerText: true });
}

const ENGINEERING = /INVALID_|MISSING_|DUPLICATE_|REVISION_|PREVIEW_|SETTINGS_|SQLITE|mismatch|D24|revision|設定草稿格式錯誤|\[[A-Z_]{4,}\]|\bZIP\b|XLSX/i;

test.describe('UX32 D39 (2) 課表頁尾', () => {
  test('頁尾改為白話取整規則，不含決策編號「D24」', async ({ page }) => {
    await openSchedule(page);
    const foot = page.locator('.tablefoot');
    await expect(foot).toContainText(FOOTER_TEXT);
    await expect(foot).not.toContainText('D24');
    await expect(page.locator('main')).not.toContainText(/\bD\d{2}\b/, { useInnerText: true });
  });
});

test.describe('UX32 D39 (3) 匯入錯誤：白話主文＋可展開的詳細資訊', () => {
  async function upload(page: Page, name: string, buffer: Buffer) {
    await page.goto('/imports');
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await page.locator('input[type="file"]').setInputFiles(xlsxUpload(name, buffer));
    const alert = page.locator('.alert-danger');
    await expect(alert).toBeVisible({ timeout: 15000 });
    return alert;
  }

  test('損毀檔案：「無法讀取這個 Excel 檔案，請重新從米豆奶匯出後再上傳。」，INVALID_XLSX 只在詳細資訊', async ({ page }) => {
    const alert = await upload(page, 'broken.xlsx', brokenXlsx());
    await expectPlainErrorWithDetails(alert, CORRUPT_TEXT, 'INVALID_XLSX', ENGINEERING);
    // 舊的「[代碼] 訊息」格式不再出現
    await expect(alert).not.toContainText(/\[[A-Z_]+\]/, { useInnerText: true });
  });

  test('缺少必要欄位的 Excel：白話說明，代碼與缺少的欄位在詳細資訊', async ({ page }) => {
    const alert = await upload(page, 'wrong-headers.xlsx', await missingHeadersXlsx());
    await expectPlainErrorWithDetails(alert, MISSING_HEADERS_TEXT, 'MISSING_REQUIRED_HEADERS', ENGINEERING);
  });

  test('同一個人員代碼出現兩列：白話說明，代碼與列號在詳細資訊', async ({ page }) => {
    const alert = await upload(page, 'duplicate-code.xlsx', await duplicateCodeXlsx());
    await expectPlainErrorWithDetails(alert, DUPLICATE_CODE_TEXT, 'DUPLICATE_PERSON_CODE', ENGINEERING);
  });
});

test.describe('UX32 D39 (4) 問題類型：只顯示中文名稱，代碼在明細技術資訊', () => {
  test('總表「需確認」欄的徽章與明細抽屜：中文名稱與白話說明；代碼只在展開的技術資訊', async ({ page }) => {
    await activateFixture(page);
    await page.goto('/');
    await expect(page.locator('.results-table tbody tr').first()).toBeVisible({ timeout: 15000 });

    // 全部徽章文字：沒有任何英文代碼
    const badges = await page.locator('.results-table tbody .badge-warn').allInnerTexts();
    expect(badges.length, '需要有待確認的學生才能驗證').toBeGreaterThan(0);
    for (const b of badges) expect(b, `徽章：${b}`).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    // #157 Ruling 3：未對應課表的班一律產生 CLASS_NOT_MAPPED（中文「班名未對應課表」），
    // 取代舊制對「缺排課」（SCHEDULE_NOT_FOUND，中文「排課缺漏」）的提示——
    // 這兩個 fixture 學生報的班根本不在課表設定內，說「缺排課」並不準確。
    expect(badges).toContain('班名未對應課表');

    // 篩出「班名未對應課表」→ 開第一位的明細抽屜
    const row = page.locator('.results-table tbody tr', { hasText: '班名未對應課表' }).first();
    await expect(row).toBeVisible();
    await row.click();
    const drawer = page.getByRole('dialog').first();
    await expect(drawer).toBeVisible();

    const warning = drawer.locator('.alert-warning').first();
    const text = await visibleText(warning);
    expect(text).toContain('班名未對應課表');
    expect(text).toContain('班名同步');
    expect(text, `抽屜待確認事項不得外露代碼或工程詞：${text}`).not.toMatch(/CLASS_NOT_MAPPED|\[[A-Z_]+\]|fallback|種子|alias/i);

    // 技術資訊預設收合；展開後才看得到問題代碼
    const tech = drawer.locator('details', { has: page.locator('summary', { hasText: '技術資訊' }) });
    await expect(tech).toHaveJSProperty('open', false);
    await tech.locator('summary').click();
    await expect(tech).toContainText('CLASS_NOT_MAPPED', { useInnerText: true });
  });
});

async function openSync(page: Page): Promise<void> {
  await page.goto('/settings');
  await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
  await page.locator('button[role="tab"]', { hasText: '班名同步' }).click();
  await expect(page.locator('[data-class-name-sync-panel]')).toBeVisible({ timeout: 10000 });
}

test.describe('UX32 D39 (1) 課表影響預覽：單位是「人」', () => {
  test('有現行資料時：「系統計算天數與米豆奶入班天數不符：N 人 → M 人」，數字取自實際預覽；沒有 mismatch／筆', async ({ page }) => {
    await activateFixture(page);
    await openSync(page);
    const row = page.locator('tr[data-mismatch-row="國小數學-一"]');
    await row.locator('button', { hasText: '同步到既有班級' }).click();
    await page.locator('select[aria-label="選擇同步目標課表班級"]').selectOption({ value: '國小數學-一A' });
    await page.locator('button', { hasText: '暫存同步' }).click();

    const previewResponse = page.waitForResponse((r) => r.url().includes('/api/v1/settings/preview') && r.request().method() === 'POST');
    await page.locator('button', { hasText: '確認變更' }).click();
    const preview = await (await previewResponse).json();
    const before = preview.mismatchBefore as number;
    const after = preview.mismatchAfter as number;
    expect(Number.isInteger(before) && Number.isInteger(after)).toBe(true);
    // D18 既有基準：fixture 原有 4 位、設定後 17 位（每位學生任一級距比較不符計 1 人）
    expect([before, after]).toEqual([4, 17]);

    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog).toContainText(impactSentence(before, after), { useInnerText: true });
    const shown = await visibleText(dialog);
    expect(shown).not.toMatch(/mismatch/i);
    // 單位是人，不是筆（明細表標題「前 50 筆」是列數，不在此限）
    const card = dialog.locator('.metric-card', { hasText: '系統計算天數與米豆奶入班天數不符' });
    expect(await visibleText(card)).not.toContain('筆');
    expect(shown).not.toMatch(/→\s*\d+\s*筆/);
  });
});

test.describe('UX32／D-1：空白星期成功預覽與確認視窗錯誤白話呈現', () => {
  const dialogOf = (page: Page) => page.locator('dialog.impact-dialog');
  const errorOf = (page: Page) => dialogOf(page).locator('[data-dialog-error]');

  test('空白星期的時段進 incompleteSessions：preview 回實際影響、可儲存並在 reload 後保留', async ({ page }) => {
    // 此測試明確啟用匿名合成名單；保留原有「有學生」路徑，並以 Chevady 班實測有實際天數變動，
    // 不把 `affectedStudents: 0`／「未改變」偽裝成 settings_only。該語意另由 response.mode 驗證。
    await activateFixture(page);
    await openClassSchedule(page, '兒童美語-Chevady');
    const row = classRow(page, '兒童美語-Chevady');
    const weekday = row.locator('input.input-weekday');
    const times = row.locator('input.input-time');
    const originalWeekday = await weekday.inputValue();
    const originalStart = await times.nth(0).inputValue();
    const originalEnd = await times.nth(1).inputValue();
    expect(originalWeekday).not.toBe('');
    expect(originalStart).not.toBe('');
    expect(originalEnd).not.toBe('');

    await weekday.fill('');
    await page.waitForTimeout(500);

    const previewRequest = page.waitForRequest(
      (request) => request.url().includes('/api/v1/settings/preview') && request.method() === 'POST'
    );
    const previewResponse = page.waitForResponse(
      (response) => response.url().includes('/api/v1/settings/preview') && response.request().method() === 'POST'
    );
    await page.locator('button', { hasText: '確認變更' }).click();
    const [request, response] = await Promise.all([previewRequest, previewResponse]);
    expect(response.status()).toBe(200);

    const requestBody = JSON.parse(request.postData() ?? '{}');
    const changedClass = requestBody.draft.classes.find(
      (item: { baseName: string }) => item.baseName === '兒童美語-Chevady'
    );
    expect(changedClass).toBeDefined();
    const toMinutes = (value: string) => {
      const [hours, minutes] = value.split(':').map(Number);
      return hours * 60 + minutes;
    };
    expect(changedClass.incompleteSessions).toContainEqual(
      expect.objectContaining({
        weekday: '',
        startMinutes: toMinutes(originalStart),
        endMinutes: toMinutes(originalEnd),
      })
    );
    expect(changedClass.sessions).not.toContainEqual(
      expect.objectContaining({
        weekday: '',
        startMinutes: toMinutes(originalStart),
        endMinutes: toMinutes(originalEnd),
      })
    );

    const preview = await response.json();
    expect(preview.mode).toBe('with_students');
    expect(preview.affectedStudents).toBeGreaterThan(0);
    expect(preview.dayDeltas.length).toBeGreaterThan(0);

    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible({ timeout: 15000 });
    const impactCard = dialog.locator('.metric-card', { hasText: '受影響學生數' });
    await expect(impactCard.locator('.metric-value')).toHaveText(`${preview.affectedStudents} 人`);
    const shown = await visibleText(dialog);
    expect(shown).not.toContain('尚未匯入學生');
    expect(shown).not.toContain('本次課表變更未改變現行學生的收費天數');

    const save = dialog.getByRole('button', { name: '儲存並更新結果' });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator('#toast')).toContainText('課表已', { timeout: 30000 });

    await page.reload();
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    const persistedRows = await classRows(page, '兒童美語-Chevady').all();
    const persistedSlots = await Promise.all(
      persistedRows.map(async (savedRow) => ({
        weekday: await savedRow.locator('input.input-weekday').inputValue(),
        start: await savedRow.locator('input.input-time').nth(0).inputValue(),
        end: await savedRow.locator('input.input-time').nth(1).inputValue(),
      }))
    );
    expect(persistedSlots).toContainEqual({ weekday: '', start: originalStart, end: originalEnd });
  });

  test('預覽伺服器錯誤（500）：白話說明「稍後再試、修改還在」，原始錯誤在詳細資訊', async ({ page }) => {
    await activateFixture(page);
    await openSchedule(page);
    await page.route('**/api/v1/settings/preview', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'SQLITE_BUSY: database is locked', code: 'SETTINGS_PREVIEW_FAILED' }) })
    );
    await classRow(page, '兒童美語-Gino').locator('input.input-time').first().fill('15:45');
    await page.waitForTimeout(500);
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(dialogOf(page)).toBeVisible({ timeout: 15000 });
    await expectPlainErrorWithDetails(errorOf(page), FAILED_TEXT, 'SETTINGS_PREVIEW_FAILED', ENGINEERING);
  });

  test('套用時預覽已逾期：白話說明並可重新確認，PREVIEW_EXPIRED 只在詳細資訊', async ({ page }) => {
    await activateFixture(page);
    await openSchedule(page);
    await classRow(page, '兒童美語-Gino').locator('input.input-time').first().fill('15:45');
    await page.waitForTimeout(500);
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(dialogOf(page)).toBeVisible({ timeout: 15000 });
    const apply = dialogOf(page).getByRole('button', { name: /^儲存/ });
    await expect(apply).toBeEnabled({ timeout: 15000 });

    await page.route('**/api/v1/settings/apply', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'PREVIEW_EXPIRED: 預覽已過期', code: 'PREVIEW_EXPIRED' }) })
    );
    await apply.click();
    await expectPlainErrorWithDetails(errorOf(page), EXPIRED_TEXT, 'PREVIEW_EXPIRED', ENGINEERING);
  });
});

test.describe('UX32 兩個視窗互相覆蓋（會寫入課表，放最後）', () => {
  test('另一個視窗先儲存 → 這個視窗按「確認變更」：409 以白話說明「資料已更新」，REVISION_CONFLICT 只在詳細資訊', async ({ browser }) => {
    const context = await browser.newContext();
    const a = await context.newPage();
    const b = await context.newPage();
    const base = process.env.E2E_PORT ? `http://127.0.0.1:${process.env.E2E_PORT}` : 'http://127.0.0.1:3100';
    try {
      // 兩個視窗都必須先切到該班所在頁籤（D61：預設安親頁籤沒有時段欄）。
      // 用 goto 深連結而不是原本的 /settings：本案例只在乎同一個 run 的 revision，
      // 不需要兩個視窗各自保留歷史。
      for (const p of [a, b]) {
        await p.goto(`${base}/settings?class=${encodeURIComponent('兒童美語-Gino')}`);
        await expect(p.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
        await expect(classRow(p, '兒童美語-Gino')).toBeVisible({ timeout: 15000 });
      }
      const start = (p: Page) => classRow(p, '兒童美語-Gino').locator('input.input-time').first();

      // 視窗 B 先儲存
      await start(b).fill('15:45');
      await b.waitForTimeout(500);
      await b.locator('button', { hasText: '確認變更' }).click();
      const impactB = b.locator('dialog.impact-dialog');
      await expect(impactB).toBeVisible({ timeout: 15000 });
      await impactB.getByRole('button', { name: /^儲存/ }).click();
      await expect(b.locator('#toast')).toContainText('課表已', { timeout: 30000 });

      // 視窗 A 用舊版本按「確認變更」
      await start(a).fill('15:50');
      await a.waitForTimeout(500);
      await a.locator('button', { hasText: '確認變更' }).click();
      const impactA = a.locator('dialog.impact-dialog');
      await expect(impactA).toBeVisible({ timeout: 15000 });
      const err = impactA.locator('[data-dialog-error]');
      await expect(err).toBeVisible();
      await expectPlainErrorWithDetails(err, CONFLICT_TEXT, 'REVISION_CONFLICT', ENGINEERING);
      await expect(impactA.getByRole('button', { name: /^儲存/ })).toBeDisabled();
    } finally {
      await context.close();
    }
  });
});
