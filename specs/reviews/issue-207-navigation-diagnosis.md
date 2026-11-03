# Issue #207 診斷報告：課表儲存／取消後立即 reload 偶發 net::ERR_ABORTED（r3 修訂版）

- 任務目標：建立 save/cancel dirty→clean 與立即導航時序的可追溯證據，完成 Phase 1 / PR-1 有界診斷、局部 trace/telemetry 收集、真實 Save/Cancel 受控 barrier 放行實驗與同族候選盤點。
- 派工 Brief：`/tmp/otter-briefs/issue-207-p1-diagnosis.md`、`/tmp/otter-briefs/pr-217-rework-r1.md`、`/tmp/otter-briefs/pr-217-rework-r2.md`
- 參考計畫：`plan/207-reload` @ `743e18ecff0e5a2b4ac69568995fb2e16c9be527` (`specs/19-issue-207-reload-recovery-plan.md`)
- 調查基線：`origin/main` = `ad45f5d7ac826cf841bcc19116ae2920c7777f5e`
- 權責界線：本次僅 Phase 1 / PR-1（診斷與可觀測性），不修改產品程式碼、不改動共用 helper 成功契約、不修改 runner/full 流程，不新增 spec 檔案。保持 Phase 2 HOLD。

---

## 1. 執行環境、Exact Revisions 與 Provenance

### 1.1 軟硬體環境
| 項目 | 規格／數值 |
|---|---|
| 作業系統 | macOS Sequoia (Darwin 25.6.0, arm64) |
| Node.js | `v24.22.2` |
| TypeScript | `5.9.3` |
| Vitest | `3.2.7` |
| Playwright | `1.63.0` (Chromium Desktop Chrome) |
| 隔離埠 | `3127`（獨立空閒埠，每輪使用全新 SQLite 臨時資料庫） |
| 依賴完整性 | APFS `cp -Rc` 副本，非 symlink；工具身份核實通過 |

### 1.2 版本與 Provenance 邊界（F4 採納）
- **基線 Base Commit**：`ad45f5d7ac826cf841bcc19116ae2920c7777f5e`
- **r2 凍結儀器 Commit（Instrumentation Commit）**：`d3717e7e18f6b454723fe3244cc6d3de3a0e3fa5`
  - 狀態：`git status --short` 乾淨
  - 測試檔 SHA-256：`1e02963567cfb647bd360729ebf2ec74033a9b334d7b6b87bd28f0336bd49412` (`web/tests/e2e/schedule-class-type-tabs.spec.ts`)
  - 案例數：8 案（原 6 案保留 + Test 7 Save 放行診斷 + Test 8 Cancel 放行診斷）
- **r3 文件修訂 Commit（Docs Commit）**：待本次提交（僅更新 `specs/reviews/issue-207-navigation-diagnosis.md`，完全不更動測試程式碼，測試檔 SHA-256 保持不變）。
- **歷史執行記錄與版本限制說明（F4 採納）**：
  - r1 baseline 3 輪（各 6 案）執行於 `ad45f5d`，但未在執行期寫入 spec hash。
  - r1 instrumented 3 輪（各 7 案）執行於提交 `a8cbed5` 前的工作樹，原始 artifacts 未綁定 commit SHA 與 spec hash。
  - Reviewer 於 r2 審查中核實了工作階段記錄（`feb99c98-3878-4ec6-a44e-38de40fbc4d8.jsonl:3595–3615` commit/clean/hash，`:3622/:3634/:3638` 三輪與歸檔）。
  - 依 F4 裁決，本報告**誠實記錄 r1 歷史 provenance 缺口**，不補造歷史 hash。r2 實驗嚴格在凍結 commit `d3717e7e` 上執行、歸檔並綁定。

---

## 2. 歷史觀察 vs. 本次重現狀態

