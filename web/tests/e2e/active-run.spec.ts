import { test, expect, type Locator, type Page, type Response, type Route } from '@playwright/test';
import path from 'path';
import { openFilter, applyFilter } from './helpers/header-filter';

/** conforming-erp-fixture 的值（09 §7：筆數只在測試/fixture，不進產品文案；未對應名冊班不納入假級距比對）。 */
const FIXTURE_TIER_MISMATCH = 4;

type StudentResponseKind = 'list' | 'options';

function matchesStudentResponse(
  response: Response,
  kind: StudentResponseKind,
  filters: Record<string, string>,
  absentFilters: string[] = []
): boolean {
  const url = new URL(response.url());
  if (!url.pathname.endsWith('/students')) return false;
  if (kind === 'options' ? url.searchParams.get('options') !== 'true' : url.searchParams.has('options')) return false;
  if (Object.entries(filters).some(([key, value]) => !url.searchParams.getAll(key).includes(value))) return false;
  return absentFilters.every((key) => !url.searchParams.has(key));
}

function holdStudentResponse(
  page: Page,
  kind: StudentResponseKind,
  filters: Record<string, string>
): Promise<{ intercepted: Promise<void>; release: () => void; remove: () => Promise<void> }> {
  let releaseGate!: () => void;
  let resolveIntercepted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const intercepted = new Promise<void>((resolve) => { resolveIntercepted = resolve; });
  const pattern = /\/api\/v1\/runs\/[^/]+\/students(?:\?.*)?$/;
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    const isOptions = url.searchParams.get('options') === 'true';
    const matches = url.pathname.endsWith('/students')
      && (kind === 'options' ? isOptions : !isOptions)
      && Object.entries(filters).every(([key, value]) => url.searchParams.getAll(key).includes(value));
    if (!matches) {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    resolveIntercepted();
    await gate;
    await route.fulfill({ response: upstream });
  };
  return page.route(pattern, handler).then(() => ({
    intercepted,
    release: releaseGate,
    remove: () => page.unroute(pattern, handler),
  }));
}

type IssueFacetOption = { value: string; count: number };

function visibleIssueOptionCount(options: IssueFacetOption[]): number {
  return options.filter((option) => option.count !== 0 && option.value !== '~blank').length;
}

async function expectRenderedIssueOptionCount(panel: Locator, expected: number): Promise<void> {
  const options = panel.locator('[data-filter-section="issueCode"] [data-filter-option]:not([data-filter-option="(空白)"])');
  await expect.poll(() => options.count()).toBe(expected);
}

/**
 * R4 重寫（specs/10 §4：不得悄悄刪檔，舊 spec → 新 UX 對照列於 PR body）。
 *
 * 筆數斷言的原則（Lead rework 裁決，09 §7「預期N人｜移除，只在fixture」）：
 *   「避免 fixture 變業務目標」是**產品文案**的限制，不是**測試**的限制。
 *   5（級距差異）／477（全批）是 conforming fixture 的值，寫在測試裡是對的。
 *
 * 舊 spec「核對結果頁 E2E 驗收測試」→ 新對應（09 §5.1／§5.2、04 §8 UX11／UX14／UX16／UX20；斷言強度不降級）：
 *   舊：核對總表「八欄」含美語天數／數學天數 → 新：12 欄（美語／數學天數位移至明細「原始資料」，不刪功能）
 *   舊：選「⚠ 僅顯示級距差異 (5筆)」→ toHaveCount(5) ＋ 首列含「級距差異」
 *       新：選項不含筆數（產品端）；同一篩選後 toHaveCount(5) ＋ 人數行 = 5 ＋ 每列含「天數不同」徽章
 *       ＋ 抽屜含「ERP 登記級距比對」與「級距差異」（新增 test「UX12」）
 *   舊：抽屜兩個固定標題「八項每週收費天數結果」「ERP 登記級距比對清單」→ 新：四分區（收費結果／課程與扣天／
 *       原始資料／技術資訊），其中「ERP 登記級距比對」仍在「課程與扣天」分區
 *   舊：「級距吻合」＋「有待確認事項」→ 表格含 SCHEDULE_NOT_FOUND → 新：同（UX12）
 *       （#157 Ruling 3 起，未對應課表的班改以 CLASS_NOT_MAPPED 提示，中文「班名未對應課表」）
 *   新增：班級扣天頁（UX05–07）、人數行 scope（UX13）
 */

