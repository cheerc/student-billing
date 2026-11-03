# Issue #207 診斷報告：課表儲存／取消後立即 reload 偶發 net::ERR_ABORTED

- 任務目標：建立 save/cancel dirty→clean 與立即導航失敗的可追溯證據，完成 Phase 1 / PR-1 有界診斷、局部 trace/telemetry 收集、受控 barrier 實驗與同族盤點。
- 派工 Brief：`/tmp/otter-briefs/issue-207-p1-diagnosis.md`
- 參考計畫：`plan/207-reload` @ `743e18ecff0e5a2b4ac69568995fb2e16c9be527` (`specs/19-issue-207-reload-recovery-plan.md`)
- 調查基線：`origin/main` = `ad45f5d7ac826cf841bcc19116ae2920c7777f5e`
- 權責界線：本次僅 Phase 1 / PR-1（診斷與可觀測性），不修改產品程式碼、不改動共用 helper 成功契約、不修改 runner/full 流程，不新增 spec 檔案。保持 Phase 2 HOLD。

---

## 1. 執行環境與 Exact Revisions

| 項目 | 規格／數值 |
|---|---|
| Git HEAD | `ad45f5d7ac826cf841bcc19116ae2920c7777f5e`（與 `origin/main` 嚴格一致） |
| 作業系統 | macOS Sequoia (Darwin 25.6.0, arm64) |
| Node.js | `v24.22.2` |
| TypeScript | `5.9.3` |
| Vitest | `3.2.7` |
| Playwright | `1.63.0` (Chromium Desktop Chrome) |
| 隔離埠 | `3127`（獨立空閒埠，每輪使用全新 SQLite 臨時資料庫） |
| 依賴完整性 | APFS `cp -Rc` 副本，非 symlink；工具身份核實通過 |

---

## 2. 歷史觀察 vs. 本次重現狀態

依 Issue #207 記錄：
1. **PR #204 開發期間**：實作者於早期迭代曾回報一次在 `schedule-class-type-tabs.spec.ts` 的「Issue #155 & D61 持久化穩定」案例出現 `net::ERR_ABORTED`；後續執行皆通過。無留存 raw trace。
2. **PR #206（HEAD `50c131b0`）GREEN 後**：實作者整檔執行 4/5，本案例於 `page.reload()` 失敗。Reviewer 保存之 error-context 快照顯示為**舊 document**：畫面已顯示「課表已為最新儲存狀態」與「課表已成功儲存」toast，證實 save 已完成，失敗發生於 `page.reload()` 發起至新 document commit 之間。
3. **歷史 Artifacts 留存狀態**：原始 PR #204/#206 執行因 `playwright.isolated.config.ts` 設定 `trace: 'on-first-retry'` 搭配 `retries: 0`，故歷史失敗未能留下 Playwright trace zip。歷史失敗依規定完整記錄，**不轉述為本次重現**。

---

## 3. 無 Instrumentation Baseline 收集（預先固定 3 輪獨立執行）

在未修改之 exact HEAD（未注入 instrumentation 與 trace）下，以三個獨立單輪命令執行 `tests/e2e/schedule-class-type-tabs.spec.ts`（埠 3127，每輪全新 server/DB）：