依 Issue #207 記錄：
1. **PR #204 開發期間**：實作者於早期迭代曾回報一次在 `schedule-class-type-tabs.spec.ts` 的「Issue #155 & D61 持久化穩定」案例出現 `net::ERR_ABORTED`；後續執行皆通過。無留存 raw trace。
2. **PR #206（HEAD `50c131b0`）GREEN 後**：實作者整檔執行 4/5，本案例於 `page.reload()` 失敗。Reviewer 保存之 error-context 快照顯示為**舊 document**：畫面已顯示「課表已為最新儲存狀態」與「課表已成功儲存」toast，證實 save 已完成，失敗發生於 `page.reload()` 發起至新 document commit 之間。
3. **歷史 Artifacts 留存狀態**：原始 PR #204/#206 執行因 `playwright.isolated.config.ts` 設定 `trace: 'on-first-retry'` 搭配 `retries: 0`，故歷史失敗未能留下 Playwright trace zip。歷史失敗依規定完整記錄，**不轉述為本次重現**。

---

## 3. 生命週期標記定義與觀測邊界（F2 校正）

為避免將程式碼靜態邊界混淆為執行期量測，明確界定下列生命週期標記的觀測狀態與性質：

| 標記代碼 | 標記名稱 | 性質與觀測方式 | 觀測限制說明 |
|---|---|---|---|
| **M1** | Traversal Call Initiated | 執行期記錄：產品端呼叫 `window.history.go(-1)`。 | wrapper 記錄 `history.go` 或 `barrier:history.go(-1)_held`。若 barrier 啟用，僅為 wrapper 扣留呼叫，原生 traversal **尚未在途**。 |
| **M2** | Native PopState Dispatched | 執行期記錄：瀏覽器核心完成 joint session history 步進，派發原生 `popstate` 事件。 | 瀏覽器監聽器記錄 `window:popstate`。表示原生歷史步進已完成。 |
| **M3** | Helper Resolved Boundary | **僅源碼 await 邊界（未量測時間）**：測試腳本等待條件滿足（POST apply 回應 200、dialog 隱藏、`.save-status-clean` 可見）。 | **僅為 test 程式碼 await 完成點，telemetry 無執行期 marker，未注入亦未量測 helper 實際耗時**。 |
| **M4** | Reload Initiated Proxy | 觀測代理：測試端呼叫 `page.reload()` 後，舊 document 觸發 `beforeunload`。 | 透過 `window:beforeunload` 觀測。**僅為瀏覽器端事件代理，非 CDP `Page.reload` 請求發起的精確底層時點**。 |
| **M5** | Document Committed | 執行期記錄：瀏覽器完成新文件 commit，新 document 初始化。 | 新文件初始化記錄 `document:init`、Playwright `framenavigated`。 |

---

## 4. 實驗設計與三輪獨立執行

### 4.1 實驗設計矩陣（F1 採納）
在 `schedule-class-type-tabs.spec.ts` 內設計對照矩陣，涵蓋真實 Save 與 Cancel 兩個獨立入口：

| 測試路徑 | 實驗分支 | 操作步驟 | 觀察標的與判定依據 |
|---|---|---|---|
| **Save 路徑** (Test 7) | 1. 未延後對照 | 新增班級 → `saveSettings(page)` → 立即 `page.reload()` | 觀測原生未延後排程下，M1、M2、M4、M5 的有序事件記錄；若發生碰撞則記錄結果。 |
| | 2. 受控延後放行 | 新增班級 → 啟用 barrier → `saveSettings(page)` → 斷言 held (M1 被扣留) → 呼叫 `pendingRelease()` 放行原生 traversal (M2) → 驗證 released → `page.reload()` (M4) | 驗證儀器能區分 held 與 released；證實原生 traversal 受控放行且收到 M2 後，reload 正常 commit (M5)。 |
| **Cancel 路徑** (Test 8) | 1. 未延後取消對照 | 新增班級（產生 dirty） → 點擊「取消修改」 → 立即 `page.reload()` | 驗證取消修改亦為 dirty→clean producer，觸發原生 M1 與 M2；觀測與立即 M4 的交互。 |
| | 2. 受控延後放行取消 | 新增班級 → 啟用 barrier → 點擊「取消修改」 → 斷言 held (M1 被扣留) → 呼叫 `pendingRelease()` 放行原生 traversal (M2) → 驗證 released → `page.reload()` (M4) | 證實 Cancel 路徑之 sentinel unwind 亦能被受控攔截並放行原生 traversal，完成後 reload 正確復原。 |

