/**
 * D2d r3／F-4（09 §6）：把焦點還給觸發點，並處理 late-disable 造成的焦點遺失。
 * 原為 impact-dialog 私有；leave-confirm-dialog 有同型缺陷（issue #48），故抽成共用模組。
 *
 * 缺陷（analysis t-20261001080131853832-21323-28 實測定位）：頁面載入時 arm 的
 * 250ms debounce 會在**第一次還原之後**才 fire → `setCalculating(true)` → opener 變
 * disabled → 瀏覽器對 disabled 元素的 `focus()` 是 no-op 且隨即把它 blur 掉 → 焦點掉到
 * `<body>` → response 回來後 `setCalculating(false)`、按鈕恢復 enabled，
 * **但沒有任何機制再還原一次**。
 *
 * ── 設計：狀態轉移驅動，不用時間窗判斷正確性 ──────────────────────────────
 * 正確性由 opener 上 `disabled` 屬性的 **`true → false` 狀態轉移**保證：
 * 那是「本次在途計算真的結束、opener 真的恢復可聚焦」的**唯一**確定訊號。
 * opener 在還原**當下**就已是 disabled（例如離頁確認開著期間 debounce 先觸發）也算已經處於 `true`，
 * 之後第一次轉成 enabled 即是同一個訊號。
 *
 * 刻意**不**用時間窗（SETTLE_MS／MAX_ATTEMPTS 之類）判斷「等多久算夠」：慢的 calculate
 * 請求可能超過任何固定時間，那會變成「被時間窗截斷而永久不復焦」。時間值只用於
 * **資源保險絲**（watchdog），它只決定「最多觀察多久」而非「多久算夠」，
 * 寧可過早放棄也不誤判。
 *
 * 監看方式用 `MutationObserver`——瀏覽器原生的狀態觀察機制，不需輪詢、不需常駐 timer：
 * - opener 的 `disabled` 屬性（`attributeFilter`）：只在該屬性真的變化時觸發；
 * - `document.body` 的 subtree `childList`：opener 從**同一個 document** 被移除（例如 client-side
 *   導覽把整頁卸載）不會改動 opener 任何屬性，屬性 observer 看不到，只能從祖先的 childList 變動得知，
 *   觸發後以 `isConnected` 判斷。
 *
 * ── 生命週期：唯一 owner，所有終止路徑都經過 `dispose()` ──────────────────
 * 補還原成功、使用者主動操作（pointerdown／keydown）、焦點被移到具體控制項、
 * opener 從 DOM 消失（含同一 document 內被移除）、watchdog 到期——全部走同一個 `dispose()`，
 * 不留 listener／observer。
 *
 * opener 不限於 button：非表單元素（例如連結）沒有 `disabled`，視為從未 disabled，
 * 只會經過「還原一次＋移除／使用者操作／watchdog 時收掉」。
 */
export function restoreFocusToOpener(opener: HTMLElement | null): void {
  if (!opener || !document.contains(opener)) return;

  const button = opener as HTMLButtonElement;
  // 正常路徑：先立刻還原一次（opener 當下可聚焦時，這就是完整行為）。
  // 注意：即使這次還原成功也**不能**直接結束——本缺陷的 late-disable 發生在
  // 還原**之後**（debounce 在 restore 之後才 fire）。所以 observer 必須一併建立。
  opener.focus();

  let disposed = false;
  let sawDisabled = button.disabled === true;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    removalObserver.disconnect();
    document.removeEventListener('pointerdown', onAct, true);
    document.removeEventListener('keydown', onAct, true);
    if (watchdog !== null) clearTimeout(watchdog);
  };

  const onAct = () => {
    // 使用者自關閉後主動操作：取消本次還原意圖（同步，不留 listener）。
    dispose();
  };

  const observer = new MutationObserver(() => {
    if (disposed) return;
    if (button.disabled) {
      sawDisabled = true;
      return;
    }
    // disabled 解除 —— 「本次在途計算結束」這個狀態轉移。
    if (!sawDisabled) return dispose();   // 沒經過 disabled：與本次無關
    if (!document.contains(opener)) return dispose();
    // 焦點必須確實遺失在 body；被移到具體控制項代表使用者另有安排，不搶。
    const active = document.activeElement;
    if (active && active !== document.body) return dispose();
    opener.focus();
    dispose();                              // 補還原成功必 cleanup
  });

  // opener 在同一個 document 內被移除：不改任何屬性，只有祖先的 childList 會變動。
  const removalObserver = new MutationObserver(() => {
    if (!opener.isConnected) dispose();
  });

  document.addEventListener('pointerdown', onAct, true);
  document.addEventListener('keydown', onAct, true);
  observer.observe(opener, { attributes: true, attributeFilter: ['disabled'] });
  removalObserver.observe(document.body, { childList: true, subtree: true });

  // 資源保險絲：只限制最長觀察時間，不參與正確性判斷。慢請求會被放棄（寧可少還原
  // 一次），正常速度下狀態轉移遠早於此。
  const WATCHDOG_MS = 5000;
  watchdog = setTimeout(() => { dispose(); }, WATCHDOG_MS);
}
