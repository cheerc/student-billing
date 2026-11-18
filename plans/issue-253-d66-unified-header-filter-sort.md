# Execution Plan — D66 表頭篩選與排序統一比照 Excel（Issue #253、#255）

- 狀態：Plan（待 Gate 1）。本檔只在 plan branch，不進 `main`。
- 契約來源（已合併，`main` @ `ac52ef0`，PR #254）：
  - [03 §5.1「表頭欄位統一篩選與排序」](../specs/03-architecture-api.md) 第 1–10 點（以下簡稱 **R1–R10**）
  - [09 §5.1／§5.2](../specs/09-ui-workflow-redesign-spec.md)、[06 D66](../specs/06-handoff-decisions.md)
  - 驗收 [04 UX129–UX133](../specs/04-tdd-acceptance.md)
- 其他依據：Investigation Report（Issue #253 comment 6971568143，DIAGNOSED）、#255 稽核、Coordinator Q1-A／Q2、r1／r2 review rulings。
- Review class：**single**（CLAUDE.md §7：UI／查詢，非 T03／T04 計費）。每個 Phase＝1 PR，依序 squash merge。

## 1. 目標、範圍與不處理

**目標**：所有可篩選／可排序的表頭共用一份純函式模組。欄位定義對每列產生 `Cell = { value, text } | null`：

- 儲存格渲染與 server／client 的篩選、選項、排序、cursor 全部讀同一個欄位定義。
- 篩選依 `text`，排序依完整比較鍵 `(value, text, personCode)`。
- 文字比較用 `Intl.Collator('zh-Hant')`（筆畫序）。
- 「(空白)」在選項面板最後。

**範圍**：

- 學生總表（server：`GET /api/v1/runs/{runId}/students`，含 SSR `resolveResultsView`）。
- client 端表：班級扣天、匯入「名單」「異動」、班名同步兩表。

**不處理**：

- 02 計費規則、整數 `grade`、適用率年級分段、額外扣天旗標等計算輸入（D66 (7)）。
- Agent 語意參數與既有 `options` 的語意：逐位元不變。
- `sort` 欄位白名單。
- 課表時段編輯表。
- `roster-query.ts`（test-only，沿用 v2 cursor 與 SQL 排序，不改）。
- #111、#118、#251。
- 不新增任何表的篩選 UI 或排序欄（R-scope ruling）。

## 2. 架構裁決（Rulings）

1. **Ruling P-1 模組位置**：新增 `web/src/lib/table-columns/`。它是純 TS，不含 `'use client'`，不依賴 Node 或 SQLite，server 與 client 共用。`summary-table.tsx` 已在 client import `@/application/roster-changes`（`formatDiscountBps`）、`@/application/applicable-rate`、`@/domain/billing/discount-rules`，所以新模組可以沿用這些 import。理由：與 `contracts/student-sort-fields.ts` 同型的共用單一來源。
2. **Ruling P-2 型別**（Implementer 可調整名稱，語意必須不變）：
   - `type Cell = { value: number | string; text: string } | null`，`null`＝空白。
   - `ColumnSpec<Row, Ctx>`：
     - `key`、`label`
     - `cells(row, ctx): Cell[]`：單值欄回傳長度 0／1，多值欄回傳多個
     - `filterable`、`sortable`
   - `compareCells(a, b, dir)`：
     - 數值 < 字串；數值依大小，字串依 `TEXT_COLLATOR` 比較，為 0 時以 UTF-16 碼元決勝。
     - 同 `value` 再比 `text`。
     - `desc` 同時反轉 value 與 text 兩層。
     - `null` 不論方向一律最後。
   - personCode 與輸入序的決勝由呼叫端負責：server 依 personCode 升冪，client 依原輸入序。
   - `buildColumnOptions(rows, spec, ctx, inScope)`：
     - 不同 `text` 以 `{ value: text | '~blank', count }` 輸出，count 為 personCode 去重。
     - 順序依 R5：取各 text 的最小 cell 做升冪，`~blank` 最後。