### 4.2 凍結 Commit `d3717e7e` 之三輪獨立執行結果
執行命令：`npm run test:e2e:isolated -- --port 3127 tests/e2e/schedule-class-type-tabs.spec.ts`（埠 3127，每輪獨立 server/DB）：

| 輪次 | 測試案例數 | 通過數 | 失敗數 | 耗時 | Exit Code | 隔離資料庫路徑 |
|---|---|---|---|---|---|---|
| Round 1 | 8 | 8 | 0 | 9.8s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-w3VF3b/app.sqlite` |
| Round 2 | 8 | 8 | 0 | 9.5s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-etg6Vc/app.sqlite` |
| Round 3 | 8 | 8 | 0 | 10.1s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-9hwXNl/app.sqlite` |

8 項測試全數通過，無 skip，無 retry。每輪皆產出完整的 `navigation-telemetry.json` 並歸檔。

---

## 5. 執行期事件軌跡與可觀測性限制（F2 校正）

### 5.1 r2 原始事件所支持的事實陳述
基於 r2 三輪執行產出的真實 `navigation-telemetry.json` 事件序列，確認下列事實：
1. **真實 Save 與 Cancel 皆觸發 `history.go(-1)`**：
   - Save 完成時：`barrierStatus.delayedDelta === -1` 且 `hasPendingRelease === true`。
   - Cancel 點擊時：`barrierStatus.delayedDelta === -1` 且 `hasPendingRelease === true`。
2. **儀器具備區分 held 與 released 之能力**：
   - 扣留狀態：`hasPendingRelease === true`。
   - 呼叫 `pendingRelease()` 後：原生 `history.go(-1)` 實際呼叫，瀏覽器派發原生 `popstate`，`hasPendingRelease` 轉為 `false`。
3. **有序事件流支持**：
   - 受控放行分支呈現嚴格有序之事件序列：`barrier:history.go(-1)_held` → `barrier:history.go(-1)_released` → 原生 `window:popstate` → `window:beforeunload` → `document:init`（新 document commit）。
   - 未延後對照分支呈現：`history.go(-1)` → 原生 `window:popstate` → `window:beforeunload` → `document:init`。
   - 在 r2 的全部執行中，`page.reload()` 皆成功 commit，**未自然重現 `net::ERR_ABORTED`**。

### 5.2 歷史樣本數據備忘（r1 歷史樣本，具版本限制）
在 r1 早期單一案例（Test 6）中，曾於未延後對照記錄到 `history.go(-1)` 至 `popstate` 約 2.8–3.5 ms、至 `beforeunload` 約 14.7–25.1 ms。此項數據僅屬 r1 歷史樣本之觀察脈絡，**受限於 r1 之版本與未凍結工作樹限制，不得直接延用或宣稱為 r2 之統計區間**。

### 5.3 儀器擾動與量測限制（Disclosure）
- **IPC 傳輸延遲**：瀏覽器內部事件透過 `exposeFunction` 非同步傳送至 Node 端，傳輸存在排隊延遲。事件時間戳記以瀏覽器端 `performance.now()` 為準。
- **跨端時鐘差異**：瀏覽器內 `performance.now()`（自導航起算之單調時鐘）與 Node 端 `Date.now()`（系統時間）分屬不同時鐘源，兩者不可進行絕對時間算術減法。
- **排程擾動**：`addInitScript` 與事件監聽器的注入增加了腳本執行開銷，可能微幅改變瀏覽器 task queue 與 microtask 的排程時序。

---

## 6. 假設驗證判定：H1 vs. H2

依派工 Ruling「不得將 mock popstate、舊 document toast、單次成功或單純延後 reload 當因果證明。保留 H2，不能猜修或關閉 issue」：

1. **主要假設 H1（dirty 清除觸發之 history traversal 與 reload 重疊相互取消）**：
   - **狀態**：**候選假設（Hypothesis），具靜態結構支持與受控放行實驗佐證，但未在本次自然執行中取得未延後天然崩潰的原始 trace**。
   - **支持依據**：
     - 靜態程式碼證實 `unwindSentinel()` 確實為 fire-and-forget，未提供任何完成等待機制。
     - Barrier 實驗證實 Save 與 Cancel 皆會觸發 `history.go(-1)`。
     - 假設 traversal 與 reload 在底層排程衝突時可能引發導航取消（為 Hypothesis，尚無本次直接 CDP netlog 或天然崩潰 trace 佐證）。
   - **限制**：目前三輪自然執行皆通過，未直接捕捉到天然的 `ERR_ABORTED` 失敗 trace。
2. **替代假設 H2（Next.js dev/HMR/編譯或其他 frame navigation 取消 reload）**：
   - **狀態**：**明確保留，未予排除**。
   - **理由**：在缺乏實際發生 `ERR_ABORTED` 當下的 Chrome DevTools Protocol netlog 的情況下，無法排除開發伺服器 HMR 更新或 frame 導航干擾。不可因 H1 具說服力即推定 H2 必定不存在。

---

## 7. 同族 Call-site 候選清單（已確認清單，非窮盡盤點；F3 校正）

### 7.1 母體、搜尋命令與 Plan 偏差說明（F3 採納）
- **搜尋母體**：專案 `web/tests/e2e/` 下全部 51 個 `.spec.ts` 檔案。
- **搜尋命令**：
  ```bash
  cd web
  grep -rn "page\.reload(" tests/e2e/
  grep -rn "page\.goBack(" tests/e2e/
  grep -rn "saveSettings(" tests/e2e/
  grep -rn "reloadSettings(" tests/e2e/
  grep -rn "取消修改" tests/e2e/
  ```
- **搜尋命中行 vs. 語意 Callsite 區分**：
  - 上述 grep 命中行僅為純文字比對結果（包含註解、不同頁面之幾何重整等無關項目）。
  - 下列清單為經人工核對程式碼脈絡後確認之「語意候選 callsite」。
- **Plan 偏差與未完成項聲明（Plan Deviation）**：
  - **原 Plan 19 要求完成全 repo 同族 call-site 的完整窮盡盤點。本清單僅為基於上述關鍵字識別出的「已確認候選清單」，並未窮盡全 repo 所有自訂 save helper（例如 `report-refresh-recovery.spec.ts` 內部的 `confirmAndSave`）、直接 API apply、或後續各類導航消費者（goto / link / back）**。
  - **此項未窮盡屬於 Phase 1 的未完成項與 Plan 偏差。本清單不可作為 Phase 2 的完整回歸測試集合**。
  - **P2 保持 HOLD**；未來在解除 P2 前，必須先補足嚴格的 producer→consumer 窮盡盤點與可區分的因果證據。

### 7.2 已確認之實際同族候選（Group A: 經 dirty→clean 觸發 sentinel unwind 後，立即由測試發起 reload／站內導航／Back）

| 檔案路徑與座標 | 呼叫模式 | 觸發原因與潛在風險說明 |
|---|---|---|
| `schedule-class-type-tabs.spec.ts:512–515` | `saveSettings(page)` → `page.reload()` | **Issue #207 原案例（Test 6）**。新增/刪班後存檔，dirty 轉 false 觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `schedule-class-type-tabs.spec.ts:536–537` | `saveSettings(page)` → `page.reload()` | Test 7 Save 未延後對照。同上。 |
| `schedule-class-type-tabs.spec.ts:630–633` | 取消修改 → `page.reload()` | Test 8 Cancel 未延後對照。新增草稿後點擊「取消修改」，dirty 轉 false 觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `settings-cancel.spec.ts:26–32` | `button: 取消修改` → `page.reload()` | 編輯時段產生草稿，按「取消修改」使 dirty 轉 false，觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `cancel-calculate-race.spec.ts:337–343` | `cancelButton.click()` → `page.reload()` | 同步設定草稿取消，`dirtyBar` 消失使 dirty 轉 false，觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `copy-d39.spec.ts:233–236` | `dialog save.click()` → `page.reload()` | 直接點擊儲存視窗，等待 `#toast` 顯示成功後立即 `page.reload()`（繞過 `saveSettings` helper 但走同一產品 state 流程）。 |
| `date-format.spec.ts:32–42` | `apply response` → `page.reload()` | 課表儲存後等待 `.save-status-clean`，立即執行 `page.reload()`。 |
| `schedule-unknown-weekday.spec.ts:204–205` | `saveSettings(page)` → `reloadSettings(page)` | `reloadSettings` 內部呼叫 `page.reload()`，同屬 save 後立即 reload。 |
| `issue-157-pr2-roster-settings.spec.ts:39–40` | `saveSettings(page)` → `reloadSettings(page)` | 同上，save 後經由 `reloadSettings` 立即 reload。 |
| `schedule-add-placeholder-row.spec.ts:631–633, 679–680` | `saveSettings(page)` → `reloadSettings(page)` | 同上，佔位列存檔後立即經由 `reloadSettings` 重新整理。 |
| `issue-157-seed-category-lifecycle.spec.ts:23–24` | `saveSettings(page)` → `reloadSettings(page)` | 同上，種子生命週期存檔後立即重新整理。 |
| `leave-guard.spec.ts:300–312` | save 成功 → `sideLink` → `page.goBack()` | 儲存後立即以站內連結導向 `/imports`，隨後依賴 `page.goBack()` 驗證返回歷史。若 sentinel unwind 未完成或與站內導航競態，會導致 Back 步數失真。 |
| `leave-guard.spec.ts:280–286` | `取消修改` → `sideLink` | 取消修改後立即以站內連結離開，與上述 save 後站內導航同屬 unwind 競態族。 |
| `d2d-impact-dialog-focus-cleanup.spec.ts:244–253` | save 成功 → `page.goBack()` | **（r1 審查 F3 補入）** 編輯時段產生草稿，點擊確認變更與儲存，dialog 關閉且 dirty 轉 false 後，立即呼叫 `page.goBack()` 測試 opener 清理。屬於真實 save 後立即 Back 之同族路徑。 |
| `report-refresh-recovery.spec.ts:354–360` | `stageAndSaveRename` → 站內連結離開 | **（r2 審查 F3 補入）** 透過內部 helper `confirmAndSave` 儲存改名（dirty 轉 false 觸發 `unwindSentinel()`），緊接著點擊導覽列連結離開至 `/imports`。屬於 save 成功後立即站內導航之同族路徑。 |

