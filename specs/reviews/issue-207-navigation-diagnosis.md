# Issue #207 診斷報告：課表儲存／取消後立即 reload 偶發 net::ERR_ABORTED（r2 修訂版）

- 任務目標：建立 save/cancel dirty→clean 與立即導航時序的可追溯證據，完成 Phase 1 / PR-1 有界診斷、局部 trace/telemetry 收集、真實 Save/Cancel 受控 barrier 放行實驗與同族盤點。
- 派工 Brief：`/tmp/otter-briefs/issue-207-p1-diagnosis.md`、`/tmp/otter-briefs/pr-217-rework-r1.md`
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
- **r1 歷史執行記錄之證據限制說明**：
  - r1 baseline 3 輪（各 6 案）執行於 `ad45f5d`，但未在執行期寫入 spec hash。
  - r1 instrumented 3 輪（各 7 案）執行於提交 `a8cbed5` 前的未提交工作樹，原始 artifacts 未綁定 commit SHA 與 spec hash。
  - 依 F4 裁決，本報告**誠實記錄此項歷史 provenance 缺口**，不補造歷史 hash，亦不以現在 8 案結果混淆過去紀錄。所有 r2 實驗皆在凍結 commit `d3717e7e` 上執行並綁定。

---

## 2. 歷史觀察 vs. 本次重現狀態

依 Issue #207 記錄：
1. **PR #204 開發期間**：實作者於早期迭代曾回報一次在 `schedule-class-type-tabs.spec.ts` 的「Issue #155 & D61 持久化穩定」案例出現 `net::ERR_ABORTED`；後續執行皆通過。無留存 raw trace。
2. **PR #206（HEAD `50c131b0`）GREEN 後**：實作者整檔執行 4/5，本案例於 `page.reload()` 失敗。Reviewer 保存之 error-context 快照顯示為**舊 document**：畫面已顯示「課表已為最新儲存狀態」與「課表已成功儲存」toast，證實 save 已完成，失敗發生於 `page.reload()` 發起至新 document commit 之間。
3. **歷史 Artifacts 留存狀態**：原始 PR #204/#206 執行因 `playwright.isolated.config.ts` 設定 `trace: 'on-first-retry'` 搭配 `retries: 0`，故歷史失敗未能留下 Playwright trace zip。歷史失敗依規定完整記錄，**不轉述為本次重現**。

---

## 3. 生命週期標記與名詞定義（F2 採納）

為避免將「wrapper 攔截呼叫」混淆為「原生 traversal 在途中」，嚴格定義並分開下列五個可觀測之生命週期標記：

| 標記代碼 | 標記名稱 | 觸發點與意義 | 觀測方式 |
|---|---|---|---|
| **M1** | Traversal Call Initiated | 產品端呼叫 `window.history.go(-1)`。若 barrier 啟用，此時僅 wrapper 扣留呼叫，原生 traversal **尚未在途**。 | wrapper 記錄 `history.go` 或 `barrier:history.go(-1)_held` |
| **M2** | Native PopState Dispatched | 瀏覽器核心完成 joint session history 步進，派發原生 `popstate` 事件。原生 traversal 於此時完成。 | `window.addEventListener('popstate')` 記錄 `window:popstate` |
| **M3** | Helper Resolved | 測試端等待條件滿足（POST apply 回應 200、dialog 隱藏、`.save-status-clean` 可見）。不包含任何 history 等待。 | Playwright `await saveSettings(page)` resolve |
| **M4** | Reload Initiated | 測試端呼叫 `page.reload()`，向瀏覽器發出導航請求，舊 document 觸發 `beforeunload`。 | `window.addEventListener('beforeunload')` 記錄 `window:beforeunload` |
| **M5** | Document Committed | 瀏覽器完成新文件 commit，新 document 初始化並執行腳本。 | 新 document 記錄 `document:init`、Playwright `framenavigated` |

---

## 4. 實驗設計與三輪獨立執行

### 4.1 實驗設計矩陣（F1 採納）
在 `schedule-class-type-tabs.spec.ts` 內設計對照矩陣，涵蓋真實 Save 與 Cancel 兩個獨立入口：

