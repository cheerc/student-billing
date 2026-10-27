import { test, expect, type Page } from '@playwright/test';
import {
  B2, ensureB2Activated, allStudents, classesOf, code, studentName, currentRunId,
  buildB2Workbook, XLSX_MIME, type ApiStudent,
} from './helpers/b2-roster';
import { trigger, panel, chips, chip, openFilter, applyFilter, urlParams } from './helpers/header-filter';

/**
 * specs/04 UX13（改寫）／UX28／UX29、09 §5.1 人數行與本班適用折扣、11 B2 第 3、5、6、9、10 項。
 * 全合成名冊；expected 由 API 分頁讀完整個 run 後在測試內獨立計算，關鍵案例另附手算值（見 helpers/b2-roster.ts）。
 */
const matched = (page: Page) => page.locator('.counts-line [data-count="matched"]');
const counts = (page: Page) => page.locator('.counts-line');

/** 與 formatDiscountBps 相同的短標規則（10000 無折扣；整十用「N折」；其餘 bps/100 折）。 */
function rateLabel(bps: number | null): string {
  if (bps === null) return '—';
  if (bps === 10000) return '無折扣';
  const tenths = bps / 1000;
  return Number.isInteger(tenths) ? `${tenths}折` : `${bps / 100}折`;
}

/** B1 凍結的暫定 v2 映射（03 §5.1）：國小輔導依年級 → 安親（1–2）／課輔（3–6）。 */
function careApplicable(s: ApiStudent): number | null {
  if (s.grade === 1 || s.grade === 2) return s.applicableAnqinBps;
  if (s.grade !== null && s.grade >= 3 && s.grade <= 6) return s.applicableTutoringBps;
  return null;
}

async function columnIndex(page: Page, header: string): Promise<number> {
  const labels = await page.locator('.results-table thead th').evaluateAll((ths) =>
    ths.map((th) => (th.textContent ?? '').replace(/\s+/g, ' ').trim())
  );
  return labels.findIndex((l) => l.startsWith(header));
}

const rowOf = (page: Page, i: number) =>
  page.locator('.results-table tbody tr', { has: page.getByRole('button', { name: `查看 ${studentName(i)} 的明細` }) });

test.beforeEach(async ({ page }) => {
  await ensureB2Activated(page);
  await page.goto('/');
  await expect(page.locator('.results-table')).toBeVisible({ timeout: 15000 });
});

