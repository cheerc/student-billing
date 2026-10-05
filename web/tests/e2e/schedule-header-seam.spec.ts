import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * issue #96 R6-F01：課表兩層表頭接縫透出資料列內容。
 *
 * 驗收者明確指出「只量間距（gap=0）不足以單獨證明畫面沒有露字」，因此本檔
 * 不比較列與列的間距，而是直接量接縫那一條像素帶上的**實際顏色**，斷言其中
 * 不得出現資料列的背景色（`.cblue` #f5f9ff / `.cteal` #f1faf8）。
 *
 * 技術手法：對接縫帶狀區域截兩張圖——一張正常、一張暫時隱藏 `tbody`——比對
 * 差異像素。接縫若沒有任何資料列內容，隱藏 tbody 不該改變任何像素；差異大於 0
 * 就代表該帶狀區域確實畫到了資料列。這個手法不受「文字色恰好等於表頭底色」
 * 等巧合影響，是直接證明「資料列有畫進來」。
 */

/** 表頭第一列下緣（含折疊邊界）那一條像素帶。 */
const SEAM_HEIGHT = 2;

interface SeamMeasurement {
  /** 隱藏 tbody 前後有差異的像素數：0 代表接縫沒有資料列內容滲入 */
  leakedPixels: number;
  /** 接縫帶狀區域出現的顏色（依出現次數排序） */
  colors: Array<{ rgb: string; count: number }>;
  /** 接縫的 y 範圍與取樣 x 範圍（供失敗訊息定位） */
  band: { pageTop: number; pageBottom: number; x: number; width: number };
  /** 表頭第一列與第二列的幾何，供失敗訊息對照 */
  geometry: { groupRowBottom: number; secondRowTop: number };
}

/** 把頁面捲到課表表頭可見的位置（避開 sticky savebar 蓋住接縫）。 */
async function scrollHeaderIntoView(page: Page) {
  await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.schedule-table thead');
    if (!header) throw new Error('找不到課表表頭');
    window.scrollTo(0, Math.max(0, window.scrollY + header.getBoundingClientRect().top - 40));
  });
  // 等頁面捲動與 sticky 定位收斂
  await page.waitForFunction(() => {
    const header = document.querySelector<HTMLElement>('.schedule-table thead');
    if (!header) return false;
    const container = document.querySelector<HTMLElement>('.schedule-table-scroll');
    if (!container) return false;
    const c = container.getBoundingClientRect();
    const h = header.getBoundingClientRect();
    return Math.abs(h.top - c.top) <= 2;
  });
}

/** 容器內雙向捲到底，確保資料列真的從表頭下方通過。 */
async function scrollTableToEnd(page: Page) {
  return page.locator('.schedule-table-scroll').evaluate((el) => {
    el.scrollLeft = el.scrollWidth - el.clientWidth;
    el.scrollTop = el.scrollHeight - el.clientHeight;
    return { left: el.scrollLeft, top: el.scrollTop };
  });
}

async function measureSeam(page: Page): Promise<SeamMeasurement> {
  const geometry = await page.evaluate(() => {
    const rows = document.querySelectorAll('.schedule-table thead tr');
    const groupRow = rows[0].getBoundingClientRect();
    const secondRow = rows[1].getBoundingClientRect();
    return { groupRowBottom: groupRow.bottom, secondRowTop: secondRow.top };
  });

  const clip = await page.evaluate(({ seamHeight }) => {
    const rows = document.querySelectorAll('.schedule-table thead tr');
    const groupRow = rows[0].getBoundingClientRect();
    const container = document.querySelector<HTMLElement>('.schedule-table-scroll');
    if (!container) throw new Error('找不到課表捲動容器');
    const c = container.getBoundingClientRect();
    const left = Math.max(0, c.left);
    const width = Math.max(1, Math.min(c.right - left, window.innerWidth - left));
    // 取樣帶狀區域以群組列下緣為中心：折疊邊界就在這一帶
    const top = Math.max(0, Math.round(groupRow.bottom) - Math.floor(seamHeight / 2));
    const height = Math.max(1, Math.min(seamHeight, window.innerHeight - top, c.bottom - top));
    return { x: Math.floor(left), y: Math.floor(top), width: Math.floor(width), height: Math.floor(height) };
  }, { seamHeight: SEAM_HEIGHT });

  const band = { pageTop: clip.y, pageBottom: clip.y + clip.height, x: clip.x, width: clip.width };

  const withBody = await page.screenshot({ clip });
  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.schedule-table tbody');
    if (body) body.style.visibility = 'hidden';
  });
  await page.waitForTimeout(120);
  const withoutBody = await page.screenshot({ clip });
  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.schedule-table tbody');
    if (body) body.style.visibility = '';
  });

  const a = await sharp(withBody).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(withoutBody).raw().toBuffer({ resolveWithObject: true });

  const counts = new Map<string, number>();
  let leakedPixels = 0;
  for (let i = 0; i < a.data.length; i += a.info.channels) {
    const key = `${a.data[i]},${a.data[i + 1]},${a.data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
      leakedPixels += 1;
    }
  }

  return {
    leakedPixels,
    colors: Array.from(counts.entries())
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([rgb, count]) => ({ rgb, count })),
    band,
    geometry,
  };
}

test.describe('R6-F01：課表兩層表頭接縫不得透出資料列', () => {
  for (const viewport of [
    { label: '768×600', width: 768, height: 600 },
    { label: '1440×900', width: 1440, height: 900 },
  ]) {
    test(`${viewport.label} 捲到底後接縫不得畫到資料列`, async ({ page }) => {
      test.setTimeout(120000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/settings');
      await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 20000 });
      await expect(page.locator('table.schedule-table tbody tr').first()).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1200);

      await scrollHeaderIntoView(page);
      const scrolled = await scrollTableToEnd(page);
      expect(scrolled.left, `${viewport.label} 課表應可水平捲動`).toBeGreaterThan(0);
      expect(scrolled.top, `${viewport.label} 應捲過表頭與首列`).toBeGreaterThan(200);
      await page.waitForTimeout(300);

      const seam = await measureSeam(page);

      // 幾何前提：兩列確實相接（這只是必要條件，單獨存在不足以證明沒露字）
      expect(
        Math.abs(seam.geometry.secondRowTop - seam.geometry.groupRowBottom),
        `${viewport.label} 兩列應相接（前提條件）`,
      ).toBeLessThanOrEqual(1);

      // 真正的斷言：接縫帶狀區域不得有任何由 tbody 繪製的像素
      expect(
        seam.leakedPixels,
        `${viewport.label} 表頭接縫畫到了資料列（顏色分布 ${JSON.stringify(seam.colors)}，帶狀區域 ${JSON.stringify(seam.band)}）`,
      ).toBe(0);
    });
  }
});