| 輪次 | 測試案例數 | 通過數 | 失敗數 | 耗時 | Exit Code | 隔離資料庫路徑 |
|---|---|---|---|---|---|---|
| Round 1 | 6 | 6 | 0 | 10.4s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-veEiTU/app.sqlite` |
| Round 2 | 6 | 6 | 0 | 7.0s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-1KGQhb/app.sqlite` |
| Round 3 | 6 | 6 | 0 | 6.6s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-pDtPlW/app.sqlite` |

**結論**：在目前 HEAD `ad45f5d` 的本機 macOS 高效能環境下，未改動 spec 於三輪獨立測試中皆 6/6 通過。依計畫規範，此條件下的結論為：**「該條件未自然重現」**。

---

## 4. 局部 Trace 收集與受控 Barrier 實驗（預先固定 3 輪獨立執行）

### 4.1 儀器設計與可觀測性注入
在 `web/tests/e2e/schedule-class-type-tabs.spec.ts` 內局部加入：
1. `test.use({ trace: 'retain-on-failure' })`：確保在 `retries: 0` 下，若遭遇失敗立即保存完整 Playwright trace。
2. 瀏覽器端 Init Instrumentation（`page.addInitScript`）：
   - 封裝原生 `history.pushState`、`replaceState`、`go`、`back`、`forward`，嚴格保留 `this`、參數與回傳值。
   - 監聽 `DOMContentLoaded`、`load`、`beforeunload`、`pagehide`、`popstate`。
   - 透過 `page.exposeFunction('__recordBrowserEvent')` 即時向 Node 端回報事件，避免 document unload 時遺失歷史時序。
   - 記錄單調時序（`performance.now()` 與 wall clock ISO 時間）、document 唯一 ID（`doc_xxxx`）及當前 URL。
3. Playwright 側事件監聽：
   - 記錄 `request:settings_apply`、`response:settings_apply`（含 status）。
   - 記錄 `main-frame:navigated`、`requestfailed`、`pageerror`。
4. 原案例（Test 6）維持原操作與原斷言不變；新增受控診斷案例（Test 7）：
   - 對照組（未延後）：真實 UI 編輯 → `saveSettings(page)` → 原生立即 `page.reload()`。
   - 實驗組（受控 Barrier）：在 UI save 前啟用 `__SENTINEL_BARRIER`，攔截 `history.go(-1)` 並暫存於 `pendingRelease`；驗證 `saveSettings(page)` 完成時 `history.go(-1)` 確實已被觸發且處於 pending 狀態；在無 history traversal 干擾下執行 `page.reload()`。

### 4.2 三輪執行結果

| 輪次 | 測試案例數 | 通過數 | 失敗數 | 耗時 | Exit Code | 隔離資料庫路徑 |
|---|---|---|---|---|---|---|
| Round 1 | 7 | 7 | 0 | 11.0s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-UfdOEZ/app.sqlite` |
| Round 2 | 7 | 7 | 0 | 10.9s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-OUprMA/app.sqlite` |
| Round 3 | 7 | 7 | 0 | 10.2s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-BXjOoL/app.sqlite` |

所有 7 項測試全數通過，每輪皆產出完整的 `navigation-telemetry.json` 並歸檔至測試產物目錄。

---

## 5. 時序分析與微競態窗口（Micro-Race Window）量測

分析 Round 1 至 Round 3 在 Test 6（Issue #155 持久化案例，無 barrier）中所記錄之真實事件微秒級時序：

### 5.1 事件時序軌跡（以 Round 1 為例）

```
[10:26:42.966Z] doc_yvjpzk: history.pushState (dirty: true，守衛推入哨兵紀錄)
[10:26:43.322Z] Playwright: request:settings_apply (POST /api/v1/settings/apply)
[10:26:43.401Z] Playwright: response:settings_apply (status 200)
                --> React 處理 apply 成功，dirty 由 true 轉為 false
                --> useUnsavedChangesGuard 觸發 useEffect -> unwindSentinel()
[10:26:43.418Z] doc_yvjpzk: history.go(delta: -1) (呼叫時點，+0.0ms)
[10:26:43.421Z] doc_yvjpzk: window:popstate (瀏覽器完成歷史步進，+2.8ms)
[10:26:43.425Z] doc_yvjpzk: history.replaceState (Next.js App Router 處理 popstate，+7.2ms)
[10:26:43.433Z] doc_yvjpzk: window:beforeunload (page.reload() 導航發起，+14.7ms)
[10:26:43.461Z] Playwright: main-frame:navigated (新 document doc_qs2it7 載入，+43.0ms)
```

### 5.2 三輪量測數據比對

| 指標 | Round 1 | Round 2 | Round 3 | 統計特徵 |
|---|---|---|---|---|
| `history.go(-1)` 至 `popstate` 間隔 | 2.8 ms | 3.5 ms | 3.0 ms | **3.1 ± 0.4 ms**（極其迅速） |
| `history.go(-1)` 至 `replaceState` (Next.js) | 7.2 ms | 9.0 ms | 6.0 ms | **7.4 ± 1.5 ms** |
| `history.go(-1)` 至 `beforeunload` (Reload) | 14.7 ms | 16.8 ms | 25.1 ms | **18.9 ± 5.5 ms** |
| `popstate` 完成至 `beforeunload` 邊界寬裕度 | +11.9 ms | +13.3 ms | +22.1 ms | **15.8 ± 5.5 ms** |