test.describe('UX28 人數行（全部／本班／已選 N 班）與本班適用折扣', () => {
  test('未選班：全部 N 人，沒有「本班」與本班適用折扣欄，並說明僅恰選一班時顯示', async ({ page }) => {
    await expect(counts(page).locator('[data-scope]')).toHaveAttribute('data-scope', 'all');
    await expect(counts(page)).toContainText(`全部 ${B2.SIZE} 人`);
    await expect(counts(page)).not.toContainText('本班');
    expect(await columnIndex(page, '本班適用折扣')).toBe(-1);
    await expect(page.getByText('選擇單一班級後，才會顯示本班適用折扣')).toBeVisible();
  });

  test('恰選一班：本班 N 人；本班適用折扣欄與合計折扣並列不覆蓋；值與手算／API 一致；null 與「未設定」分開', async ({ page }) => {
    const students = await allStudents(page);
    await applyFilter(page, '所屬班級', { pick: [B2.CARE] });
    const care = students.filter((s) => classesOf(s).includes(B2.CARE));
    expect(care).toHaveLength(6); // 列 6、7、8、9、10、15（手算）

    await expect(counts(page).locator('[data-scope]')).toHaveAttribute('data-scope', 'single');
    await expect(counts(page)).toContainText(`本班 ${care.length} 人`);
    await expect(page.getByText('選擇單一班級後，才會顯示本班適用折扣')).toHaveCount(0);

    const base = await columnIndex(page, '合計折扣');
    const local = await columnIndex(page, '本班適用折扣');
    expect(base).toBeGreaterThanOrEqual(0);
    expect(local).toBeGreaterThan(base); // 與基本率並列（在其右側）
    const cell = (i: number, col: number) => rowOf(page, i).locator('td').nth(col);

    // 手算案例：兩者不同且各自正確
    await expect(cell(6, base)).toHaveText('無折扣'); // 科數 1，基本率 10000
    await expect(cell(6, local)).toHaveText('95折'); // R13 園內生：max(9000, 10000-500)=9500
    await expect(cell(7, base)).toHaveText('95折'); // 科數 2 → 9500
    await expect(cell(7, local)).toHaveText('9折'); // max(9000, 9500-500)=9000
    await expect(cell(8, base)).toHaveText('無折扣');
    await expect(cell(8, local)).toHaveText('無折扣'); // 課輔側無園內生優惠，與基本率相同但仍並列顯示
    // 年級未知：本班適用率無法判定＝「—」，不是「未設定」也不是 100%
    await expect(cell(10, local)).toHaveText('—');

    // 全班逐列與 API 的持久化欄位一致（年級對應安親／課輔側）
    for (const s of care) {
      const i = Number(s.personCode.slice(-4));
      await expect(cell(i, base)).toHaveText(rateLabel(s.baseDiscountBps));
      await expect(cell(i, local)).toHaveText(rateLabel(careApplicable(s)));
    }

    // 本班適用折扣有自己的表頭篩選（僅恰選一班時）；選 95折 → 只剩符合者，並帶班級條件到網址
    await applyFilter(page, '本班適用折扣', { pick: ['95折'] });
    const only95 = care.filter((s) => careApplicable(s) === 9500);
    expect(only95.length).toBeGreaterThanOrEqual(1);
    await expect(matched(page)).toHaveText(String(only95.length));
    expect(urlParams(page).getAll('applicableDiscountBps')).toEqual(['9500']);
    await expect(chip(page, '本班適用折扣', '95折')).toBeVisible();

    // 改成兩個班 → 本班條件不再成立：自動移除並提示，不出現錯誤
    await applyFilter(page, '所屬班級', { pick: [B2.MATH] });
    await expect(page.locator('.alert-danger')).toHaveCount(0); // 查詢失敗警告（不是 Next 的路由播報）
    expect(urlParams(page).getAll('applicableDiscountBps')).toEqual([]);
    await expect(chip(page, '本班適用折扣')).toHaveCount(0);
    await expect(page.locator('[data-notice="applicable-removed"]')).toContainText('本班適用折扣');
  });

  test('恰選一個未配置適用折扣的班：欄位顯示「未設定」，不當成 100%（無折扣）', async ({ page }) => {
    await applyFilter(page, '所屬班級', { pick: [B2.OTHER] });
    const local = await columnIndex(page, '本班適用折扣');
    expect(local).toBeGreaterThanOrEqual(0);
    await expect(rowOf(page, 12).locator('td').nth(local)).toHaveText('未設定');
    await expect(rowOf(page, 12).locator('td').nth(local)).not.toContainText('無折扣');
  });

  test('選兩班：已選 2 班，共 M 人（去重），沒有「本班」與本班適用折扣欄；(空白) 也不算本班', async ({ page }) => {
    const students = await allStudents(page);
    await applyFilter(page, '所屬班級', { pick: [B2.CARE, B2.MATH] });
    const union = students.filter((s) => classesOf(s).some((c) => c === B2.CARE || c === B2.MATH));
    const both = students.filter((s) => classesOf(s).includes(B2.CARE) && classesOf(s).includes(B2.MATH));
    expect(both.length).toBeGreaterThanOrEqual(1); // 同時屬於兩班者只算 1 人（列 7）
    await expect(counts(page)).toContainText(`已選 2 班，共 ${union.length} 人`);
    await expect(counts(page)).not.toContainText('本班');
    expect(await columnIndex(page, '本班適用折扣')).toBe(-1);
    await expect(page.getByText('選擇單一班級後，才會顯示本班適用折扣')).toBeVisible();

    await applyFilter(page, '所屬班級', { none: true, pick: ['(空白)'] });
    await expect(counts(page)).not.toContainText('本班');
    expect(await columnIndex(page, '本班適用折扣')).toBe(-1);
  });
});

