import { test, expect } from '@playwright/test';

/**
 * #80：折扣類別與固定 5 天從獨立的 `ClassAttributesPanel` 卡片併入時段表格，
 * 同一列就能完成全部設定（不再需要上下兩次找班級）。
 *
 * 驗收目標（issue #80 Expected Outcome 1–5）：
 *  1. 不再有兩個分離的班級清單區塊；同一列即可設定類別／固定 5 天／時段；
 *  2. 省略「來源：自動／手動」pill，改以「自動設定」按鈕承載來源狀態；
 *  3. 表格底端維持「＋ 新增時段」；
 *  4. 欄位超出螢幕時表格可上下左右捲動，不產生整頁破版；
 *  5. 類別手動覆寫、固定 5 天切換、恢復自動、時段新增／修改／刪除行為完整保留。
 */

test.describe('#80：單一表格整合屬性（班級列同時設定類別與固定 5 天）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1', { hasText: '課表設定' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.schedule-table')).toBeVisible();
  });

  test('#80-1: 課表頁只有一張班級表（獨立的屬性卡片已移除）', async ({ page }) => {
    // 頁面上只有一張列出班級的表
    await expect(page.locator('table.schedule-table')).toHaveCount(1);
    // 獨立的「折扣類別與固定 5 天（N 個班級）」卡片不再存在
    await expect(page.locator('[data-class-attributes-panel]')).toHaveCount(0);
    await expect(page.getByText('折扣類別與固定 5 天（')).toHaveCount(0);
  });

  test('#80-2: 非安親頁籤同時設定類別與不計扣天；安親頁籤設定固定 5 天', async ({ page }) => {
    // 預設非安親頁籤：包含類別與不計扣天，無固定 5 天
    const headers = page.locator('table.schedule-table-non-care thead');
    await expect(headers).toContainText('班級名稱');
    await expect(headers).toContainText('列入多科折扣');
    await expect(headers).toContainText('不計扣天');
    await expect(headers).not.toContainText('天數固定 5 天');
    await expect(headers).toContainText('帶班老師');
    await expect(headers).toContainText('星期');

    const rows = page.locator('tr.schedule-row', {
      has: page.locator('[data-category-select="國小數學-四A"]').first(),
    });
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('[data-category-select="國小數學-四A"]')).toHaveCount(2);
    await expect(rows.first().locator('[data-category-select="國小數學-四A"]')).toHaveValue('math');
    // 切換至安親頁籤：包含天數固定 5 天
    await page.locator('#class-type-tab-care').click();
    const careHeaders = page.locator('table.schedule-table-care thead');
    await expect(careHeaders).toContainText('天數固定 5 天');
    await expect(careHeaders).not.toContainText('不計扣天');
    await expect(page.locator('[data-fixed-five-toggle="國小輔導-四年級"]')).toBeVisible();
  });

  test('#80-3: 省略「來源：自動／手動」pill，改以「自動設定」按鈕承載狀態', async ({ page }) => {
    // 未手動的班：沒有按鈕，顯示「—」
    await expect(page.locator('[data-restore-auto="國小數學-四A"]').first()).toHaveCount(0);
    await expect(page.locator('[aria-label="國小數學-四A 未手動修改"]').first()).toBeVisible();
    // 整張表都沒有「自動」／「手動」pill 文字欄
    await expect(page.locator('[data-category-source]')).toHaveCount(0);
    await expect(page.locator('[data-fixed-source]')).toHaveCount(0);

    // 手動後：出現可點的「自動設定」按鈕
    await page.locator('[data-category-select="國小數學-四A"]').first().selectOption('none');
    await expect(page.locator('[data-restore-auto="國小數學-四A"]').first()).toBeVisible();
    await expect(page.locator('[data-restore-auto="國小數學-四A"]').first()).toHaveText('自動設定');

    // 點它回到自動偵測值（數學班），按鈕消失
    await page.locator('[data-restore-auto="國小數學-四A"]').first().click();
    await expect(page.locator('[data-category-select="國小數學-四A"]').first()).toHaveValue('math');
    await expect(page.locator('[data-restore-auto="國小數學-四A"]').first()).toHaveCount(0);
  });

  test('#80-4: 「＋ 新增班級」仍在表格工具列（specs/14 A1）', async ({ page }) => {
    const toolbar = page.locator('.schedule-grid-container .toolbar');
    await expect(toolbar.getByRole('button', { name: '＋ 新增班級' })).toBeVisible();
  });

  test('#80-5: 欄位超出螢幕時，表格在容器內 2D 捲動、整頁不橫向溢出', async ({ page }) => {
    // 用較窄視窗逼出橫向捲動（欄位共 12 欄，min-width 1240px）
    await page.setViewportSize({ width: 900, height: 800 });

    const metrics = await page.evaluate(() => {
      const el = document.querySelector('.schedule-table-scroll') as HTMLElement | null;
      if (!el) throw new Error('找不到 .schedule-table-scroll');
      const style = getComputedStyle(el);
      return {
        pageOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      };
    });

    // 整頁不橫向溢出（捲動只在表內）
    expect(metrics.pageOverflowPx).toBeLessThanOrEqual(0);
    // 容器兩個軸都是 auto
    expect(['auto', 'scroll']).toContain(metrics.overflowX);
    expect(['auto', 'scroll']).toContain(metrics.overflowY);
    // 欄位確實比容器寬 → 橫向捲動真的存在
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

    // 橫向捲動後：首欄班級名稱仍貼在容器左緣（sticky left）
    const stickyLeft = await page.evaluate(() => {
      const container = document.querySelector('.schedule-table-scroll') as HTMLElement;
      container.scrollLeft = container.scrollWidth;
      const box = container.getBoundingClientRect();
      const cell = document.querySelector('table.schedule-table tbody .sticky-col');
      if (!cell) throw new Error('找不到 sticky 首欄');
      return cell.getBoundingClientRect().left - box.left;
    });
    expect(stickyLeft).toBeGreaterThanOrEqual(-1);
    expect(stickyLeft).toBeLessThanOrEqual(1);

    // 縱向捲動後：第一列群組表頭貼齊容器上緣，第二列子欄緊接其下、不重疊。
    const stickyRows = await page.evaluate(() => {
      const container = document.querySelector('.schedule-table-scroll') as HTMLElement;
      container.scrollTop = 200;
      const containerTop = container.getBoundingClientRect().top;
      const groups = Array.from(
        container.querySelectorAll<HTMLElement>(
          'thead tr:first-child .col-group-anqin, thead tr:first-child .col-group-tutoring'
        )
      );
      const subHeaders = Array.from(container.querySelectorAll<HTMLElement>('thead tr:nth-child(2) th'));
      if (groups.length !== 2 || subHeaders.length !== 4) throw new Error('找不到完整的兩層表頭');
      const groupTop = Math.min(...groups.map((th) => th.getBoundingClientRect().top));
      const groupBottom = Math.max(...groups.map((th) => th.getBoundingClientRect().bottom));
      const subHeaderTop = Math.min(...subHeaders.map((th) => th.getBoundingClientRect().top));
      return { groupTopOffset: groupTop - containerTop, headerGap: subHeaderTop - groupBottom };
    });
    expect(stickyRows.groupTopOffset).toBeGreaterThanOrEqual(-1);
    expect(stickyRows.groupTopOffset).toBeLessThanOrEqual(1);
    expect(stickyRows.headerGap).toBeGreaterThanOrEqual(-1);
    expect(stickyRows.headerGap).toBeLessThanOrEqual(1);
  });

  /**
   * #113 follow-up：「不計扣天」改為**逐列**勾選。
   * 驗收目標：勾第一列不連動同班其他列（這正是改動的原因——初版在班級層，會整班連動）。
   * 手算：國小數學-四A 在 seed 有 2 列；勾第 1 列後第 2 列必須仍是未勾。
   */
  test('#113-1: 不計扣天逐列獨立——勾一列不連動同班其他列', async ({ page }) => {
    const rows = page.locator('tr.schedule-row', {
      has: page.locator('[data-category-select="國小數學-四A"]').first(),
    });
    await expect(rows).toHaveCount(2);

    const toggles = rows.locator('input[data-skip-deduction-toggle]');
    await expect(toggles).toHaveCount(2);
    await expect(toggles.nth(0)).not.toBeChecked();
    await expect(toggles.nth(1)).not.toBeChecked();

    await toggles.nth(0).check();

    // 逐列獨立：只有被勾的那一列變動
    await expect(toggles.nth(0)).toBeChecked();
    await expect(toggles.nth(1)).not.toBeChecked();
    // 勾選是未儲存變更
    await expect(page.locator('.save-status-dirty')).toBeVisible();
  });

  test('#113-2: 每一列的不計扣天勾選都有自己的可讀標籤（含列序號）', async ({ page }) => {
    const rows = page.locator('tr.schedule-row', {
      has: page.locator('[data-category-select="國小數學-四A"]').first(),
    });
    await expect(rows).toHaveCount(2);
    const labels = await rows.locator('input[data-skip-deduction-toggle]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label'))
    );
    // 兩列的標籤必須不同（帶列序號），否則鍵盤／讀屏使用者分不出是哪一列
    expect(new Set(labels).size).toBe(2);
    for (const label of labels) expect(label).toMatch(/第 \d+ 列的不計扣天$/);
  });

  test('#80-6: 刪除時段仍在列尾（既有行為保留）', async ({ page }) => {
    const row = page.locator('tr.schedule-row', {
      has: page.locator('[data-category-select="兒童美語-Gino"]').first(),
    });
    await expect(row.first()).toBeVisible();
    await row.first().getByRole('button', { name: /刪除時段/ }).click();
    await expect(page.locator('.save-status-dirty')).toBeVisible();
  });
});