test.describe('R4 重寫：核對結果頁 E2E 驗收（學生總表 12 欄 + 班級扣天）', () => {
  test('UX11/UX14: 上傳 → 啟用 → 學生總表 12 欄 → 人數行 scope → 明細抽屜四分區', async ({ page }) => {
    // 1. 上傳 ERP 名冊
    await page.goto('/imports');
    await page
      .locator('input[type="file"]')
      .setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });

    // 2. 頁內啟用（R3 已將啟用整合進匯入頁，不再回首頁找按鈕）
    await page.locator('button', { hasText: '使用這份名單' }).click();
    await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });
    await page.locator('a', { hasText: '前往核對結果' }).click();
    await expect(page.locator('.data-banner-current', { hasText: '目前使用的資料' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.results-page[data-hydrated="true"]')).toBeVisible({ timeout: 15000 });

    // 3. 結果雙頁籤（09 §2／§5.2）
    await expect(page.locator('button[role="tab"]', { hasText: '學生總表' })).toBeVisible();
    await expect(page.locator('button[role="tab"]', { hasText: '班級扣天' })).toBeVisible();

    // 4. 人數一行（09 §5.1／O03）：未選班「全部 N 人」· 符合篩選M人 · N位需確認，三者 scope 不同；未選班不寫「本班」
    const counts = page.locator('.counts-line');
    await expect(counts).toBeVisible();
    await expect(counts).toContainText('全部');
    await expect(counts).not.toContainText('本班');
    await expect(counts).toContainText('符合篩選');
    await expect(counts).toContainText('位需確認');
    // 不可再以 .stat-card 呈現（09 §5.1 要求單行）
    await expect(page.locator('.stat-card', { hasText: '符合篩選學生數' })).toHaveCount(0);

    // 5. 學生總表 12 欄（09 §5.1）
    const table = page.locator('.results-table');
    await expect(table).toBeVisible();
    for (const col of [
      '姓名', '年級', '所屬班級', '安親天數', '課輔天數', '額外扣天',
      '合計折扣', '已補科數', '兄弟姊妹折扣', '特殊折扣', '園內生', '需確認',
    ]) {
      await expect(table.locator('th', { hasText: col }).first()).toBeVisible();
    }
    // 既有欄位移而非刪除：美語／數學天數不在預設欄
    await expect(table.locator('th', { hasText: '美語天數' })).toHaveCount(0);
    await expect(table.locator('th', { hasText: '數學天數' })).toHaveCount(0);
    // 合計折扣說明基本率與指定課程的差別（09 §5.1）：只在表頭 tooltip（O01），資料列不逐列重複
    await expect(table.locator('tbody')).not.toContainText('指定課程可能另有調整');
    await table.locator('thead').getByRole('button', { name: /合計折扣.*說明/ }).click();
    await expect(page.getByRole('tooltip')).toContainText('指定課程可能另有調整');
    await page.keyboard.press('Escape');

    // 6. UX14：型別不混，null 顯示為非 0 的符號
    await expect(table).toContainText('—');

    // 7. 明細抽屜（09 §5.1 四分區；原始資料／技術資訊為摺疊，UX16 Esc 可關）
    await table.locator('tbody tr').first().click();
    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('收費結果');
    await expect(drawer).toContainText('課程與扣天');
    // 原始資料與技術資訊在摺疊區，不預設展開
    await expect(drawer.locator('summary', { hasText: '原始資料' })).toBeVisible();
    await expect(drawer.locator('summary', { hasText: '技術資訊' })).toBeVisible();
    // 位移欄位在明細仍可查（不刪功能）
    await drawer.locator('summary', { hasText: '原始資料' }).click();
    await expect(drawer).toContainText('人員代碼');
    await expect(drawer).toContainText('安親天數');

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  test('UX05–07: 班級扣天頁 8 欄、狀態區分、展開逐堂計算、無 active 時標示可先檢查扣天', async ({ page }) => {
    // 本檔前一個 test 已建立名單並啟用；直接前往班級扣天頁。
    // 不得條件式 skip（可能在沒人察覺時略過驗證）：找不到表格就是失敗。
    await page.goto('/?view=deductions');
    const tab = page.locator('button[role="tab"]', { hasText: '班級扣天' });
    await expect(tab).toBeVisible();
    await tab.click();

    const table = page.locator('.deductions-table');
    for (const col of ['班級', '老師', '上課時間', '安親原始扣除', '安親實際扣除', '課輔原始扣除', '課輔實際扣除', '狀態']) {
      await expect(table.locator('th', { hasText: col }).first()).toBeVisible();
    }
    // 扣除欄正量顯示（domain 負值不改，畫面不顯示負號）
    const cells = await table.locator('tbody td.number').allTextContents();
    expect(cells.some((c) => c.trim() === '0' || /^\d+(\.\d+)?$/.test(c.trim()))).toBe(true);
    expect(cells.every((c) => !c.trim().startsWith('-'))).toBe(true);

    // 展開班級 → 逐堂五個計算欄 + 編輯連結
    await table.locator('tbody tr').first().locator('button').first().click();
    await expect(table).toContainText('編輯此班課表');
    await expect(table).toContainText('課程時長');
  });

  /** 前置：確保已有啟用的名單（本檔各 test 共用同一個隔離 DB，重複上傳同檔會走判重路徑，故冪等處理）。 */
  async function ensureActivated(page: import('@playwright/test').Page) {
    await page.goto('/');
    if ((await page.locator('button[role="tab"]', { hasText: '學生總表' }).count()) === 0) {
      await page.goto('/imports');
      await page
        .locator('input[type="file"]')
        .setInputFiles(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
      await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
      await page.locator('button', { hasText: '使用這份名單' }).click();
      await expect(page.getByText(/\d+ 位學生資料已備妥/)).toBeVisible({ timeout: 15000 });
      await page.locator('a', { hasText: '前往核對結果' }).click();
    }
    await expect(page.locator('.data-banner-current', { hasText: '目前使用的資料' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.results-page[data-hydrated="true"]')).toBeVisible({ timeout: 15000 });
  }

  test('UX13: 搜尋／需確認篩選後人數與清單一致，且「本班N人」不受其他條件收斂（表頭篩選）', async ({ page }) => {
    await ensureActivated(page);

    const counts = page.locator('.counts-line');
    const matched = counts.locator('[data-count="matched"]');
    const classScope = counts.locator('[data-count="class-scope"]');
    const needsReview = counts.locator('[data-count="needs-review"]');
    const table = page.locator('.results-table');

    // 起點：未選班級時「全部 N 人」；「符合篩選」也＝全批
    const total = Number(await matched.textContent());
    expect(total).toBeGreaterThan(0);
    await expect(classScope).toHaveText(String(total));
    await expect(counts).toContainText(`全部 ${total} 人`);

    // (1) 搜尋個人：符合篩選收斂，但全部／本班 N 人不變（scope 只到班級）
    const search = page.locator('input[placeholder*="搜尋"]').first();
    await search.fill('STU0001');
    await expect(matched).not.toHaveText(String(total));
    const afterSearch = Number(await matched.textContent());
    expect(afterSearch).toBeGreaterThan(0);
    expect(afterSearch).toBeLessThan(total);
    await expect(classScope).toHaveText(String(total)); // 人數範圍不受搜尋收斂
    await expect(table.locator('tbody tr')).toHaveCount(afterSearch); // 清單與人數一致
    expect(page.url()).not.toContain('STU0001'); // q 不得寫入 URL（09 §5.1）

    // (2) 需確認篩選（問題類型全選，不含「(空白)」）：符合篩選 = 「N位需確認」，清單列數一致，且範圍人數仍不變
    await search.fill('');
    await expect(matched).toHaveText(String(total));
    const issuePanel = await openFilter(page, '需確認');
    const issueOptions = issuePanel.locator('[data-filter-section="issueCode"] [data-filter-option]:not([data-filter-option="(空白)"]) input[type="checkbox"]');
    const issueOptionCount = await issueOptions.count();
    expect(issueOptionCount).toBeGreaterThan(0);
    for (let i = 0; i < issueOptionCount; i++) await issueOptions.nth(i).check();
    await issuePanel.getByRole('button', { name: '確定', exact: true }).click();
    await expect(matched).not.toHaveText(String(total));
    const reviewCount = Number(await needsReview.textContent());
    expect(reviewCount).toBeGreaterThan(0);
    await expect(matched).toHaveText(String(reviewCount));
    await expect(classScope).toHaveText(String(total));
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(Math.min(reviewCount, 50)); // 預設每頁 50 列
    // 每一列都有「需確認」欄的徽章（問題代碼或天數不同），不是空的「—」
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      await expect(rows.nth(i).locator('td').last().locator('.badge')).not.toHaveCount(0);
    }

    // (3) 選定某班：範圍人數＝該班人數（小於全批），再搜尋後仍不變
    await page.getByRole('button', { name: '清除全部' }).click();
    await expect(matched).toHaveText(String(total));
    const classPanel = await openFilter(page, '所屬班級');
    const firstClass = await classPanel
      .locator('[data-filter-option]:not([data-filter-option="(空白)"]):not([data-filter-option="班名無法解析"])')
      .first()
      .getAttribute('data-filter-option');
    await classPanel.locator(`[data-filter-option="${firstClass}"] input[type="checkbox"]`).check();
    await classPanel.getByRole('button', { name: '確定', exact: true }).click();
    await expect(classScope).not.toHaveText(String(total));
    const scoped = Number(await classScope.textContent());
    expect(scoped).toBeGreaterThan(0);
    expect(scoped).toBeLessThan(total);
    await expect(counts).toContainText(`本班 ${scoped} 人`);
    await expect(matched).toHaveText(String(scoped)); // 只有班級條件時，符合篩選＝本班
    await search.fill('STU0001');
    await expect(classScope).toHaveText(String(scoped)); // 再加搜尋，本班N人不動
    expect(Number(await matched.textContent())).toBeLessThanOrEqual(scoped);
  });

  test('UX12: 級距差異篩選＝fixture 的 4 筆，列內容與抽屜可查；吻合＋待確認含「班名未對應課表」（中文名稱，代碼不外露）', async ({ page }) => {
    await ensureActivated(page);
    const initialOptionsResponse = page.waitForResponse((response) =>
      matchesStudentResponse(response, 'options', {}, ['tierMismatch', 'issueCode'])
    );
    await page.goto('/');
    expect((await initialOptionsResponse).ok()).toBe(true);
    await expect(page.locator('.results-page[data-hydrated="true"]')).toBeVisible({ timeout: 15000 });

    const counts = page.locator('.counts-line');
    const table = page.locator('.results-table');
    const rows = table.locator('tbody tr');

    // 控制列表先完成、對應 facets 延後：重現原 Full 中 count + live nth 的縮減窗口。
    const heldFacets = await holdStudentResponse(page, 'options', { tierMismatch: 'true' });
    const mismatchListResponse = page.waitForResponse((response) =>
      matchesStudentResponse(response, 'list', { tierMismatch: 'true' })
    );
    const mismatchFacetResponse = page.waitForResponse((response) =>
      matchesStudentResponse(response, 'options', { tierMismatch: 'true' })
    );
    try {
      // 舊版 toHaveCount(5) ＋「級距差異」列內容，恢復（選項標籤不含筆數，筆數由結果決定）
      await applyFilter(page, '需確認', { pick: ['天數不同'] });
      const listResponse = await mismatchListResponse;
      expect(new URL(listResponse.url()).searchParams.getAll('tierMismatch')).toEqual(['true']);
      await expect(rows).toHaveCount(FIXTURE_TIER_MISMATCH);
      await heldFacets.intercepted;

      await expect(counts.locator('[data-count="matched"]')).toHaveText(String(FIXTURE_TIER_MISMATCH));
      await expect(counts.locator('[data-count="mismatch"]')).toHaveText(String(FIXTURE_TIER_MISMATCH));
      for (let i = 0; i < FIXTURE_TIER_MISMATCH; i++) {
        await expect(rows.nth(i)).toContainText('天數不同');
      }

      // 明細抽屜：米豆奶登記級距比對與「級距差異」標示（UX16 Esc 可關）
      await rows.first().click();
      const drawer = page.locator('[role="dialog"]');
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText('米豆奶登記級距比對');
      await expect(drawer).toContainText('級距差異');
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);

      // Facet response is now complete for the applied mismatch filter. Reopen the
      // panel only after its matching options have reached the DOM.
      heldFacets.release();
      const mismatchFacets = await mismatchFacetResponse;
      expect(new URL(mismatchFacets.url()).searchParams.getAll('tierMismatch')).toEqual(['true']);
      const mismatchOptions = (await mismatchFacets.json() as { options: { issueCode: IssueFacetOption[] } }).options.issueCode;
      const p = await openFilter(page, '需確認');
      await expectRenderedIssueOptionCount(p, visibleIssueOptionCount(mismatchOptions));
      await p.locator('[data-filter-section="tierMismatch"] [data-filter-option="天數不同"] input[type="checkbox"]').uncheck();
      await p.locator('[data-filter-section="tierMismatch"] [data-filter-option="天數吻合"] input[type="checkbox"]').check();

      // Facets are per-field: issueCode options must be fetched with the newly
      // applied tierMismatch=false condition before choosing an issue.
      const heldMatchList = await holdStudentResponse(page, 'list', { tierMismatch: 'false' });
      const matchListResponse = page.waitForResponse((response) =>
        matchesStudentResponse(response, 'list', { tierMismatch: 'false' }, ['issueCode'])
      );
      const matchFacetResponse = page.waitForResponse((response) =>
        matchesStudentResponse(response, 'options', { tierMismatch: 'false' }, ['issueCode'])
      );
      try {
        await p.getByRole('button', { name: '確定', exact: true }).click();
        await expect(p).toHaveCount(0);

        // The matching facet response arrives while the list response is held.
        const matchFacets = await matchFacetResponse;
        expect(new URL(matchFacets.url()).searchParams.getAll('tierMismatch')).toEqual(['false']);
        const matchOptions = (await matchFacets.json() as { options: { issueCode: IssueFacetOption[] } }).options.issueCode;
        const classNotMapped = matchOptions.find((option) => option.value === 'CLASS_NOT_MAPPED');
        const classNotMappedCount = classNotMapped?.count ?? 0;
        expect(classNotMappedCount).toBeGreaterThan(0);
        await heldMatchList.intercepted;
        heldMatchList.release();

        const matchList = await matchListResponse;
        expect(new URL(matchList.url()).searchParams.getAll('tierMismatch')).toEqual(['false']);
        await expect(rows.first()).toBeVisible();

        const issuePanel = await openFilter(page, '需確認');
        await expectRenderedIssueOptionCount(issuePanel, visibleIssueOptionCount(matchOptions));
        const classNotMappedOption = issuePanel.locator(
          '[data-filter-section="issueCode"] [data-filter-option="班名未對應課表"]'
        );
        await expect(classNotMappedOption).toBeVisible();
        await expect(classNotMappedOption.locator('[data-filter-count]')).toHaveText(String(classNotMappedCount));
        const issueLabels = await issuePanel
          .locator('[data-filter-section="issueCode"] [data-filter-option]:not([data-filter-option="(空白)"])')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-filter-option')).filter((label): label is string => label !== null));
        expect(issueLabels).toContain('班名未對應課表');
        for (const label of issueLabels) {
          await issuePanel
            .locator(`[data-filter-section="issueCode"] [data-filter-option=${JSON.stringify(label)}] input[type="checkbox"]`)
            .check();
        }

        const finalListResponse = page.waitForResponse((response) =>
          matchesStudentResponse(response, 'list', {
            tierMismatch: 'false',
            issueCode: 'CLASS_NOT_MAPPED',
          })
        );
        await issuePanel.getByRole('button', { name: '確定', exact: true }).click();
        await expect(issuePanel).toHaveCount(0);
        const finalList = await finalListResponse;
        const finalParams = new URL(finalList.url()).searchParams;
        expect(finalParams.getAll('tierMismatch')).toEqual(['false']);
        expect(finalParams.getAll('issueCode')).toContain('CLASS_NOT_MAPPED');
        expect(finalParams.getAll('issueCode')).toHaveLength(issueLabels.length);
        await expect(rows.first()).toBeVisible();

        // 問題類型只顯示中文名稱（D39 (4)）：同一列仍看得到中文名稱，英文代碼不出現在主畫面。
        // #157 Ruling 3：未對應課表的班一律 CLASS_NOT_MAPPED（中文「班名未對應課表」），
        // 不再是「缺排課」（SCHEDULE_NOT_FOUND／「排課缺漏」）——fixture 學生報的班
        // 根本不在課表設定內，說「缺排課」並不準確。
        await expect(table.locator('tbody')).toContainText('班名未對應課表');
        await expect(table.locator('tbody')).not.toContainText('CLASS_NOT_MAPPED', { useInnerText: true });
      } finally {
        heldMatchList.release();
        await heldMatchList.remove();
      }
    } finally {
      heldFacets.release();
      await heldFacets.remove();
    }
  });
});