test.describe('UX29 無課程提示', () => {
  test('顯示全批人數與離籍提示；不併入需確認；點擊篩出；另有條件時分開顯示目前條件內人數', async ({ page }) => {
    const students = await allStudents(page);
    const noCourse = students.filter((s) => s.enrollments.length === 0);
    expect(noCourse).toHaveLength(B2.NO_COURSE);
    // 前提：列 2 無課程但另有真實 issue
    expect(students[2].hasIssues).toBe(true);
    // 只有寫功課／只有交通車／班名無法解析者不是無課程
    for (const i of [3, 4, 5]) expect(students[i].enrollments.length).toBeGreaterThan(0);

    const hint = page.locator('[data-count="no-course"]');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(`無課程 ${B2.NO_COURSE} 人`);
    await expect(hint).toContainText('請至米豆奶辦理離籍');
    // 需確認人數只依真實 issue 計算，不含無課程本身
    await expect(counts(page).locator('[data-count="needs-review"]')).toHaveText(String(students.filter((s) => s.hasIssues).length));

    // 點擊篩出：名單＝這些人，人數一致，等同所屬班級選「(空白)」
    await hint.click();
    await expect(matched(page)).toHaveText(String(B2.NO_COURSE));
    const rows = page.locator('.results-table tbody tr');
    await expect(rows).toHaveCount(B2.NO_COURSE);
    for (const i of [0, 1, 2]) await expect(page.locator('.results-table tbody')).toContainText(studentName(i));
    for (const i of [3, 4, 5]) await expect(page.locator('.results-table tbody')).not.toContainText(studentName(i));
    await expect(chip(page, '所屬班級', '(空白)')).toBeVisible();
    expect(urlParams(page).getAll('enrollmentKey')).toEqual(['~blank']);
    // 無課程學生另有真實 issue 者仍計入需確認（列 2）
    await expect(counts(page).locator('[data-count="needs-review"]')).toHaveText(String(noCourse.filter((s) => s.hasIssues).length));

    // 加上年級 3（列 2 的年級，手算：列 0、1、2 依序為一、二、三年級）→ 全批仍 3，目前條件內 1
    await applyFilter(page, '年級', { pick: ['3年級'] });
    await expect(hint).toContainText(`無課程 ${B2.NO_COURSE} 人`);
    await expect(page.locator('[data-count="no-course-filtered"]')).toHaveText('1');
    await expect(matched(page)).toHaveText('1');
  });

  test('匯入預覽同數：預覽顯示相同的無課程人數與離籍提示，可篩出同一批人', async ({ page }) => {
    await page.goto('/imports');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'b2-synthetic.xlsx',
      mimeType: XLSX_MIME,
      buffer: await buildB2Workbook(),
    });
    await expect(page.locator('.stats-grid')).toBeVisible({ timeout: 15000 });
    const card = page.locator('.stat-card', { hasText: '無課程' });
    await expect(card).toContainText(String(B2.NO_COURSE));
    await expect(card).toContainText('請至米豆奶辦理離籍');
    await card.getByRole('button', { name: '只看無課程的學生' }).click();
    await expect(page.getByText(`名單預覽 (${B2.NO_COURSE} / ${B2.SIZE})`)).toBeVisible();
    for (const i of [0, 1, 2]) await expect(page.locator('tbody')).toContainText(code(i));
    for (const i of [3, 4, 5]) await expect(page.locator('tbody')).not.toContainText(code(i));
  });
});