### 5.3 關鍵機理發現

1. **未等待的非同步歷史步進（Un-awaited Traversal）**：
   - 產品程式碼 `web/src/lib/unsaved-guard.ts:45–47` 定義：
     ```ts
     export function unwindSentinel(): void {
       window.history.go(-1);
     }
     ```
     `unwindSentinel()` 為 `void` 函式，呼叫原生 `window.history.go(-1)` 後立即返回，完全不回報亦不等待 session history traversal 與相應 `popstate` 完成。
   - `web/src/components/ui/use-unsaved-changes-guard.ts:51–57` 在 `useEffect` 內呼叫 `unwindSentinel()`，亦無任何完成旗標或 Promise。
   - 測試 helper `saveSettings(page)` 僅等待 POST apply 回應、dialog 隱藏與 `.save-status-clean` 可見（DOM 渲染完成），此時 `history.go(-1)` 剛被發出或正在瀏覽器 task queue 排程中。
2. **極窄的微競態窗口（14.7ms – 25.1ms）**：
   - 在本機 Apple Silicon 高階環境下，Chromium 處理 `history.go(-1)` 僅需 ~3ms，因此在 `saveSettings` 回傳並接續執行 `page.reload()`（需跨 CDP 通訊約 10–20ms）時，`popstate` 與 Next.js 的狀態更新已碰巧在 `beforeunload` 前 12–22ms 結束。
   - **成因推論**：若在負載較高之環境（如 GitHub-hosted Ubuntu runner 僅有 2 核心 vCPU，或本機多 process 並行時），若 CPU 排程使 `history.go(-1)` 或 Next.js `replaceState` 的處理延遲 15ms 以上，`page.reload()` 之 main-frame document navigation 將與 `history.go(-1)` 之 session history traversal **直接重疊**。在 Chromium / Blink 架構中，同一 Frame 同時有 traversal 與 navigation in-flight 時，會觸發 `NavigationURLLoader` 取消其中一方，於 Playwright 端回傳 `net::ERR_ABORTED (-3)`。
3. **Barrier 實驗之直接佐證**：
   - Test 7 實測證實：在 `saveSettings` 完成時，`window.__SENTINEL_BARRIER` 捕捉到 `delayedDelta: -1` 且 `hasPendingRelease: true`，確鑿證明 `history.go(-1)` 是在 dirty 轉 clean 時由產品端主動呼叫，且在 save 完成當下該歷史步進處於未決狀態。
   - 當 barrier 將 `history.go(-1)` 扣留（不讓 traversal 發生）時，`page.reload()` 100% 穩定通過，未有任何中斷。

---

## 6. 假設驗證判定：H1 vs. H2

依派工 Ruling「不得將 mock popstate、舊 document toast、單次成功或單純延後 reload 當因果證明。保留 H2，不能猜修或關閉 issue」：

1. **主要假設 H1（dirty 清除觸發之 history traversal 與 reload 重疊相互取消）**：
   - **判定**：**高度符合現有靜態與動態觀測事實，但尚未在本次執行中取得自然失敗的原始 trace**。
   - **支持事實**：
     - `unwindSentinel()` 的 `history.go(-1)` 為火後即忘（fire-and-forget）。
     - PR #206 歷史快照顯示舊 document 已是 clean 狀態並有 toast，失敗在導航層。
     - 本次時序量測確定 `history.go` 與 `page.reload()` 之間僅有 14.7–25.1ms 之極窄空隙。
     - Barrier 實驗證實 save 結束當下 `history.go(-1)` 確實仍在發動中。
   - **保留缺口**：本次 baseline 3 輪與 instrumented 3 輪均因本機執行極快（3ms 完成 popstate）而未重現 `net::ERR_ABORTED`。
2. **替代假設 H2（Next.js dev/HMR/編譯或其他 frame navigation 取消 reload）**：
   - **判定**：**明確保留，未予排除**。
   - **理由**：在缺乏實際發生 `ERR_ABORTED` 當下的 Chrome DevTools Protocol netlog / trace 的情況下，無法排除 Next.js 開發伺服器於特定時刻發送 HMR 更新或路由重編譯導致 client 導航被中斷的可能。不可因 H1 合理即推定 H2 必定不存在。

---