3. **Ruling P-3 `col.*` 傳輸**：新增 `web/src/contracts/column-filter.ts`，負責解析並驗證 `col.<key>`，產生 `{ texts: Set<string>, blank: boolean, none: boolean }`：
   - R7 列出的 400 一律丟 `StudentQueryInputError`，訊息指名參數。
   - 字面 `~` 開頭的值以 `~~` 跳脫。
   - 「恰選一班」依 R7（兩方並存須各自恰選同一班）。
4. **Ruling P-4 cursor v3**：在 `contracts/student-query.ts` 新增 `encodeColumnCursor`／`decodeColumnCursor`（version 3）。
   - 形狀：`p`；非空白帶 `v`（number 或 string，以 JSON 型別區分）＋`t`（字串，≤200）；空白帶 `n: true`。
   - 既有 v2 `encodeStudentCursor`／`decodeStudentCursor` 保留，只給 `roster-query.ts` 用（不改其行為）。
   - `queryIdentity` 納入 `col.*` 選擇（正規化後排序），並加入 `cursorVersion: 3` 欄位。舊 cursor 因 identity 不符或版本不符而回 400。
5. **Ruling P-5 server 引擎**：`queryRunStudents` 改為兩段：
   - SQL 前篩：沿用 `createStudentPredicateBuilder`，套語意參數＋`q`／`subject`。
   - application 層：對前篩結果建完整 `StudentCalculationItem`（抽出 `toStudentItem(row, enrollments)`，與現行逐欄 mapping 同源），套 `col.*`、排序、keyset。
   - 未帶 `sort` 時以 **UTF-8 位元組序**比 personCode（`Buffer.compare`），與 SQLite BINARY `person_code ASC` 逐位元一致（UX128）。
   - 不新增 migration 或持久化排序鍵。若 p95 ≥ 200ms，**先送 [CLARIFY]**，再談預算 rank（Coordinator 指示）。
6. **Ruling P-6 stats**：`totalStudents`、`mismatchCount`、`issuesCount`、`filteredNoCourseCount` 以**最終集合**計算。
   - `mismatchCount`：沿用既有 class-scoped SQL 判定，只是限縮到最終集合（`person_code IN (...)`）。class scope＝語意 `enrollmentKey` 值 ∪ `col.enrollment` 對應的 baseName。「班名無法解析」對應 `''`，`~blank` 不納入。
   - `classScopeTotal`：只套班級條件，兩來源皆算。
   - `noCourseTotal`：不變。
7. **Ruling P-7 lanes**：
   - Lane A：P1 → P2 → P3a → P3b → P4 → P6。
   - Lane B：P5，P2 合併後可與 P3a–P4 並行。
   - 檔案柵欄：P5 **不得**修改 `lib/results-filters.ts`、`components/filters/header-filter.tsx`、`components/summary-table.tsx`、`components/active-run-view.tsx`。若需要動到，改為排在 P4 之後。P4 保持 `HeaderFilter` props 介面相容（分區欄位可選），讓 P5 不受影響。

## 3. Phase／PR 拆分

每個實作 PR 都是 RED commit（只有失敗測試，經真實入口）→ GREEN commit（最小實作）。expected 依 03／04 手算，不以待測函式輸出產生（CLAUDE.md §8）。

GREEN 前 Implementer 須對每個改到簽章或行為的 symbol 跑 `codegraph callers` 與 `codegraph impact`。下列各 Phase 已列出 2026-11-18 於 `ac52ef0` 的查詢結果，作為起點清單；實作時以重跑結果為準。

### P1 — 共用引擎核心（純函式，無既有消費者變更）

- **新增**：`web/src/lib/table-columns/{cell.ts,compare.ts,options.ts}`、`web/src/contracts/column-filter.ts`、cursor v3 函式（`web/src/contracts/student-query.ts`，只新增 export，不改既有函式）。
- **測試**：新增 `web/tests/unit/table-columns.test.ts`，涵蓋 UX129 (a)–(d)：
  - 混合值序：`1,3,'7','小班','國一',空白`／降冪 `'國一','小班','7',3,1,空白`。
  - 姓名筆畫 `丁一 王一 吳一 林一 黃一 蔡一`（明確斷言**不是**碼點序 `丁 吳 林 王 蔡 黃`）。
  - `4`／`4*額` 兩個選項；升冪 3.5 → `4` → `4*額` → 空白；降冪 `4*額` → `4` → 3.5 → 空白。
  - bps 9000 < 9500 < 10000。
  - 選項 `~blank` 最後。
  - 測試輸出記錄 `process.versions.icu`／`cldr`。
