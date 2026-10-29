import { test, expect } from '@playwright/test';
import { classRow, openClassSchedule } from './helpers/c-batch';

/**
 * UX08（specs/04 §8）：改時段後，舊回應晚到 → 最新一次請求的結果才可顯示，不被晚到的舊回應覆蓋。
 *
 * 之前只有 API 契約（requestKey 原樣回傳、draftHash 隨內容改變）有測試；前端「只採用最新 requestKey」
 * 的丟棄邏輯（settings-editor 的 latestReqKeyRef）沒有自動化證據。這裡用 Playwright 攔截 calculate 請求，
 * 讓第一次請求（舊）被扣住，第二次請求（新）先回來，再放行舊回應，斷言畫面仍是新結果。
 *
 * 手算（兒童美語-Gino 週一，seed 課表 15:20–16:50；安親窗 13:00–16:00、課輔窗 16:30–19:30）：
 *   起 15:20 → 安親重疊 16:00−15:20 = 40 分（初始）
 *   起 15:30（舊請求）→ 30 分；起 15:40（新請求）→ 20 分
 *   課輔重疊 16:50−16:30 = 20 分，不受起始時間影響。
 */
test('UX08: 舊的 calculate 回應晚到，畫面仍採用最新請求的結果', async ({ page }) => {
  const row = await openClassSchedule(page, '兒童美語-Gino');
  // 以欄位意義定位，不用 td 索引（#80 前段插入兩欄後，舊 nth(5) 會指到 col-time）
  const overlapAnqin = row.locator('[data-calc="anqin-overlap"]');
  await expect(overlapAnqin).toHaveText(/40/); // 初始結果（seed 課表）

  let calls = 0;
  let firstHeld = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/settings/calculate', async (route) => {
    calls += 1;
    if (calls === 1) {
      firstHeld = true;
      await gate; // 扣住舊請求，讓新請求先回來
    }
    await route.continue();
  });

  const start = row.locator('input.input-time').first();

  // 舊請求：起 15:30
  await start.fill('15:30');
  await expect.poll(() => firstHeld, { timeout: 5000 }).toBe(true);

  // 新請求：起 15:40（不被扣住，先回來）
  await start.fill('15:40');
  await expect(overlapAnqin).toHaveText(/20/, { timeout: 5000 });

  // 放行舊回應（30 分）——晚到，不得覆蓋畫面
  release();
  await page.waitForTimeout(800);
  await expect(overlapAnqin).toHaveText(/20/);
  await expect(overlapAnqin).not.toHaveText(/30/);
  expect(calls).toBeGreaterThanOrEqual(2);
});
