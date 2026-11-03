import { test, expect, type Page } from '@playwright/test';
import { ensureB2Activated, currentRunId } from './helpers/b2-roster';
import {
  brandLink,
  classRow,
  discardChanges,
  dirtyBar,
  editStart,
  ensureClassTypeTab,
  keepEditing,
  leaveDialog,
  openClassSchedule,
  openClassScheduleViaHome,
  openSchedule,
  scheduleHeading,
  sideLink,
  startInput,
} from './helpers/c-batch';

/**
 * specs/04 UX31／09 §3.2（11 C；D38 F07）：課表有未儲存修改時的離頁提醒。
 *
 * 站內離開入口（側欄各頁、品牌連結、班級編輯入口、瀏覽器 Back）一律先跳「繼續編輯／捨棄修改」；
 * 儲存成功與沒有修改時不打擾；reload／關閉分頁由瀏覽器原生 beforeunload 提醒（只驗有使用者互動後會出現）。
 * 另驗：確認視窗不因反覆導覽而累積、確認後只導覽一次、捨棄後沒有殘留的 beforeunload。
 *
 * 全部走實際的側欄／連結點擊與瀏覽器返回，不直接呼叫 router。
 * 會儲存課表的案例放在最後，避免影響前面案例的初始狀態。
 */

const pathOf = (page: Page) => new URL(page.url()).pathname;

/** 關閉分頁前的 beforeunload：有原生提醒 → 回傳 dialog 型別；沒有 → 分頁直接關閉。 */
async function closeWithBeforeUnload(page: Page): Promise<'beforeunload' | 'closed'> {
  const seen: string[] = [];
  page.on('dialog', (d) => {
    seen.push(d.type());
  });
  await page.close({ runBeforeUnload: true });
  if (page.isClosed()) return 'closed';
  return (seen[0] as 'beforeunload') ?? 'closed';
}

