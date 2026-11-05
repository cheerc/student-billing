# 19 — 匯入頁重設與資料表表頭排序 Execution Plan

- 來源：Issue #219（匯入頁重設）、Issue #220（表頭排序＋共用表頭元件）；Operator 2026-11-05 人工操作回報 P01–P03。
- Base：`main` @ `68dea98`。
- 本檔是執行計畫，不定義規則；規則與驗收由 Phase 0 寫入 06／09／03／04 後才生效（CLAUDE.md §2 權威順序）。

---

## 1. 目標、範圍與排除

### 1.1 目標

| 代號 | 來源 | 目標 |
|---|---|---|
| G1 | #219 P01 | 「使用這份名單」之前不出現任何導向他頁的班名同步連結；啟用完成後才引導「前往班名同步 →」。 |
| G2 | #219 P03 | 步驟條重做為具引導效果的進度條；頁首精簡。 |
| G3 | #219 P01+P03 | 預覽階段收斂為單張確認卡；「查看異動」「預覽名單」兩個按鈕開同一個大型浮動視窗（頁籤：異動／名單）。 |
| G4 | #220 | 共用表頭元件：同一欄位定義同時描述排序與篩選。 |
| G5 | #220 | client 全量資料表可點表頭排序。 |
| G6 | #220 | 學生總表 server 端排序，與 cursor 分頁一致。 |

### 1.2 排除（不得在本計畫內做）

- 不改 02 計費規則、03 §4 不可變快照／交易不變式。
- 不改 `POST /imports/preview` 回應形狀：`classNameReport`、`pendingClasses`、`rosterDiff`、`issues` 全數保留（Agent 與既有測試相容）。
- 不保存未啟用預覽以供離頁還原（G1 讓使用者不需在啟用前離頁，問題即消失；保存預覽屬另案）。
- 不改核對頁「待設定班級提示」（`web/src/components/active-run-view.tsx:681-689`）。
- 不對可編輯課表時段表（`settings/schedule-grid.tsx`）加排序：編輯中列位置跳動易誤操作。
- 不改 API 預設排序：未帶 `sort` 時 `/runs/{id}/students` 與 `/imports/{id}/students` 順序與現行逐位元相同。

---

## 2. Planner Rulings

以下為 Planner 依 Operator 方向自行裁定的細節（Operator 可推翻；推翻時只需改 Phase 0 的規格文字與對應驗收）：

1. Ruling: 浮動視窗內容＝「異動」頁籤（與目前名單相比新增／異動／未出現＋逐人明細、略過資料列警告、班名不一致 N/M/K 純數字無連結）＋「名單」頁籤（搜尋、狀態篩選、名單表）— 單一視窗集中「需要時才看」的資訊，主畫面只留決策所需。
2. Ruling: 略過資料列警告移入視窗，主畫面確認卡以一行計數提示（含略過列數）提醒，數量 > 0 時以 warning 樣式顯示 — 保留可見性又不攤開全文。
3. Ruling: 啟用完成畫面在 `classNameReport.unmappedCount > 0`（取啟用前預覽回應，不重新查詢）時顯示「前往班名同步 →」，連結 `/settings?tab=sync`（不帶 `?import=`，此時新名單已是現行名單）— 啟用後現行名單即新名單，不需深連結。`settings/page.tsx` 的 `?import=` 支援保留（相容舊連結），不刪。
4. Ruling: 步驟條 = `<ol>`＋`aria-current="step"`，移除 `role="navigation"`；完成步驟顯示 ✓；當前步驟下方一行行動說明；步驟 1 說明併入原「目前課表：… 已儲存」與「查看課表 →」文字連結；頁首只留 h1＋一句說明。顏色一律用 `globals.css` 既有 token（無對應 token 時於 `:root` 新增，不寫死 hex）。
5. Ruling: 排序兩態（升冪↔降冪），點另一欄從升冪開始；未點任何欄＝現行預設順序；空值不論方向排最後；文字 `localeCompare(…, 'zh-Hant')`、數值依數值；同值以 personCode（無則原始序）穩定排序。
6. Ruling: 學生總表排序狀態入網址（與篩選同一 `replaceState` 機制）；client 表排序只存元件 state — 學生總表需與 cursor identity 綁定，client 表無此需求。
7. Ruling: 學生總表首批可排序欄＝在 `student_calculations` 有實體欄位且單值者：姓名（`name`）、年級（`grade`）、安親天數（`anqin_days`）、課輔天數（`tutoring_days`）、合計折扣（`base_discount_bps`）、已補科數（`subject_count`，Phase B3 先驗證該欄即畫面所示值）。所屬班級（多值）、本班適用折扣（讀模型推導）及其他由 JSON／issue 推導之欄本批不開放排序，表頭不顯示排序鈕 — 避免在 SQL 外重算排序鍵。
8. Ruling: `sort` wire 格式 `sort=<field>` 或 `sort=-<field>`（降冪），單值；白名單外回 400 並指名參數。cursor 編碼改為 `(sortValue, personCode)` keyset，identity 納入 `sort`。

