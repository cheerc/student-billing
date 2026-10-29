# 17 班名同步（Class Name Sync）重構計畫

> 狀態：**計畫草稿（Plan）**，待 Coordinator／Operator 核可；尚未實作。
> 依據：2026-10-29 Operator 於 planner session 的直接需求（原文摘要見 §1.1）。
> 基準：`origin/main` @ `99b6bcb`（D61 Phase 3 已合併）。
> 本檔是**執行計畫**，不定義計費規則；契約變更於各 Phase 同步寫入 06（新決策列）、09 §3.3、04 §8。

---

## 1. 目標與依據

### 1.1 Operator 需求（2026-10-29）

1. 「課表設定」中「名單中有 N 個班級尚未加入課表設定」「班名對應」「班名比對報告」資訊重複，要**整個重構成一個好用的功能**。
2. 仍需比對「匯入學生」（米豆奶名冊）班名與系統（課表設定）班名的差異。
3. 仍需「加入課表設定」，讓使用者把名冊班名新增進課表時不必手動輸入太多資料。
4. 新增「同步班級名稱」：列出名冊中與系統不一樣的班名，選擇要和系統中哪一個班級合併；**合併後班名必須是名冊（米豆奶）的班名**——米豆奶是真實資料，系統能沿用就沿用。
5. 米豆奶也可能誤植，**不可自動覆蓋**；同步需人工確認。
6. 「加入課表設定」應整合進「同步班級名稱」。
7. 預期結果：功能完成後，既有課表設定（目前靠「班名對應」別名連到名冊的班）會**全部被判定為班名不一致**，由使用者逐一同步。

### 1.2 現況盤點（重複點，皆已讀碼核實）

同一份「名冊有／系統無」清單（`report.rosterOnly`）目前在 4 處以 3 種形狀出現：

| # | 位置 | 元件／來源 | 內容 |
|---|---|---|---|
| A | 課表頁籤 | `web/src/components/settings/schedule-grid.tsx:485-540`（`rosterOnlyClasses` → `<details>`「名單中有 N 個班級尚未加入課表設定」） | 名冊班名表＋［加入課表設定］（開一般新增表單） |
| B | 班名對應頁籤上半 | `web/src/components/settings/class-name-report-panel.tsx`（`ClassNameReportPanel`） | 「米豆奶有／系統無」「系統有／本次名冊無」兩表並排＋別名不對稱說明 |
| C | 班名對應頁籤下半 | `web/src/components/settings/mapping-panel.tsx`（`MappingPanel` 的「待確認米豆奶班名」表） | **同一份 rosterOnly** 再列一次，可輸入目標班名、勾選建立 alias |
| D | 匯入預覽 | `web/src/components/imports/imports-workflow.tsx:395-404`（「本次匯入名冊中發現 N 個班名待確認」alert）＋`class-name-report-summary.tsx` 摘要卡 | 兩段文字描述同一件事 |
| E | 核對結果頁 | `web/src/components/active-run-view.tsx:681-687` | 「前往課表設定，確認班名對應」 |

資料來源：`web/src/application/class-name-match-report.ts`（`getClassNameMatchReport`，以 `classifyErpDualTrack` 判定，**別名覆蓋者算已對應**）、`web/src/application/pending-classes.ts`（匯入預覽同源判斷）、route `web/src/app/api/v1/settings/class-name-report/route.ts`（7 條 Web 路由之一，D60-6）。

既有可重用機制：
- 課表編輯器以 `rowId` 追蹤班名變化：`detectClassLifecycle`（`web/src/domain/classification/class-attributes.ts:168`）辨識整班改名；`carryAttributesOnRename`（同檔 :240）把課程類型／多科折扣／類別／固定 5 天帶到新名（併入 baseline 既有班時以目標班為準，UX72）。→ **「同步」在草稿層就是「整班改名」**，不需新的持久化模型。
- 儲存走既有 preview → `ImpactDialog` → apply 交易（D60 單一現況、03 §4 交易不變式），報告儲存後刷新／重試／鎖定機制在 `settings-editor.tsx:171-410`（UX46）。
- 計算端別名解析：`draftToAliasMap`（`web/src/adapters/sqlite/settings-repository.ts:198`）供 `apply-settings.ts`、`calculate-run.ts`、`roster-changes.ts`、`schedule-deductions.ts`、`roster-query.ts` 使用。