test.describe('UX31 站內離開入口：dirty 時先確認', () => {
  const targets: Array<{ name: RegExp; label: string; path: string }> = [
    { name: /匯入學生/, label: '匯入學生', path: '/imports' },
    { name: /核對結果/, label: '核對結果', path: '/' },
  ];

  for (const t of targets) {
    test(`側欄「${t.label}」：先跳確認；繼續編輯保留草稿並留在課表頁；Esc 等同繼續編輯；捨棄修改才離開`, async ({ page }) => {
      await openSchedule(page);
      await editStart(page, '15:45');

      await sideLink(page, t.name).click();
      await expect(leaveDialog(page)).toBeVisible();
      expect(pathOf(page)).toBe('/settings');
      await expect(leaveDialog(page)).toContainText('離開');
      await expect(keepEditing(page)).toBeVisible();
      await expect(discardChanges(page)).toBeVisible();

      // 繼續編輯：關閉確認、留在課表頁、草稿與「有未儲存的變更」都還在
      await keepEditing(page).click();
      await expect(leaveDialog(page)).toHaveCount(0);
      expect(pathOf(page)).toBe('/settings');
      await expect(await startInput(page)).toHaveValue('15:45');
      await expect(dirtyBar(page)).toBeVisible();

      // Esc 等同繼續編輯（不離開、不丟草稿）
      await sideLink(page, t.name).click();
      await expect(leaveDialog(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(leaveDialog(page)).toHaveCount(0);
      expect(pathOf(page)).toBe('/settings');
      await expect(await startInput(page)).toHaveValue('15:45');

      // 捨棄修改：才真的離開
      await sideLink(page, t.name).click();
      await expect(leaveDialog(page)).toBeVisible();
      await discardChanges(page).click();
      await expect.poll(() => pathOf(page)).toBe(t.path);
      await expect(leaveDialog(page)).toHaveCount(0);
    });
  }

  test('品牌／首頁連結：先跳確認；捨棄修改後回到首頁', async ({ page }) => {
    await openSchedule(page);
    await editStart(page, '15:50');

    await brandLink(page).click();
    await expect(leaveDialog(page)).toBeVisible();
    expect(pathOf(page)).toBe('/settings');

    await keepEditing(page).click();
    await expect(leaveDialog(page)).toHaveCount(0);
    await expect(await startInput(page)).toHaveValue('15:50');

    await brandLink(page).click();
    await expect(leaveDialog(page)).toBeVisible();
    await discardChanges(page).click();
    await expect.poll(() => pathOf(page)).toBe('/');
  });

  test('瀏覽器 Back：離開前先確認；繼續編輯留在課表頁且草稿保留；捨棄修改後回到上一頁', async ({ page }) => {
    // 先有一個上一頁：首頁 → 側欄進課表設定（站內導覽，歷史紀錄才有上一頁可返回）
    await page.goto('/');
    await expect(page.locator('main')).toBeVisible();
    await sideLink(page, /課表設定/).click();
    await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
    expect(pathOf(page)).toBe('/settings');

    await editStart(page, '15:55');

    await page.goBack();
    await expect(leaveDialog(page)).toBeVisible();
    expect(pathOf(page)).toBe('/settings');

    await keepEditing(page).click();
    await expect(leaveDialog(page)).toHaveCount(0);
    expect(pathOf(page)).toBe('/settings');
    await expect(await startInput(page)).toHaveValue('15:55');
    await expect(dirtyBar(page)).toBeVisible();

    // 再按一次 Back 仍然會攔截（不是只攔第一次）
    await page.goBack();
    await expect(leaveDialog(page)).toBeVisible();
    await discardChanges(page).click();
    await expect.poll(() => pathOf(page)).toBe('/');
  });

  test('確認視窗不累積；確認後只導覽一次；捨棄後沒有殘留的 beforeunload', async ({ page }) => {
    await openClassScheduleViaHome(page, '兒童美語-Gino');
    const original = await (await startInput(page)).inputValue();
    await editStart(page, '16:00');

    // 反覆觸發離開（連點連結、連按返回）：確認視窗始終只有一層
    await page.evaluate(() => {
      const a = [...document.querySelectorAll('aside.side a')].find((el) => el.textContent?.includes('匯入學生')) as
        | HTMLAnchorElement
        | undefined;
      a?.click();
      a?.click();
      a?.click();
    });
    await expect(leaveDialog(page)).toHaveCount(1);
    await page.evaluate(() => {
      history.back();
      history.back();
    });
    await page.waitForTimeout(500);
    await expect(leaveDialog(page)).toHaveCount(1);
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    expect(pathOf(page)).toBe('/settings');

    // 確認捨棄：只導覽一次（歷史紀錄只多一筆）
    await discardChanges(page).click();
    await expect.poll(() => pathOf(page)).toBe('/imports');
    await expect(leaveDialog(page)).toHaveCount(0);

    // 返回一步剛好回到課表頁（不是重複的同網址紀錄），且是乾淨的伺服器狀態、不再有提醒
    await page.goBack();
    await expect.poll(() => pathOf(page)).toBe('/settings');
    await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
    await expect(leaveDialog(page)).toHaveCount(0);
    await expect(dirtyBar(page)).toHaveCount(0);
    // 側欄進入的網址不帶 ?class=，Back 後頁籤回到預設安親（沒有時段欄）；先切回該班所在頁籤。
    await ensureClassTypeTab(page, '兒童美語-Gino');
    await expect(await startInput(page)).toHaveValue(original);

    // 再返回一步就是最初的首頁
    await page.goBack();
    await expect.poll(() => pathOf(page)).toBe('/');
    await expect(leaveDialog(page)).toHaveCount(0);

    // 捨棄後沒有殘留的 beforeunload：關閉分頁不再出現原生提醒
    expect(await closeWithBeforeUnload(page)).toBe('closed');
  });
});

test.describe('UX31 班級編輯入口：「編輯此班課表」進出課表頁', () => {
  test('從「編輯此班課表」進入 → 改草稿 → 經站內連結離開會先確認；捨棄後再進入是乾淨的伺服器狀態；繼續編輯仍留在該班課表', async ({
    page,
  }) => {
    await ensureB2Activated(page);
    await page.goto('/?view=deductions');
    await expect(page.locator('.deductions-table')).toBeVisible({ timeout: 15000 });
    const firstClassBtn = page.locator('.deductions-table tbody > tr:not(.ded-expanded) button').first();
    const classKey = (await firstClassBtn.textContent())?.trim().split(/\s+/)[0] ?? '';
    const esc = classKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const enterFromDeductions = async () => {
      await page.goto('/?view=deductions');
      await expect(page.locator('.deductions-table')).toBeVisible({ timeout: 15000 });
      await page.locator('.deductions-table tbody > tr:not(.ded-expanded) button', { hasText: new RegExp(`^${esc}\\s`) }).click();
      await page.getByRole('button', { name: /編輯此班課表/ }).click();
      await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
      await expect(page.locator('[data-focus-class]')).toContainText(classKey);
    };
    // 以「編輯此班課表」帶入的班名定位（D61 起不可用表格第一列：列序依頁籤與篩選變動）
    const classStart = () => classRow(page, classKey).locator('input.input-time').first();

    await enterFromDeductions();
    const original = await classStart().inputValue();
    const changed = original === '15:35' ? '15:40' : '15:35';
    await editStart(page, changed, classStart());

    // 「顯示全部班級」不離開課表頁：不跳確認、草稿還在
    await page.locator('[data-focus-class]').getByRole('button', { name: '顯示全部班級' }).click();
    await expect(leaveDialog(page)).toHaveCount(0);
    await expect(dirtyBar(page)).toBeVisible();
    // 回到該班（重新整理前的網址）以便後續步驟：直接用側欄離開
    await sideLink(page, /核對結果/).click();
    await expect(leaveDialog(page)).toBeVisible();

    // 繼續編輯：仍在課表頁、草稿保留
    await keepEditing(page).click();
    await expect(leaveDialog(page)).toHaveCount(0);
    expect(pathOf(page)).toBe('/settings');
    await expect(dirtyBar(page)).toBeVisible();

    // 捨棄修改：離開；再從「編輯此班課表」進入，是沒有被草稿汙染的伺服器狀態
    await sideLink(page, /核對結果/).click();
    await expect(leaveDialog(page)).toBeVisible();
    await discardChanges(page).click();
    await expect.poll(() => pathOf(page)).toBe('/');

    await enterFromDeductions();
    await expect(dirtyBar(page)).toHaveCount(0);
    await expect(classStart()).toHaveValue(original);
    await expect(leaveDialog(page)).toHaveCount(0);
  });
});

test.describe('UX31 reload／關閉分頁：瀏覽器原生 beforeunload', () => {
  test('有互動且有未儲存修改：關閉分頁與重新整理都會出現原生提醒；取消提醒後草稿還在', async ({ page }) => {
    await openSchedule(page);
    await editStart(page, '15:45');

    // 關閉分頁：出現 beforeunload，取消（dismiss）後分頁仍在、草稿仍在
    const dialogPromise = page.waitForEvent('dialog', { timeout: 5000 });
    await page.close({ runBeforeUnload: true });
    const d = await dialogPromise;
    expect(d.type()).toBe('beforeunload');
    await d.dismiss();
    expect(page.isClosed()).toBe(false);
    await expect(await startInput(page)).toHaveValue('15:45');
    await expect(dirtyBar(page)).toBeVisible();

    // 重新整理：出現 beforeunload；同意離開後回到乾淨的伺服器狀態
    const types: string[] = [];
    page.once('dialog', async (dlg) => {
      types.push(dlg.type());
      await dlg.accept();
    });
    await page.reload();
    expect(types).toEqual(['beforeunload']);
    await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
    await expect(dirtyBar(page)).toHaveCount(0);
  });

  test('沒有修改時不打擾：站內連結直接離開、Back 直接返回、關閉分頁沒有原生提醒', async ({ page }) => {
    await page.goto('/');
    await sideLink(page, /課表設定/).click();
    await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });

    await sideLink(page, /匯入學生/).click();
    await expect.poll(() => pathOf(page)).toBe('/imports');
    await expect(leaveDialog(page)).toHaveCount(0);

    await page.goBack();
    await expect.poll(() => pathOf(page)).toBe('/settings');
    await page.goBack();
    await expect.poll(() => pathOf(page)).toBe('/');
    await expect(leaveDialog(page)).toHaveCount(0);

    expect(await closeWithBeforeUnload(page)).toBe('closed');
  });

  test('改了又「取消修改」回到沒有修改：離開不打擾', async ({ page }) => {
    await openSchedule(page);
    await editStart(page, '15:45');
    await page.locator('button', { hasText: '取消修改' }).click();
    await expect(dirtyBar(page)).toHaveCount(0);

    await sideLink(page, /匯入學生/).click();
    await expect.poll(() => pathOf(page)).toBe('/imports');
    await expect(leaveDialog(page)).toHaveCount(0);
  });
});