---

## 3. Phase / PR 拆分

依賴：`P0 → {A1, B1}`（A1 與 B1 可並行開發，合併仍一次一個）`→ A2（需 A1）→ B2（需 A2、B1）→ B3（需 B1）`。

審查等級：全部 `single`（UI／設定／工具／docs；不碰 T03／T04 計算核心）。

### P0 — docs(specs)：D64／D65 決策與目標契約

- 檔案：
  - `specs/06-handoff-decisions.md`：新增 **D64**（匯入頁重設：G1–G3，含 Ruling 1–4）、**D65**（表頭排序＋共用表頭元件：G4–G6，含 Ruling 5–8）。
  - `specs/09-ui-workflow-redesign-spec.md`：改寫「班名同步摘要」段（目前規定摘要卡在「使用這份名單」之前）、匯入流程段、§5.1／§5.2 加排序語意。
  - `specs/03-architecture-api.md`：查詢參數表 `sort` 由「兩端皆回 400」改為白名單契約；cursor 契約（「Cursor 契約變更」段）納入 sort。
  - `specs/04-tdd-acceptance.md`：UX47 改寫；新增 UX121 起（建議 UX121 啟用前無同步連結、UX122 完成畫面同步引導、UX123 步驟條、UX124 確認卡＋浮動視窗、UX125 共用表頭、UX126 client 排序、UX127 server 排序＋cursor、UX128 預設順序不變）。
  - `CLAUDE.md` §2 第 1 層決策區間 D01–D63 → D01–D65、第 3 層加列本檔；`specs/README.md` 索引加 19。
  - 本檔隨此 PR 進 `specs/`。
- 驗證：純文件，無 RED。檢查 04 新列皆有 input→expected、測試層欄；`git diff --stat` 只含 `specs/` 與 `CLAUDE.md`。

### A1 — feat(imports)：頁首與步驟條重做（G2）

- 檔案：`web/src/components/imports/imports-workflow.tsx`（`:220-257` 頁首、步驟條、課表提示）、`web/src/app/globals.css`（`:1593-1655`）。建議把步驟條抽成 `web/src/components/imports/import-steps.tsx`（純展示元件，props：`stage`、`scheduleSavedAt`）。
- 測試（RED 先行，入口為元件 SSR 渲染，同 `tests/unit/imports-workflow-ui.test.ts` 既有作法）：
  - `stage='upload'` → `<ol>` 內 3 個 `<li>`，第 1 個 `aria-current="step"`；不存在 `role="navigation"`。
  - `stage='preview'` → 步驟 1 含 ✓ 且無數字「1」；步驟 2 `aria-current="step"`。
  - `stage='upload'` 且有課表儲存時間 → 步驟 1 行動說明含「目前課表：YYYY-MM-DD HH:mm 已儲存」與連到 `/settings?tab=schedule` 的連結；頁首不再有「查看課表 →」按鈕。
  - E2E（`tests/e2e/imports.spec.ts` 新增或調整案例）：1280×800 下步驟條三項文字 ≥ 15px（`getComputedStyle`）、編號圓 ≥ 32px。
- 指令：`cd web && npx vitest run tests/unit/imports-workflow-ui.test.ts && npm run typecheck && npm run lint && npm run test:e2e:isolated -- tests/e2e/imports.spec.ts`
- 注意：先讀 `web/tests/e2e/CLAUDE.md`；以文字定位步驟的既有 E2E 選取器需同步更新。

### A2 — feat(imports)：確認卡、異動／名單浮動視窗、班名同步引導移至完成畫面（G1、G3）

- 檔案：
  - `imports-workflow.tsx` 預覽段（`:300-540`）收斂為確認卡：檔名、4 stat-card、一行計數提示、[查看異動] [預覽名單]、核對基準日、主要鈕「使用這份名單」。
  - 新元件 `web/src/components/imports/import-review-dialog.tsx`：原生 `<dialog>`＋`showModal()`，參照 `settings/impact-dialog.tsx:97-140` 的焦點還原作法；頁籤「異動」「名單」；寬 ≥ `min(1100px, 100vw - 32px)`、高 ≤ `90vh` 內部捲動。
  - 「異動」頁籤承接 `roster-changes-details.tsx`、`preview.issues`、班名 N/M/K 文字（**不渲染** `ClassNameReportSummaryCard` 的連結；可將該元件加 `showLink` prop 或拆出純文字版）。
  - 「名單」頁籤承接原名單預覽表（搜尋、狀態篩選，`imports-workflow.tsx:202` 的 `filteredStudents` 邏輯搬入）。
  - 完成畫面（`:542-563`）依 Ruling 3 加「前往班名同步 →」。
