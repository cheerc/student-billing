import { test, expect } from '@playwright/test';
import { B2, ensureB2Activated, allStudents, classesOf, studentName } from './helpers/b2-roster';
import { trigger, panel, chips, chip, openFilter, applyFilter, urlParams, visibleOptionLabels } from './helpers/header-filter';

/**
 * specs/04 UX25（瀏覽器部分）／specs/09 §5.1（D36 六點）／specs/11 §3 B2：表頭 ▾ 篩選。
 *
 * 全合成名冊（helpers/b2-roster.ts）；expected 來自「以 API 分頁讀完整個 run 後，在測試內獨立計算」，
 * 不是拿被測的選項端點或 SQL 篩選的輸出當黃金值。已知手算值：無課程 3 人、班名無法解析 1 人、共 210 人。
 */
const matched = (page: import('@playwright/test').Page) => page.locator('.counts-line [data-count="matched"]');

test.beforeEach(async ({ page }) => {
  await ensureB2Activated(page);
  await page.goto('/');
  await expect(page.locator('.results-table')).toBeVisible({ timeout: 15000 });
});

test.describe('UX25 表頭篩選：選項、六點語意、三種空狀態', () => {
  test('選項取自整個 run（含只在後頁出現的班）；「(空白)」與「班名無法解析」是兩個不同項目，皆不是空字串', async ({ page }) => {
    const students = await allStudents(page);
    expect(students).toHaveLength(B2.SIZE);
    // 前提：後頁獨有班不在第一頁（50 人）內，否則測試沒有意義
    expect(students.slice(0, 50).some((s) => classesOf(s).includes(B2.LATE))).toBe(false);
    expect(students.slice(50).some((s) => classesOf(s).includes(B2.LATE))).toBe(true);

    const p = await openFilter(page, '所屬班級');
    const labels = await visibleOptionLabels(p);
    const expectedClasses = [...new Set(students.flatMap(classesOf).filter(Boolean))];
    expect(expectedClasses.length).toBeGreaterThanOrEqual(6);
    for (const c of expectedClasses) expect(labels, `選項缺少 ${c}`).toContain(c);
    expect(labels).toContain(B2.LATE);

    // 兩個保留項目：不同名稱、不是空字串、各自的人數（手算：無課程 3、班名無法解析 1）
    expect(labels).toContain('(空白)');
    expect(labels).toContain('班名無法解析');
    expect(labels.every((l) => l.trim() !== '')).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    await expect(p.locator('[data-filter-option="(空白)"] [data-filter-count]')).toHaveText(String(B2.NO_COURSE));
    await expect(p.locator('[data-filter-option="班名無法解析"] [data-filter-count]')).toHaveText(String(B2.UNPARSED));

    // 各班人數＝該班學生數（去重；以完整清單獨立計算）
    for (const c of [B2.MATH, B2.CARE, B2.ENGLISH, B2.LATE]) {
      const n = students.filter((s) => classesOf(s).includes(c)).length;
      await expect(p.locator(`[data-filter-option="${c}"] [data-filter-count]`)).toHaveText(String(n));
    }
    // 姓名與代碼是敏感欄位：所屬班級以外的面板也不提供選項清單；姓名維持搜尋框
    await page.keyboard.press('Escape');
    await expect(trigger(page, '姓名')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '搜尋姓名或人員代碼' })).toBeVisible();
  });

  test('輸入「數學」→ 全選搜尋結果 → 確定；不清掉搜尋範圍外既有的選取；再加一欄為 AND', async ({ page }) => {
    const students = await allStudents(page);
    const mathClasses = [...new Set(students.flatMap(classesOf))].filter((c) => c.includes('數學'));
    expect(mathClasses.length).toBeGreaterThanOrEqual(1);

    // 先只選兒童美語-Gino
    await applyFilter(page, '所屬班級', { pick: [B2.ENGLISH] });
    const onlyEnglish = students.filter((s) => classesOf(s).includes(B2.ENGLISH));
    await expect(matched(page)).toHaveText(String(onlyEnglish.length));

    // 再開：搜尋「數學」→ 只剩數學班 → 全選搜尋結果
    const p = await openFilter(page, '所屬班級');
    await expect(p.locator(`[data-filter-option="${B2.ENGLISH}"] input[type="checkbox"]`)).toBeChecked();
    const search = p.getByRole('textbox', { name: '搜尋所屬班級選項' });
    await search.fill('數學');
    const hits = await visibleOptionLabels(p);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((l) => l.includes('數學'))).toBe(true);
    await p.getByRole('button', { name: '全選搜尋結果' }).click();
    // 搜尋範圍外既有的選取沒有被清掉：清空關鍵字後兒童美語-Gino 仍勾選
    await search.fill('');
    await expect(p.locator(`[data-filter-option="${B2.ENGLISH}"] input[type="checkbox"]`)).toBeChecked();
    for (const c of mathClasses) {
      await expect(p.locator(`[data-filter-option="${c}"] input[type="checkbox"]`)).toBeChecked();
    }
    await p.getByRole('button', { name: '確定', exact: true }).click();
    await expect(p).toHaveCount(0);

    // 同欄 OR：任一報名班命中即列出，人數依 personCode 去重
    const wanted = new Set([...mathClasses, B2.ENGLISH]);
    const orExpected = students.filter((s) => classesOf(s).some((c) => wanted.has(c)));
    await expect(matched(page)).toHaveText(String(orExpected.length));
    for (const c of wanted) await expect(chip(page, '所屬班級', c)).toBeVisible();
    expect(urlParams(page).getAll('enrollmentKey').sort()).toEqual([...wanted].sort());

    // 再加一欄（年級 3）：跨欄 AND
    await applyFilter(page, '年級', { pick: ['3年級'] });
    const andExpected = orExpected.filter((s) => s.grade === 3);
    expect(andExpected.length).toBeLessThan(orExpected.length);
    await expect(matched(page)).toHaveText(String(andExpected.length));
    await expect(chip(page, '年級', '3年級')).toBeVisible();
    expect(urlParams(page).getAll('grade')).toEqual(['3']);
  });

  test('取消保留原條件；逐一移除 chip；清除全部回到全批；有篩選的欄位 ▾ 變色', async ({ page }) => {
    const students = await allStudents(page);
    await applyFilter(page, '所屬班級', { pick: [B2.MATH] });
    await applyFilter(page, '年級', { pick: ['3年級'] });
    const mathIds = students.filter((s) => classesOf(s).includes(B2.MATH));
    const mathG3 = mathIds.filter((s) => s.grade === 3);
    await expect(matched(page)).toHaveText(String(mathG3.length));
    await expect(trigger(page, '年級')).toHaveAttribute('data-filter-active', 'true');
    await expect(trigger(page, '所屬班級')).toHaveAttribute('data-filter-active', 'true');
    await expect(trigger(page, '園內生')).not.toHaveAttribute('data-filter-active', 'true');

    // 取消：面板內改了選擇，但按「取消」不改條件
    const p = await openFilter(page, '年級');
    await p.locator('[data-filter-option="3年級"] input[type="checkbox"]').uncheck();
    await p.locator('[data-filter-option="4年級"] input[type="checkbox"]').check();
    await p.getByRole('button', { name: '取消', exact: true }).click();
    await expect(p).toHaveCount(0);
    await expect(matched(page)).toHaveText(String(mathG3.length));
    expect(urlParams(page).getAll('grade')).toEqual(['3']);
    await expect(chip(page, '年級')).toHaveCount(1);
    // 重開面板仍是原條件
    const again = await openFilter(page, '年級');
    await expect(again.locator('[data-filter-option="3年級"] input[type="checkbox"]')).toBeChecked();
    await expect(again.locator('[data-filter-option="4年級"] input[type="checkbox"]')).not.toBeChecked();
    await page.keyboard.press('Escape');

    // 逐一移除 chip：只移除該條件
    await chip(page, '年級', '3年級').click();
    await expect(matched(page)).toHaveText(String(mathIds.length));
    await expect(chip(page, '年級')).toHaveCount(0);
    await expect(trigger(page, '年級')).not.toHaveAttribute('data-filter-active', 'true');
    expect(urlParams(page).getAll('enrollmentKey')).toEqual([B2.MATH]);

    // 清除全部
    await applyFilter(page, '年級', { pick: ['2年級'] });
    await page.getByRole('button', { name: '清除全部' }).click();
    await expect(matched(page)).toHaveText(String(B2.SIZE));
    await expect(chips(page).locator('button[aria-label^="移除"]')).toHaveCount(0);
    for (const key of ['enrollmentKey', 'grade']) expect(urlParams(page).getAll(key)).toEqual([]);
  });

  test('三種空狀態分開：(空白)＝無課程 3 人、班名無法解析 1 人、取消全選後確定＝0 筆；未設篩選＝全部', async ({ page }) => {
    // 未設篩選：全部
    await expect(matched(page)).toHaveText(String(B2.SIZE));

    // (空白)：零報名者
    await applyFilter(page, '所屬班級', { pick: ['(空白)'] });
    await expect(matched(page)).toHaveText(String(B2.NO_COURSE));
    await expect(page.locator('.results-table tbody tr')).toHaveCount(B2.NO_COURSE);
    for (const i of [0, 1, 2]) {
      await expect(page.locator('.results-table tbody')).toContainText(studentName(i));
    }
    expect(urlParams(page).getAll('enrollmentKey')).toEqual(['~blank']);
    await expect(chip(page, '所屬班級', '(空白)')).toBeVisible();

    // 班名無法解析：有報名但 baseName 空（不是無課程）
    let p = await openFilter(page, '所屬班級');
    await p.locator('[data-filter-option="(空白)"] input[type="checkbox"]').uncheck();
    await p.locator('[data-filter-option="班名無法解析"] input[type="checkbox"]').check();
    await p.getByRole('button', { name: '確定', exact: true }).click();
    await expect(matched(page)).toHaveText(String(B2.UNPARSED));
    await expect(page.locator('.results-table tbody tr')).toHaveCount(B2.UNPARSED);
    await expect(page.locator('.results-table tbody')).toContainText(studentName(5));
    expect(urlParams(page).getAll('enrollmentKey')).toEqual(['~empty']);
    await expect(chip(page, '所屬班級', '班名無法解析')).toBeVisible();
    await expect(chip(page, '所屬班級', '(空白)')).toHaveCount(0);

    // 取消全選後按確定：0 筆（不是全部）
    p = await openFilter(page, '所屬班級');
    await p.getByRole('button', { name: '取消全選' }).click();
    await expect(p.locator('[data-filter-option] input[type="checkbox"]:checked')).toHaveCount(0);
    await p.getByRole('button', { name: '確定', exact: true }).click();
    await expect(matched(page)).toHaveText('0');
    await expect(page.getByText('沒有符合條件的學生')).toBeVisible();
    expect(urlParams(page).getAll('enrollmentKey')).toEqual(['~none']);
    await expect(chip(page, '所屬班級')).toHaveCount(1);

    // 由網址還原三種狀態
    for (const [wire, expected] of [['~blank', B2.NO_COURSE], ['~empty', B2.UNPARSED], ['~none', 0]] as const) {
      await page.goto(`/?enrollmentKey=${encodeURIComponent(wire)}`);
      await expect(matched(page)).toHaveText(String(expected));
    }
  });

  test('鍵盤全程操作：Enter 開啟、輸入、Tab 順序、Space 勾選、Enter 確定；Esc 關閉；焦點回表頭按鈕；Tab 不逸出面板', async ({ page }) => {
    const students = await allStudents(page);
    const mathClasses = [...new Set(students.flatMap(classesOf))].filter((c) => c.includes('數學'));
    const t = trigger(page, '所屬班級');
    await expect(t).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(t).toHaveAttribute('aria-expanded', 'false');
    await t.focus();
    await page.keyboard.press('Enter');

    const p = panel(page, '所屬班級');
    await expect(p).toBeVisible();
    await expect(t).toHaveAttribute('aria-expanded', 'true');
    const search = p.getByRole('textbox', { name: '搜尋所屬班級選項' });
    await expect(search).toBeFocused();

    // Shift+Tab 從第一個控制項回繞到最後一個（確定），不逸出面板
    await page.keyboard.press('Shift+Tab');
    await expect(p.getByRole('button', { name: '確定', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(search).toBeFocused();

    await page.keyboard.type('數學');
    await page.keyboard.press('Tab');
    await expect(p.getByRole('button', { name: '全選搜尋結果' })).toBeFocused();
    await page.keyboard.press('Enter');
    for (const c of mathClasses) {
      await expect(p.locator(`[data-filter-option="${c}"] input[type="checkbox"]`)).toBeChecked();
    }
    await page.keyboard.press('Tab');
    await expect(p.getByRole('button', { name: '取消全選' })).toBeFocused();
    await page.keyboard.press('Tab');
    const firstBox = p.locator('[data-filter-option] input[type="checkbox"]').first();
    await expect(firstBox).toBeFocused();
    await page.keyboard.press('Space');
    await expect(firstBox).not.toBeChecked();
    await page.keyboard.press('Space');
    await expect(firstBox).toBeChecked();

    // 依 Tab 前進到「取消」再到「確定」
    const cancel = p.getByRole('button', { name: '取消', exact: true });
    for (let i = 0; i < 60; i++) {
      if (await cancel.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(p.getByRole('button', { name: '確定', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(p).toHaveCount(0);
    await expect(t).toBeFocused();
    await expect(t).toHaveAttribute('aria-expanded', 'false');
    const wanted = students.filter((s) => classesOf(s).some((c) => mathClasses.includes(c)));
    await expect(matched(page)).toHaveText(String(wanted.length));
    for (const c of mathClasses) await expect(chip(page, '所屬班級', c)).toBeVisible();

    // Esc：關閉、條件不變、焦點回到表頭按鈕
    await page.keyboard.press('Space');
    await expect(p).toBeVisible();
    await p.getByRole('textbox', { name: '搜尋所屬班級選項' }).fill('美語');
    await p.getByRole('button', { name: '全選搜尋結果' }).click();
    await page.keyboard.press('Escape');
    await expect(p).toHaveCount(0);
    await expect(t).toBeFocused();
    await expect(matched(page)).toHaveText(String(wanted.length));
    await expect(chip(page, '所屬班級', B2.ENGLISH)).toHaveCount(0);
  });

  test('所有對應欄位都有表頭篩選入口；科別入口已移除；姓名維持搜尋框且不入網址', async ({ page }) => {
    for (const column of ['年級', '所屬班級', '安親天數', '課輔天數', '額外扣天', '合計折扣', '兄弟姊妹折扣', '特殊折扣', '園內生', '需確認']) {
      const t = trigger(page, column);
      await expect(t, `${column} 缺少表頭篩選`).toHaveCount(1);
      await expect(t).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(t).toHaveAttribute('aria-expanded', 'false');
    }
    // 科別入口（D36 移除）
    await expect(page.locator('select[aria-label="科別篩選"]')).toHaveCount(0);
    await expect(page.getByText('全部科別')).toHaveCount(0);

    // 姓名：搜尋框，條件 chip 可移除，不寫入網址；清除全部一併清空搜尋
    const q = page.getByRole('textbox', { name: '搜尋姓名或人員代碼' });
    await q.fill('B2E_0006');
    await expect(matched(page)).toHaveText('1');
    await expect(page.locator('.results-table tbody')).toContainText(studentName(6));
    expect(page.url()).not.toContain('B2E_0006');
    await expect(chip(page, '姓名或代碼', 'B2E_0006')).toBeVisible();
    await page.getByRole('button', { name: '清除全部' }).click();
    await expect(q).toHaveValue('');
    await expect(matched(page)).toHaveText(String(B2.SIZE));
  });
});
