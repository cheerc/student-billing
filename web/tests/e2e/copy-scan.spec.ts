import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { openFilter, applyFilter } from './helpers/header-filter';
import { brokenXlsx, missingHeadersXlsx, sideLink, xlsxUpload } from './helpers/c-batch';

/**
 * R5 文案全頁掃描（specs/09 §7；specs/04 UX16 相關；specs/10 §5）。
 *
 * 方法：對每一頁、每一種可到達的狀態，取瀏覽器實際「可見」的文字
 * （document.body.innerText，不含收合中的 <details>、不含被隱藏的元素）加上可見元素的
 * aria-label／title／placeholder／alt，掃描 09 §7 文案表列為「日常介面不得出現」的字。
 * 技術資訊可查，但必須收在摺疊區——摺疊區內的內容不算日常介面，展開才看得到。
 *
 * 批次 C（11 C；D39；UX32）擴充：
 *   - 問題類型代碼（SCHEDULE_NOT_FOUND 等）不再是例外：日常介面只顯示中文名稱，代碼在明細的技術資訊摺疊區（D39 (4)）。
 *   - 禁用字新增：mismatch、決策／規則編號（D24 等）、大寫底線的錯誤／問題代碼（INVALID_XLSX 等）、「設定草稿格式錯誤」、
 *     fallback／排課種子、英文系統錯誤（Failed to fetch、404 預設頁）。
 *   - 新增「使用者實際會走到」的狀態：課表警告（非法／空白星期、計算失敗）、離頁確認、確認視窗的失敗態（預覽 400／409／逾期）、
 *     匯入錯誤（損毀檔案、缺欄位）、有待確認事項的學生明細、總表查詢失敗、404 與歷史找不到。
 *     R5 的掃描漏掉了這些實際狀態，工程字才會被使用者看到；之後新增任何畫面狀態都要加進這份清單。
 *
 * 例外（有依據，不是放寬）：檔名、人員代碼、學生姓名是資料，不是文案。
 *
 * 一次跑完所有狀態，最後統一斷言「違規清單為空」，失敗時一次列出全部違規（頁面／狀態／命中字／上下文）。
 * 本檔也是文案回歸：之後任何頁面把工程字放回日常介面都會在這裡變紅。
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

/** scan() 呼叫次數（每個頁面狀態一次，標籤不得重複）。 */
const EXPECTED_STATES = 47; // #112 PR-1C/PR-2 原為 49；#155 移除 2 處課程類型切換確認對話框掃描（非安親轉安親、安親轉非安親）→ 47

/** 09 §7 文案表 ＋ 任務清單：日常介面不得出現。 */
const FORBIDDEN: Array<{ term: string; re: RegExp }> = [
  { term: 'P1', re: /\bP1\b/ },
  { term: '展示A/B/C', re: /展示\s*[ABC]\b/ },
  { term: 'localhost／原型', re: /localhost|原型/i },
  { term: 'Run', re: /\bRun\b/ },
  { term: 'rev', re: /\brev\b/i },
  { term: 'Run ID／ID', re: /\bID\b/ },
  { term: '長ID（英數雜湊或帶前綴的識別碼）', re: /\b(?:imp|run|prev|setprev|set)_[A-Za-z0-9_-]{6,}|[0-9a-f]{16,}/ },
  { term: 'alias', re: /alias/i },
  { term: 'baseName', re: /baseName/i },
  { term: 'dry-run', re: /dry[-_ ]?run/i },
  { term: 'active', re: /\bactive\b/i },
  { term: 'OOXML', re: /OOXML/i },
  { term: 'inlineStr', re: /inlineStr/i },
  { term: 'DB路徑', re: /DB\s*路徑|資料庫[^。\n]{0,8}路徑|\.sqlite|Local Storage|儲存路徑/i },
  { term: '雙軌差異JSON／JSON', re: /雙軌|\bJSON\b/i },
  { term: 'PREVIEW_EXPIRED', re: /PREVIEW_EXPIRED/ },
  { term: 'REVISION_CONFLICT', re: /REVISION_CONFLICT/ },
  { term: 'API', re: /\bAPI\b/ },
  { term: '雜湊／SHA／hash', re: /雜湊|\bSHA\b|\bhash\b/i },
  { term: '英文操作提示（應為中文）', re: /Upload XLSX|\(Settings\)|Storage Path/ },
  { term: 'token（解析器內部名詞，日常說「報名班級」）', re: /\btokens?\b/i },
  { term: '規則編號（R04 等 spec 內部編號）', re: /\bR\d{2}\b/ },
  // ── 批次 C（D39；UX32）──
  { term: 'mismatch', re: /mismatch/i },
  { term: '決策／規則編號（D24 等）', re: /\bD\d{2}\b/ },
  { term: '英文錯誤／問題代碼（大寫底線，如 INVALID_XLSX、SCHEDULE_NOT_FOUND）', re: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/ },
  { term: '設定草稿格式錯誤（zod 訊息）', re: /設定草稿格式錯誤/ },
  { term: 'fallback／排課種子', re: /fallback|排課種子/i },
  { term: '版本識別（erp-tag、v2 等）', re: /erp-tag|\bv[0-9]\b/i },
  { term: '英文系統錯誤', re: /Failed to fetch|TypeError|Unexpected token|NetworkError|Internal Server Error|This page could not be found|SQLITE/i },
  { term: '英文標籤（Match／Mismatch）', re: /\((?:Match|Mismatch)\)/ },
];