- 測試（RED 先行）：
  - unit：fixture preview（含 `classNameReport` mismatch>0）於 `stage='preview'` 渲染 → HTML 不含 `href="/settings?tab=sync`、不含名單表 `<table>`；含「查看異動」「預覽名單」按鈕。
  - unit：`stage='success'` 且 `unmappedCount>0` → 含連到 `/settings?tab=sync` 的「前往班名同步 →」；`unmappedCount=0` → 不含。
  - E2E：上傳 `tests/fixtures/conforming-erp-fixture.xlsx` → 預覽頁無「前往班名同步」連結；點「查看異動」→ dialog 開啟且顯示「名冊有 12 個班名與課表不一致（其中 12 個尚未對應，影響 191 位學生）」（數字沿用 04 UX47 獨立盤點值，非 report 函式輸出）；Esc 關閉且焦點回到觸發鈕；點「預覽名單」→ 名單頁籤，列數 477（fixture 總列）；按「使用這份名單」→ 完成畫面出現「前往班名同步 →」，點擊後 URL 為 `/settings?tab=sync`。
  - 調整既有斷言：`tests/e2e/imports.spec.ts:216-217`、`class-name-report.spec.ts:96-207`、`round3-mapping-candidates-sync.spec.ts:143`、`copy-scan.spec.ts:243`、`tests/unit/imports-workflow-ui.test.ts:289-290`、`tests/unit/class-name-sync-banner-impact.test.tsx`——依 P0 改寫後的 UX47／UX121–124，不得只刪斷言。
- 指令：`cd web && npx vitest run tests/unit/imports-workflow-ui.test.ts tests/unit/class-name-sync-banner-impact.test.tsx && npm run typecheck && npm run lint`，E2E 逐檔 `npm run test:e2e:isolated -- <file>`（列出上述 4 個 spec＋新增者，報告各檔測試數）。

### B1 — refactor(tables)：共用欄位定義與表頭元件（G4，無行為變更）

- 檔案：
  - 新 `web/src/components/tables/column-def.ts`：`ColumnDef<Row> = { key; label; className?; sort?: { type: 'text'|'number'; accessor(row) } | { server: string }; filter?: FilterSection 來源 }`。
  - 新 `web/src/components/tables/table-header-cell.tsx`：渲染 `<th>`，內含（可選）排序按鈕＋（可選）`HeaderFilter` 觸發鈕；`aria-sort` 只在有排序狀態時輸出。
  - `summary-table.tsx:183-205`、`results/class-deductions-panel.tsx:195-200` 改用上述元件；`STUDENT_TABLE_COLUMNS`（`summary-table.tsx:27`）改由欄位定義推導，維持單一來源。
  - `filters/header-filter.tsx` 介面不變。
- 驗證：純結構重構，無 RED；既有測試全綠即證據：`cd web && npx vitest run && npm run typecheck && npm run lint`，E2E 逐檔跑 `results*.spec.ts`／`summary*`／`class-deductions*` 中觸及表頭的 spec（PR 描述列檔名與測試數）。新增 unit 測 `table-header-cell` 無 sort 設定時輸出與舊 `<th>` 相同文字與篩選鈕名稱（「{欄名}篩選」）。

### B2 — feat(tables)：client 資料表排序（G5）

- 對象：A2 的「名單」頁籤表、「異動」頁籤的異動明細表（`roster-changes-details.tsx:127`）、班級扣天主表（`class-deductions-panel.tsx:195`）、班名同步兩表（`class-name-sync-panel.tsx:159,449`）。動作欄（按鈕）不可排序。
- 新 `web/src/components/tables/use-client-sort.ts`：純函式 `sortRows(rows, def, dir)`＋hook。
- 測試（RED 先行）：
  - unit `sortRows`：數值 `[3, null, 1, 2]` 升冪 → `[1, 2, 3, null]`、降冪 → `[3, 2, 1, null]`；ASCII 文字 `['b', null, 'a']` 升冪 → `['a', 'b', null]`；兩列同值保持輸入相對順序。中文排序案例的 expected 須在測試內寫明比較依據（`Intl.Collator('zh-Hant')`），不得以 `sortRows` 自身輸出生成。
  - E2E：班級扣天表點「班級」表頭 → `aria-sort="ascending"`，再點 → `descending`；點另一欄 → 該欄 `ascending`、前一欄無 `aria-sort`。