### 1.3 範圍

**In scope**
- 新 read model：以**名稱完全相同**判定一致；經別名才連上的視為「不一致（有舊對應）」。
- 單一「班名同步」頁籤（取代「班名對應」）：一張差異表，每列兩個動作——［同步到既有班級］／［新增為課表班級］，支援勾選批次同步「有舊對應建議」的列。
- 同步＝草稿中把系統班整班改名為米豆奶班名＋清理相關別名；經既有影響預覽與儲存交易落地。
- 移除重複呈現 A、B、C；D、E 收斂為一行摘要＋連結至「班名同步」。
- 修正改名時屬性搬移的潛在缺口（見 §5 R2），並以測試鎖定「同步不改變計費結果」。
- 同步更新 06（新決策列）、09 §3.3、04 §8 相關 UX 列。

**Out of scope（不做）**
- 不直接寫入／修改米豆奶或名冊資料；不以米豆奶覆蓋系統任何欄位（D17、需求 5）。
- 不做模糊比對或自動建議（D32-C、CLAUDE.md 別名政策）；唯一的預選來源是**使用者過去建立的別名**（人類決定，非推測）。
- 不改計費規則（02）、不改 run 快照與 11 條 API 的路由清單（D60-6）。
- 不移除計算端別名支援、不寫 migration 刪除既有 alias 資料（見 §6 Q1）。
- 不新增「以既有班級為範本複製時段」功能（見 §6 Q3）。

---

## 2. 產品設計（UI/UX）

> 視覺沿用 `web/src/app/globals.css` 既有 token 與元件（`.card`、`.toolbar`、`.data-table`、`.pill`、`.tabs`、`YesNoRadioGroup`），不另立色票。

### 2.1 資訊架構

```
課表設定
 ├─ [課表]（預設）— 頂端若有不一致：單行橫幅
 │     「名冊有 N 個班名與課表不一致（其中 M 個尚未對應，影響 K 位學生）  前往班名同步 →」
 └─ [班名同步 (N)]
       ├─ 摘要列：名冊 X 個班名 · 一致 Y · 不一致 N（未對應 M，影響 K 位學生）
       ├─ 差異表（主體，一張）
       └─ 「課表有、本次名冊沒有的班級 (S)」<details> 預設收合（參考用；也是同步目標來源）
匯入預覽：一張摘要卡（取代 alert＋卡片兩段），連到 /settings?tab=sync&import=<id>
核對結果：沿用待設定班級提示，連結文字改「前往班名同步」
```

### 2.2 差異表（每列＝一個名冊有、課表沒有同名班的米豆奶班名）

| 欄 | 內容 |
|---|---|
| ☐ | 只有「有舊對應」的列可勾（批次同步用） |
| 米豆奶班名 | 名冊原文 baseName，粗體 |
| 學生 | `N 位（M 筆）` |
| 現況 | `pill warn`「未對應課表」（計費會出 `CLASS_NOT_MAPPED`）／`pill`「經舊對應連到「X」」（計費已正確，只是名稱不同） |
| 動作 | ［同步到既有班級］［新增為課表班級］；已暫存者改顯示「已暫存：X → Y（未儲存）」＋［復原］ |

排序：未對應優先，其次學生數多者優先，再依班名。

**［同步到既有班級］**（列內展開，不開 modal，避免脫離上下文）：
- 下拉：候選＝課表中「本次名冊沒有同名報名」的班（`systemOnly`），依課程類型分組（安親課輔班／美語班／數學班／其他班／不排課），每項顯示班名、時段數、已停用標記；有舊對應時**預選**該舊對應目標並標示「（舊對應）」，否則留空（D32-C）。
- 已被本草稿其他列選走的班不可再選。
- 確認區以文字寫明後果：「課表班級「X」將改名為「Y」，X 的 N 個時段、課程類型與折扣設定一併沿用」；若另有米豆奶班名 Z 也經舊對應連到 X，加一行警示「「Z」目前也經舊對應連到 X，同步後 Z 會變成未對應」。
- ［暫存同步］只改草稿（dirty），真正寫入仍需底部［確認變更］→ ImpactDialog（人工確認兩段）。

