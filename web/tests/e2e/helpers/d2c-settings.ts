import { expect, type Locator, type Page, type Request } from '@playwright/test';
import { buildSeedDraft } from '../../../src/adapters/sqlite/settings-repository';

/** 只透過正式 preview／apply 與 revision CAS 還原合成課表，不讀寫 DB 檔。 */
export async function resetSeedSettings(page: Page): Promise<void> {
  const current = await page.request.get('/api/v1/runs/current');
  expect(current.ok()).toBe(true);
  const { revision } = await current.json();
  const preview = await page.request.post('/api/v1/settings/preview', {
    data: { draft: buildSeedDraft(), expectedRevision: revision },
  });
  expect(preview.ok()).toBe(true);
  const { previewId } = await preview.json();
  const apply = await page.request.post('/api/v1/settings/apply', {
    data: { previewId, expectedRevision: revision, idempotencyKey: `d2c-reset-${previewId}` },
  });
  expect(apply.ok()).toBe(true);
}

/** calculate 由 client effect 發出；等其回應，避免在 SSR 畫面尚未 hydration 時批次派發事件。 */
export async function reloadSettings(page: Page): Promise<void> {
  const calculated = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/settings/calculate') && response.request().method() === 'POST'
  );
  await page.reload();
  expect((await calculated).ok()).toBe(true);
  await expect(page.locator('.save-status-clean')).toBeVisible();
}

const isCalculateRequest = (request: Request): boolean =>
  new URL(request.url()).pathname === '/api/v1/settings/calculate' && request.method() === 'POST';

/**
 * 執行一個會改動課表草稿的動作，並等**這個動作**觸發的 calculate 請求回應（Issue #271）。
 *
 * 為什麼：草稿一變，250ms debounce 後會 `setCalculating(true)`（「確認變更」disabled），回應回來才恢復
 * （`settings-editor.tsx` calculate effect；specs/09 §3「確認變更與儲存仍受計算與提交 gate 保護」）。
 * 動作完成後立刻點「確認變更」，點擊可能落在翻轉瞬間：Playwright 的 enabled 檢查通過，按鈕卻在
 * pointerdown 前變 disabled，Chromium 不送 click，確認視窗永遠不開。
 * 等 calculate 回應 → 才點，點擊就不可能撞上翻轉。
 *
 * - 以 **request** 為錨：`waitForRequest` 只比對註冊之後才送出的請求，所以編輯之前就在途的 calculate
 *   （頁面掛載時那一筆、cancelEdits 那一筆）的回應不會被誤當成這次編輯的回應；
 *   編輯自己的 debounce 請求約 250ms 後才送出，這裡等的就是它的回應。
 * - 註冊必須在動作**之前**，否則請求可能先送出而漏接。
 * - 多步驟編輯請**每一個**改草稿的步驟各包一次：debounce 會把短時間內的連續編輯合併成一筆請求，
 *   但間隔 >250ms 的步驟各會送一筆；只包最後一步時，前一步的請求可能先被匹配，最後一步的 debounce 還沒觸發。
 *   只選目標／展開面板等不改草稿的步驟不必包（不會觸發 calculate）。
 * - 動作若沒有改到草稿就不會有 calculate，這裡會逾時失敗——那代表測試的編輯根本沒生效，不是要重試。
 */
export async function awaitCalculateAfter<T = void>(page: Page, edit: () => Promise<T>): Promise<T> {
  const requested = page.waitForRequest(isCalculateRequest);
  let result: T;
  try {
    result = await edit();
  } catch (error) {
    requested.catch(() => {}); // 動作已失敗：不讓懸置的等待變成 unhandled rejection
    throw error;
  }
  const response = await (await requested).response();
  expect(response?.ok(), '本次編輯觸發的 calculate 應成功完成').toBe(true);
  return result;
}

/**
 * 點底部操作列「確認變更」：先確認它 enabled 才點。
 * 搭配 `awaitCalculateAfter` 使用——只檢查 enabled 擋不住「debounce 尚未送出」的窗口。
 */
export async function clickConfirmChanges(page: Page): Promise<void> {
  const confirmBtn = page.getByRole('button', { name: '確認變更', exact: true });
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
}

/**
 * 點「確認變更」→ 確認視窗 → 儲存，並等本次 apply 成功、dialog 關閉與 dirty 清除；toast 不能識別是哪次儲存。
 *
 * 前提：呼叫端已用 `awaitCalculateAfter` 等過最後一個改草稿步驟的 calculate（#271）。
 * 這裡**不再重點**：舊版以 `expect.poll` 重複點擊來蓋住「點擊落在 debounce 翻轉瞬間而遺失」，
 * 那只是把遺失的點擊藏起來；現在遺失點擊的成因由呼叫端的 request 錨定等待消除。
 */
export async function saveSettings(page: Page): Promise<void> {
  const dialog = page.locator('dialog.impact-dialog');

  await clickConfirmChanges(page);
  await expect(dialog).toBeVisible({ timeout: 10000 });

  const applied = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/settings/apply') && response.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: /儲存並更新結果|儲存課表/ }).click();
  expect((await applied).ok()).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(page.locator('.save-status-clean')).toBeVisible();
}