interface Violation {
  where: string;
  term: string;
  context: string;
}

async function visibleCopy(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.body.innerText];
    document.querySelectorAll('[aria-label],[title],[placeholder],[alt]').forEach((el) => {
      // 收合的 <details>／隱藏元素不算日常介面
      if (!(el as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true, contentVisibilityAuto: true })) return;
      for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute(attr);
        if (v) parts.push(v);
      }
    });
    return parts.join('\n');
  });
}

/** 已掃描的狀態；最後核對數量，避免某個狀態被無聲略過。 */
const scanned: string[] = [];

async function scan(page: Page, where: string, out: Violation[]) {
  const raw = await visibleCopy(page);
  // 掃到空白頁不代表乾淨：每個狀態都必須有實質文字
  expect(raw.trim().length, `「${where}」沒有取到任何可見文字，掃描無效`).toBeGreaterThan(30);
  scanned.push(where);
  const text = raw;
  for (const { term, re } of FORBIDDEN) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      const at = m.index ?? 0;
      out.push({ where, term, context: text.slice(Math.max(0, at - 18), at + m[0].length + 18).replace(/\s+/g, ' ') });
    }
  }
}

test.describe('R5 文案全頁掃描（09 §7）', () => {
  test('每一頁每一種可到達的狀態：日常介面沒有工程字，技術資訊只在摺疊區', async ({ page }) => {
    test.setTimeout(180_000);
    const violations: Violation[] = [];

    // ── A. 全新資料庫（初始、只有課表）──────────────────────────
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await scan(page, '首頁｜初始空狀態', violations);

    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜課表頁籤（空 DB）', violations);

    // 課表警告態（批次 C）：非法星期、空白星期、計算失敗、離頁確認——使用者改課表時實際會看到的畫面
    const row3 = page.locator('.schedule-table tbody tr').nth(3);
    const cancelEdits = async () => {
      await page.locator('button', { hasText: '取消修改' }).click();
      await expect(page.locator('.save-status-dirty')).toHaveCount(0);
    };
    await row3.locator('input.input-weekday').fill('八');
    await expect(page.locator('[data-unknown-weekday-notice]')).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜星期無法識別（非法星期）', violations);
    await row3.locator('input.input-weekday').fill('');
    await expect(page.locator('[data-unknown-weekday-notice]')).toContainText('沒有填星期', { timeout: 10000 });
    await scan(page, '課表設定｜星期無法識別（空白星期）', violations);
    await cancelEdits();

    await page.route('**/api/v1/settings/calculate', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'SQLITE_ERROR: internal failure' }) })
    );
    await row3.locator('input.input-time').first().fill('14:10');
    await expect(page.locator('[data-calculate-error]')).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜計算失敗', violations);
    await page.unroute('**/api/v1/settings/calculate');
    await cancelEdits();

    // #81（本 PR 新增的畫面狀態，依 09:254 必須加入掃描清單）：上傳非課表檔 →
    // 整批拒絕的白話錯誤（錯誤訊息本身不得含工程字）
    await page.locator('input[type="file"]').setInputFiles({
      name: 'not-a-schedule.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('這不是 Excel'),
    });
    await expect(page.locator('[data-schedule-import-error]')).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜課表 Excel 匯入失敗（整批拒絕）', violations);

    // #82／#80（本 PR 新增的畫面狀態）：「未設定時間」說明按鈕（focus 才開 tooltip，
    // 內容不得含工程字）
    // #157：「自動設定」／「未手動修改」兩處文案已隨 Ruling 4 拆除，課表操作欄不再有它們。
    await page.reload();
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    const notSetTip = page.getByRole('button', { name: '未設定時間' }).first();
    await notSetTip.focus();
    await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜未設定時間說明（tooltip）', violations);
    await page.keyboard.press('Escape');

    await row3.locator('input.input-time').first().fill('14:20');
    await sideLink(page, /匯入學生/).click();
    const leave = page.getByRole('dialog', { name: '有尚未儲存的課表修改' });
    await expect(leave).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜離頁確認視窗', violations);
    await leave.getByRole('button', { name: '繼續編輯' }).click();
    await cancelEdits();

    await page.locator('button', { hasText: '班名對應' }).click();
    await page.waitForTimeout(300);
    await scan(page, '課表設定｜班名對應頁籤（尚未匯入）', violations);
    await page.locator('button', { hasText: /^課表/ }).first().click();

    await page.locator('input.input-time').first().fill('13:30');
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(page.locator('dialog.impact-dialog')).toBeVisible({ timeout: 15000 });
    await scan(page, '課表設定｜確認變更視窗（只有課表）', violations);
    await page.keyboard.press('Escape');
    await cancelEdits();

    // specs/14 1C（新增畫面狀態）：新增班級選安親、安親頁籤、焦點定位
    await page.getByRole('button', { name: /＋ 新增班級|＋ 新增時段/ }).click();
    await page.locator('select[aria-label="新增班級課程類型"]').selectOption('care');
    await scan(page, '課表設定｜新增班級表單（選安親課輔班）', violations);
    await page.getByRole('button', { name: '取消新增' }).click();

    await page.locator('#class-type-tab-care').click();
    await scan(page, '課表設定｜安親課輔班頁籤', violations);

    await page.goto(`/settings?tab=schedule&class=${encodeURIComponent('兒童美語-Gino')}`);
    await expect(page.locator('[data-focus-class]')).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜焦點班級定位（存在班級）', violations);

    await page.goto(`/settings?tab=schedule&class=${encodeURIComponent('不存在的班級')}`);
    await expect(page.locator('[data-focus-class-missing]')).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜焦點班級定位（班級不存在）', violations);

    await page.goto('/imports');
    await scan(page, '匯入學生｜選擇檔案', violations);

    // 匯入錯誤：損毀檔案、缺少必要欄位（D39 (3)；錯誤代碼只在收合的「詳細資訊」裡）
    await page.locator('input[type="file"]').setInputFiles(xlsxUpload('broken.xlsx', brokenXlsx()));
    await expect(page.locator('.alert-danger')).toBeVisible({ timeout: 15000 });
    await scan(page, '匯入學生｜損毀檔案錯誤', violations);
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(xlsxUpload('wrong-headers.xlsx', await missingHeadersXlsx()));
    await expect(page.locator('.alert-danger')).toBeVisible({ timeout: 15000 });
    await scan(page, '匯入學生｜缺少必要欄位錯誤', violations);

    await page.goto('/history');
    await scan(page, '匯入紀錄｜空狀態', violations);

    // 打錯網址與找不到的歷史紀錄：不得是英文預設頁
    await page.goto('/no-such-page');
    await scan(page, '找不到頁面（404）', violations);
    await page.goto('/history/not-a-real-run');
    await scan(page, '歷史檢視｜找不到這筆紀錄', violations);

    // ── B. 已上傳、未使用 ────────────────────────────────────────
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await scan(page, '匯入學生｜確認名單（預覽）', violations);

    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await scan(page, '首頁｜已匯入、尚未使用', violations);

    // #83：未使用的名單不是匯入 → 匯入紀錄仍是空狀態（這是使用者看得到的實際狀態）
    await page.goto('/history');
    await expect(page.getByText('還沒有匯入紀錄')).toBeVisible();
    await scan(page, '匯入紀錄｜空狀態（未使用的名單不是匯入）', violations);

    // ── C. 重傳同檔（判重）→ 使用這份名單 → 完成 ─────────────────
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('button', { hasText: '使用這份名單' })).toBeVisible({ timeout: 15000 });
    // #83：同名判重不產生任何警示文案（ERP 固定檔名是正常操作）
    await expect(page.getByText('已經上傳過同名檔案')).toHaveCount(0);
    await expect(page.getByText('重複上傳')).toHaveCount(0);
    await scan(page, '匯入學生｜確認名單（重傳同名檔案，無警示）', violations);
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
    await scan(page, '匯入學生｜完成', violations);
    await page.locator('a', { hasText: '前往核對結果' }).click();

    // ── D. 核對結果 ──────────────────────────────────────────────
    await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
    await scan(page, '核對結果｜學生總表', violations);

    await page.locator('.results-table tbody tr').first().click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await scan(page, '核對結果｜學生明細抽屜', violations);
    await page.keyboard.press('Escape');

    // 有待確認事項的學生（非只有「天數不同」）：抽屜要列出問題類型與說明——R5 沒有掃到的實際狀態
    const issueRow = page
      .locator('.results-table tbody tr')
      .filter({ has: page.locator('.badge-warn', { hasNotText: '天數不同' }) })
      .first();
    await expect(issueRow).toBeVisible();
    await issueRow.click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await scan(page, '核對結果｜學生明細抽屜（有待確認事項）', violations);
    await page.keyboard.press('Escape');

    const search = page.locator('input[placeholder*="搜尋"]').first();
    await search.fill('沒有這個學生');
    await expect(page.getByText('沒有符合條件的學生')).toBeVisible({ timeout: 10000 });
    await scan(page, '核對結果｜空篩選', violations);
    await page.locator('button', { hasText: '清除篩選條件' }).click();

    // 總表查詢失敗（伺服器錯誤、連線中斷）：白話說明，不外露英文系統錯誤
    const studentsApi = '**/api/v1/runs/*/students*';
    await page.route(studentsApi, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'SQLITE_ERROR: no such column' }) })
    );
    await search.fill('觸發查詢失敗');
    await expect(page.locator('.alert-danger')).toBeVisible({ timeout: 10000 });
    await scan(page, '核對結果｜查詢失敗（伺服器錯誤）', violations);
    await page.unroute(studentsApi);
    await page.route(studentsApi, (route) => route.abort('failed'));
    await search.fill('再次觸發查詢失敗');
    await expect(page.locator('.alert-danger')).toBeVisible({ timeout: 10000 });
    await scan(page, '核對結果｜查詢失敗（連線中斷）', violations);
    await page.unroute(studentsApi);
    await search.fill('');
    await expect(page.locator('.results-table tbody tr').first()).toBeVisible({ timeout: 10000 });

    // 表頭篩選面板（D36）：面板內的文案與選項也在日常介面內，一併掃描
    const classPanel = await openFilter(page, '所屬班級');
    await expect(classPanel).toBeVisible();
    await scan(page, '核對結果｜表頭篩選面板（所屬班級）', violations);
    await page.keyboard.press('Escape');
    const issuePanel = await openFilter(page, '需確認');
    await expect(issuePanel).toBeVisible();
    await scan(page, '核對結果｜表頭篩選面板（需確認）', violations);
    await page.keyboard.press('Escape');

    await applyFilter(page, '所屬班級', { pick: ['國小數學-一'] });
    await expect(page.locator('.notice-warn')).toBeVisible();
    await scan(page, '核對結果｜已套用篩選條件與待設定班級提示', violations);
    await page.getByRole('button', { name: '清除全部' }).click();

    await page.locator('button[role="tab"]', { hasText: '班級扣天' }).click();
    await expect(page.locator('.deductions-table')).toBeVisible();
    await scan(page, '核對結果｜班級扣天', violations);
    await page.locator('.deductions-table tbody tr').first().locator('button').first().click();
    await scan(page, '核對結果｜班級扣天（展開逐堂）', violations);

    // ── E. 匯入紀錄與歷史檢視 ────────────────────────────────────
    await page.goto('/history');
    await expect(page.locator('tbody tr[data-status="current"]')).toHaveCount(1);
    await scan(page, '匯入紀錄｜有資料', violations);
    await page.getByLabel('檔名').fill('不存在的檔名');
    await scan(page, '匯入紀錄｜空篩選', violations);
    await page.locator('button', { hasText: '清除篩選' }).click();

    await page.locator('a', { hasText: '查看當時結果' }).first().click();
    await expect(page.locator('h1')).toHaveText('歷史資料（唯讀）');
    await scan(page, '歷史檢視｜學生總表', violations);
    await page.locator('button[role="tab"]', { hasText: '班級扣天' }).click();
    await expect(page.locator('.deductions-table')).toBeVisible();
    await scan(page, '歷史檢視｜班級扣天', violations);

    // ── F. 有名單後的課表設定與確認變更 ──────────────────────────
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜課表頁籤（已有名單）', violations);
    await page.locator('button', { hasText: '班名對應' }).click();
    await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜班名對應頁籤（有待處理班名）', violations);

    const row = page.locator('tr', { hasText: '國小數學-一' });
    await row.locator('input.input-target-classname').fill('國小數學-一A');
    await row.locator('input[type="checkbox"]').check();
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(page.locator('dialog.impact-dialog')).toBeVisible({ timeout: 15000 });
    await scan(page, '課表設定｜確認變更視窗（有名單，影響預覽）', violations);

    // 套用時預覽已逾期（伺服器回 PREVIEW_EXPIRED）
    const apply = page.locator('dialog.impact-dialog').getByRole('button', { name: /^儲存/ });
    await expect(apply).toBeEnabled({ timeout: 15000 });
    await page.route('**/api/v1/settings/apply', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'PREVIEW_EXPIRED: 預覽已過期', code: 'PREVIEW_EXPIRED' }) })
    );
    await apply.click();
    await expect(page.locator('dialog.impact-dialog [data-dialog-error]')).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜確認變更視窗（預覽逾期）', violations);
    await page.unroute('**/api/v1/settings/apply');
    await page.keyboard.press('Escape');
    await cancelEdits();

    // 回到「課表」頁籤（前面的班名對應在另一個頁籤），再操作時段列
    await page.locator('button[role="tab"]', { hasText: /^課表/ }).first().click();
    await expect(page.locator('.schedule-table')).toBeVisible();

    // Ruling 2 狀態：確認變更視窗呈現「課程學費折扣變動」明細表
    await page.route('**/api/v1/settings/preview', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'with_students',
          previewId: 'prev-course-scan',
          affectedStudents: 1,
          dayDeltas: [],
          subjectCountDeltas: [],
          baseDiscountDeltas: [],
          courseRateDeltas: [
            { personCode: 'P9999', name: '掃描學生', course: 'tutoring', courseLabel: '課輔', before: 10000, after: 9500 },
          ],
          mismatchBefore: 0,
          mismatchAfter: 0,
          tierTransitions: [],
          issueDelta: { before: 0, after: 0 },
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          targetRuleSetVersion: 'erp-tag-v4',
        }),
      })
    );
    await page.locator('.schedule-table tbody tr').nth(3).locator('input.input-time').first().fill('14:40');
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(page.locator('dialog.impact-dialog')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('dialog.impact-dialog [data-course-rate-deltas]')).toBeVisible({ timeout: 10000 });
    await scan(page, '課表設定｜確認變更視窗（課程學費折扣變動）', violations);
    await page.unroute('**/api/v1/settings/preview');
    await page.keyboard.press('Escape');
    await cancelEdits();

    // 資料已被另一個視窗更新（預覽回 409，訊息與實際伺服器相同）
    await page.route('**/api/v1/settings/preview', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: '版本衝突：目前 revision 為 3，請求為 2', code: 'REVISION_CONFLICT' }),
      })
    );
    await page.locator('.schedule-table tbody tr').nth(3).locator('input.input-time').first().fill('14:30');
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(page.locator('dialog.impact-dialog [data-dialog-error]')).toBeVisible({ timeout: 15000 });
    await scan(page, '課表設定｜確認變更視窗（資料已更新 409）', violations);
    await page.unroute('**/api/v1/settings/preview');
    await page.keyboard.press('Escape');
    await cancelEdits();

    // 空白星期：預覽回 400（真實伺服器行為）
    await page.locator('.schedule-table tbody tr').nth(3).locator('input.input-weekday').fill('');
    await page.waitForTimeout(500);
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(page.locator('dialog.impact-dialog [data-dialog-error]')).toBeVisible({ timeout: 15000 });
    await scan(page, '課表設定｜確認變更視窗（空白星期，預覽失敗）', violations);
    await page.keyboard.press('Escape');

    // 涵蓋的頁面狀態數（新增狀態時同步調整；少了代表有狀態被略過）
    expect(new Set(scanned).size).toBe(EXPECTED_STATES);

    const report = violations
      .map((v) => `[${v.where}] 「${v.term}」…${v.context}…`)
      .filter((line, i, all) => all.indexOf(line) === i)
      .join('\n');
    expect(report, `日常介面出現 09 §7 禁用字：\n${report}`).toBe('');
  });
});