- **測試**：`col.*` 解析的 400 清單（R7）；cursor v3 encode／decode 與形狀拒絕（UX131 (d) 的單元部分）。
- **RED**：測試 import 新模組（不存在）而失敗，或先放 stub 檔使斷言失敗。RED 原因必須是行為斷言失敗，不是 typecheck 錯誤；以 stub 匯出讓測試跑到 expect。
- **callers／impact**：新 symbol 無既有 caller；`queryIdentity` 不在本 Phase 修改。
- **驗收**：
  - `cd web && npx vitest run tests/unit/table-columns.test.ts`
  - `npm run typecheck`
  - `npm run lint`

### P2 — 學生總表欄位定義＋儲存格改用同一格式化（UI 顯示變更）

- **新增**：`web/src/lib/table-columns/student-columns.ts`。內容是 R6 的 13 欄 ColumnSpec（`ctx = { singleClass, snapshots }`），以及 `gradeCell(grade, gradeRaw)`，P5 匯入名單共用。
- **搬移**：`summary-table.tsx` 內的 `extraDays`、`localRate`、`num` 與年級格式化移入上述模組。`formatBaseDiscount` 保留 export，內部改呼叫模組。原因：`detail-drawer.tsx:61`、`base-discount-default-10000.test.ts`、`copy-batch-c.test.ts`、`summary-table-columns.test.ts`、`summary-table-wiring.test.ts` 仍 import 它。
- **修改**：`web/src/components/summary-table.tsx`，每格 `<td>` 文字取自 `spec.cells(row, ctx)`（空白 →「—」）。
  - **所屬班級**：每行主文字改為 `baseName`；空 baseName 顯示「班名無法解析」；原始 token 放在 `title`（Q2-b）。
  - **需確認**：顯示全部徽章，依序為 `天數不同`、每個 actionable issue 標籤、`待核對`（Q2-a）。
- **測試**：
  - `tests/unit/summary-table-columns.test.ts` 擴充 UX129 (e)：SSR 渲染合成列，逐格斷言 `<td>` 文字＝`cells()[i].text` 或「—」。
  - 所屬班級 `title` 為原 token；多 issue 學生顯示三個徽章。
- **callers／impact**（起點清單）：
  - `SummaryTable` ← `ActiveRunView`（`active-run-view.tsx:117`）
  - `formatBaseDiscount` ← `SummaryTable`、`DrawerPanel`（`detail-drawer.tsx:61`），以及上列 4 個測試
  - E2E 可能斷言舊儲存格文字（只顯示首個 issue、所屬班級原 token）：`active-run.spec.ts`、`copy-scan.spec.ts`、`results-density.spec.ts`。須跑 targeted E2E 並依新契約更新（不得 skip）。
- **驗收**：
  - `npx vitest run tests/unit/summary-table-columns.test.ts tests/unit/summary-table-wiring.test.ts tests/unit/copy-batch-c.test.ts`
  - `npm run typecheck`、`npm run lint`
  - targeted：`npm run test:e2e:isolated -- tests/e2e/results-density.spec.ts`，以及其他受影響 spec（逐一列檔名與測試數）。

### P3a — Server：`col.*` 篩選、`columnOptions`、stats（不含排序變更）

