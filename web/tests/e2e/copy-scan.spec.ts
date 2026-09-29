import { test, expect, Page } from '@playwright/test';
import path from 'path';

/**
 * R5 文案全頁掃描（specs/09 §7；specs/04 UX16 相關；specs/10 §5）。
 *
 * 方法：對每一頁、每一種可到達的狀態，取瀏覽器實際「可見」的文字
 * （document.body.innerText，不含收合中的 <details>、不含被隱藏的元素）加上可見元素的
 * aria-label／title／placeholder／alt，掃描 09 §7 文案表列為「日常介面不得出現」的字。
 * 技術資訊可查，但必須收在摺疊區——摺疊區內的內容不算日常介面，展開才看得到。
 *
 * 例外（有依據，不是放寬）：
 *   - 問題類型代碼（SCHEDULE_NOT_FOUND 等）是 UX15 明定保留的短標（「未知碼短標需確認且可查原因」，D17 照實呈現）。
 *   - 檔名、人員代碼、學生姓名是資料，不是文案。
 *
 * 一次跑完所有狀態，最後統一斷言「違規清單為空」，失敗時一次列出全部違規（頁面／狀態／命中字／上下文）。
 * 本檔也是文案回歸：之後任何頁面把工程字放回日常介面都會在這裡變紅。
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

/** scan() 呼叫次數（每個頁面狀態一次，標籤不得重複）。 */
const EXPECTED_STATES = 24;

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
];

/** UX15 明定保留的問題類型短標，掃描前先排除。 */
const ISSUE_CODES =
  /SCHEDULE_NOT_FOUND|SCHEDULE_EMPTY|UNKNOWN_WEEKDAY|DUPLICATE_SUBJECT_ENROLLMENT|STAFF_FAMILY_NO_DISCOUNT|CONFLICTING_NOTE_SOURCE|NUMERIC_POLICY_DIFFERENCE/g;

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
  const text = raw.replace(ISSUE_CODES, ' ');
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

    await page.locator('button', { hasText: '班名對應' }).click();
    await page.waitForTimeout(300);
    await scan(page, '課表設定｜班名對應頁籤（尚未匯入）', violations);
    await page.locator('button', { hasText: /^課表/ }).first().click();

    await page.locator('input.input-time').first().fill('13:30');
    await page.locator('button', { hasText: '確認變更' }).click();
    await expect(page.locator('dialog.impact-dialog')).toBeVisible({ timeout: 15000 });
    await scan(page, '課表設定｜確認變更視窗（只有課表）', violations);
    await page.keyboard.press('Escape');

    await page.goto('/imports');
    await scan(page, '匯入學生｜選擇檔案', violations);

    await page.goto('/history');
    await scan(page, '匯入紀錄｜空狀態', violations);

    // ── B. 已上傳、尚未使用 ──────────────────────────────────────
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await scan(page, '匯入學生｜確認名單（預覽）', violations);

    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await scan(page, '首頁｜已匯入、尚未使用', violations);

    await page.goto('/history');
    await scan(page, '匯入紀錄｜有尚未使用的批次', violations);

    // ── C. 重傳同檔（判重）→ 使用這份名單 → 完成 ─────────────────
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('button', { hasText: '使用這份名單' })).toBeVisible({ timeout: 15000 });
    await scan(page, '匯入學生｜確認名單（重複上傳提示）', violations);
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
    await scan(page, '匯入學生｜完成', violations);
    await page.locator('a', { hasText: '開始核對' }).click();

    // ── D. 核對結果 ──────────────────────────────────────────────
    await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
    await scan(page, '核對結果｜學生總表', violations);

    await page.locator('.results-table tbody tr').first().click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await scan(page, '核對結果｜學生明細抽屜', violations);
    await page.keyboard.press('Escape');

    const search = page.locator('input[placeholder*="搜尋"]').first();
    await search.fill('沒有這個學生');
    await expect(page.getByText('沒有符合條件的學生')).toBeVisible({ timeout: 10000 });
    await scan(page, '核對結果｜空篩選', violations);
    await page.locator('button', { hasText: '清除篩選條件' }).click();

    const classSelect = page.locator('select', { has: page.locator('option', { hasText: '全部班級' }) });
    await classSelect.selectOption({ label: '國小數學-一' });
    await expect(page.locator('.notice-warn')).toBeVisible();
    await scan(page, '核對結果｜待設定班級提示', violations);
    await page.locator('button', { hasText: '重置篩選 ✕' }).click();

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
