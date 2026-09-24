# P1 三處漂移修正實作計畫 (P1 Drift Fix Implementation Plan)

**Source of truth:** `specs/01-product-spec.md §4.3`、`specs/02-calculation-rules.md §2–§3`、`specs/03-architecture-api.md §3–§5`、`specs/04-tdd-acceptance.md I19`、`specs/06-handoff-decisions.md D15/D18/D22/D25–D27`、仲裁決策 `d-20260924031135053252-2`。  
**Goal:** 依仲裁決策落實 P1 三處漂移修正：D1 班級設定採 S 表五欄平鋪時段列模型與 CAS 鏈路；D2 沿用 D18 具名候選模式補齊 D22 三組漂移；D3 班級全文按 token_index 升冪重組呈現、分校換行集合篩選與列表脫敏，確保全功能無 runtime 回歸。  
**Architecture:** 設定層將班級與時段對齊 Excel S 表 R4:E96 平鋪形式，初始草稿攜帶 seed 全量 89 筆時段列以消除空 sessions 雙義性；別名對應維持 human-in-the-loop 人工逐項確認；匯入與查詢層維持原始字元保真，以 token 重組還原班級全文，透過分校維表實現精確集合篩選並保護 PII 脫敏。  
**Tech stack:** TypeScript 5, Next.js 15 (App Router), React 19, better-sqlite3, ExcelJS, Zod, Vitest。

## Global Constraints

- **僅作未來實作規劃**：本 plan 文件僅定義未來的 tasks 規格，本 PR 嚴格不修改任何 `web/` 下之 runtime code、migration 或測試。
- **繁體中文**：所有介面文字、錯誤訊息、規格描述皆採繁體中文。
- **無 classId 主鍵前不做更名**：P1 暫緩更名，以「停用舊班＋新增新班」替代。
- **停用不硬刪**：砍除物理硬刪除，一律採軟停用（`active = false`），保留歷史。
- **不改既有核心算法**：R01–R18 衝堂與折扣數值計算維持原樣，`tagsRaw.includes(...)` 不改。
- **零 PII 洩漏**：列表 API 脫敏，測試與驗證嚴格使用匿名代號或列號指涉。

## Evidence and Open Hypotheses

- **Established (已驗證事實)**：
  - S 表 `(需要時修改)上課時間設定表-v250922` R4:E96 共有 89 筆排課列，涵蓋 49 個班級；F–K 欄全為公式（ExcelJS type 6 FORMULA），由計算引擎內部處理；星期實測僅「六」單日填寫（其餘為一~五）；帶班老師有 2 列空白（來源：`schedule-seed-reader.ts` 與私有 Excel 檢驗）。
  - ERP 學生檔（Sheet1 A1:I478）：分校複值 450/477、聯絡方式複值 426/477、標籤複值 82/477，全以 `\n` 換行符分隔；226 列非空標籤中 12 種相異標籤行均無內部空白；`calculate-run` 領域層已按 `token_index` 升冪排序列舉報名（來源：`erp-reader.ts`、`runs-repository.ts` 與私有 Excel 檢驗）。
  - I19 基準錨點：全科別 54 個 baseName、42 個精確相等自動候選、12 個待設定、seed 側 7 個本批未出現班級（來源：`specs/04-tdd-acceptance.md I19`）。
- **Unproven (待驗證假設)**：無（所有關鍵邊界與資料形狀皆已由私有來源及既有測試探勘核實）。

## Documentation Impact Check

- **docs-check:** `arch=Y adr=Y area=Y` — 規格文件 `specs/01`、`02`、`03`、`04`、`06` 均已配合仲裁決策同步修訂完成；本 `specs/08-drift-fix-plan.md` 為對應之落地執行計畫。

---

## File and Dependency Map

### 影響與建立檔案清單
- **合約與領域型別**：
  - Modify: `web/src/contracts/settings.ts`（擴充平鋪時段列型別、草稿結構與驗證）
  - Modify: `web/src/domain/students/types.ts`（確認 StudentSnapshot 與分校陣列型別）