**［新增為課表班級］**（列內展開迷你表單，取代舊的「開一般新增表單」）：
- 班名唯讀＝米豆奶班名（不讓使用者打字，避免再造出不一致）。
- 只問一題：課程類型（五選一 radio，D61 順序）。其餘依類型預設：多科折扣（美語／數學預設「是」）、固定 5 天「否」、不計扣天（其他班預設「是」）；類別維持既有 `initialCategory: 'unset'` 行為（UX95）。
- 排課類型自動建立一列「星期未定、時間未填」→ 觸發既有 1c 待補時間警示（UX108），允許先存檔。
- 暫存後列上提供「到課表填時段 →」（切到課表頁籤並以 `focusClass` 定位）。

**批次**：勾選後出現動作列「同步已勾選的 N 個班名到其舊對應」；只適用有舊對應的列（其目標已由人過去決定），仍經 ImpactDialog。

**ImpactDialog**：新增「班名同步」區塊列出本次 `X → Y` 改名與新增班級（由 `classLifecycle.renames/news` 推得，純前端）。

### 2.3 狀態與無障礙
- 沿用 UX46 的報告刷新序列：重新取得中顯示「更新中…」、差異表鎖定；失敗→［重新載入］→［重新整理頁面］。
- 無名單：沿用現有空狀態文案，改為「匯入名單後，可在這裡同步班名」。
- 列內展開以 `aria-expanded`／`aria-controls` 連結；下拉有可見 label；pill 不只靠顏色（有文字）；動作按鈕 ≥ 既有按鈕尺寸；窄螢幕（≤720px）表格改卡片列（沿用 `.table-scroll-container` 或既有 responsive 規則，見 `tests/e2e/responsive.spec.ts`）。
- 成功暫存給 toast（既有 `showToast`）：「已暫存：X → Y，按『確認變更』後生效」。

---

## 3. 契約（Proposed）

### 3.1 Read model `ClassNameSyncReport`（取代 `ClassNameMatchReport`，同檔演進）

```ts
interface ClassNameSyncReport {
  importId: string;
  scope: ClassNameReportScope;               // 保留 latest / run
  snapshotStatus: 'ok' | 'unavailable';
  rosterClassCount: number | null;           // 名冊不重複班名數
  exactMatchCount: number | null;            // 名稱完全相同
  mismatches: Array<{                        // 名冊有、課表無同名
    erpBaseName: string;
    students: number; tokens: number;
    legacyAliasTarget: string | null;        // 舊別名指向且該班存在於課表；否則 null
  }> | null;
  unmappedStudents: number | null;           // legacyAliasTarget=null 的列涵蓋之不重複學生數（=計費受影響者）
  systemOnly: Array<{                        // 課表有、名冊無同名報名＝同步目標候選
    baseName: string; active: boolean;
    classType: ClassType;                    // 用於分組
    sessionCount: number;
    legacyAliasFrom: string[];               // 本名冊中經舊別名連到此班的米豆奶班名
  }> | null;
}
```

- **一致的定義改為嚴格同名**（需求 7）。計算端仍照舊解析別名——「不一致（有舊對應）」不影響計費，只影響本報告。
- `summarizeClassNameReport` 產出：`mismatchCount`、`unmappedCount`、`unmappedStudents`、`reportPath=/settings?tab=sync&import=<id>`。
- route `GET /api/v1/settings/class-name-report` **路徑與查詢參數不變**（不動 D60-6 的 11 條路由），僅回應形狀改變；唯一 client 是本專案 UI（`settings-editor.tsx`、`imports/preview/route.ts`），已以 `grep -rn "class-name-report" web/scripts` 確認 scripts 無呼叫（2026-10-29，`99b6bcb`）。

### 3.2 草稿轉換 `stageClassNameSync`（新純函式，建議置於 `web/src/domain/schedules/class-name-sync.ts`）