### 7.3 已確認之非同族候選（Group B: 無 dirty→clean 轉換，或純粹為幾何/狀態切換 reload）

| 檔案路徑與座標 | 呼叫模式 | 非同族判定依據 |
|---|---|---|
| `schedule-class-type-tabs.spec.ts:291, 298` | `setViewportSize` → `page.reload()` | 純視區切換後重整以量測幾何 layout；頁面無任何編輯，`dirty` 恆為 `false`，未曾 arm sentinel。 |
| `copy-scan.spec.ts:171` | 非課表上傳失敗 → `page.reload()` | 錯誤訊息展示後的重整；未產生草稿，`dirty` 恆為 `false`。 |
| `leave-guard.spec.ts:254` | dirty 狀態下 `page.reload()` | 刻意在 `dirty === true` 時重新整理以測試瀏覽器原生 `beforeunload` 對話框；非 dirty→clean unwind 路徑。 |
| `batch-e-navigation.spec.ts:76` | `/` 總表頁籤 → `page.reload()` | 首頁核對結果分頁切換後重整驗證 URL query 參數，無 settings guard。 |
| `roster-filter.spec.ts:45` | `/` 學生篩選 → `page.reload()` | 學生名冊篩選後的持久化重整，無 settings guard。 |
| `deductions-navigation.spec.ts:26, 35` | `/?view=deductions` → `page.reload()` | 首頁扣天檢視之 URL 參數與重新整理測試，無 settings guard。 |
| `leave-confirm-dialog-focus.spec.ts:95, 117` | `page.goBack()` | 測試確認離開對話框內部的焦點還原，此時頁面處於 dirty 狀態。 |
| `d2d-impact-dialog-focus-negative.spec.ts:67` | `button: 取消修改`（無導航） | 測試取消修改後焦點是否停留在按鈕本身，後續無 `reload` 或 `goBack` 導航。 |