- **修改**：
  - `web/src/contracts/student-query.ts`：`normalizeStudentQuery` 收 `col.*`，產出 `columns` 選擇；`queryIdentity` 納入。
  - `web/src/application/query-students.ts`：兩段式引擎（P-5）；`toStudentItem` 抽出，`getStudentCalculationDetail` 共用；stats 依 P-6。
  - `web/src/application/query-student-options.ts`：
    - 新增 `columnOptions`（R7、D46：每欄 scope＝語意前篩 ∩ 其他 `col.*` 條件，排除本欄）。
    - 既有 `options` 的計數另外再限縮到「通過全部 `col.*`」的人；未帶 `col.*` 時與現況逐位元相同。
  - `ALLOWED_RUN_QUERY_PARAMS` 的檢查要允許 `col.` 前綴（只放行 R6 的 columnKey）。
- **本 Phase 不改排序**。Ruling P-8：
  - 未帶 `sort`：JS 引擎依 personCode 的 UTF-8 位元組序分頁（P-5），cursor 仍是 v2 無排序形狀。
  - 帶 `sort`：沿用既有 SQL `ORDER BY`＋v2 keyset，只把 JS 篩出的最終集合以 `person_code IN (...)` 加進 SQL WHERE。
  - 理由：排序規則的變更集中在 P3b 一次交付，P3a 不寫會被丟棄的過渡比較邏輯。
- **測試**：新增 `web/tests/integration/column-filter-sort.test.ts`，涵蓋 UX130 (a)–(f)。
  - 合成 G13 run：P01…P13 與班A／班B／無報名。
  - review 三生：R1 `tier_mismatch=1`＋`CLASS_NOT_MAPPED`／`SCHEDULE_EMPTY`；R2 只有 `needsReview`；R3 無。
  - 入口：route handler `GET`（`src/app/api/v1/runs/[runId]/students/route.ts`）或 `queryRunStudents`／`queryStudentOptions`。
- **回歸**：下列測試**不改 expected**，全綠：
  - `filter-options-excel-style.test.ts`、`contextual-options.test.ts`、`multivalue-query-nocourse.test.ts`
  - `issue59-tier-mismatch-query.test.ts`、`results-page-stats-scope.test.ts`、`applicable-discount-boundary.test.ts`
  - `base-discount-default-10000.test.ts`、`issue-140-not-configured-reachability.test.ts`、`query-student-options-v4.test.ts`
- **callers／impact**（起點清單）：
  - `queryRunStudents` 直接 caller：route `GET`、`resolveResultsView`（`results-view.ts:33` ← `HomePage` `app/page.tsx:14`）、`scripts/bench.ts:39`、`scripts/perf-recompute-isolated.ts:50,82`。
  - 測試：`activate-run`、`backup-restore`、`base-discount-default-10000`、`erp-field-preservation`、`issue-140-not-configured-reachability`、`issue59-tier-mismatch-query`、`results-page-stats-scope`、`settings-preview-apply`、`t06-recovery`；間接 `api-runs`、`round4-fixtures`、`multivalue-query-nocourse`、`filter-options-excel-style`、`student-sort-keyset`。
  - `queryStudentOptions` ← route `GET`、`resolveResultsView`；測試 `applicable-discount-boundary`、`base-discount-default-10000`、`contextual-options`、`issue59-tier-mismatch-query`、`query-student-options-v4`。
  - `normalizeStudentQuery` ← `parseRunQuery`、`queryStudentOptions`／`legal`、`parseResultsState`（`results-state.ts:20`）、`parseImportQuery`（roster-query，不得改變其行為）。
  - `createStudentPredicateBuilder` ← `queryRunStudents`、`queryStudentOptions`。
- **驗收**：
  - `npx vitest run tests/integration/column-filter-sort.test.ts`，加上上列回歸檔
  - `npm run typecheck`、`npm run lint`、`npm run test`
  - `npm run test:perf:isolated`：現有五條路徑全部經過新引擎，揭露 p95；若 ≥ 200ms 依 P-5 送 [CLARIFY]。

### P3b — Server：排序與 cursor v3

- **修改**：
  - `query-students.ts`：`sort` 全面改走 application 層 `compareCells`，keyset 為 `(value, text, personCode)`，cursor 改 v3（P-4）。`sort` 欄位→columnKey 對照：`name→name`、`grade→grade`、`anqinDays`、`tutoringDays`、`baseDiscountBps→baseDiscount`、`subjectCount`。
  - `queryRunStudents` 不再呼叫 `buildSortSql`／v2 cursor。`student-sort.ts` 與 v2 cursor 只剩 `roster-query.ts` 使用，不刪除（out of scope）。
