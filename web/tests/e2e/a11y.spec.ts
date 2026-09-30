import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { openFilter, applyFilter } from './helpers/header-filter';

/**
 * R5 可及性稽核（specs/09 §6；specs/04 UX16）。
 *
 * 本 repo 沒有 axe 依賴，且 R5 不新增依賴，所以這裡自寫檢查，逐條對 09 §6：
 *   1. 一頁一個 h1；main 與具名導覽 landmark；導航 aria-current
 *   2. icon／按鈕／連結／輸入都有 accessible name（純符號不算名字）
 *   3. 表單控制項有真 label（placeholder／title 不算）
 *   4. 互動目標 ≥ 24px（行內文字連結依 WCAG 2.5.8 例外；checkbox／radio 以其 label 的可點範圍計）
 *   5. 不以 emoji／符號作唯一狀態（badge／status 必須有文字）
 *   6. 資訊不只藏在 hover：不可聚焦元素不得只靠 title 傳達內容（tooltip 需 hover/focus/click 皆可開、Esc 可關）
 *   7. modal／drawer：role=dialog＋aria-modal＋名稱、開啟時焦點進入、Tab 不逸出（focus trap）、Esc 關閉、關閉返回觸發點
 *   8. 頁籤：role=tab／aria-selected、鍵盤（Tab＋Enter/Space）可切換、對應 tabpanel
 *   9. 錯誤：role=alert／aria-live，且不只靠顏色
 *  10. 鍵盤焦點有可見指示
 *
 * 頁面稽核一次跑完全部狀態後統一斷言「違規清單為空」，失敗時一次列出（頁面／規則／元素）。
 * 這不是取代人工輔助科技測試（未用螢幕閱讀器實測，見驗收報告的限制）。
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
const EXPECTED_STATES = 15;

interface Finding {
  where: string;
  rule: string;
  detail: string;
}

/** 在瀏覽器內執行的稽核腳本（回傳違規陣列）。 */
async function runAudit(page: Page): Promise<Array<{ rule: string; detail: string }>> {
  return page.evaluate(() => {
    const out: Array<{ rule: string; detail: string }> = [];
    const visible = (el: Element) =>
      (el as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true, contentVisibilityAuto: true }) !== false &&
      el.getClientRects().length > 0;
    const desc = (el: Element) => {
      const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      const txt = ((el as HTMLElement).innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
      return `<${el.tagName.toLowerCase()}${(el as HTMLElement).id ? '#' + (el as HTMLElement).id : ''}${cls ? '.' + cls : ''}> ${txt}`;
    };
    const hasLetters = (s: string) => /[\p{L}\p{N}]/u.test(s);

    const nameOf = (el: Element): string => {
      const al = el.getAttribute('aria-label');
      if (al && al.trim()) return al.trim();
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
        if (t) return t;
      }
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length) {
        const t = [...labels].map((l) => l.textContent?.trim() ?? '').join(' ').trim();
        if (t) return t;
      }
      const txt = ((el as HTMLElement).innerText || el.textContent || '').trim();
      if (txt && hasLetters(txt)) return txt;
      const title = el.getAttribute('title');
      if (title && title.trim()) return title.trim();
      return '';
    };

    // 1. h1／landmark／導航 aria-current
    const h1s = [...document.querySelectorAll('h1')].filter(visible);
    if (h1s.length !== 1) out.push({ rule: 'h1', detail: `可見 h1 有 ${h1s.length} 個（應為 1）` });
    if (document.querySelectorAll('main').length !== 1) out.push({ rule: 'landmark', detail: 'main 不是恰好 1 個' });
    document.querySelectorAll('nav').forEach((n) => {
      if (!n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')) out.push({ rule: 'landmark', detail: 'nav 沒有名稱' });
    });
    const path = location.pathname;
    if (['/', '/settings', '/imports', '/history'].some((p) => (p === '/' ? path === '/' : path.startsWith(p)))) {
      const cur = document.querySelectorAll('aside a[aria-current="page"]');
      if (cur.length !== 1) out.push({ rule: 'aria-current', detail: `導航 aria-current="page" 有 ${cur.length} 個（應為 1）` });
    }

    // 2–4. 互動元素：名稱、label、目標大小
    const interactive = document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="button"], [tabindex]:not([tabindex="-1"])'
    );
    interactive.forEach((el) => {
      if (!visible(el)) return;
      const tag = el.tagName.toLowerCase();
      const type = (el as HTMLInputElement).type;

      if (!nameOf(el)) out.push({ rule: 'name', detail: `沒有 accessible name：${desc(el)}` });

      if ((tag === 'input' && !['button', 'submit', 'reset', 'file'].includes(type)) || tag === 'select' || tag === 'textarea') {
        const labelled =
          ((el as HTMLInputElement).labels?.length ?? 0) > 0 || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (!labelled) out.push({ rule: 'label', detail: `表單控制項沒有 label（placeholder/title 不算）：${desc(el)}` });
      }

      if (Number(el.getAttribute('tabindex')) > 0) out.push({ rule: 'tabindex', detail: `tabindex>0：${desc(el)}` });

      // 目標大小：行內文字連結例外；checkbox/radio 以 label 可點範圍計
      const display = getComputedStyle(el).display;
      if (tag === 'a' && display === 'inline') return;
      let rect = el.getBoundingClientRect();
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        const lab = (el as HTMLInputElement).labels?.[0];
        if (lab) rect = lab.getBoundingClientRect();
      }
      if (Math.min(rect.width, rect.height) < 24) {
        out.push({ rule: 'target-size', detail: `目標 ${Math.round(rect.width)}×${Math.round(rect.height)}px < 24：${desc(el)}` });
      }
    });

    // 5. 不以 emoji／符號作唯一狀態
    document.querySelectorAll('[class*="badge"], [class*="status-"], [class*="pill"], [role="status"]').forEach((el) => {
      if (!visible(el)) return;
      const t = ((el as HTMLElement).innerText || '').trim();
      if (t && !hasLetters(t) && !el.getAttribute('aria-label')) out.push({ rule: 'symbol-only', detail: `只有符號、沒有文字：${desc(el)}` });
    });

    // 6. 資訊不只藏在 hover：不可聚焦元素只靠 title 傳達內容
    document.querySelectorAll('[title]').forEach((el) => {
      if (!visible(el)) return;
      const focusable = el.matches('a[href], button, input, select, textarea, summary, [tabindex]');
      if (!focusable) out.push({ rule: 'hover-only', detail: `只靠 title（hover）傳達，鍵盤看不到：${desc(el)} → 「${el.getAttribute('title')}」` });
    });

    return out;
  });
}