```ts
stageClassNameSync(
  state: { rows: ScheduleGridRow[]; aliases: AliasMapping[] },
  op: { erpBaseName: string; systemBaseName: string }
): { rows; aliases; orphanedAliasRaws: string[] }
```
- 把 `className.trim() === systemBaseName` 的**所有列**改成 `erpBaseName`（保留 rowId → 既有 lifecycle 判為整班改名）。
- 移除 `rawBaseName === erpBaseName` 的別名；移除 `targetBaseName === systemBaseName` 的別名並回傳其 raw（UI 警示用）。
- 前置拒絕（throw 或回傳錯誤碼，由實作者選一並寫測試）：`erpBaseName` 已存在於 rows；`systemBaseName` 不存在；兩者相同。
- `stageNewClassFromRoster(rows, { erpBaseName, classType })`：產生一列預設值；排課類型時段留空。屬性仍走既有 `onAddRow` 選項路徑。

---

## 4. Phase / PR 拆分（1 Phase = 1 PR）

> 每個行為變更都要 **RED commit（只含失敗測試）→ GREEN commit（實作）** 兩個 commit；RED 需在改動前的 HEAD 跑出預期的行為性失敗並在 PR 描述附上輸出。
> 命令皆於 `web/` 執行。新 worktree 先確認 `node_modules`（`cp -Rc` 或 `npm ci`，不得 symlink），並確認 `npx tsc -v`／`npx vitest --version` 輸出正確。
> 審查等級：P1 觸及計費不變式驗證 → 建議 **dual**（Ruling R-3）；P2、P3 為 UI／文件 → single。

### P1 — Read model、同步純函式與「同步不改計費」不變式（後端／domain）

**交付**
1. `class-name-match-report.ts`：改為 §3.1 形狀，嚴格同名判定；`legacyAliasTarget` 只在目標班存在於該設定時給值；`systemOnly` 附 `classType`、`sessionCount`、`legacyAliasFrom`。`summarizeClassNameReport` 同步改。
2. `pending-classes.ts`／`imports/preview/route.ts`：匯入預覽的「待確認」改用同一 read model 的 `mismatches`（消除兩條判定路徑）；`pendingClasses` 回應欄位的去留——先 `grep` 03 §API 與所有 consumer，若僅 `imports-workflow.tsx` 使用，在 P3 移除 UI 時一併移除，P1 先保持值語意不變（Ruling R-5）。
3. 新增 `domain/schedules/class-name-sync.ts`（§3.2）。
4. 修補 `carryAttributesOnRename`：`from` 不在 `manualAttrs`／baseline map 時目前直接 `continue`（`class-attributes.ts:249-250`），新名會以 `resolveClassAttributes(to)` 重新解析而**遺失課程類型**。改為以 `resolveClassAttributes(from, 已儲存設定)` 作為來源後再搬移（實作者先寫 RED 確認可達性：以 baseline 中無 classType 的已存班改名；若證實不可達，於 PR 記錄實驗並改為守門測試，不改碼）。
5. 06 新增決策列（建議編號 D62，**待 Operator 確認文字**）記錄 §1.1 需求與 R-1～R-6 Ruling；03 §5.2.4 報告契約改寫。

**測試（RED 先行；預期值依規格手算，不得取函式輸出當 golden）**
- `tests/integration/d1-class-name-match-report.test.ts`（改寫或新增 `class-name-sync-report.test.ts`）：
  - 名冊 {甲, 乙, 丙}、課表 {甲, X, W}、別名 乙→X → `exactMatchCount=1`、`mismatches=[乙(legacy X), 丙(null)]`、`systemOnly=[X(legacyAliasFrom=[乙]), W([])]`、`unmappedStudents`＝丙的不重複學生數。
  - 別名目標不在課表 → `legacyAliasTarget=null`。
  - 同一學生報名乙、丙 → `unmappedStudents` 跨班去重只算丙的學生。
  - run 範圍／快照缺失 → `unavailable` 且清單為 null（保留既有 UX44 行為）。