- **儲存庫與應用層**：
  - Modify: `web/src/adapters/sqlite/settings-repository.ts`（初始草稿攜 seed 全量 89 筆時段、平鋪轉換管線、TTL 檢驗）
  - Modify: `web/src/application/settings-preview.ts`（預覽僅跑 formal 軌、TTL 驗證、回傳前後天數差異）
  - Modify: `web/src/adapters/sqlite/runs-repository.ts`（班級全文依 token_index 重組呈現、分校集合篩選 SQL）
- **UI 與元件層**：
  - Modify: `web/src/components/settings-editor.tsx`（改為 S 表五欄平鋪表格、新增時段、停用按鈕、具名候選核取清單）
  - Modify: `web/src/app/settings/page.tsx`（載入 89 筆全量平鋪草稿、載入 D18 與 D22 具名候選清單）
  - Modify: `web/src/app/page.tsx`（分校多值篩選器、列表脫敏、明細抽屜展示）
- **測試清單**：
  - Create: `web/tests/unit/settings-grid-model.test.ts`（S表平鋪列增刪改、起迄驗證與全量 seed 測試）
  - Modify: `web/tests/integration/settings-preview.test.ts`（預覽 TTL、formal-only、409 CAS 衝突）
  - Modify: `web/tests/integration/candidate-aliases.test.ts`（D18 ＋ D22 具名候選確認與 I19 54/42/12/7 錨點測試）
  - Modify: `web/tests/integration/erp-field-preservation.test.ts`（班級全文重組、分校集合篩選、列表脫敏測試）

### 依賴順序
1. **Task 1 & Task 2 (D1 平鋪排課與預覽鏈路)**：基礎資料模型，優先建立。
2. **Task 3 (D2 具名候選與雙軌視圖)**：依賴 D1 之草稿設定與 alias 結構。
3. **Task 4 & Task 5 (D3 原值重組與分校篩選)**：依賴匯入快照與查詢 API。
4. **Task 6 (整合與 Parity 驗證)**：端到端整合驗證。

---

## Task Shape（未來實作工作拆解）

### Task 1: D1 班級平鋪排課設定列模型（後端合約、初始草稿與前端五欄表格）

**Files:**
- Modify: `web/src/contracts/settings.ts:1-55`
- Modify: `web/src/adapters/sqlite/settings-repository.ts:130-175`
- Modify: `web/src/components/settings-editor.tsx:1-350`
- Modify: `web/src/app/settings/page.tsx:1-95`
- Test: `web/tests/unit/settings-grid-model.test.ts`

**Interfaces:**
- Consumes: `ScheduleSeedManifest` 中的 89 筆 S 表排課列資料。
- Produces: `SettingsDraft` 包含平鋪之 `classes` 與 `sessions`，初始狀態攜帶全量 seed，徹底消除空 sessions 雙義性。

**Acceptance:**
- 設定頁表格以五欄（班級名稱、帶班老師、星期、上課時間(起)、上課時間(迄)）平鋪展示 89 筆排課列。
- Gino 班呈現為 3 筆獨立列（週一、週三、週五）；星期欄位為唯讀展示。
- 支援為班級新增時段列、修改起迄時間、修改帶班老師。
- 起大於等於迄（如 `17:00 ~ 15:00`）時顯示紅框驗證錯誤並阻擋提交。
- 刪除按鈕一律執行軟停用（`active = false`），不執行物理硬刪除；暫緩班級更名功能。

**Test-first evidence:**
- Failing case: 傳入起時間晚於迄時間之草稿，驗證應失敗拒絕。
- RED: `npx vitest run web/tests/unit/settings-grid-model.test.ts` → `ValidationError: endMinutes must be greater than startMinutes`.
- Minimal behavior: 在 `contracts/settings.ts` 中以 Zod 定義平鋪時段列檢驗，在 `settings-repository.ts` 實作初始草稿攜帶全量 89 筆時段，在 `settings-editor.tsx` 渲染五欄平鋪表格。
- GREEN: `npx vitest run web/tests/unit/settings-grid-model.test.ts` → `8 passed`.
- Project verification: `npm --prefix web run build` → 通過編譯。

---

### Task 2: D1 排課預覽 TTL、formal-only 執行與隨機冪等鍵後綴