/**
 * 課表表格中某個班級的列（#80 之後的定位慣例）。
 *
 * 以 sticky 首欄的班級名稱 input 定位，而不是以 `[data-category-select="X"]`：
 * #80 把屬性欄併入每一個時段列之後，同一班的多個時段列**各有**一份類別下拉與
 * 固定 5 天勾選（值相同），用屬性欄當錨點會解析到多個元素、觸發 Playwright
 * strict mode violation。班級名稱才是「一班一組」的穩定錨點。
 *
 * 回傳的是該班的**第一列**；要看該班全部時段請改用
 * `page.locator('tr.schedule-row', { has: page.locator(`input.input-classname[value="${className}"]`) })`。
 */
export function classRow(page: import('@playwright/test').Page, className: string) {
  return page
    .locator('tr.schedule-row', { has: page.locator(`input.input-classname[value="${className}"]`) })
    .first();
}

/** 某個班級的全部時段列（同名多列）。 */
export function classRows(page: import('@playwright/test').Page, className: string) {
  return page.locator('tr.schedule-row', {
    has: page.locator(`input.input-classname[value="${className}"]`),
  });
}

/**
 * 依 `?class=` 深連結已經選好的類型頁籤，確認目標班列可見；若目前頁籤不含該班
 * （例如側欄進入後停在預設安親頁籤，或先前步驟切走了），改點對應的
 * `#class-type-tab-*` 再等待。頁籤鍵與 `CLASS_TYPE_ORDER` 同名（care／english／math／other／unscheduled）。
 *
 * 回傳該班**第一列**。找不到時錯誤訊息會同時指出班名與嘗試過的頁籤，
 * 避免「停在安親頁籤 → 0 列」被誤讀成資料不見了。
 */
export async function ensureClassTypeTab(page: Page, className: string): Promise<Locator> {
  const row = classRow(page, className);
  if (await row.count()) {
    await expect(row).toBeVisible({ timeout: 15000 });
    return row;
  }
  const attempted: string[] = [];
  for (const type of CLASS_TYPE_TABS) {
    const tab = page.locator(`#class-type-tab-${type}`);
    attempted.push(type);
    await tab.click();
    if (await row.count()) {
      await expect(row).toBeVisible({ timeout: 15000 });
      return row;
    }
  }
  throw new Error(
    `找不到班級「${className}」的排課列（已嘗試頁籤：${attempted.join('／')}）。` +
      `請確認班名拼字與 seed（tests/e2e/helpers/c-batch.ts 的 startInput 預設值）。`
  );
}

const CLASS_TYPE_TABS = ['care', 'english', 'math', 'other', 'unscheduled'] as const;

export type ClassTypeTab = (typeof CLASS_TYPE_TABS)[number];

/**
 * 切到指定類型頁籤（`#class-type-tab-*`），並等到該頁籤真的被選取。
 * 需要「停在某個頁籤」而不是「找到某班」時使用（例如讀取該頁籤的數量摘要）。
 */
export async function selectClassTypeTab(page: Page, type: ClassTypeTab): Promise<void> {
  const tab = page.locator(`#class-type-tab-${type}`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
}

/**
 * 課表頁「是否有多科折扣」的 YesNoRadioGroup（D61 單選統一，取代舊的五態下拉選單）。
 *
 * 頁籤語意（`schedule-grid.tsx`）：
 * - 安親課輔班／美語班／數學班：每班第一列有一組單選（同班其餘列顯示靜態「↳ 同本班」）；
 * - 其他班：**整欄不存在**（09 §3.1 的欄位徹底分離），因此那裡的類別恆為 none；
 * - 不排課：同樣沒有此欄。
 *
 * 單選的 `<input>` 是 `opacity: 0` 的隱藏框，點擊要用可見的 `label.yes-option`／`label.no-option`。
 */
export function multiDiscountGroup(page: Page, className: string): Locator {
  return page.locator(`div[role="radiogroup"][aria-label="${className} 的是否有多科折扣"]`).first();
}

/**
 * 把某班的「是否有多科折扣」設成是／否 —— 也就是 D61 之後改變**既有**班級類別（category）的唯一 UI 路徑。
 *
 * 對照表（`deriveEffectiveCategory`）：是→該班類型本身（care／english／math），否→none。
 * 「其他班」沒有這個控制項，其類別恆為 none；要改它的課程類型得走 Excel 匯入（UX106／UX109）。
 */
export async function setMultiDiscount(page: Page, className: string, yes: boolean): Promise<void> {
  // 先切到該班所在的頁籤（預設是安親頁籤，數學／美語班的列根本不存在）
  await ensureClassTypeTab(page, className);
  const group = multiDiscountGroup(page, className);
  await expect(
    group,
    `找不到「${className}」的多科折扣單選。其他班／不排課頁籤沒有這個欄位（09 §3.1）；` +
      `要改它們的課程類型請走 Excel 匯入。`
  ).toBeVisible({ timeout: 15000 });
  await group.locator(yes ? 'label.yes-option' : 'label.no-option').click();
  await expect(
    group.locator(`input[value="${yes ? 'true' : 'false'}"]`),
    `點擊後「${className}」的多科折扣應為${yes ? '是' : '否'}`
  ).toBeChecked();
}