async function installSentinelBarrier(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__sentinelBarrier = {
      enabled: false,
      release: null as null | (() => void),
      popCount: 0,
    };
    const origGo = history.go;
    history.go = function (delta?: number) {
      if (w.__sentinelBarrier?.enabled && delta === -1) {
        const receiver = this;
        const args = arguments;
        w.__sentinelBarrier.release = () => {
          w.__sentinelBarrier.release = null;
          origGo.apply(receiver, args as any);
        };
        return;
      }
      return origGo.apply(this, arguments as any);
    };
    window.addEventListener('popstate', () => {
      if (w.__sentinelBarrier) w.__sentinelBarrier.popCount++;
    }, true);
  });
}

test.describe('UX31 儲存成功後不再提醒（會寫入課表，放最後）', () => {
  test('改草稿 → 確認變更 → 儲存課表成功 → 側欄、Back、關閉分頁都不打擾', async ({ page }) => {
    await page.goto('/');
    await sideLink(page, /課表設定/).click();
    await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
    await editStart(page, '15:45');

    await page.locator('button', { hasText: '確認變更' }).click();
    const impact = page.locator('dialog.impact-dialog');
    await expect(impact).toBeVisible({ timeout: 15000 });
    await impact.locator('button', { hasText: /^儲存/ }).click();
    await expect(page.locator('#toast')).toContainText('課表已', { timeout: 15000 });
    await expect(dirtyBar(page)).toHaveCount(0);

    // 儲存成功後：離開不打擾
    await sideLink(page, /匯入學生/).click();
    await expect.poll(() => pathOf(page)).toBe('/imports');
    await expect(leaveDialog(page)).toHaveCount(0);

    // Back 一步就回到課表頁（沒有殘留的攔截紀錄），再一步回首頁，都不打擾
    await page.goBack();
    await expect.poll(() => pathOf(page)).toBe('/settings');
    await expect(leaveDialog(page)).toHaveCount(0);
    await page.goBack();
    await expect.poll(() => pathOf(page)).toBe('/');
    await expect(leaveDialog(page)).toHaveCount(0);

    // 已儲存的課表頁：關閉分頁沒有原生提醒
    await sideLink(page, /課表設定/).click();
    await expect(scheduleHeading(page)).toBeVisible({ timeout: 15000 });
    expect(await closeWithBeforeUnload(page)).toBe('closed');
  });
});