### 7.4 待確認／邊界案例（Group C: Boundary Cases）

| 檔案路徑與座標 | 呼叫模式 | 待確認原因與後續指引 |
|---|---|---|
| `d2b-class-category-empty-db.spec.ts:94` | `saveSettings(page)` 後接續操作頁籤 | 有 save 但無緊接著的 reload；若後續點擊引發 client router 換頁，可能落入 Group A 之站內導航邊界。 |
| `schedule-add-placeholder-row.spec.ts:625` | `saveSettings(page)` 後斷言 DOM | 有 save 但無立即導航，隨後繼續新增第二列，不構成導航中斷。 |
| `issue-157-pr2-roster-settings.spec.ts:99` | `saveSettings(page)` 後點擊分頁按鈕 | 有 save 但接續為同頁分頁切換，無 full reload。 |

---

## 8. Artifacts 留存位置與佐證索引

所有執行日誌、時序記錄與測試產物已妥善保存：
- **r2 凍結 commit 執行產物（commit `d3717e7e`，8 案全數通過）**：
  - 本機臨時目錄：`/tmp/issue-207-diagnosis/rework-r2/`
  - 本機持久化目錄：`~/Downloads/issue-207-diagnosis/rework-r2/`
    - `round-1/` (`console.log`, `exit_code.txt`=0, `test-results/`)
    - `round-2/` (`console.log`, `exit_code.txt`=0, `test-results/`)
    - `round-3/` (`console.log`, `exit_code.txt`=0, `test-results/`)