## 7. 全 Repo 同族 Call-site 完整盤點

依 Brief 規範，針對 `web/tests/e2e/**/*.ts` 中涉及 `page.reload`、`page.goto`、`page.goBack`、`saveSettings`、`reloadSettings` 及取消修改之所有呼叫進行逐一因果與邊界審查：

### 7.1 實際同族（Direct Family：經 dirty→clean 觸發 sentinel unwind 後立即執行 reload／站內導航／Back）

| 檔案路徑與座標 | 呼叫模式 | 觸發原因與潛在風險說明 |
|---|---|---|
| `tests/e2e/schedule-class-type-tabs.spec.ts:325–328` | `saveSettings(page)` → `page.reload()` | **Issue #207 原案例**。新增/刪班後存檔，dirty 轉 false 觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `tests/e2e/settings-cancel.spec.ts:26–32` | `button: 取消修改` → `page.reload()` | 編輯時段產生草稿，按「取消修改」使 dirty 轉 false，觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `tests/e2e/cancel-calculate-race.spec.ts:337–343` | `cancelButton.click()` → `page.reload()` | 同步設定草稿取消，`dirtyBar` 消失使 dirty 轉 false，觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `tests/e2e/copy-d39.spec.ts:233–236` | `dialog save.click()` → `page.reload()` | 直接點擊儲存視窗，等待 `#toast` 顯示成功後立即 `page.reload()`（繞過 `saveSettings` helper 但走同一產品 state 流程）。 |
| `tests/e2e/date-format.spec.ts:38–42` | `apply response` → `page.reload()` | 課表儲存後等待 `.save-status-clean`，立即執行 `page.reload()`。 |
| `tests/e2e/schedule-unknown-weekday.spec.ts:204–205` | `saveSettings(page)` → `reloadSettings(page)` | `reloadSettings` 內部呼叫 `page.reload()`，同屬 save 後立即 reload。 |
| `tests/e2e/issue-157-pr2-roster-settings.spec.ts:39–40` | `saveSettings(page)` → `reloadSettings(page)` | 同上，save 後經由 `reloadSettings` 立即 reload。 |
| `tests/e2e/schedule-add-placeholder-row.spec.ts:631–633, 679–680` | `saveSettings(page)` → `reloadSettings(page)` | 同上，佔位列存檔後立即經由 `reloadSettings` 重新整理。 |
| `tests/e2e/issue-157-seed-category-lifecycle.spec.ts:23–24` | `saveSettings(page)` → `reloadSettings(page)` | 同上，種子生命週期存檔後立即重新整理。 |
| `tests/e2e/leave-guard.spec.ts:300–310` | save 成功 → `sideLink` → `page.goBack()` | 儲存後立即以站內連結導向 `/imports`，隨後依賴 `page.goBack()` 驗證返回歷史。若 sentinel unwind 未完成或與站內導航競態，會導致 Back 步數失真。 |
| `tests/e2e/leave-guard.spec.ts:280–285` | `取消修改` → `sideLink` | 取消修改後立即以站內連結離開，與上述 save 後站內導航同屬 unwind 競態族。 |

### 7.2 非同族（Non-Family：無 dirty→clean 轉換，或純粹為幾何/狀態切換 reload）

| 檔案路徑與座標 | 呼叫模式 | 非同族判定依據 |
|---|---|---|
| `tests/e2e/schedule-class-type-tabs.spec.ts:104, 111` | `setViewportSize` → `page.reload()` | 純視區切換後重整以量測幾何 layout；頁面無任何編輯，`dirty` 恆為 `false`，未曾 arm sentinel。 |
| `tests/e2e/copy-scan.spec.ts:171` | 非課表上傳失敗 → `page.reload()` | 錯誤訊息展示後的重整；未產生草稿，`dirty` 恆為 `false`。 |
| `tests/e2e/leave-guard.spec.ts:254` | dirty 狀態下 `page.reload()` | 刻意在 `dirty === true` 時重新整理以測試瀏覽器原生 `beforeunload` 對話框；非 dirty→clean unwind 路徑。 |
| `tests/e2e/batch-e-navigation.spec.ts:76` | `/` 總表頁籤 → `page.reload()` | 首頁核對結果分頁切換後重整驗證 URL query 參數，無 settings guard。 |
| `tests/e2e/roster-filter.spec.ts:45` | `/` 學生篩選 → `page.reload()` | 學生名冊篩選後的持久化重整，無 settings guard。 |
| `tests/e2e/deductions-navigation.spec.ts:26, 35` | `/?view=deductions` → `page.reload()` | 首頁扣天檢視之 URL 參數與重新整理測試，無 settings guard。 |
| `tests/e2e/leave-confirm-dialog-focus.spec.ts:95, 117` | `page.goBack()` | 測試確認離開對話框內部的焦點還原，此時頁面處於 dirty 狀態。 |
| `tests/e2e/d2d-impact-dialog-focus-cleanup.spec.ts:253` | `page.goBack()` | 測試影響評估對話框關閉後的全域監聽器清理，非 sentinel unwind 競態。 |

