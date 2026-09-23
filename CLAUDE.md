# 學生收費核對工具 (student-billing) 開發指南

本文件是專案事實、架構約定與流程政策的最高權威來源。所有參與本專案的 Agent (Lead, Implementer, Reviewer) 均須嚴格遵守。

---

## 1. 專案定位與現況

本專案為「學生收費核對工具」之 **localhost P1 原型工具**。
主要用途：供校務人員上傳 ERP 學生名單 XLSX，依班級、學生、科別篩選，核對人數、適用折扣、每週收費級距、ERP 登記級距差異與警示，供人工開立繳費單及核對財務報表使用。

### P1 核心功能 (In Scope)
- 任意檔名之學生名單 XLSX 匯入，依必要標頭解析（支援欄位重排與隱藏），相容非 Excel 原生之 inlineStr OOXML。
- 真實名單預覽、去重人數統計、班級與學生篩選、本地 SQLite 持久化。
- 八項總表計算（安親天數、課輔天數、美語天數、數學天數、中文天數、寫功課天數、加重美語天數、週六課輔天數）。
- 課程適用折扣計算、ERP 登記級距比對、差異提示與計算過程解釋。
- 課程、老師、每週時段、別名映射 (Alias) 維護，支援 Preview（影響評估）與 Apply（原子套用與重算）。
- 本地最小唯讀 API 供查詢指定 Run 之計算結果。

### P1 負向範圍 (Negative Scope - 絕對禁止在 P1 實作)
- 不匯入財務報表、不自動對帳、不計算應收帳款金額。
- 不直連 ERP 系統、不自動開單。
- 不實作使用者登入、RBAC 權限管理、Firestore、雲端部署 (Vercel) 或 Tunnel。
- 不輸出點名表模板、不實作 A4 報表列印（此屬 P3 範圍，見 `specs/05-attendance-templates.md`）。
- 不建立通用動態公式編輯器或 DSL 引擎。

---

## 2. 規格文件權威順序 (Authority Hierarchy)

若文件內容或要求出現衝突，依下列優先順序判定：

1. **使用者最新明確決策**：`specs/06-handoff-decisions.md`（D01–D24，特別是 D17 與 D24）。
2. **正式規則與契約規格**：
   - `specs/02-calculation-rules.md`（收費規則 R01–R18、欄位契約、結構化班名）
   - `specs/03-architecture-api.md`（不可變快照、資料模型、交易與 API 契約）
   - `specs/04-tdd-acceptance.md`（U01–U49、I01–I20、原生 Excel 實測錨點）
3. **執行計畫**：`specs/07-p1-implementation-plan.md`（T00–T07 依序執行，展示 A/B/C 交付節點）。
4. **歷史 Review 與交接記錄**：`specs/reviews/*`（僅供脈絡參考，若有數字或推論與 04 §3 或 D24 衝突，以最新正式規格為準）。

### 核心業務決策原則
- **D17（最高原則）**：系統職責在於**照實呈現計算結果**與**顯眼標記不一致處**。ERP 登記可能有人為錯誤，正是需要藉由工具發現；嚴禁為了使計算結果吻合 ERP 而修改課表或扭曲計算公式。特例狀況交由人工開單處理。
- **D24（最新取整規則）**：衝堂扣天取整：同班各時段重疊先相加得出正扣天量 $d$，依其小數部分判斷：
  - $< 0.3$：不扣天
  - $0.3 \le \text{frac} < 0.8$：扣 $0.5$ 天
  - $\ge 0.8$：扣 $1.0$ 天
  最後轉為負扣天。原 Excel 負數 INT/MOD 公式導致實質門檻變為 0.2 / 0.7，屬歷史缺陷。
- **雙軌制度 (Dual-track Evaluation)**：
  - 正式軌 `erp-tag-v1`：只讀「標籤」欄，不從備註 fallback，備註原文完整保留。
  - 診斷軌 `excel-v260922-compat`：保留原 Excel 負數公式與歷史欄位讀取邏輯，**僅供比對與診斷差異**，絕不可作為正式開單結果。
- **規則參數化**：每日 180 分鐘、0.3/0.8 門檻、課輔整日特例集中於 `ruleSet` 參數；變更參數需建立新版本並重算，舊 Run 結果不可變。P1 不做參數編輯 UI。

---

## 3. 資料保護與安全性邊界 (Data Privacy & Hard Boundaries)

- **敏感個資嚴禁外洩**：真實學生名單、學生代碼 (personCode)、姓名、電話、備註、身分證等個資，**絕對禁止**提交至 Git、CI、PR 描述、測試報告或任何公開/雲端介面。回報時僅能以來源座標（如「列 205」）或匿名代碼指涉。
- **本機資料嚴格隔離**：
  - 專案根目錄之來源 Excel 檔（`嘉義縣私立資優生文教機構.xlsx` 等）保留在本地，不可修改、不可 stage。
  - `~$*.xlsx` 鎖定暫存檔、`2026夏令營/`、`specs/evidence/`、`app/data/` 已被 `.gitignore` 排除，嚴禁強行加入。
- **測試資料規範**：
  - Git/CI 測試一律採用保形、匿名或合成 fixture。
  - ERP 檔案具有 100% `inlineStr`、無 `sharedStrings.xml`、缺 `<dimension>` 之特殊 OOXML 結構，測試 fixture 必須保留此原形特徵，避免因自製 fixture 掩蓋相容性問題。

