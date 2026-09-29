import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

/**
 * R5 UX20 響應式驗收（specs/04 §8 UX20；specs/09 §6）：1440×900、1280×800、1024×768、768 寬。
 *
 * 驗收條件：
 *   1. 無整頁橫向溢出（documentElement.scrollWidth ≤ 視窗寬）
 *   2. 寬表只在表內捲動（表格容器可捲，頁面不捲）；姓名欄 sticky（橫向捲動後仍貼在容器左緣）；表頭 sticky（縱向捲動後仍貼在容器上緣）
 *   3. 底部操作列不遮擋操作（捲到底後，主要內容裡沒有任何互動元素被操作列蓋住）
 *   4. 導覽在每個尺寸都可達（四個入口皆可見、可點），768 收合成頂部橫列且不佔滿垂直空間
 *   5. 沒有「死遮罩」：沒有覆蓋大半視窗、卻不是 dialog 的固定定位元素
 *
 * 方法與限制（誠實揭露）：這是「自動量測＋實作者視覺檢視」，不是 operator 人工驗收。
 * 設定環境變數 UX20_SCREENSHOT_DIR 時會輸出各尺寸截圖（使用合成 fixture，不含真實資料）；
 * 設定 UX20_RESULT_FILE 時會輸出量測結果 JSON，供驗收報告引用。未設定時只做斷言，不寫任何檔案。
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
];

const NAV_ENTRIES = ['課表設定', '匯入學生', '核對結果', '匯入紀錄'];

interface Row {
  viewport: string;
  page: string;
  pageOverflowPx: number;
  scrollContainers: Array<{ selector: string; clientWidth: number; scrollWidth: number; scrollsInside: boolean }>;
  note?: string;
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const docW = document.documentElement.scrollWidth;
    const winW = window.innerWidth;
    const containers = [...document.querySelectorAll('.table-scroll, .table-scroll-container, .scroll')]
      .filter((el) => (el as HTMLElement).getClientRects().length > 0)
      .map((el) => {
        const h = el as HTMLElement;
        return {
          selector: `.${h.className.split(/\s+/).filter(Boolean)[0]}`,
          clientWidth: h.clientWidth,
          scrollWidth: h.scrollWidth,
          scrollsInside: h.scrollWidth > h.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(h).overflowX),
        };
      });
    return { overflow: docW - winW, containers };
  });
}

/** 固定定位、覆蓋大半視窗、卻不是 dialog 的元素＝死遮罩。 */
async function findDeadOverlays(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const out: string[] = [];
    document.querySelectorAll('body *').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < vw * vh * 0.5) return;
      if (el.closest('dialog, [role="dialog"]')) return;
      out.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} ${Math.round(r.width)}×${Math.round(r.height)}`);
    });
    return out;
  });
}

test.describe('R5 UX20 響應式驗收', () => {
  test('四種尺寸 × 各主要頁面：無整頁橫向溢出、寬表表內捲動、sticky、底部操作列不遮擋、導覽可達、無死遮罩', async ({ page }) => {
    test.setTimeout(240_000);
    const shotDir = process.env.UX20_SCREENSHOT_DIR;
    const resultFile = process.env.UX20_RESULT_FILE;
    if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
    const rows: Row[] = [];

    const shot = async (vp: string, name: string) => {
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `${vp}-${name}.jpg`), type: 'jpeg', quality: 72 });
    };
    const makeCheck = (vp: (typeof VIEWPORTS)[number]) => async (name: string, note?: string) => {
      const m = await measure(page);
      rows.push({ viewport: vp.name, page: name, pageOverflowPx: m.overflow, scrollContainers: m.containers, note });
      // 1. 無整頁橫向溢出
      expect(m.overflow, `[${vp.name}｜${name}] 整頁橫向溢出 ${m.overflow}px`).toBeLessThanOrEqual(1);
      // 5. 無死遮罩
      expect(await findDeadOverlays(page), `[${vp.name}｜${name}] 有覆蓋大半視窗的固定定位元素`).toEqual([]);
      await shot(vp.name, name);
    };

    // ── 全新資料庫的空狀態（必須在建立資料前量測）────────────────
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const check = makeCheck(vp);
      await page.goto('/');
      await expect(page.locator('h2', { hasText: '還沒有可核對的學生資料' })).toBeVisible();
      await check('home-empty');
      await page.goto('/history');
      await expect(page.getByText('還沒有匯入紀錄')).toBeVisible({ timeout: 15000 });
      await check('history-empty');
    }

    // ── 準備資料：上傳並使用（合成 fixture）─────────────────────
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.locator('button', { hasText: '使用這份名單' })).toBeVisible({ timeout: 15000 });
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.locator('.success-stage-card')).toBeVisible({ timeout: 15000 });

    // 歷史檢視的網址（取自匯入紀錄的連結）
    await page.goto('/history');
    const historyHref = await page.locator('a', { hasText: '查看當時結果' }).first().getAttribute('href');
    expect(historyHref).toMatch(/^\/history\//);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      const check = makeCheck(vp);

      // ── 導覽在此尺寸可達 ─────────────────────────────────────
      await page.goto('/');
      await expect(page.locator('.data-banner-current')).toBeVisible({ timeout: 15000 });
      for (const entry of NAV_ENTRIES) {
        const link = page.locator('aside a', { hasText: entry });
        await expect(link, `[${vp.name}] 導覽入口「${entry}」不可見`).toBeVisible();
        await link.click({ trial: true }); // 沒被其他元素遮住、可點
      }
      const sideBox = await page.locator('aside.side').boundingBox();
      if (vp.width <= 800) {
        // 768 導航收合成頂部橫列：寬度撐滿、不佔滿垂直空間
        expect(sideBox!.width).toBeGreaterThanOrEqual(vp.width - 2);
        expect(sideBox!.height, `[${vp.name}] 收合後的導覽仍佔 ${Math.round(sideBox!.height)}px 高`).toBeLessThan(120);
      }

      // ── 核對結果：學生總表（寬表）────────────────────────────
      await check('results-students');
      const tableScroll = page.locator('.table-scroll').first();
      const needsScroll = await tableScroll.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      if (needsScroll) {
        // 2a. 橫向捲動後，姓名欄仍貼在容器左緣（sticky）；頁面不橫向捲
        await tableScroll.evaluate((el) => (el.scrollLeft = el.scrollWidth));
        const stick = await page.evaluate(() => {
          const box = document.querySelector('.table-scroll')!.getBoundingClientRect();
          const cell = document.querySelector('.results-table tbody .sticky-name')!.getBoundingClientRect();
          return { left: cell.left - box.left, pageX: window.scrollX };
        });
        expect(Math.abs(stick.left), `[${vp.name}] 姓名欄捲動後偏離容器左緣 ${stick.left}px`).toBeLessThanOrEqual(2);
        expect(stick.pageX).toBe(0);
        await tableScroll.evaluate((el) => (el.scrollLeft = 0));
      }
      // 2b. 縱向捲動表內後，表頭仍貼在容器上緣（sticky）
      await tableScroll.evaluate((el) => (el.scrollTop = 200));
      const headTop = await page.evaluate(() => {
        const box = document.querySelector('.table-scroll')!.getBoundingClientRect();
        const th = document.querySelector('.results-table thead th')!.getBoundingClientRect();
        return th.top - box.top;
      });
      expect(Math.abs(headTop), `[${vp.name}] 表頭捲動後偏離容器上緣 ${headTop}px`).toBeLessThanOrEqual(2);
      await tableScroll.evaluate((el) => (el.scrollTop = 0));

      // ── 核對結果：學生明細抽屜（modal 不得造成整頁溢出，也不算死遮罩）──
      await page.locator('.results-table tbody tr').first().locator('button.link-button').click();
      await expect(page.locator('[role="dialog"]')).toBeVisible();
      await check('results-drawer');
      await page.keyboard.press('Escape');
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);

      // ── 核對結果：班級扣天 ────────────────────────────────────
      await page.locator('button[role="tab"]', { hasText: '班級扣天' }).click();
      await expect(page.locator('.deductions-table')).toBeVisible();
      await check('results-deductions');

      // ── 課表設定（含底部操作列）──────────────────────────────
      await page.goto('/settings');
      await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 10000 });
      await page.locator('input.input-time').first().fill('13:30'); // 使操作列出現「有未儲存的變更」
      await check('settings-schedule');
      // 3. 捲到底後，主要內容沒有互動元素被底部操作列蓋住
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const covered = await page.evaluate(() => {
        const bar = document.querySelector('.savebar')!.getBoundingClientRect();
        // 元素的「實際可見矩形」＝自身矩形與每一層會裁切內容的祖先（overflow 非 visible）求交集；
        // 捲出自己捲動容器的列仍有座標，但看不到也點不到，不算被蓋住。
        const visibleRect = (el: Element) => {
          let r = el.getBoundingClientRect();
          let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
            const pr = p.getBoundingClientRect();
            left = Math.max(left, pr.left); top = Math.max(top, pr.top);
            right = Math.min(right, pr.right); bottom = Math.min(bottom, pr.bottom);
          }
          return { left, top, right, bottom, w: right - left, h: bottom - top };
        };
        const hits: string[] = [];
        document.querySelectorAll('main button, main a, main input, main select').forEach((el) => {
          if (el.closest('.savebar') || el.getClientRects().length === 0) return;
          const v = visibleRect(el);
          if (v.w <= 0 || v.h <= 0) return; // 被容器裁掉，看不到
          const inView = v.bottom > 0 && v.top < window.innerHeight;
          const overlaps = v.left < bar.right && v.right > bar.left && v.top < bar.bottom && v.bottom > bar.top;
          if (inView && overlaps) hits.push(`${el.tagName.toLowerCase()} ${(el as HTMLElement).innerText?.slice(0, 12) ?? ''}`);
        });
        return hits;
      });
      expect(covered, `[${vp.name}] 底部操作列蓋住了互動元素`).toEqual([]);
      await page.evaluate(() => window.scrollTo(0, 0));

      await page.locator('button[role="tab"]', { hasText: '班名對應' }).click();
      await expect(page.locator('.mapping-table')).toBeVisible({ timeout: 10000 });
      await check('settings-mapping');

      // ── 匯入學生：選擇檔案／確認名單 ─────────────────────────
      await page.goto('/imports');
      await check('imports-upload');
      await page.locator('input[type="file"]').setInputFiles(FIXTURE);
      await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
      await check('imports-preview');

      // ── 匯入紀錄與歷史檢視 ────────────────────────────────────
      // 等內容真的出現再斷言（Next dev 首次編譯時 loading.tsx 的外殼會暫時與內容並存）
      await page.goto('/history');
      await expect(page.locator('.history-current')).toBeVisible({ timeout: 15000 });
      await check('history');
      await page.goto(historyHref!);
      await expect(page.locator('.data-banner-history')).toBeVisible({ timeout: 15000 });
      await check('history-detail');
    }

    if (resultFile) {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, JSON.stringify(rows, null, 2));
    }
    // 每個尺寸 × 每個頁面都有量測（4 × 11：空狀態 2、結果 3、設定 2、匯入 2、紀錄 2）
    expect(rows).toHaveLength(VIEWPORTS.length * 11);
  });
});