- 指令：`cd web && npx vitest run tests/unit/<new>.test.ts && npm run typecheck && npm run lint`＋逐檔 E2E。

### B3 — feat(query)：學生總表 server 排序（G6）

- 檔案：
  - `web/src/contracts/student-query.ts:83`：`sort` 移出「尚未實作」拒絕清單，改白名單（Ruling 7、8）；`queryIdentity` 納入 sort；`encodeStudentCursor`／`decodeStudentCursor` 改 keyset `(sortValue, personCode)`。
  - `web/src/application/query-students.ts:148`：`ORDER BY` 依 sort（`<col> <dir> NULLS LAST, person_code ASC`；SQLite 以 `(<col> IS NULL), <col> <dir>` 實作）；分頁 WHERE 改 keyset 比較。
  - `web/src/application/roster-query.ts:182`：同上（`/imports/{previewId}/students`，可排序欄限 `imported_students` 實體欄：姓名、年級；其餘回 400）。
  - `web/src/lib/results-filters.ts` 網址狀態加 `sort`；`active-run-view.tsx` 條件或排序改變時清 cursor 重查（沿用 `:304` 既有行為）。
  - 表頭：Ruling 7 之欄啟用排序按鈕。
- 測試（RED 先行，入口為 route handler／application 查詢，沿用 `tests/integration` 既有 DB fixture 作法）：
  - 合成 5 名學生（含 grade null、同 anqin_days 兩人）→ `sort=-anqinDays&limit=2` 逐頁取完 → 順序依手算表；null 在最後；同值依 personCode 升冪；跨頁無重複無遺漏。
  - 未帶 `sort` → 結果與以 `person_code ASC` 手算順序相同（UX128 相容）。
  - `sort=bogus`、`sort=enrollment` → 400 指名 `sort`。
  - 換 sort 沿用舊 cursor → 400（identity 不符）。
  - E2E：學生總表點「安親天數」→ 網址含 `sort=anqinDays`、第一列為最小值；reload 後維持。
- 指令：`cd web && npx vitest run tests/integration/<new>.test.ts tests/integration/multivalue-query-nocourse.test.ts && npm run typecheck && npm run lint`；效能：`npm run test:perf:isolated`（03／CLAUDE.md §8：四條 API 單輪 p95 < 200ms，排序後須重驗並揭露數字）。

---

## 4. TDD 與證據要求（全 Phase 共通）

- 行為變更 Phase（A1、A2、B2、B3）：**RED commit**（只含失敗測試，於 PR 描述附失敗輸出摘要與失敗原因）→ **GREEN commit**（實作）。B1、P0 無 RED，理由見各段。
- expected 一律依規格獨立手算；不得以待測函式輸出產生（CLAUDE.md §8）。A2 的 N/M/K 數字引用 04 UX47 已獨立盤點之值。
- Full E2E 不作為各 PR gate（CLAUDE.md §8）；逐檔 `test:e2e:isolated` 為針對性證據，須列檔名與測試數。最後一個 PR 合併後由 nightly 驗全量。
- 測試 fixture 僅用 `tests/fixtures/conforming-erp-fixture.xlsx` 或合成資料；不得引用真實名單數字。

## 5. 風險與防護

| 風險 | 防護 |
|---|---|
| 既有 E2E 以文字／`role="navigation"` 定位步驟條或名單表 | A1／A2 先 `grep -rn` 受影響選取器並在同 PR 改寫；PR 描述列出改動的 spec 檔。 |
| 浮動視窗焦點陷阱、Esc、捲動鎖 | 用原生 `<dialog>.showModal()`，沿用 `impact-dialog.tsx` 焦點還原；E2E 驗 Esc 與焦點返回。 |
| 搬移名單表後 `核對基準日`／「使用這份名單」流程被改壞 | A2 E2E 走完上傳→預覽→啟用→完成全流程。 |
| B3 cursor 格式改變使舊 cursor 失效 | 新格式解碼失敗回 400（既有行為：條件改變即 400）；client 條件變更必清 cursor。 |
| 排序破壞 Agent 查帳 API 預設順序 | UX128 測未帶 `sort` 時順序不變。 |
| 排序拖慢 p95 | B3 重跑 `test:perf:isolated` 並揭露；必要時於 migration 加索引（另列為 B3 內可選步驟，需附量測）。 |
| 視窗寬度在窄螢幕溢出 | `min(1100px, 100vw - 32px)`；E2E 以 390×844 驗無水平捲動。 |