test.describe('UX31 R1/R2/R3: 儲存與取消之離頁守衛結算生命週期', () => {
  for (const action of ['save', 'cancel'] as const) {
    test(`UX31 R1 (settings_only): ${action} 結算期間點擊站內連結，不丟失新目的地`, async ({ page }) => {
      await installSentinelBarrier(page);
      await page.goto('/');
      await expect(page.locator('main')).toBeVisible();
      await sideLink(page, /課表設定/).click();
      await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });

      // 新增班級產生 dirty
      await page.getByRole('button', { name: '＋ 新增班級' }).click();
      const form = page.locator('dialog.add-class-dialog form.add-session-panel');
      const testName = `國小輔導-r1-${action}-${Date.now().toString().slice(-4)}`;
      await form.getByLabel('新增班級名稱').fill(testName);
      await form.getByRole('button', { name: '確認新增' }).click();
      await expect(page.locator('.save-status-dirty')).toBeVisible();

      // 啟用 barrier 扣留 Save/Cancel 觸發的 history.go(-1)
      await page.evaluate(() => {
        (window as any).__sentinelBarrier.enabled = true;
      });

      if (action === 'save') {
        await page.getByRole('button', { name: '確認變更', exact: true }).click();
        const dialog = page.locator('dialog.impact-dialog');
        await expect(dialog).toBeVisible({ timeout: 15000 });
        const applied = page.waitForResponse(
          (r) => r.url().endsWith('/api/v1/settings/apply') && r.request().method() === 'POST'
        );
        await dialog.getByRole('button', { name: /儲存並更新結果|儲存課表/ }).click();
        expect((await applied).ok()).toBe(true);
        await expect(dialog).toBeHidden();
        await expect(page.locator('.save-status-clean')).toBeVisible();
      } else {
        await page.getByRole('button', { name: '取消修改', exact: true }).click();
        await expect(page.locator('.save-status-dirty')).toHaveCount(0);
        await expect(page.locator('.save-status-clean')).toBeVisible();
      }

      // 確認 history.go(-1) 確實已被呼叫並被 barrier 扣留
      await page.waitForFunction(() => typeof (window as any).__sentinelBarrier?.release === 'function');

      // 結算期間點擊站內連結
      await sideLink(page, /匯入學生/).click();

      // 放行原生 traversal
      await page.evaluate(() => (window as any).__sentinelBarrier.release());
      await page.waitForFunction(() => (window as any).__sentinelBarrier.popCount >= 1);

      // 斷言：最終目的地必須是 /imports，不被舊 cleanup 覆蓋或退回
      await expect(page, '舊 cleanup 不能把已要求的匯入學生導航退回課表').toHaveURL(/\/imports$/);
      await expect(leaveDialog(page)).toHaveCount(0);

      // Back 第一次回到課表設定完整 URL（/settings?tab=schedule）
      await page.goBack();
      await expect(page).toHaveURL(/\/settings(?:\?tab=schedule)?$/);
      await expect(leaveDialog(page)).toHaveCount(0);

      // Back 第二次回到首頁
      await page.goBack();
      await expect(page).toHaveURL(/:\d+\/$/);
      await expect(leaveDialog(page)).toHaveCount(0);

      // Forward 依序回到課表設定與匯入學生
      await page.goForward();
      await expect(page).toHaveURL(/\/settings(?:\?tab=schedule)?$/);
      await page.goForward();
      await expect(page).toHaveURL(/\/imports$/);
    });
  }

  test('UX31 R1 (with_students): Save 結算期間點擊站內連結，不丟失新目的地', async ({ page }) => {
    await installSentinelBarrier(page);
    await ensureB2Activated(page);
    await sideLink(page, /課表設定/).click();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });

    // 新增班級產生 dirty
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const form = page.locator('dialog.add-class-dialog form.add-session-panel');
    const testName = `國小輔導-r1-students-${Date.now().toString().slice(-4)}`;
    await form.getByLabel('新增班級名稱').fill(testName);
    await form.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 啟用 barrier
    await page.evaluate(() => {
      (window as any).__sentinelBarrier.enabled = true;
    });

    await page.getByRole('button', { name: '確認變更', exact: true }).click();
    const dialog = page.locator('dialog.impact-dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    const applied = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/settings/apply') && r.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: /儲存並更新結果|儲存課表/ }).click();
    expect((await applied).ok()).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(page.locator('.save-status-clean')).toBeVisible();

    await page.waitForFunction(() => typeof (window as any).__sentinelBarrier?.release === 'function');

    await sideLink(page, /匯入學生/).click();

    await page.evaluate(() => (window as any).__sentinelBarrier.release());
    await page.waitForFunction(() => (window as any).__sentinelBarrier.popCount >= 1);

    await expect(page, '舊 cleanup 不能把已要求的匯入學生導航退回課表').toHaveURL(/\/imports$/);
    await expect(leaveDialog(page)).toHaveCount(0);
  });

  test('UX31 R2: Save／Cancel 結算期間立即再編輯，不誤彈離頁確認視窗且新草稿受保護', async ({ page }) => {
    await installSentinelBarrier(page);
    await page.goto('/');
    await sideLink(page, /課表設定/).click();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });

    // 1. 產生草稿
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const form = page.locator('dialog.add-class-dialog form.add-session-panel');
    const testName1 = `國小輔導-r2-1-${Date.now().toString().slice(-4)}`;
    await form.getByLabel('新增班級名稱').fill(testName1);
    await form.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 2. 啟用 barrier
    await page.evaluate(() => {
      (window as any).__sentinelBarrier.enabled = true;
    });

    // 3. 取消修改 (dirty -> false，history.go(-1) 被扣留)
    await page.getByRole('button', { name: '取消修改', exact: true }).click();
    await expect(page.locator('.save-status-dirty')).toHaveCount(0);
    await expect(page.locator('.save-status-clean')).toBeVisible();
    await page.waitForFunction(() => typeof (window as any).__sentinelBarrier?.release === 'function');

    // 4. 立即再次編輯！(dirty 重新轉為 true)
    await page.getByRole('button', { name: '＋ 新增班級' }).click();
    const testName2 = `國小輔導-r2-2-${Date.now().toString().slice(-4)}`;
    await form.getByLabel('新增班級名稱').fill(testName2);
    await form.getByRole('button', { name: '確認新增' }).click();
    await expect(page.locator('.save-status-dirty')).toBeVisible();

    // 5. 放行上一輪的 history.go(-1)
    await page.evaluate(() => (window as any).__sentinelBarrier.release());
    await page.waitForFunction(() => (window as any).__sentinelBarrier.popCount >= 1);
    await page.evaluate(() => {
      (window as any).__sentinelBarrier.enabled = false;
    });

    // 6. 斷言：上一輪的 popstate 不得誤判為使用者按 Back，離頁視窗必須為 0！
    await expect(leaveDialog(page), '結算期間立即再編輯不應誤彈離頁確認視窗').toHaveCount(0);

    // 7. 新草稿受保護：此時點側欄離開，必須跳出確認視窗！
    await sideLink(page, /匯入學生/).click();
    await expect(leaveDialog(page), '新草稿仍受保護，點離開需彈出確認視窗').toBeVisible();

    // 8. 捨棄修改：只導航一次到匯入頁
    await discardChanges(page).click();
    await expect(page).toHaveURL(/\/imports$/);
  });

  test('UX31 R3: dirty 期間按「顯示全部班級」清除 ?class= 焦點後 Save／Cancel，不復活舊焦點參數', async ({ page }) => {
    // 1. 帶 ?class= 進入課表
    await openClassSchedule(page, '兒童美語-Gino');
    await expect(page.locator('[data-focus-class]')).toBeVisible();

    // 2. 修改時段產生 dirty (確保值不同於現況)
    const startInputBox = await startInput(page);
    const currentVal = await startInputBox.inputValue();
    const nextVal = currentVal === '15:45' ? '14:30' : '15:45';
    await startInputBox.click();
    await startInputBox.fill(nextVal);
    await expect(dirtyBar(page)).toBeVisible();

    // 3. 點擊「顯示全部班級」清除焦點（URL 移除 class 參數）
    await page.locator('button', { hasText: '顯示全部班級' }).click();
    await expect(page.locator('[data-focus-class]')).toHaveCount(0);
    expect(page.url()).not.toContain('class=');

    // 4. 取消修改（或儲存）
    await page.locator('button', { hasText: '取消修改' }).click();
    await expect(dirtyBar(page)).toHaveCount(0);
    await expect(page.locator('.save-status-clean')).toBeVisible();

    // 5. 斷言：結算完成後，網址列絕不得復活 ?class= 舊參數
    expect(page.url(), '結算退回 base 不應復活已清除的 class 參數').not.toContain('class=');

    // 6. 重新整理後仍應為全部班級（不退回單班聚焦）
    await page.reload();
    await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });
    expect(page.url()).not.toContain('class=');
    await expect(page.locator('[data-focus-class]')).toHaveCount(0);
  });
});