- `tests/integration/d1-class-name-report-api.test.ts`：回應形狀、查詢參數白名單不變、400/404 不變。
- `tests/unit/class-name-sync.test.ts`：多列整班改名、rowId 保留、別名清理與 `orphanedAliasRaws`、三種前置拒絕。
- `tests/unit/d2b-class-attributes.test.ts`（或新增）：seed 班（`categorySource='seed'`）同步成非 seed 名後 classType／多科折扣／category 保留且 source→`manual`；其他班改名後 `skipDeduction` 仍為 true（`billing-calculator.ts:144` 依班名的 seed 預設不得被觸發——須確認儲存後時段帶明確 `skipDeduction`）。
- **計費不變式（核心）** `tests/integration/class-name-sync-billing-invariance.test.ts`：合成 fixture（保留 inlineStr 原形 fixture 規範），課表 X＋別名 乙→X → 計算 run A；對草稿套 `stageClassNameSync(乙, X)` 後走 settings preview/apply → run B；斷言**每位學生**的安親／課輔天數、適用折扣、級距比對、issues（除名稱字串外）A=B，且乙的學生在 B 不再經別名解析。另一案：存在 丁→X 別名時，丁的學生在 B 變為 `CLASS_NOT_MAPPED`（預期的、會在 ImpactDialog 顯示的變化）。

**驗證命令**
```bash
cd web
npx vitest run tests/integration/class-name-sync-report.test.ts tests/integration/d1-class-name-report-api.test.ts tests/unit/class-name-sync.test.ts tests/integration/class-name-sync-billing-invariance.test.ts tests/integration/pending-classes.test.ts tests/integration/unmapped-classes.test.ts tests/integration/candidate-aliases.test.ts
npm run typecheck && npm run lint
```
（全量 `npm test` 由 CI 跑；`grep -rln "ClassNameMatchReport\|rosterOnly\|aliasCoveredBy" tests src` 必須只剩 P2 會處理的 UI 檔，PR 描述附清單。）

**P1 驗收**：read model／API 新形狀可用；舊 UI 在 P1 期間以適配層維持可用（P1 內讓 `settings-editor.tsx` 與兩個 panel 讀新欄位，`rosterOnly` 由 `mismatches` 投影），既有 E2E 不因 P1 變紅——若無法保持，P1 與 P2 合併為同一 PR 並於描述說明（Ruling R-6）。

### P2 — 「班名同步」頁籤 UI（取代 B、C、A）

**交付**
1. 新元件 `web/src/components/settings/class-name-sync-panel.tsx`（§2.2）；刪除 `class-name-report-panel.tsx`、`mapping-panel.tsx`（及其 CSS：`globals.css` 中 `.class-name-report*`、`.mapping-*` 未再使用者）。
2. `settings-editor.tsx`：頁籤 `'mapping'` → `'sync'`，標籤「班名同步 (N)」；移除 `candidateTargets`／`handleToggleAlias`／`handleUpdateCandidateTarget`／`candidates`（`buildDynamicCandidates` 若再無 consumer，一併移除並刪 `tests/unit/dynamic-candidates.test.ts`）；新增 `handleStageSync`／`handleStageNewClass`／`handleUndoStaged` 呼叫 P1 純函式；報告刷新序列保留並改鎖定差異表。
3. `app/settings/page.tsx`：`?tab=sync`；`?tab=mapping` 視為 `sync`（舊連結相容）；移除 `classifyErpDualTrack`／`candidates` 的 SSR 計算。
4. `schedule-grid.tsx`：刪除 roster-only `<details>` 表與 `pendingRosterOnlyClass` 路徑，改為 §2.1 單行橫幅（`onGoToSync` callback）。
5. `impact-dialog.tsx`：新增「班名同步」區塊（renames／news）。
6. 09 §3.3 改寫為「班名同步」；04 §8 改寫 UX46、UX70、UX95、UX109 並新增 UX110～（同步／新增／批次／橫幅／舊連結相容），刪除不再成立的「待確認米豆奶班名」敘述（以 `grep -rn "待確認米豆奶班名\|班名對應" specs CLAUDE.md` 反向掃描，見 memory「PR 廢除行為時要反向掃描全 repo」）。