| 測試路徑 | 實驗分支 | 操作步驟 | 預期觀察與判定判準 |
|---|---|---|---|
| **Save 路徑** (Test 7) | 1. 未延後對照 | 新增班級 → `saveSettings(page)` → 立即 `page.reload()` | 觀察原生 M1、M2、M3、M4、M5 之真實排程與間隔；若 Chromium 偶發碰撞則記錄 `ERR_ABORTED`。 |
| | 2. 受控延後放行 | 新增班級 → 啟用 barrier → `saveSettings(page)` → 斷言 held (M1 被扣留) → 呼叫 `pendingRelease()` 放行原生 traversal (M2) → 驗證 released → `page.reload()` (M4) | 驗證儀器能區分 held 與 released；證實 traversal 受控放行且完成 (M2) 後，reload 正常 commit (M5)。 |
| **Cancel 路徑** (Test 8) | 1. 未延後取消對照 | 新增班級（產生 dirty） → 點擊「取消修改」 → 立即 `page.reload()` | 驗證取消修改亦為 dirty→clean producer，觸發原生 M1 與 M2；觀察與立即 M4 的交互。 |
| | 2. 受控延後放行取消 | 新增班級 → 啟用 barrier → 點擊「取消修改」 → 斷言 held (M1 被扣留) → 呼叫 `pendingRelease()` 放行原生 traversal (M2) → 驗證 released → `page.reload()` (M4) | 證實 Cancel 路徑之 sentinel unwind 亦能被受控攔截並放行原生 traversal，完成後 reload 正確復原。 |

### 4.2 凍結 Commit 之三輪獨立執行結果
執行命令：`npm run test:e2e:isolated -- --port 3127 tests/e2e/schedule-class-type-tabs.spec.ts`（埠 3127，每輪獨立 server/DB）：

| 輪次 | 測試案例數 | 通過數 | 失敗數 | 耗時 | Exit Code | 隔離資料庫路徑 |
|---|---|---|---|---|---|---|
| Round 1 | 8 | 8 | 0 | 9.8s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-w3VF3b/app.sqlite` |
| Round 2 | 8 | 8 | 0 | 9.5s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-etg6Vc/app.sqlite` |
| Round 3 | 8 | 8 | 0 | 10.1s | 0 | `/var/folders/21/xjsdlh3x2s9b6sljbbkxm9kw0000gn/T/sb-e2e-9hwXNl/app.sqlite` |

8 項測試全數通過，無 skip，無 retry。每輪皆產出完整的 `navigation-telemetry.json` 並歸檔。

---

## 5. 時序分析、微競態窗口與可觀測性限制（F2 採納）

### 5.1 量測數據分析
在未延後對照中，記錄到 M1 (`history.go(-1)`)、M2 (`popstate`) 與 M4 (`beforeunload`) 之相對時間：
- **M1 至 M2 間隔**：本機量測值為 **2.8 – 3.5 ms**。
- **M1 至 M4 間隔**：本機量測值為 **14.7 – 25.1 ms**。
- **M2 至 M4 裕度**：在目前環境下，原生 `popstate` 比 `page.reload()` 早約 **11.9 – 22.1 ms** 結束。

### 5.2 受控放行實驗所證實之事實
1. **Save 與 Cancel 雙路徑皆呼叫 `history.go(-1)`**：
   - Save 完成時：`barrierStatus.delayedDelta === -1` 且 `hasPendingRelease === true`。
   - Cancel 點擊時：`barrierStatus.delayedDelta === -1` 且 `hasPendingRelease === true`。
2. **儀器具備區分 held 與 released 之能力**：
   - 扣留時：`hasPendingRelease === true`。
   - 呼叫 `pendingRelease()` 後：原生 `history.go(-1)` 實際執行，瀏覽器派發原生 `popstate`（由 `waitForFunction` 監聽確認抵達），`hasPendingRelease` 轉為 `false`。
   - 放行且步進完成後，`page.reload()` 正常執行，持久化與草稿還原皆正確。