**Files:**
- Modify: `web/src/contracts/settings.ts`
- Modify: `web/src/application/settings-preview.ts:90-150`
- Modify: `web/src/adapters/sqlite/settings-repository.ts:80-125`
- Modify: `web/src/components/settings-editor.tsx:100-145`
- Test: `web/tests/integration/settings-preview.test.ts`

**Interfaces:**
- Consumes: `SettingsPreviewRequest` 帶 `draft` 與 `expectedRevision`。
- Produces: `SettingsPreviewResult` 帶 `previewId`、`inputHash` 與 `expiresAt`（TTL 限制，預設 15 分鐘）；套用請求帶 `idempotencyKey`（隨機後綴）。

**Acceptance:**
- 預覽計算僅執行正式軌 `erp-tag-v1`，不跑 `excel-v260922-compat` 診斷軌，大幅提升計算反應速度。
- 預覽記錄寫入 SQLite `settings_previews` 時附帶過期時間戳記；逾期之 `previewId` 呼叫 apply 時回傳 `400 PREVIEW_EXPIRED`。
- 前端發起套用時，`idempotencyKey` 自動附加隨機後綴（`apply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`），避免網路重試誤碰撞。
- 並發修改導致 revision 推進時，嚴格回傳 `409 Conflict`。

**Test-first evidence:**
- Failing case: 模擬已逾期之 `previewId` 發起 apply，應遭拒絕。
- RED: `npx vitest run web/tests/integration/settings-preview.test.ts` → `AssertionError: expected 400, got 200`.
- Minimal behavior: 在 `settings-preview.ts` 中加入 TTL 檢查與 formal-only 計算路由；在 `settings-editor.tsx` 套用呼叫中注入隨機後綴。
- GREEN: `npx vitest run web/tests/integration/settings-preview.test.ts` → `passed`.
- Project verification: `npm --prefix web run test` → 全部測試通過。

---

### Task 3: D2 具名候選擴充（D18 ＋ D22）與雙軌對照視圖

**Files:**
- Modify: `web/src/domain/schedules/seed-manifest.ts:80-130`
- Modify: `web/src/app/settings/page.tsx:10-50`
- Modify: `web/src/components/settings-editor.tsx:170-230`
- Test: `web/tests/integration/candidate-aliases.test.ts`

**Interfaces:**
- Consumes: ERP baseName 清單、有效班級設定庫。
- Produces: 雙軌對照視圖（Seed 49 班盤點基準 ＋ 當前 active classes 設定視圖）、具名候選清單（D18 ＋ D22 三組）。

**Acceptance:**
- 沿用 D18 具名候選模式，具名列出 4 組確認候選：
  1. `國小數學-一` $\to$ `國小數學-一A`（D18）
  2. `國小國語文-小三四` $\to$ `國小國語文-小三小四`（D22）
  3. `小六國文加強班` $\to$ `小六加強班-國文`（D22）
  4. `小六數學加強班` $\to$ `小六加強班-數學`（D22）
- 驗證候選時只驗 target 班級是否存在於有效設定中。
- 不建通用模糊推薦引擎，ambiguous 情況暫緩；砍除「標記待調 ERP」第三動作，待設定班級以既有問題清單（issues）承載。
- 使用者逐項勾選核取方塊後，發起一次整表 dry-run preview，看到影響後原子套用；嚴禁自動批准。
- 保持 I19 初始錨點：54 個 baseName、42 個精確相等自動候選、12 個待設定、seed 側 7 個本批未出現。

**Test-first evidence:**
- Failing case: 斷言 D22 三組具名候選出現在設定頁推薦清單中。
- RED: `npx vitest run web/tests/integration/candidate-aliases.test.ts` → `AssertionError: expected candidates to contain D22 items`.
- Minimal behavior: 在 `page.tsx` 擴充 `NAMED_CANDIDATES` 包含 D18 與 D22，在 `settings-editor.tsx` 渲染多組具名候選。
- GREEN: `npx vitest run web/tests/integration/candidate-aliases.test.ts` → `passed`.
- Project verification: `npm --prefix web run build` → 通過編譯。

---

