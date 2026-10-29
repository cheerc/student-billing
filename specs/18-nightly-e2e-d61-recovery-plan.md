# 18 Issue #188 Nightly Full E2E 復原執行計畫（D61 契約落差）

日期：2026-10-29。受測對象：`main` @ `99b6bcb5`（D61 Phase 3，#187 合併後）。
依據：[Issue #188](https://github.com/cheerc/student-billing/issues/188)、nightly run `40786271398`（schedule，2026-10-28T23:17Z）、`full-e2e-40786271398-1` 產物，以及本計畫撰寫時的 HEAD 重跑證據。
狀態：**計畫；Phase 1 已合併（PR #191），Phase 2 進行中（PR #192），Phase 3／4 待派**。本文件只定義修復工作與驗收方式，不定義新的產品契約。

> **檔號說明**：本檔原於 `plan/issue-188-nightly-e2e` 分支編為 `specs/17-nightly-e2e-d61-recovery-plan.md`，與已合併的 `specs/17-class-name-sync-plan.md`（D62，PR #190）撞號。改號為 **18** 以維持檔號唯一。

> 型別說明：本計畫的權威契約來源只有 `specs/09`（D61 UI 契約）、`specs/04` §8（UX106–UX109）與 `web/CLAUDE.md` §8。`specs/15`、`specs/16` 被根目錄 `CLAUDE.md` 引用，但**不存在於 `main`**（僅存在於未合併的 `plan/*` 分支，屬另一項待決落差）。本計畫不複製其內容、不補寫該兩檔；此引用落差見 §8。

---

## 1. 目標、依據與範圍

### 1.1 已證實的失敗事實（診斷交付，非本計畫推論）

nightly `40786271398`（HEAD `99b6bcb`）：

| 指標 | 值 |
|---|---|
| Specs / Blob | 49 / 49 |
| Cases | 189（passed 136、failed 53、skipped 0） |
| 失敗 spec 檔 | 19（見 §1.2） |
| 上一個 nightly（`058e6bb`） | 2 failed（`recovery-ui`、`schedule-add-placeholder-row`） |
| 最後一次全綠（`606750c`） | 49 spec 全綠 |

病程定位（同機、同 `npm run test:e2e:isolated`、獨立 worktree 重跑）：

| rev | 實測 |
|---|---|
| `606750c`（最後綠） | a11y 9✓、cancel-race 5✓、header-seam 2✓、sticky 2✓、grid-workflow 1✓、d2d-focus 3✓、copy-d39 10✓ |
| `12206ac`（D61 前） | header-seam 2✓、d2d-focus 3✓、copy-d39 10✓ |
| `681757c`（Phase 1） | 上述 + cancel-race 5✓、a11y 9✓、d2b-empty 4✓、round3-preview 2✓、excel-io 4✓；**copy-d39 空白星期 1✗** |
| `cc78615`（Phase 2） | header-seam 2✓、grid-workflow 1✓、d2d-focus 3✓、cancel-race 5✓、a11y 9✓ |
| `99b6bcb`（Phase 3） | 19 檔失敗，對應 nightly 的 53 案例 |

結論：**Phase 3 的「一頁籤一張表」改動是 52 個失敗的共同轉折；另有 1 個失敗源自 Phase 1 的預覽契約變更。**

### 1.2 53 個失敗案例的完整歸屬（集合相等，不是抽樣）

| 族 | 案例數 | spec 檔 | 直接原因 |
|---|---|---|---|
| A 路由／選取器 | 40 | a11y 1、cancel-calculate-race 3、copy-d39 1（409 案）、d2d-impact-dialog-focus 3、…-cleanup 6、…-negative 6、leave-confirm-dialog-focus 9、leave-guard 1、report-refresh-recovery 2、round3-mapping-candidates-sync 2（#1、#4）、schedule-stale-response 1、schedule-unknown-weekday 4、settings-cancel 1 | 預設頁籤 `care` 沒有 `input.input-time`（`schedule-grid.tsx:719`）；舊的「89 列平鋪大表」列序假設失效 |
| B 選取器已淘汰 | 8 | d2b-class-category-empty-db 4、round3-preview-category-deltas 2、schedule-excel-io 1、schedule-grid-workflow 1 | `data-category-select` 已由 YesNoRadioGroup 取代（全 repo 只剩測試引用）；`schedule-table-non-care` 與「時段」摘要亦已改；round3-preview 另需「改課程類型」的可達路徑 |
| C 幾何前提 | 4 | schedule-header-seam 2、schedule-sticky-header 2 | 安親表無垂直捲動（`maxTop=0`）且無 `.col-group-anqin/.col-group-tutoring` 群組表頭（只在排課表 `schedule-grid.tsx:902,905`） |
| D 契約衝突 | 1 | copy-d39 1（空白星期 → 期望 400，實得 200） | Phase 1 引入 `incompleteSessions`（`contracts/settings.ts:290`）後，空白星期列被移出 `sessions`，`SettingsDraftSchema` 因而通過（`settings-preview.ts:153`） |
| **合計** | **53** | **19 檔** | 與 `full-e2e/verify.log` 的 19 條 `E2E child command failed` 及 53 條 `Non-first-pass test` 完全一致 |

### 1.3 範圍

**In scope**

1. E2E 測試契約回到可執行的真實入口（頁籤導覽、穩定班級識別、YesNoRadioGroup 操作、幾何前提）。
2. 共用 helper 的單一入口，避免下一個 UI 改版再次造成同型整批失敗。
3. 契約衝突（族 D）依裁決落地，並同步 `specs/09`／`specs/04` 或產品驗證。
4. E2E 慣例文件（`web/tests/e2e/CLAUDE.md`）同步。

**Out of scope**

- 不改計費規則、不變更 D61 的頁籤／欄位契約（那是已驗收的產品行為）。
- 不新增或刪除任何 `tests/e2e/*.spec.ts`（維持 49 檔盤點）。
- 不處理上一個 nightly 的 2 個舊失敗（`recovery-ui`、`schedule-add-placeholder-row`）——後者在本 HEAD 已綠（見 §6 證據），前者不在本次 53 案例內。
- 不動 Issue #190（class name sync read model）正在改的檔案，除非衝突不可避免（見 §7）。

---

## 2. 共用契約（Phase 1 建立的 helper 介面）

所有修復都經由這兩個 helper 進入課表頁，禁止各 spec 自行拼頁籤切換與列定位。

`web/tests/e2e/helpers/c-batch.ts`（既有檔，擴充；不要另開第二份 helper）：

```ts
/** 以產品既有 ?class= 深連結（specs/09 §3.1：?class= 自動切至該班類型頁籤）開啟課表並回傳該班第一列。 */
export async function openClassSchedule(page: Page, className: string): Promise<Locator>;

/** 需要瀏覽器歷史（Back 測試）時使用：先到 /，再由側欄進課表，然後切換到該班所在頁籤。 */
export async function openClassScheduleViaHome(page: Page, className: string): Promise<Locator>;

/** 既有語意不變：回傳「該班第一列的起始時間輸入」。className 預設 '兒童美語-Gino'（= 舊 nth(3) 的語意）。 */
export const startInput: (page: Page, className?: string) => Locator;
```

`web/tests/e2e/helpers/d2c-settings.ts`（既有 `classRow`／`classRows`，已由 Phase 3 遷移過的 spec 使用）：

- `classRow(page, name)` 保持不變；**新增** `ensureClassTypeTab(page, className)`：讀 `?class=`，若當前頁籤不含該班則點對應 `#class-type-tab-*` 並等待該班列可見。
- 兩份 helper 需互相引用而非各自複製頁籤邏輯（`c-batch` 可 import `classRow`／`ensureClassTypeTab`）。

**預設值語意（必須寫進 helper 註解）**：舊測試的 `.schedule-table tbody tr input.input-time` + `nth(3)` = seed 的「兒童美語-Gino 週一 15:20–16:50」（seed 該班 3 個時段，首列週一）。因此 `startInput(page)` 預設 `'兒童美語-Gino'` 可保留所有既有的 40／20 分獨立手算預期，不需改動 expected。

---

## 3. Phase / PR 拆分

每個 Phase = 1 個可獨立合併的 PR，且**合併後可用「失敗集合」獨立證明**（不是「重跑變綠」）。四片互不依賴，可平行開發；合併順序建議 P1 → P2 → P3 → P4。

### Phase 1（PR-1）：共用導覽 helper ＋ A 族 40 案例

**分支**：`fix/issue-188-e2e-navigation-helpers`
**審查等級**：`single`（測試與測試工具；無產品程式碼變更）

**模組／檔案責任**

| 檔案 | 動作 |
|---|---|
| `web/tests/e2e/helpers/c-batch.ts` | 實作 §2 三個匯出；`openSchedule` 保留但改為 `openClassSchedule` 的薄包裝 |
| `web/tests/e2e/helpers/d2c-settings.ts` | 新增 `ensureClassTypeTab`；`classRow` 不變 |
| `web/tests/e2e/a11y.spec.ts:245` | 改用 `openClassSchedule` + `classRow` |
| `web/tests/e2e/cancel-calculate-race.spec.ts:32,130,204` | `overlap`／`enterFromHome`／row 改為 Gino 列；保留 Back 歷史語意（用 `openClassScheduleViaHome`） |
| `web/tests/e2e/d2d-impact-dialog-focus.spec.ts:40,133` | `openAndEsc` 內改用 helper |
| `web/tests/e2e/d2d-impact-dialog-focus-cleanup.spec.ts:76` | 同上 |
| `web/tests/e2e/d2d-impact-dialog-focus-negative.spec.ts:25,137` | 同上 |
| `web/tests/e2e/leave-confirm-dialog-focus.spec.ts:51,106` | `openDirtySchedule`（`:51`）改用 `openClassScheduleViaHome`（需保留側欄入口的歷史）；late-disable 案例（`:106`）沿用它 |
| `web/tests/e2e/leave-guard.spec.ts:195` | `classStart` 改 `classRow` |
| `web/tests/e2e/report-refresh-recovery.spec.ts:156-160` | `applyScheduleTimeChange` 改 `classRow`（仍在「課表」外層頁籤內） |
| `web/tests/e2e/round3-mapping-candidates-sync.spec.ts:92,262` | `startTimeInput` 改 `classRow(page,'兒童美語-Gino')`；#1 的 `renameWholeClass`（`:92`）在改名後以 `ensureClassTypeTab(page,'R3國文班驗收')` 切到 `other` 頁籤再驗證（改名目標 `國小國語文-小五` 是 `other`，留在安親頁籤會是 0 列 → 不變 dirty） |
| `web/tests/e2e/schedule-stale-response.spec.ts:19,37` | `nth(3)` → `classRow(page,'兒童美語-Gino')` |
| `web/tests/e2e/schedule-unknown-weekday.spec.ts:34,126` | `nth(3)` → Gino 列；`nth(4)`「鄰列仍完整」改為穩定鄰班（如 `兒童美語-Archy`），**保留原語意**（其他列不受影響） |
| `web/tests/e2e/settings-cancel.spec.ts:14` | `nth(3)` → `classRow`（並在 reload 後重新定位） |
| `web/tests/e2e/copy-d39.spec.ts:220` | 兩個視窗都先切到 Gino 列；`nth(3)` 移除 |
| `web/tests/e2e/CLAUDE.md` | 新增「操作排課列一律經 helper／`?class=`，不得用 `tbody nth(n)` 定位」與「預設頁籤是安親課輔班，時段欄只在排課頁籤」兩條 |

**新增守門測試（純靜態掃描，`web/tests/unit/e2e-conventions.test.ts`）**

以 `fs` 讀 `tests/e2e/*.spec.ts`，斷言：

1. 任何 spec 都不再出現 `data-category-select`、`schedule-table-non-care`、`.schedule-table tbody tr').nth(` 這三種字面（allowlist：無）。
2. 出現 `input.input-time` 或 `input.input-weekday` 的 spec，必須符合下列之一，否則紅：
   - import 自 `./helpers/c-batch` 或 `./helpers/d2c-settings`（`classRow`／`classRows`／`openClassSchedule`／`ensureClassTypeTab`／`startInput`），或
   - 檔名在白名單（初期僅 `schedule-add-placeholder-row.spec.ts` 的本地 `rowOf`，理由：它測「新班未填時間」，班級尚不存在於 `?class=` 路由與 `classRow` 的 seed 假設）。
   註：`schedule-header-seam.spec.ts`／`schedule-sticky-header.spec.ts` 不直接碰輸入框（只量幾何），不受此條約束。
3. 檔案清單仍為 49 檔（與 `scripts/e2e-full.mjs` 的動態盤點一致）。

> 這條守門是為了本次的同型失敗不再重演（歷史已重複四次：UI 改版後整批 spec 假設舊版面）。它不是行為測試，理由與界線寫在測試檔頭註解。

**驗收（Phase 1 單獨）**

```bash
cd web
npm run typecheck
npm run lint
npx vitest run tests/unit/e2e-conventions.test.ts
for s in a11y cancel-calculate-race copy-d39 d2d-impact-dialog-focus d2d-impact-dialog-focus-cleanup \
         d2d-impact-dialog-focus-negative leave-confirm-dialog-focus leave-guard report-refresh-recovery \
         round3-mapping-candidates-sync schedule-stale-response schedule-unknown-weekday settings-cancel; do
  npm run test:e2e:isolated -- tests/e2e/$s.spec.ts
done
```

- 期望：上列 13 檔全綠；`d2b-class-category-empty-db`、`round3-preview-category-deltas`、`schedule-excel-io`、`schedule-grid-workflow`、`schedule-header-seam`、`schedule-sticky-header` **仍失敗**（分別留給 P2／P3）；`copy-d39` 只剩「空白星期」1 案紅（P4）。

**鑑別力（不可只有綠燈）**

- Mutation 1：把 `openClassSchedule` 內的 `?class=` 拿掉 → 上述 A 族案例必須重新變紅。
- Mutation 2：把 `startInput` 預設改回 `.first()` 但停在安親頁籤 → 必須變紅。
- 兩者都要在 PR 描述貼出「mutation 後哪幾個案例紅」的實測輸出；只有綠燈不足以證明 helper 有承載契約。

**TDD 說明**：本 Phase 改的是測試入口，沒有產品行為變更。RED 已存在於 HEAD（§1.2 的 40 案例），因此證據鏈是「HEAD 紅 → helper 後綠 → mutation 後再紅」，不需也不得偽造一段產品 RED commit。

---

### Phase 2（PR-2）：B 族 8 案例（淘汰選取器與可達路徑裁決）

**分支**：`fix/issue-188-e2e-obsolete-selectors`
**前置**：Phase 1 的 helper（單獨開發時可先 cherry-pick，或由同一位實作者接續）。
**審查等級**：`single`；但 §3.2 的 Ruling 需 coord 先同意。

**逐檔做法**

| 檔案 | 現在 | 改成 |
|---|---|---|
| `d2b-class-category-empty-db.spec.ts:35,62,80`、`:56-70`（afterEach） | `[data-category-select="X"]` 的 `selectOption('none'/'math')` | `div[role="radiogroup"][aria-label="X 的是否有多科折扣"]` 的 `label.no-option`／`label.yes-option` 點擊；斷言改 `input[value="false"|"true"]` 的 `toBeChecked()`。D2b-4 與 N-1 的 afterEach 斷言改為「還原後 四A、四B 多科折扣皆為『是』」（`seed-manifest.ts:205-206` 兩班皆 `math`） |
| `d2b-class-category-empty-db.spec.ts:76-100`（Q9） | 用選單造出「四A none vs 四B math」 | 用單選造出「四A 多科折扣=否（category none） vs 四B 多科折扣=是（category math）」，其餘流程不變（先存、再整班改名、期待 `[data-merge-conflict]`） |
| `round3-preview-category-deltas.spec.ts:93-94,165` | 把 小五（`other`）的 category 改 math | 見 §3.2 Ruling：改走 Excel 匯出入變更課程類型（`other` → `math`），保留原手算 expected（0→1、2→3、95折→9折） |
| `schedule-excel-io.spec.ts:58,75` | 用 `data-category-select` 設 none | 用 四A 的多科折扣單選設「否」（`math` → category `none`），匯出前後以 `input[value="false"]` 被勾選驗證 |
| `schedule-excel-io.spec.ts:80` | `table.schedule-table-non-care` | 逐頁籤加總（`#class-type-tab-english|math|other|unscheduled` 的 `tr.schedule-row`）＋ care |
| `schedule-grid-workflow.spec.ts:27,33` | `.count-summary` 含「時段」、第一個 `input.input-time` | 依 `specs/09:67` 改成「安親頁籤顯示 `共 8 個班級`（不含時段）」＋切到排課頁籤後斷言 `{N} 個班級 · {M} 個時段`；編輯改用 helper（Gino 列） |
| `round3-mapping-candidates-sync.spec.ts:92`（改名目標在 `other` 頁籤） | 切回「課表」後直接 `renameWholeClass` | 改名後以 `ensureClassTypeTab(page,'R3國文班驗收')` 切到 `other` 頁籤再驗證（改名目標 `國小國語文-小五` 為 `other`） |

**§3.2 Ruling（需 coord 同意後才動工）**

`Ruling: round3-preview 改走 Excel 匯出入變更課程類型，而非在 UI 新增「變更既有班級類型」功能。`
理由：D61 只提供「新增班級時選類型」（`schedule-grid.tsx:582-597` 為新增表單；既有列只有 YesNoRadioGroup，沒有類型選單），`specs/16`（未合併分支）第 3 與 4 點也只新增新班表單與 Excel 9 欄契約。要讓「既有 `other` 班變成 `math`」在 UI 可達，等於新增一個未驗收的產品功能。Excel 匯出入是 D61 明列的正式路徑（`specs/04` UX106/UX109、`specs/09:70`「類別變更…進完整影響預覽」），且不改變原本的手算 expected。
替代方案（若 coord 認為不可）：把該案例改成「多科折扣 是→否」的類別變更（`math` → `none`），但 95折→9折 的 expected 需重新獨立手算與改 fixture，工作量與風險都更高。

**驗收（Phase 2 單獨）**

```bash
cd web
npm run typecheck && npm run lint
npm run test:e2e:isolated -- tests/e2e/d2b-class-category-empty-db.spec.ts
npm run test:e2e:isolated -- tests/e2e/round3-preview-category-deltas.spec.ts
npm run test:e2e:isolated -- tests/e2e/schedule-excel-io.spec.ts
npm run test:e2e:isolated -- tests/e2e/schedule-grid-workflow.spec.ts
```

- 期望：4 檔全綠（共 11 案）；`schedule-header-seam`／`schedule-sticky-header` 仍紅（P3）。
- Mutation：把 `data-category-select` 舊字串塞回某一檔 → 守門測試（P1）與該檔必須同時紅，證明守門有效。

---

### Phase 3（PR-3）：C 族 4 案例（幾何前提改到排課頁籤）

**分支**：`fix/issue-188-e2e-geometry-tab`
**審查等級**：`single`

- `schedule-header-seam.spec.ts:124-170`：在 `page.goto` 之後以 `openClassSchedule(page,'兒童美語-Gino')` 進入排課表（才有兩層表頭與可垂直捲動的 52 列）。`scrollTableToEnd` 與 `measureSeam` 不變；`>200` 的垂直捲動前提在排課表成立（實測 `maxTop=2131`）。
- `schedule-sticky-header.spec.ts:10-120`：同樣先切到排課表；`.col-group-anqin`／`.col-group-tutoring`（`schedule-grid.tsx:902,905`）與安親窗口標題定位因此可解析。**不得**改成對安親表做等價斷言——安親表本來就沒有這些群組表頭，也沒有垂直捲動。
- 兩個檔的檔頭註解補一行「本案例的前提是排課頁籤；安親頁籤無時段欄與垂直捲動」。

**驗收**

```bash
cd web
npm run test:e2e:isolated -- tests/e2e/schedule-header-seam.spec.ts
npm run test:e2e:isolated -- tests/e2e/schedule-sticky-header.spec.ts
```

- 期望 4 案全綠；接縫帶 `leakedPixels === 0`、兩列相接前提 `<=1px` 不得放寬。
- Mutation：把 `openClassSchedule` 換回 `page.goto('/settings')` → 4 案必須重新紅。

---

### Phase 4（PR-4）：D 族 1 案例（契約裁決後才動）

**分支**：`fix/issue-188-e2e-blank-weekday-contract`（若裁決為「改測試」）
**前置**：coord／operator 對 §3.4 裁決回覆。**未回覆前此 Phase blocked，不得猜。**
**審查等級**：`dual`（若改產品驗證行為，涉及設定預覽契約）；若只改測試與 spec 文字則 `single`。

**現況事實**

- `copy-d39.spec.ts:162-186` 期望 `POST /api/v1/settings/preview` 回 400；本機與 CI 實測皆 **200**。
- 轉折點：`681757c`（Phase 1）起紅（`12206ac` 仍綠）。
- 機制：`splitSavableSessions`（`contracts/settings.ts:290`）把空白／缺時間列移入 `incompleteSessions`（`contracts/settings.ts:152`），`SettingsPreviewRequestSchema` 因而通過（`settings-preview.ts:153`）。
- 反證：`tests/integration/schedule-unknown-weekday.test.ts:218` 仍斷言 400 且**目前綠**——因為它直接構造「星期欄空白、時間完整」的 `sessions`（不經 grid 的 `splitSavableSessions`）。這證明「契約只被 UI 的組裝路徑繞過」，不是伺服器完全放寬。
- 另一面：UX108 的「先存檔」正是靠這條路徑（`schedule-add-placeholder-row.spec.ts:106` 的 reload 測試在 CI 與本機皆綠）。

**兩種互斥選項，必須由 coord／operator 選一**

| 選項 | 內容 | 影響 |
|---|---|---|
| **D-1 改測試＋改 09（建議）** | `copy-d39` 的空白星期案例改為：預覽回 200 → 對話框仍顯示「尚未匯入學生」或實際影響、**不得**顯示「受影響 0 人／未改變」、可儲存；同時修 `specs/09:87`「提交仍拒絕空白星期」為「空白星期列轉為 `incompleteSessions`，不進計費核心、不阻擋存檔」，並同步 `specs/04` UX32 列文的機制描述 | 不改產品；與 D61 Ruling 3（先存檔）一致；`tests/integration/schedule-unknown-weekday.test.ts:218` 保留（伺服器對「偽造完整 session」仍嚴格） |
| **D-2 改產品復原 400** | 在 `settings-preview.ts` 於 `SettingsDraft` 之後再驗「不得含空白星期」 | 與 UX108「未填時間可先存檔」直接衝突，`schedule-add-placeholder-row.spec.ts:106` 會轉紅；不建議 |

**建議採用 D-1**，理由：D61 的 1c 目的是「允許先存檔、以視覺警示提醒」，而 UX32 的原意是「沒有預覽就不得假裝 0 人／未改變」，兩者在 200＋`settings_only` 下都能滿足。D-2 會把已驗收的 UX108 打回去。

**若採用 D-1 的驗收**

```bash
cd web
npm run test:e2e:isolated -- tests/e2e/copy-d39.spec.ts
npx vitest run tests/integration/schedule-unknown-weekday.test.ts
```

- `copy-d39` 全 10 案綠；`schedule-unknown-weekday.test.ts` 9 案仍綠（證明伺服器契約沒有被放寬到「偽造 session」）。
- spec 文字（09 §87、04 UX32）與測試同一 PR，避免文件與行為再次分岔。
- Mutation：把 `splitSavableSessions` 的空白星期分支改回丟進 `sessions` → `schedule-unknown-weekday.test.ts:218` 與改寫後的 `copy-d39` 必須同時紅。

---

## 4. 交付順序與「失敗集合」驗證

| 階段 | 失敗 spec 集合（相對 nightly） | 失敗案例數 |
|---|---|---|
| 現況 `99b6bcb` | 19 檔（§1.2） | 53 |
| P1 合併後 | 7 檔：d2b-empty、round3-preview、excel-io、grid-workflow、header-seam、sticky，加上 copy-d39（只剩空白星期 1 案） | 13 |
| P1+P2 | 3 檔：header-seam、sticky、copy-d39（空白星期） | 5 |
| P1+P2+P3 | 1 檔：copy-d39（空白星期） | 1 |
| P1+P2+P3+P4 | 0 | 0 |

**判準一律是集合相等**：用 `comm` 比對「應跑 49 檔」與「實跑 49 檔」，再比對失敗案例清單；`exit 0` 不算證據。最終一次必須是**新的 nightly（scheduled）**，或經 coord 核准的 `workflow_dispatch`（並在報告中註明「manual dispatch 不是 scheduled 執行」）。

每個 PR 的 gate（皆在該 PR 的 worktree 內跑，`web/` 目錄）：

```bash
npm run typecheck && npm run lint && npm test
npm run test:e2e:isolated -- tests/e2e/<本 Phase 的檔>
```

- **必須在該 PR 的 worktree 內執行**：在 primary checkout 跑會掃到未變更的樹，綠燈不屬於受審 HEAD。
- `npm test` 若出現對 `data/app.sqlite` 的寫入（`DATABASE_PATH` 未隔離）即為測試隔離缺陷，不得以此綠燈交付。
- `npm run test:e2e:full` 只在最終階段（或 coord 要求時）跑一次，避免每 PR 30+ 分鐘；但**不得**用單檔綠燈宣稱 full 綠。

---

## 5. TDD／證據鏈

本批多數是測試入口修正，沒有產品行為變更。證據鏈固定為三件事，缺一不可：

1. **HEAD 紅**：在 `99b6bcb` 上執行該 spec 的實測輸出（本次已記錄於 §1.2；PR 內貼實際命令與摘要）。
2. **修正後綠**：同命令全綠。
3. **Mutation 再紅**：改壞 helper／拿掉頁籤切換後必須重新紅，證明修正不是靠放寬斷言換綠。

禁止事項（同 `CLAUDE.md` §8）：不得提高 timeout 掩蓋、不得加 `test.skip`、不得改 expected 數字、不得 `retry`、不得把 `toBeVisible` 換成 `toHaveCount(0)` 之類的弱斷言。

---

## 6. 已存在的反例證據（避免誤判）

- `schedule-add-placeholder-row.spec.ts:106`（UX108 存檔後 reload 保留待補列）在 **CI 與本機皆綠**；本計畫不把它列入失敗，也不得為了 P4 的 D-2 選項去動它。
- `tests/integration/schedule-unknown-weekday.test.ts` 9 案在本機 HEAD 全綠（`npx vitest run tests/integration/schedule-unknown-weekday.test.ts` 實跑）。因此「空白星期已全面放寬」是錯誤推論；放寬只發生在 grid → `splitSavableSessions` → `SettingsDraftSchema` 這條 UI 組裝路徑。
- `schedule-class-type-tabs.spec.ts` 的 4 案（UX106 頁籤順序與欄位分離）在 nightly 未失敗；本計畫不得改它的斷言，只在新 helper 需要時對齊 import。

---

## 7. 風險、相容性與依賴

| 風險 | 說明 | 對策 |
|---|---|---|
| 與 PR #190 衝突 | #190（`feat/issue-189-phase-1-sync-read-model`）動 `settings-editor.tsx`、`class-attributes.ts`、`mapping-panel.tsx`、`class-name-report-panel.tsx`；本計畫 P1／P2 不應改產品檔，但 `round3-mapping-candidates-sync`／`report-refresh-recovery` 依賴 mapping 面板 | P1／P2 不碰產品檔；若 #190 先合併，重跑 mapping 相關 4 檔確認 helper 仍可用 |
| helper 預設值綁定 seed | `startInput` 預設 `'兒童美語-Gino'` 依賴 seed；若 seed 改名，多檔會同時紅 | 預設值集中在一處並在註解寫明來源（`seed-manifest.ts`）；守門測試的 allowlist 只有幾何兩檔 |
| 幾何斷言對版面敏感 | 表頭接縫／sticky 依賴 `border-collapse`（已知 #99） | 本 Phase 只改「進哪個頁籤」，不改 `<=1px`／`leakedPixels === 0` 門檻 |
| `?class=` 深度連結 | 依 `specs/09:60`「`?class=` 自動切至目標類型頁籤」；已有 E2E 覆蓋（`leave-confirm` 的入口矩陣） | helper 先斷言「目標班列可見」，失敗時錯誤訊息要指出班名與頁籤 |
| CI 較慢 | nightly 上 focus 案例多為 15s／30s timeout；本機單獨重跑可在 6 秒內取得 409 | 不以加 timeout 修；先修入口。若修完仍偶發，另開 issue 記錄實際耗時（不得默默放寬） |
| 文件引用落差 | 根 `CLAUDE.md` §2 引用 `specs/15`、`specs/16`，但兩檔不在 `main` | 不動本計畫範圍；建議 coord 另開 issue 決定「補檔或移除引用」（§8） |

---

## 8. 交付狀態與待決事項

**待決（回覆後才動工）**

1. **P4 契約**：D-1（改測試＋改 09/04，建議）或 D-2（改產品復原 400）。未決前 P4 blocked。
2. **P2 Ruling**：`round3-preview` 以 Excel 匯出入變更課程類型（建議），或改寫成多科折扣變更並重新手算。
3. **`specs/15`／`specs/16` 引用落差**：是否另開 issue（不在本計畫內處理）。
4. **最終驗證形式**：新的 scheduled nightly，或 coord 核准的 `workflow_dispatch`（需在報告中標明差異）。

**本計畫未做的事（避免誤讀）**

- 未修改任何產品程式碼、未修改任何 E2E spec、未開 PR、未改 Issue #188 狀態。
- 未執行 `npm run test:e2e:full`（30+ 分鐘）；本計畫的 49／53 數字全部來自 nightly run `40786271398` 的 `verify.log` 與產物，以及本機逐檔重跑的實際輸出。
- 未新增 `tests/e2e/*.spec.ts`；若 Phase 1 的守門測試需要例外清單，清單本身寫在測試檔內並附理由。