### 5.3 儀器干擾與量測限制（Disclosure）
- **IPC 與傳輸延遲**：瀏覽器內部事件透過 `exposeFunction` 非同步傳輸至 Node 端，傳輸本身存在微小延遲。事件排序以瀏覽器內部之 `performance.now()` 為準，不以 Node 到達時間排序。
- **時鐘不同步限制**：瀏覽器內 `performance.now()` 為頁面導航起算之單調時鐘，Node 端為 `Date.now()`，兩者絕對毫秒差存在對齊誤差（±2–5ms），故跨端比較採事件序列因果而非絕對時間減法。
- **Instrumentation 擾動**：`addInitScript` 與事件監聽的注入增加了微秒級的 JS 執行開銷，可能微幅改變瀏覽器 task queue 的排程微間隔。

---

## 6. 假設驗證判定：H1 vs. H2

依派工 Ruling「不得將 mock popstate、舊 document toast、單次成功或單純延後 reload 當因果證明。保留 H2，不能猜修或關閉 issue」：

1. **主要假設 H1（dirty 清除觸發之 history traversal 與 reload 重疊相互取消）**：
   - **狀態**：**候選假設（Hypothesis），具高度靜態結構支持與受控實驗佐證，但未在本次 3 輪自然執行中取得未延後天然崩潰的原始 trace**。
   - **支持論據**：
     - 靜態結構證實 `unwindSentinel()` 確實為 fire-and-forget 且未等待。
     - Barrier 實驗證實 Save 與 Cancel 皆會觸發此項未等待之呼叫。
     - 微時序量測證實 M1 與 M4 之間僅有約 15–25ms 之極窄空隙。
     - 若 traversal 與 reload 併發，Chromium / Blink 架構下確實會引發導航取消（CDP `net::ERR_ABORTED`）。
   - **限制**：目前樣本在無干擾的自然執行下皆綠，未直接捕捉到天然的 `ERR_ABORTED` 失敗 trace。
2. **替代假設 H2（Next.js dev/HMR/編譯或其他 frame navigation 取消 reload）**：
   - **狀態**：**明確保留，未予排除**。
   - **理由**：在缺乏實際發生 `ERR_ABORTED` 當下的 Chrome DevTools Protocol netlog 的情況下，無法排除開發伺服器 HMR 更新或 frame 導航干擾。不可因 H1 具說服力即推定 H2 必定不存在。

---

## 7. 全 Repo 同族 Call-site 完整盤點（F3 採納）

### 7.1 搜尋範圍與母體定義（Search Universe & Denominator）
- **母體**：全專案 `web/tests/e2e/` 下全部 **51 個 `.spec.ts` 規格檔案**。
- **可重現搜尋命令**：
  ```bash
  cd web
  # 1. 導航操作呼叫點
  grep -rn "page\.reload(" tests/e2e/       # 16 處
  grep -rn "page\.goBack(" tests/e2e/       # 20 處
  # 2. 儲存與重新整理 helper
  grep -rn "saveSettings(" tests/e2e/       # 12 處
  grep -rn "reloadSettings(" tests/e2e/     # 6 處
  # 3. 捨棄與取消修改操作
  grep -rn "取消修改" tests/e2e/             # 18 處
  ```

### 7.2 實際同族（Group A: 經 dirty→clean 觸發 sentinel unwind 後，立即由測試發起 reload／站內導航／Back）