async function audit(page: Page, where: string, findings: Finding[], seen: string[]) {
  seen.push(where);
  for (const f of await runAudit(page)) findings.push({ where, ...f });
}

test.describe('R5 可及性稽核（09 §6）', () => {
  test('頁面稽核：每個頁面狀態的 landmark／名稱／label／目標大小／符號／hover-only', async ({ page }) => {
    test.setTimeout(180_000);
    const findings: Finding[] = [];
    const seen: string[] = [];

    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await audit(page, '首頁｜初始空狀態', findings, seen);

    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    await audit(page, '課表設定｜課表頁籤', findings, seen);
    await page.locator('button', { hasText: '班名對應' }).click();
    await page.waitForTimeout(300);
    await audit(page, '課表設定｜班名對應頁籤', findings, seen);

    await page.goto('/imports');
    await audit(page, '匯入學生｜選擇檔案', findings, seen);
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    await audit(page, '匯入學生｜確認名單', findings, seen);

    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await audit(page, '首頁｜已匯入、尚未使用', findings, seen);
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
    await audit(page, '核對結果｜學生總表', findings, seen);

    // 表頭篩選（D36）：面板開啟、已套用條件（chips）兩個狀態也要通過名稱／label／目標大小／符號稽核
    await openFilter(page, '所屬班級');
    await audit(page, '核對結果｜表頭篩選面板（所屬班級）', findings, seen);
    await page.keyboard.press('Escape');
    await openFilter(page, '需確認');
    await audit(page, '核對結果｜表頭篩選面板（需確認，兩個分區）', findings, seen);
    await page.keyboard.press('Escape');
    await applyFilter(page, '年級', { pick: ['3年級'] });
    await audit(page, '核對結果｜已套用篩選條件', findings, seen);
    await page.getByRole('button', { name: '清除全部' }).click();

    await page.locator('.results-table tbody tr').first().locator('button.link-button').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await audit(page, '核對結果｜學生明細抽屜', findings, seen);
    await page.keyboard.press('Escape');

    await page.locator('button[role="tab"]', { hasText: '班級扣天' }).click();
    await expect(page.locator('.deductions-table')).toBeVisible();
    await page.locator('.deductions-table tbody tr').first().locator('button').first().click();
    await audit(page, '核對結果｜班級扣天（展開）', findings, seen);

    // 有待處理班名的班名對應頁（有候選列、核取方塊與輸入框）——空 DB 的班名對應頁沒有這些控制項，審不到
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    await page.locator('button[role="tab"]', { hasText: '班名對應' }).click();
    await expect(page.locator('.mapping-table tbody tr').first()).toBeVisible({ timeout: 10000 });
    await audit(page, '課表設定｜班名對應頁籤（有待處理班名）', findings, seen);

    await page.goto('/history');
    await expect(page.locator('tbody tr[data-status="current"]')).toHaveCount(1);
    await audit(page, '匯入紀錄｜有資料', findings, seen);
    await page.locator('a', { hasText: '查看當時結果' }).first().click();
    await expect(page.locator('h1')).toHaveText('歷史資料（唯讀）');
    await audit(page, '歷史檢視｜學生總表', findings, seen);

    expect(new Set(seen).size).toBe(EXPECTED_STATES);
    // 相同規則、相同元素種類的重複項（例如表格每一列一顆按鈕）合併並標註數量，方便閱讀
    const grouped = new Map<string, number>();
    for (const f of findings) {
      const key = `[${f.where}] (${f.rule}) ${f.detail.replace(/學生\d+/g, '學生N').replace(/\d+×\d+px/, 'W×Hpx')}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    const report = [...grouped].map(([k, n]) => (n > 1 ? `${k}  ×${n}` : k)).join('\n');
    expect(report, `可及性違規（09 §6）：\n${report}`).toBe('');
  });

  test('明細抽屜（modal）：名稱、焦點進入、Tab 不逸出、Esc 關閉、關閉後焦點回到觸發點', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
    await page.goto('/');
    await expect(page.locator('.results-table')).toBeVisible();

    const trigger = page.locator('.results-table tbody tr').first().locator('button.link-button');
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const name = (await dialog.getAttribute('aria-label')) ?? '';
    expect(name.length, 'dialog 需有名稱').toBeGreaterThan(0);

    // 開啟時焦點進入 dialog
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    expect(await inside(), '開啟後焦點應在 dialog 內').toBe(true);

    // focus trap：連按 Tab 與 Shift+Tab，焦點永遠在 dialog 內
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      expect(await inside(), `Tab 第 ${i + 1} 次後焦點逸出 dialog`).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside(), `Shift+Tab 第 ${i + 1} 次後焦點逸出 dialog`).toBe(true);
    }

    // Esc 關閉，焦點回到觸發點
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('確認變更視窗（native dialog）：Tab 不逸出、Esc 關閉並回到「確認變更」按鈕', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    await page.locator('input.input-time').first().fill('13:30');
    const opener = page.locator('button', { hasText: '確認變更' });
    await opener.click();

    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog).toHaveAttribute('aria-labelledby', 'impactDialogTitle');
    // 等預覽載入完成、操作按鈕都可用再測（載入期間只有 ✕ 一個可聚焦元素）
    // 按鈕文字依情境為「儲存課表」（只有課表）或「儲存並更新結果」（已有名單）
    await expect(dialog.locator('button', { hasText: /^儲存/ })).toBeEnabled({ timeout: 15000 });
    // 原生 modal <dialog> 會把其餘頁面設為 inert：焦點只可能在 dialog 內，或交給瀏覽器介面（activeElement 為 body）。
    // 不可落在 dialog 外的任何頁面元素。
    const escaped = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        return !!a && a !== document.body && !a.closest('dialog');
      });
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      expect(await escaped(), `Tab 第 ${i + 1} 次後焦點落到 dialog 外的頁面元素`).toBe(false);
    }
    // 開啟時焦點在 dialog 內
    const firstFocus = await page.evaluate(() => !!document.activeElement?.closest('dialog') || document.activeElement === document.body);
    expect(firstFocus).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('頁籤：role=tab／aria-selected、鍵盤 Enter／Space 可切換、對應 tabpanel', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
    await page.goto('/');

    const tablist = page.locator('[role="tablist"]');
    await expect(tablist).toHaveAttribute('aria-label', /.+/);
    const students = tablist.locator('[role="tab"]', { hasText: '學生總表' });
    const deductions = tablist.locator('[role="tab"]', { hasText: '班級扣天' });
    await expect(students).toHaveAttribute('aria-selected', 'true');
    await expect(deductions).toHaveAttribute('aria-selected', 'false');

    // 只用鍵盤：聚焦後 Enter 切換
    await deductions.focus();
    await page.keyboard.press('Enter');
    await expect(deductions).toHaveAttribute('aria-selected', 'true');
    await expect(students).toHaveAttribute('aria-selected', 'false');
    // 選中的頁籤有對應且可見的 tabpanel
    const panelId = await deductions.getAttribute('aria-controls');
    expect(panelId, '頁籤需以 aria-controls 指向 tabpanel').toBeTruthy();
    const panel = page.locator(`#${panelId}`);
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.deductions-table')).toBeVisible();

    // Space 切回
    await students.focus();
    await page.keyboard.press('Space');
    await expect(students).toHaveAttribute('aria-selected', 'true');

    // 方向鍵／Home／End（WAI-ARIA tabs 模式）：移動焦點並切換；roving tabindex（只有選中的頁籤在 Tab 順序內）
    await expect(students).toHaveAttribute('tabindex', '0');
    await expect(deductions).toHaveAttribute('tabindex', '-1');
    await students.focus();
    await page.keyboard.press('ArrowRight');
    await expect(deductions).toBeFocused();
    await expect(deductions).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight'); // 循環回第一個
    await expect(students).toBeFocused();
    await expect(students).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(deductions).toBeFocused();
    await page.keyboard.press('Home');
    await expect(students).toBeFocused();
    await page.keyboard.press('ArrowLeft'); // 循環到最後一個
    await expect(deductions).toBeFocused();
    await expect(deductions).toHaveAttribute('aria-selected', 'true');
  });

  test('頁籤（課表設定）：同樣的 tab／tabpanel 對應與方向鍵', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });

    const tablist = page.locator('[role="tablist"]');
    await expect(tablist).toHaveAttribute('aria-label', /.+/);
    const schedule = tablist.locator('[role="tab"]', { hasText: /^課表/ });
    const mapping = tablist.locator('[role="tab"]', { hasText: '班名對應' });
    await expect(schedule).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`#${await schedule.getAttribute('aria-controls')}`)).toHaveAttribute('role', 'tabpanel');

    await schedule.focus();
    await page.keyboard.press('ArrowRight');
    await expect(mapping).toBeFocused();
    await expect(mapping).toHaveAttribute('aria-selected', 'true');
    const panel = page.locator(`#${await mapping.getAttribute('aria-controls')}`);
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toBeVisible();
  });

  test('Tooltip（合計折扣說明）：hover、focus、click 皆可開，Esc 可關，內容鍵盤讀得到', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
    await page.goto('/');
    await expect(page.locator('.results-table')).toBeVisible();

    const tip = page.locator('.results-table thead').getByRole('button', { name: /合計折扣.*說明|說明.*合計折扣/ });
    await expect(tip).toBeVisible();
    const bubble = page.locator('[role="tooltip"]');
    await expect(bubble).toHaveCount(0);

    // hover 開
    await tip.hover();
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText('指定課程可能另有調整');
    await page.mouse.move(0, 0);
    await expect(bubble).toHaveCount(0);

    // focus（鍵盤）開，且以 aria-describedby 關聯
    await tip.focus();
    await expect(bubble).toBeVisible();
    const describedBy = await tip.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toContainText('指定課程可能另有調整');

    // Esc 關
    await page.keyboard.press('Escape');
    await expect(bubble).toHaveCount(0);

    // click 開 → 再 click 關（觸控可用）
    await tip.click();
    await expect(bubble).toBeVisible();
    await tip.click();
    await expect(bubble).toHaveCount(0);
  });

  test('錯誤訊息：上傳格式不對 → 白話錯誤以 role=alert 朗讀，不只靠顏色', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'not-a-roster.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('這不是試算表'),
    });

    // 限定在 main：Next.js 的路由播報元素本身也是 role=alert，不能拿來當錯誤訊息的證據
    const alert = page.locator('main [role="alert"]');
    await expect(alert).toBeVisible({ timeout: 15000 });
    const text = (await alert.innerText()).trim();
    expect(text.length).toBeGreaterThan(4);
    // 有文字說明（不只是紅色），且沒有內部詞
    expect(text).not.toMatch(/IMPORT_FAILED|Error:|at \w+\.|stack/i);
  });

  test('鍵盤焦點可見：Tab 逐一走過核對結果頁前 15 個焦點，每個都有可見的焦點指示', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });
    await page.goto('/');
    await expect(page.locator('.results-table')).toBeVisible();

    const missing: string[] = [];
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const shadow = cs.boxShadow && cs.boxShadow !== 'none';
        return { ok: outline || !!shadow, label: `${el.tagName.toLowerCase()} ${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 20)}` };
      });
      if (r && !r.ok) missing.push(`第 ${i + 1} 個焦點：${r.label}`);
    }
    expect(missing, `這些元素取得鍵盤焦點時看不到焦點指示：\n${missing.join('\n')}`).toEqual([]);
  });

  test('狀態色語意（09 §4）：琥珀＝需確認、綠＝成功／目前使用、灰＝歷史／中性；顏色之外都有文字', async ({ page }) => {
    const rgb = async (loc: ReturnType<Page['locator']>) =>
      loc.first().evaluate((el) => {
        const m = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g)!.map(Number);
        return { r: m[0], g: m[1], b: m[2] };
      });
    const isAmber = (c: { r: number; g: number; b: number }) => c.r > c.g && c.g > c.b && c.r - c.b >= 15;
    const isGreen = (c: { r: number; g: number; b: number }) => c.g > c.r && c.g > c.b;
    const isNeutral = (c: { r: number; g: number; b: number }) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 16;

    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    // 課表設定：頁籤上的待確認班名數、班名對應列的「待確認」＝琥珀
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
    const countPill = page.locator('button[role="tab"] .pill.warn');
    await expect(countPill).toBeVisible();
    expect(isAmber(await rgb(countPill)), '班名對應頁籤的待確認數應為琥珀色').toBe(true);
    await page.locator('button[role="tab"]', { hasText: '班名對應' }).click();
    const pending = page.locator('.mapping-table .pill.warn', { hasText: '待確認' });
    await expect(pending.first()).toBeVisible();
    expect(isAmber(await rgb(pending)), '「待確認」應為琥珀色，不是綠色（綠＝成功）').toBe(true);
    // D1：收合的「本次名單未出現的班級」details 已被「班名比對報告」的「系統有／本次名冊無」清單取代
    //（09 §3.3；該清單預設展開）。這裡驗證同一件事在報告清單裡仍是中性灰（資訊，不是待確認）：
    // 以該清單的表頭列（非彩色狀態徽章）為準——它的背景不得是琥珀或綠色。
    const systemOnlyHead = page
      .getByRole('region', { name: '系統有／本次名冊無' })
      .getByRole('columnheader', { name: '系統班名' });
    await expect(systemOnlyHead).toBeVisible();
    const unseen = await rgb(systemOnlyHead);
    expect(isNeutral(unseen), '「系統有／本次名冊無」只是資訊，應為中性灰').toBe(true);
    expect(isAmber(unseen), '不應為琥珀色（琥珀＝待確認）').toBe(false);
    expect(isGreen(unseen), '不應為綠色（綠＝成功）').toBe(false);

    // 核對結果：目前使用的資料＝綠；歷史唯讀＝灰
    await page.goto('/');
    await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
    const basisNow = page.locator('.data-banner-current .pill');
    await expect(basisNow).toContainText('核對基準日');
    expect(isGreen(await rgb(basisNow)), '目前使用的資料，核對基準日標籤應為綠色').toBe(true);
    await page.goto('/history');
    await page.locator('a', { hasText: '查看當時結果' }).first().click();
    await expect(page.locator('.data-banner-history')).toBeVisible({ timeout: 15000 });
    const basisOld = page.locator('.data-banner-history .pill');
    await expect(basisOld).toContainText('核對基準日');
    expect(isNeutral(await rgb(basisOld)), '歷史資料的核對基準日標籤應為中性灰').toBe(true);
  });
});