### Task 4: D3 ERP 所屬班級全文按 token_index 升冪重組呈現與字元保真

**Files:**
- Modify: `web/src/adapters/sqlite/runs-repository.ts:50-100`
- Modify: `web/src/adapters/sqlite/import-repository.ts:70-120`
- Modify: `web/src/app/page.tsx:200-280`
- Test: `web/tests/integration/erp-field-preservation.test.ts`

**Interfaces:**
- Consumes: SQLite `student_enrollments` 儲存的各 enrollment tokens。
- Produces: 學生明細物件中之 `classText`，由 enrollments 按 `token_index ASC` 以換行符 `\n` 重組拼回。

**Acceptance:**
- 不在 `imported_students` 資料表新增 `class_text_raw` 欄位（砍此多餘欄位，避免資料庫結構膨脹）。
- 學生核對總表明細抽屜展示「所屬班級全文」時，直接依 `student_enrollments` 之 `token_index` 升冪排序列舉，還原與 ERP 儲存格完全一致的換行多班全文。
- 文字欄位（姓名、代碼、備註、標籤、分校）字元 100% 完全一致保真，非文字欄位（年級、日期）維持正規化等價。
- tags 切分邏輯不改動（維持相容），計算核心 R05–R08 繼續走 `tagsRaw.includes(...)` 整串比對。

**Test-first evidence:**
- Failing case: 檢查查詢返回之學生班級全文是否等於按 token_index 升冪拼接之結果。
- RED: `npx vitest run web/tests/integration/erp-field-preservation.test.ts` → `AssertionError: classText mismatch`.
- Minimal behavior: 在查詢學生時以 SQL `GROUP_CONCAT(raw_token, char(10))` 或程式碼依 `token_index` 排序組合成 `classText`。
- GREEN: `npx vitest run web/tests/integration/erp-field-preservation.test.ts` → `passed`.
- Project verification: `npm --prefix web run test` → 全部測試通過。

---

### Task 5: D3 分校換行切分集合篩選與列表 API 脫敏

**Files:**
- Modify: `web/src/adapters/sqlite/runs-repository.ts:120-180`
- Modify: `web/src/domain/students/header-normalizer.ts`
- Modify: `web/src/app/api/v1/students/route.ts`
- Modify: `web/src/app/page.tsx:80-150`
- Test: `web/tests/integration/branch-filter-and-privacy.test.ts`

**Interfaces:**
- Consumes: 查詢參數 `branch`。
- Produces: 分校維表 token 精確集合篩選結果；脫敏後之列表 API 響應（不含完整備註與電話）。

**Acceptance:**
- 面對 450/477 筆具換行複值之分校資料，篩選時依換行切分各分校 token 並正規化；只要學生分校集合包含該篩選值即精確命中，解決單一字串全等比對遺漏複值學生的缺陷。
- 人數統計嚴格依 `personCode` 去重，不因多分校而虛增。
- 列表 API `GET /api/v1/students` 執行脫敏保護：不回傳完整電話（遮蔽呈現），備註欄位僅回傳 `hasNotes: boolean`；單生明細抽屜 API（`GET /students/{personCode}/calculation`）按需查閱完整自由備註。
- 就學資料（schoolInfo）只存不篩，保留原始文字。

**Test-first evidence:**
- Failing case: 測試篩選某一分校時，具備該分校但屬於複值換行的學生應被正確篩出。
- RED: `npx vitest run web/tests/integration/branch-filter-and-privacy.test.ts` → `expected 450 matches, got 27`.
- Minimal behavior: 在 SQL 查詢中建構分校 token 正規化比對（如 `EXISTS` 或維表關聯）；在列表 API 進行欄位脫敏遮蔽。
- GREEN: `npx vitest run web/tests/integration/branch-filter-and-privacy.test.ts` → `passed`.
- Project verification: `npm --prefix web run test` → 全部測試通過。

---

### Task 6: 整合測試與 Parity 回歸驗證（I17–I19、U33、U41–U49 全覆蓋）

**Files:**
- Test: `web/tests/integration/full-p1-parity.test.ts`
- Test: `web/tests/integration/i19-anchor.test.ts`