| 檔案路徑與座標 | 呼叫模式 | 觸發原因與潛在風險說明 |
|---|---|---|
| `schedule-class-type-tabs.spec.ts:514` | `saveSettings(page)` → `page.reload()` | **Issue #207 原案例（Test 6）**。新增/刪班後存檔，dirty 轉 false 觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `schedule-class-type-tabs.spec.ts:536` | `saveSettings(page)` → `page.reload()` | Test 7 Save 未延後對照。同上。 |
| `schedule-class-type-tabs.spec.ts:628` | 取消修改 → `page.reload()` | Test 8 Cancel 未延後對照。新增草稿後點擊「取消修改」，dirty 轉 false 觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `settings-cancel.spec.ts:26–32` | `button: 取消修改` → `page.reload()` | 編輯時段產生草稿，按「取消修改」使 dirty 轉 false，觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `cancel-calculate-race.spec.ts:337–343` | `cancelButton.click()` → `page.reload()` | 同步設定草稿取消，`dirtyBar` 消失使 dirty 轉 false，觸發 `unwindSentinel()`，緊接著執行 `page.reload()`。 |
| `copy-d39.spec.ts:233–236` | `dialog save.click()` → `page.reload()` | 直接點擊儲存視窗，等待 `#toast` 顯示成功後立即 `page.reload()`（繞過 `saveSettings` helper 但走同一產品 state 流程）。 |
| `date-format.spec.ts:38–42` | `apply response` → `page.reload()` | 課表儲存後等待 `.save-status-clean`，立即執行 `page.reload()`。 |
| `schedule-unknown-weekday.spec.ts:204–205` | `saveSettings(page)` → `reloadSettings(page)` | `reloadSettings` 內部呼叫 `page.reload()`，同屬 save 後立即 reload。 |
| `issue-157-pr2-roster-settings.spec.ts:39–40` | `saveSettings(page)` → `reloadSettings(page)` | 同上，save 後經由 `reloadSettings` 立即 reload。 |
| `schedule-add-placeholder-row.spec.ts:631–633, 679–680` | `saveSettings(page)` → `reloadSettings(page)` | 同上，佔位列存檔後立即經由 `reloadSettings` 重新整理。 |
| `issue-157-seed-category-lifecycle.spec.ts:23–24` | `saveSettings(page)` → `reloadSettings(page)` | 同上，種子生命週期存檔後立即重新整理。 |
| `leave-guard.spec.ts:300–310` | save 成功 → `sideLink` → `page.goBack()` | 儲存後立即以站內連結導向 `/imports`，隨後依賴 `page.goBack()` 驗證返回歷史。若 sentinel unwind 未完成或與站內導航競態，會導致 Back 步數失真。 |
| `leave-guard.spec.ts:280–285` | `取消修改` → `sideLink` | 取消修改後立即以站內連結離開，與上述 save 後站內導航同屬 unwind 競態族。 |
| `d2d-impact-dialog-focus-cleanup.spec.ts:244–253` | save 成功 → `page.goBack()` | **（F3 修正補入）** 編輯時段產生草稿，點擊確認變更與儲存，dialog 關閉且 dirty 轉 false 後，立即呼叫 `page.goBack()` 測試 opener 清理。屬於真實 save 後立即 Back 之同族路徑。 |

### 7.3 非同族（Group B: 無 dirty→clean 轉換，或純粹為幾何/狀態切換 reload）

| 檔案路徑與座標 | 呼叫模式 | 非同族判定依據 |
|---|---|---|
| `schedule-class-type-tabs.spec.ts:290, 297` | `setViewportSize` → `page.reload()` | 純視區切換後重整以量測幾何 layout；頁面無任何編輯，`dirty` 恆為 `false`，未曾 arm sentinel。 |
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
   - 完備實作了 Save 與 Cancel 雙路徑之受控 barrier 放行實驗，消除了 r1 原生 traversal 被跳過之缺陷（F1 解決）。
   - 區分並記錄了 M1–M5 生命週期標記，去除了過度定性之確證宣稱，誠實保留 H2 候選（F2 解決）。
   - 重跑全量搜尋，將 `d2d-impact-dialog-focus-cleanup.spec.ts` 補入實際同族，明訂 51 檔母體與搜尋指令（F3 解決）。
   - 採用獨立凍結 commit 與乾淨狀態綁定 r2 執行，記錄 spec hash 與版本邊界（F4 解決）。
2. **Phase 2 (PR-2) 執行方向與邊界建議**：
   - **優先在產品邊界解決生命週期**：修復核心應集中於 `web/src/lib/unsaved-guard.ts` 與 `web/src/components/ui/use-unsaved-changes-guard.ts`，賦予 sentinel unwind 一個可等待或生命週期協調的完成狀態（例如回傳或暴露 unwind 完成信號），確保 dirty 轉 clean 時歷史步進不會成為未受控的背景射後不理操作；而非僅在測試端 `saveSettings` 加大 sleep。
   - **嚴格 TDD 兩階段 Commit**：P2 實作時，必須先依據 P1 揭露之時序邊界撰寫 tests-only RED commit，在未修復的 parent commit 上確認紅燈，再提交 minimal GREEN 修正 commit。
   - **保持 Issue #207 開啟**：P1 PR 合併後不關閉 Issue #207（Refs #207），待 P2 修復完成並經由 GitHub-hosted Ubuntu nightly full E2E 驗證通過後，再由 Coordinator 決定結案。