test.describe('UX13（改寫）條件保留、兩頁籤獨立、姓名不入網址', () => {
  test('選班 → 搜尋學生 → 開明細 → 返回；切頁籤再回來；兩頁籤各自保留條件（F03）', async ({ page }) => {
    const students = await allStudents(page);
    await applyFilter(page, '所屬班級', { pick: [B2.MATH] });
    const mathN = students.filter((s) => classesOf(s).includes(B2.MATH)).length;
    const search = page.getByRole('textbox', { name: '搜尋姓名或人員代碼' });
    await search.fill(studentName(13));
    await expect(matched(page)).toHaveText('1');
    // 本班 N 人不受姓名搜尋收斂（scope 只到班級）
    await expect(counts(page).locator('[data-count="class-scope"]')).toHaveText(String(mathN));
    expect(page.url()).not.toContain(code(13));
    expect(page.url()).not.toContain(studentName(13));

    // 開明細 → 返回（Esc）：名單／人數／條件不變
    await rowOf(page, 13).getByRole('button', { name: `查看 ${studentName(13)} 的明細` }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(matched(page)).toHaveText('1');
    await expect(search).toHaveValue(studentName(13));
    await expect(chip(page, '所屬班級', B2.MATH)).toBeVisible();

    // 切到班級扣天：不顯示學生總表的篩選列與人數行，改用班級／老師／狀態
    await page.locator('button[role="tab"]', { hasText: '班級扣天' }).click();
    await expect(page.locator('.deductions-table')).toBeVisible();
    expect(urlParams(page).get('view')).toBe('deductions');
    await expect(trigger(page, '所屬班級')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '搜尋姓名或人員代碼' })).toHaveCount(0);
    await expect(counts(page)).toHaveCount(0);
    for (const column of ['班級', '老師', '狀態']) await expect(trigger(page, column)).toHaveCount(1);
    await expect(chip(page, '所屬班級')).toHaveCount(0); // 學生總表的條件不作用於本頁籤

    // 班級扣天自己的條件：班級搜尋「數學」→ 全選搜尋結果
    const panelBefore = await openFilter(page, '班級');
    const allClassLabels = await panelBefore.locator('[data-filter-option]').evaluateAll((els) => els.map((e) => e.getAttribute('data-filter-option') ?? ''));
    await page.keyboard.press('Escape');
    const mathLabels = allClassLabels.filter((l) => l.includes('數學'));
    expect(mathLabels.length).toBeGreaterThanOrEqual(1);
    expect(mathLabels.length).toBeLessThan(allClassLabels.length);
    await applyFilter(page, '班級', { searchAll: '數學' });
    await expect(page.locator('.deductions-table tbody > tr:not(.ded-expanded)')).toHaveCount(mathLabels.length);
    await expect(page.locator('.class-deductions')).toContainText(`共 ${mathLabels.length} 個班級`);
    for (const l of mathLabels) await expect(chip(page, '班級', l)).toBeVisible();

    // 切回學生總表：學生條件、姓名搜尋、人數都還在；班級扣天條件不影響學生名單
    await page.locator('button[role="tab"]', { hasText: '學生總表' }).click();
    await expect(page.locator('.results-table')).toBeVisible();
    expect(urlParams(page).get('view') ?? 'students').toBe('students');
    await expect(matched(page)).toHaveText('1');
    await expect(search).toHaveValue(studentName(13));
    await expect(chip(page, '所屬班級', B2.MATH)).toBeVisible();
    await expect(chip(page, '班級')).toHaveCount(0);

    // 再切回班級扣天：條件仍在
    await page.locator('button[role="tab"]', { hasText: '班級扣天' }).click();
    await expect(page.locator('.class-deductions')).toContainText(`共 ${mathLabels.length} 個班級`);
    for (const l of mathLabels) await expect(chip(page, '班級', l)).toBeVisible();
  });

  test('重新整理／從其他頁返回：條件（網址）、姓名搜尋（頁內保存）與表內捲動位置保留', async ({ page }) => {
    await applyFilter(page, '所屬班級', { pick: [B2.MATH] });
    const search = page.getByRole('textbox', { name: '搜尋姓名或人員代碼' });
    await search.fill('B2E_00');
    await expect(matched(page)).not.toHaveText(String(B2.SIZE));
    const total = await matched(page).textContent();
    const scroller = page.locator('.table-scroll').first();
    await scroller.evaluate((el) => { el.scrollTop = 300; });
    await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
    const before = await scroller.evaluate((el) => el.scrollTop);
    await page.waitForTimeout(400); // 讓捲動位置寫入頁內保存

    await page.goto('/imports');
    await expect(page.locator('h1')).toContainText('匯入學生');
    await page.goBack();

    await expect(page.locator('.results-table')).toBeVisible({ timeout: 15000 });
    await expect(matched(page)).toHaveText(String(total));
    await expect(chip(page, '所屬班級', B2.MATH)).toBeVisible();
    await expect(page.getByRole('textbox', { name: '搜尋姓名或人員代碼' })).toHaveValue('B2E_00');
    await expect
      .poll(async () => page.locator('.table-scroll').first().evaluate((el) => el.scrollTop), { timeout: 5000 })
      .toBeGreaterThan(before - 40);
    expect(page.url()).not.toContain('B2E_00');
  });


});