**Interfaces:**
- Consumes: 完整真實 477 學生樣本、Seed 49 班排課。
- Produces: 完整驗證報表，斷言所有黃金指標無回歸。

**Acceptance:**
- 驗證固定原檔原排課無新增 alias 時：一般輔導 179 tokens 為 174 match / 5 mismatch（列 30/35/43/51/52）；13 人 `schedule_not_found`、1 數學班 `schedule_empty`、8 個 `care_window` 班級不誤報缺時段。
- 驗證套用 D18（數學一班對一A）時：13 名學生安親各減少 0.5 天，mismatch 由 5 增為 18。
- 驗證 I19 初始盤點錨點：54 個 baseName、42 個精確相等、12 個待設定、seed 側 7 個本批未出現。
- 驗證 R17 同類重複 2 人、R18 員工家屬無折扣 5 人、列 205 備註衝突 1 人，提示與計算完全穩定。

**Test-first evidence:**
- Failing case: 斷言全流程 Parity 矩陣全部指標。
- RED: `npx vitest run web/tests/integration/full-p1-parity.test.ts` → 斷言失敗。
- Minimal behavior: 執行完整測試套件並驗證無回歸。
- GREEN: `npx vitest run web/tests/integration/full-p1-parity.test.ts` → `All tests passed`.
- Project verification: `npm --prefix web test && npm --prefix web run build` → 通過。

---

## PR Boundaries

| PR 代號 | 包含任務 | 目標與可觀察驗收成果 | 獨立可 Merge 條件 |
| :--- | :--- | :--- | :--- |
| **PR-1: D1 排課平鋪列模型與預覽強化** | Task 1, Task 2 | S 表五欄平鋪時段編輯、初始草稿攜帶全量 89 筆 seed、預覽 TTL、formal-only、隨機冪等鍵後綴；起迄時間檢驗。 | 需通過 `settings-grid-model.test.ts` 與 `settings-preview.test.ts`，不破壞既有計算。 |
| **PR-2: D2 具名候選與雙軌對照** | Task 3 | 具名候選納入 D18 與 D22 三組漂移、雙軌對照視圖、人工逐項勾選預覽套用；I19 錨點維持。 | 需通過 `candidate-aliases.test.ts`，維持不自動批准原則。 |
| **PR-3: D3 原值重組呈現與分校篩選脫敏** | Task 4, Task 5, Task 6 | 班級全文依 token_index 重組呈現（不增 DB 欄位）、分校換行集合篩選、列表 API 脫敏、全套 Parity 回歸驗收通過。 | 需通過 `erp-field-preservation.test.ts` 及全部整合測試。 |

---

## No Placeholders 聲明

本計畫嚴格遵守無佔位符原則：
- 全文無任何 `TBD`、`TODO`、`implement later` 或模糊之「加適當處理」字眼。
- 所有檔案路徑、函式簽名、資料庫欄位、測試命令與預期行為皆具體明確，完全可直接由後續實作 Session 依步驟消費。

## Self-Review 核對

1. **Requirement coverage**：D1（五欄可編輯、F-K不進、星期唯讀、更名暫緩、停用不硬刪、care_window提示暫緩、TTL＋formal-only）、D2（具名候選沿D18、ambiguous暫緩、只驗target存在、雙軌視圖、砍標記待調ERP）、D3（砍class_text_raw逐筆重組、tags切分不改、分校集合篩選維表、列表脫敏、就學資料只存不篩）均完整對應 Task 1 至 Task 5，無遺漏亦無未授權膨脹。
2. **Fact integrity**：所有數字（S表89列49班、分校複值450/477、聯絡426/477、標籤82/477、I19 54/42/12/7）皆有真實來源與代碼錨點佐證。
3. **Consistency**：合約型別、API 參數與 Task 間 consumes/produces 完全一致。
4. **Test validity**：每個 Task 皆具備具體之 RED/GREEN 驗證命令與預期失敗特徵。
5. **Dependency order**：PR-1（排課與預覽基礎）$\to$ PR-2（別名候選）$\to$ PR-3（查詢與脫敏展示），順序合理，無破壞性循環依賴。
6. **Placeholder scan**：已全面掃描確認零佔位符。