### 7.3 待確認／邊界案例（Boundary Cases）

| 檔案路徑與座標 | 呼叫模式 | 待確認原因與後續指引 |
|---|---|---|
| `tests/e2e/d2b-class-category-empty-db.spec.ts:94` | `saveSettings(page)` 後接續操作頁籤 | 有 save 但無緊接著的 reload；若後續點擊引發 client router 換頁，可能落入 7.1 之站內導航邊界。 |
| `tests/e2e/schedule-add-placeholder-row.spec.ts:625` | `saveSettings(page)` 後斷言 DOM | 有 save 但無立即導航，隨後繼續新增第二列，不構成導航中斷。 |
| `tests/e2e/issue-157-pr2-roster-settings.spec.ts:99` | `saveSettings(page)` 後點擊分頁按鈕 | 有 save 但接續為同頁分頁切換，無 full reload。 |

---

## 8. Artifacts 留存位置與佐證索引

所有執行日誌、時序記錄與測試產物已妥善保存，供 Reviewer 與 Coordinator 查驗：
- **本機臨時目錄**：`/tmp/issue-207-diagnosis/`
- **本機持久化目錄**：`~/Downloads/issue-207-diagnosis/`
  - `baseline-uninstrumented/round-1/`（`console.log`, `exit_code.txt`=0）
  - `baseline-uninstrumented/round-2/`（`console.log`, `exit_code.txt`=0）
  - `baseline-uninstrumented/round-3/`（`console.log`, `exit_code.txt`=0）
  - `instrumented-runs/round-1/`（`console.log`, `exit_code.txt`=0, `navigation-telemetry.json`）
  - `instrumented-runs/round-2/`（`console.log`, `exit_code.txt`=0, `navigation-telemetry.json`）
  - `instrumented-runs/round-3/`（`console.log`, `exit_code.txt`=0, `navigation-telemetry.json`）

---

## 9. 結論與 Phase 2 (P2) Gate 建議

1. **Phase 1 交付結論**：
   - 建立了完備的導航與歷史步進微時序可觀測性（Telemetry）。
   - 揭露了 `unwindSentinel()` 的 `history.go(-1)` 是火後即忘（未等待），且與 `page.reload()` 之間存在僅 14.7–25.1ms 的微小競態窗口。
   - 建立了同族 11 處 callsite 的完整清單。
   - 依 Brief ruling，未在本次高階本機環境中宣稱「自然重現失敗」，明確保留 H2 候選。
2. **Phase 2 (PR-2) 執行方向與邊界建議**：
   - **優先在產品邊界解決生命週期**：若 Coord 核准修復，修改重點應為 `web/src/lib/unsaved-guard.ts` 與 `web/src/components/ui/use-unsaved-changes-guard.ts`，賦予 sentinel unwind 一個可等待或生命週期協調的完成狀態（例如回傳或暴露 unwind 完成信號），確保 dirty 轉 clean 時歷史步進不會成為未受控的背景射後不理操作；而非僅在測試端 `saveSettings` 加大 sleep。
   - **嚴格 TDD 兩階段 Commit**：P2 實作時，必須先依據 P1 揭露之時序邊界撰寫 tests-only RED commit，在未修復的 parent commit 上確認紅燈，再提交 minimal GREEN 修正 commit。
   - **保持 Issue #207 開啟**：P1 PR 合併後不關閉 Issue #207（Refs #207），待 P2 修復完成並經由 GitHub-hosted Ubuntu nightly full E2E 驗證通過後，再由 Coordinator 決定結案。