- **測試**：
  - `column-filter-sort.test.ts` 加 UX131 (a)(b)(c)(f)：G13 grade、N6 name、bps、A6 `4`／`4*額` 頁界，`limit=1/2/3` 逐頁串接，跨頁無重複無遺漏。
  - UX131 (d)：v2 cursor、`v:true`、`n`＋`v` 並存、缺 `t`、換 sort → 400 指名 `cursor`。
  - (e)：未帶 sort 與 `person_code ASC` 相同。
- **更新**：`web/tests/integration/student-sort-keyset.test.ts` 中 **runs 端點**的 `name` 碼點序與 `grade` 子句改依 UX131 手算（04 標示 UX127 (c) 已由 UX131 取代）。**imports 端點（roster-query）案例不改**。
- **E2E**：`web/tests/e2e/results-server-sort.spec.ts` 若斷言姓名碼點序或 `grade` null 最後，依新規則更新。
- **callers／impact**（起點清單）：
  - `decodeStudentCursor`／`encodeStudentCursor`／`buildSortSql` ← `queryRunStudents`（本 Phase 移除）、`queryImportStudents`（保留）。
  - `TEXT_SORT_FIELDS` ← `decodeStudentCursor`（v2，保留）。
- **驗收**：
  - `npx vitest run tests/integration/column-filter-sort.test.ts tests/integration/student-sort-keyset.test.ts`
  - `npm run test`、`npm run typecheck`、`npm run lint`
  - `npm run test:perf:isolated`（含 `sort-anqin-desc` 路徑，揭露 p95）
  - targeted `npm run test:e2e:isolated -- tests/e2e/results-server-sort.spec.ts`

### P4 — 學生總表 UI 改用 `col.*`

- **修改**：
  - `web/src/lib/results-filters.ts`：
    - `StudentFilters` 以 columnKey 為鍵；`readResultsUrl`／`buildResultsQuery`／`buildStudentApiParams` 改讀寫 `col.<key>`。
    - 舊語意參數一律移除，並加入 `pruned` 提示（09 URL bullet）。
    - `displayValue` 對學生欄＝顯示文字（`~blank`→「(空白)」）。
    - `pruneStudentFilters` 以 `columnOptions` 剪枝。
    - `exactlyOneClass` 改讀 `col.enrollment`（排除 `~blank`）。
    - 學生欄不再用 `compareOptionValues`，順序以 server 回傳為準。
    - `DEDUCTION_FILTER_FIELDS` 與其函式不動，屬 P5 範圍。
  - `web/src/lib/results-state.ts`：`dropApplicable`、`parseResultsState`（以 `col.*` 解析驗證取代 `normalizeStudentQuery` 的學生欄驗證）、`pruneResultsState`。
  - `web/src/application/results-view.ts`：SSR 以 `columnOptions` 剪枝；`invalid` 判定沿用。
  - `web/src/components/active-run-view.tsx`：
    - 選項來源改 `columnOptions`。
    - 需確認改為單一清單（移除「米豆奶天數比較／問題類型」兩分區，`sectionFor` 調整）。
    - `ensureApplicableOptions` 改帶 `col.*`。
  - `web/src/components/filters/header-filter.tsx`：只在必要時改；props 介面保持相容（P-7）。
- **測試**：
  - unit `tests/unit/results-filters.test.ts`：URL 讀寫、舊參數移除與提示、`~~` 跳脫、prune、chips。
  - E2E（UX132）更新：
    - `filter-options-excel-style.spec.ts`、`header-filter-panel.spec.ts`、`results-filter-scope.spec.ts`：這三檔以舊語意參數組網址，須改 `col.*`，並新增舊網址被移除＋提示的案例。
    - `results-server-sort.spec.ts`。
    - 文案 spec：`active-run.spec.ts`、`copy-d39.spec.ts`、`copy-scan.spec.ts`、`recovery-ui.spec.ts`，這些檔含「米豆奶天數比較／天數吻合／問題類型」字樣，逐一判斷是面板文案還是明細文案，只改面板相關的。
    - unit `copy-batch-c.test.ts`。