test.describe('run 變更、無效網址與晚到回應', () => {
  test('網址帶有這份資料中已不存在的選值（run 變更後）→ 自動移除並提示，其餘條件保留', async ({ page }) => {
    const students = await allStudents(page);
    const runId = await currentRunId(page);
    const q = new URLSearchParams();
    q.set('runId', 'run_previous_generation');
    q.append('enrollmentKey', '已不存在的班');
    q.append('enrollmentKey', B2.MATH);
    q.set('grade', '9');
    await page.goto(`/?${q}`);
    await expect(page.locator('.results-table')).toBeVisible({ timeout: 15000 });

    const notice = page.locator('[data-notice="filters-pruned"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('已移除');
    await expect(notice).toContainText('已不存在的班');
    await expect(chip(page, '所屬班級', '已不存在的班')).toHaveCount(0);
    await expect(chip(page, '所屬班級', B2.MATH)).toBeVisible();
    await expect(chip(page, '年級')).toHaveCount(0);
    const mathN = students.filter((s) => classesOf(s).includes(B2.MATH)).length;
    await expect(matched(page)).toHaveText(String(mathN));
    // 網址同步為移除後的條件與目前的 run
    await expect.poll(() => urlParams(page).getAll('enrollmentKey')).toEqual([B2.MATH]);
    expect(urlParams(page).getAll('grade')).toEqual([]);
    expect(urlParams(page).get('runId')).toBe(runId);
  });

  test('網址帶有無效的篩選值 → 忽略並提示，不白屏、不顯示錯誤頁', async ({ page }) => {
    await page.goto('/?hasExtraDeduction=maybe');
    await expect(page.locator('.results-table')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-notice="filters-invalid"]')).toContainText('無效');
    await expect(matched(page)).toHaveText(String(B2.SIZE));
    await expect(chips(page).locator('button[aria-label^="移除"]')).toHaveCount(0);
  });

  test('client 端晚到回應不得覆蓋新條件的結果（先送出年級 3 的慢回應，再改成年級 4）', async ({ page }) => {
    const students = await allStudents(page);
    await page.route(/\/api\/v1\/runs\/[^/]+\/students\?/, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.getAll('grade').join() === '3' && !url.searchParams.has('options')) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      await route.continue();
    });

    await applyFilter(page, '年級', { pick: ['3年級'] }); // 慢回應
    const p = await openFilter(page, '年級');
    await p.locator('[data-filter-option="3年級"] input[type="checkbox"]').uncheck();
    await p.locator('[data-filter-option="4年級"] input[type="checkbox"]').check();
    await p.getByRole('button', { name: '確定', exact: true }).click();

    const g4 = students.filter((s) => s.grade === 4).length;
    await expect(matched(page)).toHaveText(String(g4));
    await page.waitForTimeout(2200); // 讓年級 3 的慢回應在此之後回來
    await expect(matched(page)).toHaveText(String(g4));
    await expect(chip(page, '年級', '4年級')).toBeVisible();
    await expect(chip(page, '年級', '3年級')).toHaveCount(0);
    expect(urlParams(page).getAll('grade')).toEqual(['4']);
    const gradeCol = await columnIndex(page, '年級');
    const cells = await page.locator('.results-table tbody tr').evaluateAll(
      (trs, col) => trs.map((tr) => (tr.querySelectorAll('td')[col]?.textContent ?? '').trim()),
      gradeCol
    );
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c === '4年級')).toBe(true);
  });
});