---

## 4. 目錄結構與路徑約定 (Directory & Path Conventions)

- **規格文件目錄**：`specs/` 位於專案根目錄，保持單一權威來源，不複製多份。
- **應用程式目錄**：所有產品程式碼位於 `app/` 子目錄（即 `/Users/cheerc/Projects/student-billing/app/`）。
- **資料儲存目錄**：`app/data/` 存放 SQLite 資料庫 (`app.sqlite`)、來源副本、私有 fixture 與報告。
- **開發指令路徑**：所有 `npm`、建置、測試指令皆必須在 `app/` 目錄內執行。

---

## 5. 技術選型與環境 (Tech Stack & Environment)

- **Runtime**：Node.js 24 (本機使用 Node v24.21.0)。
- **Language**：TypeScript (啟用 strict 模式)。
- **Web Framework**：Next.js 16 (App Router)。
- **Database**：SQLite (使用 `better-sqlite3` native module，支援交易 rollback 與 migration)。
- **Data Validation & Parsing**：Zod (型別與 API 驗證), ExcelJS (串流讀取大型試算表)。
- **Testing Framework**：Vitest (單元與整合測試), Playwright Chromium (E2E 流程驗收)。
- **伺服器網路安全**：開發與測試伺服器一律僅監聽 `127.0.0.1` (localhost)，禁止綁定 `0.0.0.0` 或開啟公網 tunnel。

---

## 6. Git 工作流程與分支政策 (Git & Branching Policy)

- **短分支原則**：每個任務建立獨立短分支（如 `feat/t00-bootstrap`, `feat/t01-import`, `fix/issue-description`），自 `main` 簽出。
- **PR 與合併方式**：
  - 所有變更必須經由 GitHub Pull Request 提交。
  - 合併方式一律採 **Squash and merge**，維持 `main` 分支線性的任務交付歷史。
  - GitHub 免費方案之 private repo 無法開啟原生 Branch Protection，所有合併由 AgEnD daemon 之 `repo merge` 關卡把關（需通過 CI 與 current-head 審查）。
- **Attribution 規範**：
  - Git Commit Message 結尾必須包含：
    `Co-Authored-By: Claude Code <noreply@anthropic.com>`
  - GitHub Pull Request 描述結尾必須包含：
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

---

## 7. 團隊角色分工與審查政策 (Roles & Code Review Policy)

### 團隊角色與職責
- **Team Lead (`sb-team-lead`)**：負責任務拆解、派工、Review 與 CI 收斂、最終 Merge 與階段交付；不直接修改產品程式碼。
- **Implementer (`sb-team-impl`)**：負責功能實作、TDD 測試撰寫、PR 建立與 Rework 修正。
- **Reviewer (`sb-team-reviewer`, `sb-team-reviewer2`)**：負責獨立唯讀審查、驗證技術事實與規則落實，提出具體證據的 Verdict。

### 審查等級 (Review Class)
- **`dual` 審查（雙審查人）**：
  - 適用範圍：計算核心邏輯任務（**T03** 純規則計算 R01–R18、**T04** 啟用 Run 與雙軌差異報告）。
  - 要求：必須由 `sb-team-reviewer` 與 `sb-team-reviewer2` 雙方各自提交獨立的 `VERIFIED` 裁決。
- **`single` 審查（單審查人）**：
  - 適用範圍：基礎架構、資料匯入、UI 介面、設定維護、工具與文件（**T00, T01, T02, T05, T06, T07, docs**）。
  - 要求：由 `sb-team-reviewer` 審查並提交 `VERIFIED`。

### 審查作業標準
- Reviewer 必須在隔離的唯讀 worktree 中審查指定的 exact HEAD commit。
- 審查報告裁決僅能為 `VERIFIED`、`REJECTED` 或 `UNVERIFIED`。
- `VERIFIED` 與 `REJECTED` 必須包含 `### Evidence` 區塊，具體列出執行命令 (`ran:`) 與程式碼引文 (`cited:`)。
- 規格文件與架構指引變更（Instruction-surface）依 `reviewing-instruction-surface` 標準審查。

---

## 8. 測試與驗收門檻 (Testing & Acceptance Criteria)

- **測試先行 (TDD)**：所有功能修改必須先建立重現問題或驗證規格之失敗測試 (RED)，實作完成後達到通過 (GREEN)。
- **禁止反向產生測試 Expected**：測試之預期結果必須依據規格獨立手算或驗證，絕對不可使用待測函式的輸出直接作為黃金標準。
- **真實樣本驗證**：477 筆真實學生資料之驗證僅於本機執行，驗收報告保存於私有報告中，不納入版本控制。
- **效能驗收標準 (477 人資料量)**：
  - 匯入解析至可查詢：$\le 3$ 秒
  - 完整重算：$\le 1$ 秒
  - 班級/學生篩選反應時間：$\le 200$ ms (經 07 指定暖機後 10 次 p95 評估)
- **誠實記錄未驗項**：未完成之項目（例如整本 Excel workaround 原生 golden、A4 點名表輸出）必須於驗收報告誠實揭露，嚴禁虛報完成。