**測試（RED 先行）**
- Unit（`tests/unit/class-name-sync-panel.test.tsx` 或沿用 `settings-schedule-grid-ui.test.ts` 的 render 方式）：
  - 報告含 乙(legacy X)、丙(null) → 兩列；乙列可勾、丙列不可勾；乙的同步下拉預選 X 並標「（舊對應）」，丙的下拉為空。
  - 選 X 暫存 → 列顯示「已暫存：X → 乙」、isDirty=true、X 從其他列候選消失；［復原］→ 回原狀且非 dirty。
  - 丁→X 也存在 → 確認區顯示丁的警示文字。
  - ［新增為課表班級］選「不排課」→ rows 新增一班、名稱=丙、無時段；選「美語班」→ 一列星期未定、1c 警示類別成立。
  - 報告刷新中 → 所有動作 disabled。
- 改寫：`tests/unit/settings-editor-candidates-sync.test.ts`、`tests/unit/settings-ux-dirty-candidates.test.ts`、`tests/unit/settings-schedule-grid-ui.test.ts`（roster-only 段落改為橫幅）。
- E2E（目標檔，`npm run test:e2e:isolated -- <file>` 逐檔）：
  - 新 `tests/e2e/class-name-sync.spec.ts`：上傳合成名冊 → 班名同步頁看到不一致 → 同步乙到 X → 確認變更 → ImpactDialog 列出「X → 乙」→ 儲存 → 重載後乙不在差異表、課表有「乙」班且時段同 X、核對結果頁乙的學生天數與同步前相同。
  - 同檔：新增「交通車」為不排課 → 儲存 → 退出差異表、核對結果無 `CLASS_NOT_MAPPED`（取代 UX109 舊旅程）。
  - 同檔：`/settings?tab=mapping` 開到班名同步頁籤。
  - 改寫或刪除：`class-name-report.spec.ts`、`issue-157-pr2-roster-settings.spec.ts`、`round3-mapping-candidates-sync.spec.ts`、`report-refresh-recovery.spec.ts`；檢查並更新選擇器：`a11y.spec.ts`、`responsive.spec.ts`、`copy-scan.spec.ts`、`copy-d39.spec.ts`、`d2b-class-category.spec.ts`、`settings-preview-apply.spec.ts`、`cancel-calculate-race.spec.ts`、`recovery-ui.spec.ts`（以 `grep -ln "班名對應\|tab=mapping\|mapping-table\|roster-only\|class-name-report" tests/e2e` 為準）。刪除／新增 spec 前先讀 `web/tests/e2e/CLAUDE.md`。

**驗證命令**
```bash
cd web
npx vitest run tests/unit/class-name-sync-panel.test.tsx tests/unit/settings-editor-candidates-sync.test.ts tests/unit/settings-ux-dirty-candidates.test.ts tests/unit/settings-schedule-grid-ui.test.ts
npm run typecheck && npm run lint
npm run test:e2e:isolated -- tests/e2e/class-name-sync.spec.ts
# 另逐檔跑上列每個被改寫的 E2E spec，PR 描述列「檔名／測試數／結果」；
# 合併前由 Coordinator 決定是否跑 npm run test:e2e:full（唯一 full 入口）。
```

### P3 — 入口收斂與文案（D、E）

**交付**
1. `imports-workflow.tsx`：刪除「本次匯入名冊中發現 N 個班名待確認…」alert；`class-name-report-summary.tsx` 改為單卡「名冊有 N 個班名與課表不一致（其中 M 個尚未對應，影響 K 位學生）」＋「前往班名同步 →」。`pendingClasses` 欄位依 P1 Ruling 處理。
2. `active-run-view.tsx:687` 連結改 `/settings?tab=sync`、文字「前往班名同步」；`lib/issue-copy.ts:23,27` 文案改用「班名同步」。
3. 04 UX47 改寫；`copy-scan`／`copy-d39` 的禁用詞或期望文案同步。CLAUDE.md 若有「班名對應」使用者面詞彙（目前 §1 提「別名映射 (Alias) 維護」），依 project-docs-maintain 更新一句。