- **r1 歷史執行產物（留存脈絡，附第 1.2 節之 provenance 限制說明）**：
  - `/tmp/issue-207-diagnosis/` 與 `~/Downloads/issue-207-diagnosis/` 下之 `baseline-uninstrumented/` 及 `instrumented-runs/`。

---

## 9. 結論與 Phase 2 (P2) Gate 建議

1. **Phase 1 交付結論**：
   - 實作了 Save 與 Cancel 雙路徑之受控 barrier 放行實驗，消除了 r1 原生 traversal 被跳過之缺陷（F1 關閉）。
   - 界定並校正了 M1–M5 生命週期標記，M3 標示為僅源碼 await 邊界未量測時間，M4 標示為 beforeunload 觀測代理；去除了無實測之確定性宣稱；誠實保留 H2 候選（F2 處置完成）。
   - 補齊了已知漏項 `report-refresh-recovery.spec.ts:354–360`，校正現有所有座標；誠實將未窮盡全 repo 所有自訂 save helper 的現況標列為 **Plan 偏差與未完成項**（F3 處置完成）。
   - 嚴格綁定 r2 凍結 commit `d3717e7e` 與 spec hash `1e02963567cfb647bd360729ebf2ec74033a9b334d7b6b87bd28f0336bd49412`，並誠實揭露 r1 歷史限制（F4 關閉）。
2. **Phase 2 (PR-2) 執行方向與邊界建議**：
   - **P2 保持嚴格 HOLD**：目前既未在自然執行中捕捉到天然的 `ERR_ABORTED` 失敗 trace，亦未完成全 repo 窮盡之 producer→consumer 盤點。依 Ruling，在解除 P2 前，必須先補足窮盡盤點與真正可區分的因果證據。
   - **優先在產品邊界解決生命週期**：未來若 Coord 核准修復，修復核心應集中於 `web/src/lib/unsaved-guard.ts` 與 `web/src/components/ui/use-unsaved-changes-guard.ts`，賦予 sentinel unwind 一個可等待或生命週期協調的完成狀態（例如回傳或暴露 unwind 完成信號），確保 dirty 轉 clean 時歷史步進不會成為未受控的背景射後不理操作；而非僅在測試端 `saveSettings` 加大 sleep。
   - **保持 Issue #207 開啟**：P1 僅為有界且標明 Plan 偏差的診斷交付，不 Closes #207；owner 維持 impl，追蹤由 Coordinator 管理，禁止自行 merge。