- **callers／impact**（起點清單）：
  - `displayValue` ← `pruneStudentFilters`、`chipsOf`、`dropApplicable`（`results-state.ts:12`）、`sectionFor`（`active-run-view.tsx:509`）。
  - `compareOptionValues` ← `sectionFor`。
  - `pruneStudentFilters` ← `pruneResultsState`、`results-filters.test.ts`。
  - `readResultsUrl` ← `parseResultsState`。
  - `buildStudentApiParams` ← `load`（`active-run-view.tsx:210`）、`ensureApplicableOptions`（`:257`）。
  - `parseResultsState`／`pruneResultsState` ← `ActiveRunView`、`resolveResultsView`。
  - `exactlyOneClass` ← `ActiveRunView`／`applyFilters`（`:324`）、`dropApplicable`、`pruneResultsState`、`pruneStudentFilters`。
  - `chipsOf`、`HeaderFilter` 另有 caller `ClassDeductionsPanel`，P4 不得改變其行為。
- **驗收**：
  - `npx vitest run tests/unit/results-filters.test.ts`、`npm run test`、`npm run typecheck`、`npm run lint`、`npm run build`
  - targeted E2E：上列每個 spec 用 `npm run test:e2e:isolated -- tests/e2e/<file>`，列檔名與測試數
  - **`npm run test:e2e:full`**（UI 行為變更，依 CLAUDE.md §8 記錄 exact HEAD／Node／Playwright／規格檔數／案例數）

### P5 — client 表共用模組（Lane B，P2 合併後可開始）

- **修改**：
  - `web/src/components/tables/column-def.ts`：client 排序設定改為 `{ cell: (row) => Cell }`，取代 `{ type, accessor }`；`{ server }` 變體不動。
  - `web/src/components/tables/use-client-sort.ts`：`sortRows` 改用 `compareCells`，同值保持輸入序，空白最後。`COLLATOR` 移除，改用模組的 `TEXT_COLLATOR`。
  - `web/src/components/results/class-deductions-panel.tsx`：
    - 班級、老師、狀態為 text cell；四個扣除欄的 value 為數值，text 為 `formatDeduction` 的輸出。
    - 表頭篩選選項改用 `buildColumnOptions`（「(空白)」最後）。
    - URL 鍵 `dClass`／`dTeacher`／`dStatus` 不變。
  - `web/src/components/imports/import-review-dialog.tsx`：年級欄用 `gradeCell`，顯示 `N年級`，空白「—」，不再是 `N 年級`／「未識別」。其他欄改為 cell。
  - `web/src/components/imports/roster-changes-details.tsx`、`web/src/components/settings/class-name-sync-panel.tsx`：accessor 改為 cell。
  - `import-preview.ts:77` 的年級分布標籤**不改**（R6 註）。
- **測試**：
  - `tests/unit/sort-rows.test.ts`：UX126 既有案例在新比較下仍成立的保留；(d) 中文 expected 依筆畫手算。
  - `tests/unit/table-columns.test.ts`：UX133 (a)，年級 A–F 升冪 D,B,E,F,A,C／降冪 A,F,E,B,D,C。
  - `tests/integration/class-deductions-panel.test.ts`：UX133 (b)，老師 `王一`、`吳一`、空白。
  - `tests/unit/imports-workflow-ui.test.ts`、`tests/unit/roster-changes-details-ui.test.ts`、`tests/unit/class-name-sync-panel.test.tsx`。
  - E2E：`class-deductions-two-sides.spec.ts`、`deductions-navigation.spec.ts`、`imports.spec.ts`、`roster-changes-details.spec.ts`、`class-name-sync.spec.ts`、`round3-mapping-candidates-sync.spec.ts`。
  - UX133 (c) 來源檢查：靜態 unit 掃描 `src/components/**` 不得出現 `new Intl.Collator(` 或 `localeCompare(`，只有 `lib/table-columns` 例外。若既有程式另有合法用途，於測試內明列例外清單與理由。