**測試**：`tests/e2e/imports.spec.ts`（摘要卡數字：依合成 fixture **手動盤點**後填入，不得由函式輸出反推；現 UX47 錨點為 12 班／191 位為舊「別名算已對應」口徑，嚴格同名後需重新盤點）、`copy-scan.spec.ts`、`copy-d39.spec.ts`；unit：`issue-copy` 若有測試一併。

---

## 5. 風險與回歸防護

| # | 風險 | 防護 |
|---|---|---|
| R1 | 同步改名改變計費（班名是計費鍵，`run_class_categories` 以名冊班名為 key） | P1 計費不變式整合測試（逐學生比對）；ImpactDialog 照實顯示受影響學生 |
| R2 | 改名時屬性遺失（`carryAttributesOnRename` 的 `continue` 分支）或觸發依班名的 seed 預設（`billing-calculator.ts:144`、`contracts/settings.ts:259`、`schedule-grid.tsx:130`） | P1 第 4 項 RED 測試；儲存後時段必帶明確 `skipDeduction` |
| R3 | 全部舊別名班一次變「不一致」，使用者面對大量列 | 摘要分「未對應（影響計費）」與「有舊對應（僅名稱）」；批次同步舊對應；未對應排前 |
| R4 | 刪別名導致其他米豆奶班名 Z 失去對應 | 確認區事前警示；ImpactDialog 事後顯示 |
| R5 | 米豆奶誤植被同步進課表 | 同步永遠需人工選目標＋兩段確認；不做自動／模糊建議；同步前可［復原］，儲存後可再改名（既有改名流程） |
| R6 | 舊連結 `?tab=mapping` 失效 | 相容映射＋E2E |
| R7 | 報告過期仍可操作 | 沿用 UX46 鎖定序列，差異表與批次列都鎖 |
| R8 | 11 條 API 契約漂移 | 路徑與查詢參數不變，只改回應形狀；03 同步更新 |

Rollback：每個 Phase 獨立 squash commit，可單獨 revert；無 migration、無資料寫入格式變更（草稿 `classes`／`aliases` 結構不變）。

---

## 6. Rulings 與待決事項

**Rulings（Planner 自主裁決）**
- R-1：同步＝草稿層整班改名，沿用既有 preview/apply 交易，不新增 API 或資料表 — 既有 rowId lifecycle 已支援，最小變更且保留人工兩段確認。
- R-2：「一致」改採嚴格同名；計算端別名解析不變 — 滿足需求 7，又不在 UI 重構中改計費。
- R-3：P1 審查等級建議 dual — 雖非 T03/T04 計算核心，但改名直接觸及計費鍵，由 Coordinator 最終決定。
- R-4：舊別名目標可作預選，其餘留空 — 舊別名是過去的人工決定，不違反 D32-C 禁止模糊建議。
- R-5：route 路徑不變、只改形狀；`pendingClasses` 欄位待 consumer 盤點後於 P3 處理 — 不動 D60-6 路由數。
- R-6：P1 須讓舊 UI 仍綠；做不到則 P1+P2 合併並說明 — 避免 main 出現壞掉的中間態。
- R-7：計畫檔編號 17 — CLAUDE.md 引用的 `specs/15-*`、`specs/16-*` 在 `origin/main` 不存在（`git ls-files specs` 僅有 14），為避免撞號保留 15／16。此缺檔另行回報，不在本計畫修。

**待 Operator 決定（不擋 P1；擋對應項目）**
- Q1：UI 不再提供「建立新別名」。米豆奶班名若確定誤植、但又不想把課表改成錯字時，目前只剩「維持不一致（計費會 CLASS_NOT_MAPPED）」。是否需要保留「暫時對應（不改名）」逃生口？**預設：不保留**（需求 4 明說合併後必須是米豆奶班名）。
- Q2：所有舊別名同步完後，是否另案移除計算端別名支援與資料（migration）？**預設：另案，本計畫不做。**
- Q3：「新增為課表班級」是否需要「以既有班級為範本複製時段」？**預設：不做**，先觀察使用量。
- Q4：06 新決策列編號與措辭（建議 D62）由 Operator 確認。