- **callers／impact**（起點清單）：
  - `useClientSort` ← `RosterChangesDetails`（`:133`）、`ClassNameSyncPanel`（`:52`）、`ClassDeductionsPanel`（`:123`）、`ImportReviewDialog`（`:47`）。
  - `sortRows` ← `apply`（`use-client-sort.ts:69`）、`sort-rows.test.ts`。
- **檔案柵欄**：見 P-7。
- **驗收**：
  - 上列 vitest 檔、`npm run test`、`npm run typecheck`、`npm run lint`、`npm run build`
  - targeted E2E（列檔名與測試數）
  - **`npm run test:e2e:full`**

### P6 — 效能閘門與收尾

- **修改**：
  - `web/scripts/perf-contract.ts` 的 `PERF_PATHS` 新增三條，`web/tests/perf/filter-api.spec.ts` 加相應斷言：
    - `col-filter`：`col.grade=1年級`＋`col.anqinDays=4`
    - `sort-name`：`sort=name&limit=50`
    - `options-columns`：`options=true`，斷言 `columnOptions.grade` 非空
  - 根目錄 `CLAUDE.md` §8：「四條 API 量測路徑加 D65 排序路徑共五條」改為實際條數與名稱。此為專案文件，與程式同一 PR；只改 §8 該句。
  - `specs/04-tdd-acceptance.md` 的 D66 說明段：改寫為實作進度（各 UX 由哪個 PR 交付）。
- **PR 描述**：`Closes #253`、`Closes #255`。
- **驗收**：
  - `npm run test:perf:isolated`：全部路徑單輪 p95 < 200ms，揭露每條數字、硬體、Node 與 Chromium 版本。
  - `npm run test:e2e:full`：最終 HEAD 證據。
  - 本 Phase 只有量測與文件、沒有產品行為變更，RED／GREEN 改為：新增的 perf 斷言先在 P5 後的 main 跑過一次並記錄，確認可量測。

## 4. 測試資料與規範

- 一律使用合成 fixture，不用真實學生資料（CLAUDE.md §3）。
- 姓名與老師名只用 04 列出的合成字串（`丁一`…）。
- 筆畫 expected 只用總筆畫數相異的字（03 R4）；不得以 `Intl.Collator` 的輸出生成 expected 陣列，必須寫死手算結果。
- E2E 遵守 `web/tests/e2e/CLAUDE.md`：`test:e2e:isolated` 為 targeted；full 只用 `test:e2e:full`；不得 skip、retry 或 rerun-to-green。

## 5. 風險與防護

| 風險 | 防護 |
|---|---|
| application 層全量建 item 使 p95 上升（每次請求對 ≤ 名冊人數的列 JSON.parse trace 並查 enrollments） | P3a／P3b 各跑 `test:perf:isolated` 並揭露；超標先 [CLARIFY]（P-5）；P6 新增 D66 專屬路徑 |
| 未帶 sort 的順序與 SQLite BINARY 不一致 | P-5 以 UTF-8 位元組比較；UX128／UX131 (e) 回歸 |
| ICU／CLDR 版本差異 | expected 只用相異筆畫字；測試輸出 `process.versions.icu`；client 與 server 各自 ICU，規則相同（03 R4） |
| 語意參數或既有 `options` 被意外改動（Agent 契約） | P3a 回歸清單不改 expected；未帶 `col.*` 時逐位元相同 |
| `roster-query.ts` 被波及 | v2 cursor 與 `buildSortSql` 保留；`student-sort-keyset.test.ts` 的 imports 案例不改 |
| P4／P5 同時改共用檔 | P-7 檔案柵欄；違反時改序列 |
| E2E 舊斷言（舊網址參數、兩分區、首個 issue） | P2／P4／P5 逐一列出並更新為新契約；不得 skip |

## 6. 開放事項

- 無阻擋事項。P3a 與 P3b 依 P-8 拆分；若 Implementer 判斷兩者無法獨立驗收，於 P3a RED 前以 [CLARIFY] 請 Coordinator 決定是否合併。
