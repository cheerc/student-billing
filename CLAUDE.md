# 學生收費核對工具 (student-billing) 開發指南

本文件是專案事實、架構約定與流程政策的最高權威來源。所有參與本專案的 Agent (Lead, Implementer, Reviewer) 均須嚴格遵守。

---

## 1. 專案定位與現況

本專案為「學生收費核對工具」之 **localhost P1 原型工具**。
主要用途：供校務人員上傳 ERP 學生名單 XLSX，依班級、學生等欄位篩選（欄位清單見 09 §5.1；科別入口已由 D36 移除），核對人數、適用折扣、每週收費級距、ERP 登記級距差異與警示，供人工開立繳費單及核對財務報表使用。

### P1 核心功能 (In Scope)
- 任意檔名之學生名單 XLSX 匯入，依必要標頭解析（支援欄位重排與隱藏），相容非 Excel 原生之 inlineStr OOXML。
- 真實名單預覽、去重人數統計、班級與學生篩選、本地 SQLite 持久化。
- 八項總表計算（安親天數、課輔天數、美語天數、數學天數、中文天數、寫功課天數、加重美語天數、週六課輔天數）。
- 課程適用折扣計算、ERP 登記級距比對、差異提示與計算過程解釋。
- 課程類型（安親課輔班／非安親課輔班）、課程、老師、每週時段、別名映射 (Alias) 維護，支援 Preview（影響評估）與 Apply（原子套用與重算）。
- 本地最小唯讀 API 供查詢指定 Run 之計算結果。

### P1 負向範圍 (Negative Scope - 絕對禁止在 P1 實作)
- 不匯入財務報表、不自動對帳、不計算應收帳款金額。（此為**產品功能**之限制。另有 §9 的產品外離線輔助工具 `billing:compare`（國小輔導）與 `billing:compare:sessions`（按堂計價），可手動產出差異報告供人工核對帳務——它們不是產品功能，見 §9.0）
- 不直連 ERP 系統、不自動開單。
- 不實作使用者登入、RBAC 權限管理、Firestore、雲端部署 (Vercel) 或 Tunnel。
- 不輸出點名表模板、不實作 A4 報表列印（此屬 P3 範圍，見 `specs/05-attendance-templates.md`）。
- 不建立通用動態公式編輯器或 DSL 引擎。

### 系統術語表 (Glossary: 米豆奶與 ERP)
依 2026-09-30 決策 `d-20260929163653995243-9`：
- **米豆奶**：本專案之外部學生名冊來源系統正名為「米豆奶」。所有使用者可見之 UI 畫面、操作指引、API 上傳錯誤與計算提示，統一使用「米豆奶」（例如「上傳米豆奶名單」、「米豆奶登記級距」、「米豆奶匯入班名」）。
- **技術識別保留**：程式碼、資料庫與既有規格文件中之 `ERP` / `erp` 技術識別（如資料庫欄位 `erp_billing_tier`、API 參數 `erpBillingTier`、規則集版本 `erp-tag-v1` / `erp-tag-v2`、模組名 `erp-reader.ts`、測試資產 `conforming-erp-fixture.xlsx` 等）均維持原樣，作為米豆奶系統之內部技術識別，不進行破壞性更名或全面替換，亦不改寫歷史規格與歷史 Run 紀錄。

---

## 2. 規格文件權威順序 (Authority Hierarchy)

若文件內容或要求出現衝突，依下列優先順序判定：

1. **使用者最新明確決策**：`specs/06-handoff-decisions.md`（D01–D57，特別是 D17、D24、D33 UI 重設方向、D52 雙審查與解耦裁決，以及 D57 #159 PR-2 現行 v4-only runtime）。
2. **正式規則與契約規格**：
   - `specs/02-calculation-rules.md`（收費規則 R01–R18、§9A erp-tag-v4 解耦段、欄位契約、結構化班名）
   - `specs/03-architecture-api.md`（不可變快照、資料模型、交易與 API 契約）
   - `specs/04-tdd-acceptance.md`（U01–U74、I01–I20、UX01–UX89、原生 Excel 實測錨點）
   - `specs/09-ui-workflow-redesign-spec.md`（先課表→匯入→核對的畫面與操作流程，及其必要 API／設定生命週期放寬；授權來源為 D33，不改 02 計費規則）
3. **執行計畫**：
   - `specs/07-p1-implementation-plan.md`（T00–T07 依序執行，展示 A/B/C 交付節點）
   - `specs/10-ui-workflow-redesign-plan.md`（UI 重設 R0–R5 分批；驗收矩陣在 04 §8，本檔不定義規則）
   - `specs/11-ui-acceptance-fix-plan.md`（第一次人工驗收修正 PR-0、A、S、B1、B2、C、D 分批；決策 D34–D39 在 06，驗收列 UX25 起在 04 §8，本檔不定義規則）
   - `specs/12-round2-acceptance-fix-plan.md`（第二次人工驗收修正 R2-F01／R2-F02 與驗收工具 T1／T2／T3；驗收列 UX74 起在 04 §8，工具指令在該檔 §4，本檔不定義規則）
   - `specs/14-class-type-settings-plan.md`（課程類型分類與課表設定重構規格與拆分計畫：依課程類型分頁、固定 5 天旗標與課程學費折扣解耦；授權來源為 2026-10-18 operator 裁決，實作時同步更新 02／03／04／09，拆分見該檔 §6）
4. **歷史 Review 與交接記錄**：`specs/reviews/*`（僅供脈絡參考，若有數字或推論與 04 §3 或 D24 衝突，以最新正式規格為準）。

第 2 層各文件各管其域：02 管計費規則、03 管資料模型與交易不變式、04 管驗收、09 管 UI 流程。09 對 01／03 的 UI 流程與設定生命週期放寬，僅限 D33 授權且 09 §8 明列的範圍；02 計費規則與 03 §4 的不可變快照／交易不變式不因 09 改變。

### 核心業務決策原則
- **D17（最高原則）**：系統職責在於**照實呈現計算結果**與**顯眼標記不一致處**。ERP 登記可能有人為錯誤，正是需要藉由工具發現；嚴禁為了使計算結果吻合 ERP 而修改課表或扭曲計算公式。特例狀況交由人工開單處理。
- **D24（最新取整規則）**：衝堂扣天取整：同班各時段重疊先相加得出正扣天量 $d$，依其小數部分判斷：
  - $< 0.3$：不扣天
  - $0.3 \le \text{frac} < 0.8$：扣 $0.5$ 天
  - $\ge 0.8$：扣 $1.0$ 天
  最後轉為負扣天。原 Excel 負數 INT/MOD 公式導致實質門檻變為 0.2 / 0.7，屬歷史缺陷。
- **正式規則與歷史相容版本**：
  - 正式軌：使用 run 保存的正式 rule set（目前目標為 `erp-tag-v4`）；優惠標記只讀「標籤」欄，不從備註 fallback，備註原文完整保留。
  - `excel-v260922-compat`：PR-2 移除舊 calculators 與 compat float kernel，僅保留已保存的歷史 run 結果供 read-only 呈現。PR-1 已停止新 run diagnostics，移除比較頁與 `GET /runs/{runId}/comparison`（GET 回 404）；既有 run、診斷表列與 raw issue 值不重寫。兩個舊診斷碼仍保留於 `KNOWN_ISSUE_CODES` 及明確 raw API 篩選，結果頁 UI 的 actionable projection 則排除 `NUMERIC_POLICY_DIFFERENCE`／`RULESET_POLICY_DIFFERENCE`，保留其他問題與 `needsReview` 級距警告。歷史決策 D55 保留原文。
  - #159 PR-2 起，所有新 Run 與新計算預覽固定使用 `erp-tag-v4`。active run 為任一非 v4 版本（v1／v2／v3、compat 或未知版本）時，普通 activate／recalculate／apply 不會沿用或猜測版本，會要求使用者明確預覽並確認升級 v4；升級前值只讀舊 Run 已保存的結果，升級後才計算 v4。舊 Run、歷史 issue、設定與類別快照不重算、不回填；歷史 read-model 用獨立的 read-only 版本 metadata，不能用新計算能力表推導舊結果。舊成功 idempotency replay 仍先回傳原回應。
- **規則參數化**：每日 180 分鐘、0.3/0.8 門檻、課輔整日特例集中於 `ruleSet` 參數；變更參數需建立新版本並重算，舊 Run 結果不可變。P1 不做參數編輯 UI。

---

## 3. 資料保護與安全性邊界 (Data Privacy & Hard Boundaries)

- **敏感個資嚴禁外洩**：真實學生名單、學生代碼 (personCode)、姓名、電話、備註、身分證等個資，**絕對禁止**提交至 Git、CI、PR 描述、測試報告或任何公開/雲端介面。回報時僅能以來源座標（如「列 205」）或匿名代碼指涉。
- **本機資料嚴格隔離**：
  - 專案根目錄之來源 Excel 檔（`嘉義縣私立資優生文教機構.xlsx` 等）保留在本地，不可修改、不可 stage。
  - `~$*.xlsx` 鎖定暫存檔、`2026夏令營/`、`/data/`（含 SQLite 資料庫、來源副本與私有 evidence/）已被 `.gitignore` 排除，嚴禁強行加入。
- **測試資料規範**：
  - Git/CI 測試一律採用保形、匿名或合成 fixture。
  - ERP 檔案具有 100% `inlineStr`、無 `sharedStrings.xml`、缺 `<dimension>` 之特殊 OOXML 結構，測試 fixture 必須保留此原形特徵，避免因自製 fixture 掩蓋相容性問題。

---

## 4. 目錄結構與路徑約定 (Directory & Path Conventions)

- **規格文件目錄**：`specs/` 位於專案根目錄，保持單一權威來源，不複製多份，維持公開乾淨。
- **應用程式目錄**：所有產品程式碼位於 `web/` 子目錄（即 `/Users/cheerc/Projects/student-billing/web/`）。
- **資料儲存目錄**：專案根目錄 `/data/` 存放 SQLite 資料庫 (`app.sqlite`)、來源副本、私有 fixture、私有 evidence 與報告（被 `.gitignore` 排除）。
- **開發指令路徑**：所有 `npm`、建置、測試指令皆必須在 `web/` 目錄內執行。

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
  - GitHub 免費方案之 private repo 無法開啟原生 Branch Protection，因此所有合併須經 **merge gate** 把關：**CI 通過**，且**審查裁決所指的 commit 等於要合併的 HEAD**（current-head 審查）。
- **Attribution 規範**：
  - Git Commit Message 結尾必須包含：
    `Co-Authored-By: Claude Code <noreply@anthropic.com>`
  - GitHub Pull Request 描述結尾必須包含：
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

---

## 7. 團隊角色分工與審查政策 (Roles & Code Review Policy)

### 團隊角色與職責
- **Team Lead**：負責任務拆解、派工、Review 與 CI 收斂、最終 Merge 與階段交付；不直接修改產品程式碼。
- **Implementer**：負責功能實作、TDD 測試撰寫、PR 建立與 Rework 修正。
- **Reviewer**：負責獨立唯讀審查、驗證技術事實與規則落實，提出具體證據的 Verdict。

### 審查等級 (Review Class)
- **`dual` 審查（雙審查人）**：
  - 適用範圍：計算核心邏輯任務（**T03** 純規則計算 R01–R18、**T04** 啟用 Run 與雙軌差異報告）。
  - 要求：必須由**兩位不同的 Reviewer** 各自提交獨立的 `VERIFIED` 裁決。
- **`single` 審查（單審查人）**：
  - 適用範圍：基礎架構、資料匯入、UI 介面、設定維護、工具與文件（**T00, T01, T02, T05, T06, T07, docs**）。
  - 要求：由**一位 Reviewer** 審查並提交 `VERIFIED`。

### 審查作業標準
- **Reviewer** 必須在隔離的唯讀 worktree 中審查指定的 exact HEAD commit。
- 審查報告裁決僅能為 `VERIFIED`、`REJECTED` 或 `UNVERIFIED`。
- `VERIFIED` 與 `REJECTED` 必須包含 `### Evidence` 區塊，具體列出執行命令 (`ran:`) 與程式碼引文 (`cited:`)。

---

## 8. 測試與驗收門檻 (Testing & Acceptance Criteria)

### Full E2E 唯一執行契約（Issue #101；本機 = GitHub Nightly）

- **任何人或 Agent 執行「全量 Full E2E」時，唯一正式入口是在 `web/` 執行 `npm run test:e2e:full`。** `.github/workflows/nightly-e2e.yml` 必須呼叫**完全相同**的命令；本機和 CI 不得各自維護測試檔清單、skip、SQLite seed、`.next` 清理、retries、reporter、測試結果聚合與 coverage gate。
- `web/scripts/e2e-full.mjs` 是 full E2E orchestration SSOT：動態掃描 `web/tests/e2e/*.spec.ts`，一般檔案透過 `test:e2e:isolated` 每檔獨立 DB+server；`d2d-upgrade-restore.spec.ts` 與 `d2d-upgrade-journey.spec.ts` 必須分別用 `--seed-v2-active` 真正跑完，journey 排最後，不能以 skip 冒充 covered；最後合併 Blob/HTML/JUnit/JSON 並執行 fail-closed verifier。任何失敗／漏跑／未經核准 skip／報告缺失都不是 PASS。
- `npm run test:e2e:isolated`（無 args）及單檔命令僅供既有功能測試與針對性除錯，**不得**作為 full E2E merge/review/nightly 的驗收證據。針對性驗證必須明列檔名與測試數。
- 目前 E2E 使用 Chromium、serial、`retries: 0`，禁止以 rerun-to-green、測試隔離黑名單、blanket skip 或 `continue-on-error` 掩蓋 flaky。每檔隔離 SQLite 與 Next server；`.next` 在一般全量階段內共用，只於 full 開始與 v2 seeded phase 前清理；本機和 nightly 同一行為。
- CI/本機的 Node/OS、瀏覽器 shared libraries 前置安裝可以不同，但 **full E2E 測試執行入口與 coverage 驗收不能不同**。本機綠燈不代表 hosted Ubuntu 已驗證，必須記錄 exact HEAD/Node/Playwright/規格檔數/測試案例數/失敗證據。
- Nightly 固定 GitHub-hosted Ubuntu，schedule + 手動 `workflow_dispatch`，不在每個 PR 增加 full E2E gate；scheduled run 若紅，需追蹤原始失敗、run URL 與負責人，不得以手動重跑綠燈取消首次失敗證據。
- **開發 E2E、新增/刪除 spec、修改 runner、reporter、seed 或 CI workflow 前，一律先讀** `web/tests/e2e/CLAUDE.md`。如變更 full 流程，必須同時維護 root `CLAUDE.md`、`web/CLAUDE.md` 指引以及測試文件，確保本機／nightly 不分岔。

- **測試先行 (TDD)**：所有功能修改必須先建立重現問題或驗證規格之失敗測試 (RED)，實作完成後達到通過 (GREEN)。
- **Gate 工具與結果核實**：新 worktree 執行 gate 前，先確認 `web/node_modules` 存在且 TypeScript／Vitest 版本輸出符合工具身份；缺依賴時不得把 `npx` 的 exit code 0 當成通過。Gate 報告附實際執行的 test 數；未執行測試明確標示，不以空殼結果交付。
- **node 依賴不可 symlink**：新 worktree 需要 `node_modules` 時，只能 `npm ci`（約 1 分鐘），**或**以 `cp -Rc` 由既有副本共用。`cp -Rc` 的 `-c` 是 **macOS／APFS 專屬**（`clonefile(2)`，見 `man cp`；跨檔案系統或不支援 clone 的目標會自動退回完整複製），**GNU coreutils 的 `cp` 沒有這個選項**（實測 `cp: invalid option -- 'c'`）。因此：**僅限本機 APFS 上的 macOS；會在 `ubuntu-latest` 執行的測試或 script 一律不可使用**——CI 上請改用 `npm ci`（或 `cp -R`，代價是完整複製而非 clone 加速）。兩者都不可用 `-a`、不可用 `--symbolic-link`。本機 `cp -Rc` 的建議保留：它與 `npm ci` 產出的樹狀結構相同，差別只在 clone 共用區塊而非真複製，那個加速是本機開發實際需要的。

  ```bash
  # macOS／APFS：clone 加速（本機 worktree 準備）
  cp -Rc <既有副本>/node_modules <新 worktree>/web/node_modules
  # 跨平台（CI、任何會在 ubuntu-latest 執行的 script）：完整複製
  cp -R  <既有副本>/node_modules <新 worktree>/web/node_modules
  ```

  若 symlink 指向 filesystem root 之外的路徑，Turbopack 會 panic `Error [TurbopackInternalError]: Symlink [project]/node_modules is invalid, it points out of the filesystem root`，但 `test:e2e:isolated` 只會回 `Process from config.webServer was not able to start. Exit code: 1`，不指出真因——易誤判為測試失敗或依賴損壞而徒勞重灌。遇到 `webServer ... Exit code: 1` 且無測試失敗輸出時，先比對 `web/node_modules` 是否為 symlink，再懷疑其他原因。
- **禁止反向產生測試 Expected**：測試之預期結果必須依據規格獨立手算或驗證，絕對不可使用待測函式的輸出直接作為黃金標準。
  - **狹義 baseline 差異特徵化例外（operator 決策 `d-20260930131128030911-29` A 授權）**：僅允許不可變、pre-change baseline（如 D1 之 `8961c03`）之輸出資料用於鎖定重構前後業務欄位「未發生非預期改變」；此類 golden 嚴禁作算法正確性 oracle，且不得從新 HEAD 更新以掩蓋失敗；新規則／新行為／bug 修正之預期結果仍必須依規格獨立手算或外部驗證（詳細 provenance 見 `specs/04-tdd-acceptance.md` §8 UX34）。
- **真實樣本驗證**：477 筆真實學生資料之驗證僅於本機執行，驗收報告保存於私有報告中，不納入版本控制。
- **效能驗收標準 (477 人資料量)**：
  - 匯入解析至可查詢：$\le 3$ 秒
  - 完整重算：$\le 1$ 秒
  - 班級/學生篩選反應時間：$\le 200$ ms (經 07 指定暖機後 10 次 p95 評估)
- **效能門檻量測條件**：使用單檔、不與其他測試檔並行的獨立量測，記錄硬體、Node／瀏覽器版本、build 模式、輪數與統計方式（見 `specs/07` T07）。四條 API 路徑以 `npm run test:perf:isolated` 執行 production build／HTTP 量測，單輪 p95 必須 < 200ms；不含 UI render。並行下失敗後重跑到通過不算 PASS，獨立量測的失敗同樣須揭露，不以重試掩蓋。
- **誠實記錄未驗項**：未完成之項目（例如整本 Excel workaround 原生 golden、A4 點名表輸出）必須於驗收報告誠實揭露，嚴禁虛報完成。

---

## 9. 帳務比對輔助工具 (Billing Reconciliation Tools)

### 9.0 定位：side script，非專案組件

本節的兩台工具（`billing:compare`、`billing:compare:sessions`）都是**個人隨手使用的 side script**，供日後開新 session 時能直接取用的核對工具，**目前不屬專案交付方向的一部分**。因此：

- 不視為產品功能、不列入交付範圍、不隨產品版本演進維護。
- 維護優先度等同一般開發工具：能用、能重跑即可，不追求與產品同級別的覆蓋。實際防護只有 `tests/unit/compare-billing-report-parse.test.ts` 與 `tests/unit/compare-session-pricing-report.test.ts`。**不得**宣稱「型別或未定義變數由 lint 守護」：eslint 對 `.mjs` 未啟用 `no-undef`／`no-unused-vars`，且 `tsconfig` 未開 `checkJs`，`.mjs` 內的型別錯誤不會被 `npm run typecheck` 攔下（review F-NEW-5／F-minor-4 已實測確認兩者皆放行）。
- **不得複寫產品的班名／級距／離班解析**：級距一律取 `parseSingleClassToken`，班別類別一律取 `rateCategoryOfClass`，離班標記一律取 API 已解析的 `enrollment.withdrawalDate`。複寫必然漂移——review F-NEW-2 曾漏 `[5]` 並把 `[Starter]` 默默當成 5 天；F-minor-2 又以自訂 regex 重複偵測離班而與產品錨定行尾的寫法分歧。按堂計價工具的「折扣分派到哪一門課」同樣取 `parseSingleClassToken` 的 `baseName`（去方括號修飾），不自寫剝方括號的 regex。
- 執行一律走 `npm run billing:compare` 或 `npm run billing:compare:sessions`（走既有 `tsx`）。裸 `node` 無法解析產品 TS 內部的無副檔名 import（`./types`），會 `ERR_MODULE_NOT_FOUND`。
- 若日後確認有長期需求，經 operator 決定後**另案**檢討是否正式納入專案；在此之前維持現狀。

### 9.1 什麼時候該想到用這台工具

若使用者提到下列任一情境，**先想到本工具並主動詢問是否要跑**，不要等對方記得指令：

- 要「對帳」「核對帳務」「比對財務報表」「比對帳」「核對實質帳務」。
- 手上有一份米豆奶匯出的**財務報表 XLSX**，想知道與計算結果差在哪。
- 問「某個班／某個學生的天數或折扣對不對」「報表跟我們算的不一樣」。
- 要做期中／期末核對、發單前核對、月中核對。
- **問的是美語或數學的折扣**（該生不在國小輔導的級距制度內）→ 改用 `billing:compare:sessions`。

**先問哪一台**：使用者通常只說「幫我對帳」而不指定科目。判斷依據是報表上開課的是哪一類班——**國小輔導（安親／課輔／寫功課）走 `billing:compare`，兒童美語／國小數學走 `billing:compare:sessions`**。若不確定，兩台都跑（皆為唯讀，互不影響）。

**使用方式**（使用者通常不需知道指令，只要把報表路徑給出即可）：

```bash
cd web
# 國小輔導（級距＋折扣）
npm run billing:compare -- --xlsx "<財務報表.xlsx>" [--out "<報告.html>"] [--base http://127.0.0.1:3000]
# 兒童美語／國小數學（僅折扣）
npm run billing:compare:sessions -- --xlsx "<財務報表.xlsx>" [--out "<報告.html>"] [--base http://127.0.0.1:3000]
```

**跑之前必須先確認兩件事**（缺任一項工具會失敗，細節見 §9.2）：

1. 本機伺服器已啟動（`npm run dev`）。未啟動時錯誤訊息為 `fetch failed`。
2. 已存在**完成的** active run。沒有時工具會明確回報「找不到 active run」。

跑完把產出的 HTML 路徑回報給使用者，並說明各類差異筆數；**不要**代使用者下結論哪一邊才對（D17）。

### 9.2 工具細節

#### 兩台工具的差異

| 面向 | `billing:compare`（國小輔導） | `billing:compare:sessions`（按堂計價） |
|---|---|---|
| 比對科目 | 國小輔導（安親／課輔／寫功課） | 兒童美語、國小數學 |
| 計價方式 | 每週收費**級距**（週收費天數） | **堂數 × 單價**，無級距制度 |
| 比對欄位 | 週收費天數 ＋ 適用折扣 | **僅適用折扣** |
| 天數差異分類 | 有（`DAY_DIFF`／`BOTH_DIFF`／`TIER_UNPARSED`） | **不存在，不設該分類** |
| 一名學生 → 紀錄數 | 一筆 | **每筆學費列一筆**（雙科學生兩筆） |
| 報表金額欄 | 不需要 | 需要：欄 9.. 為**每班一欄**，依同名表頭定位 |
| 額外歸納 | 級距不符、重複報名、離班、寫功課 | 非標準折扣（期中補加收）、班級未分類、系統無適用值 |

#### 共通

- 前置條件：需先啟動本機伺服器（`npm run dev`）且已存在完成的 active run；報表工作表名固定為 `班級營收狀況`。
- 預設輸出 `~/Downloads/`，**不得**輸出至專案內或納入版本控制（工具會直接拒絕專案內路徑）。
- 差異分類一律在各自工具的 `defineCategories([...])` 宣告；badge、label、分頁、需人工判讀清單與主控台統計鍵名皆由其推導。新增分類時只改該處，不可各處各列一份。**機制共用、資料各列**：兩台的分類內容本就不同，那是資料而非重複實作。

#### 兩台工具仍需在工具端手寫的表面（尚未接上推導）

- **國小輔導工具**（`compare-billing-report.mjs`）：統計卡的 `count()` 與 `INSIGHT_GROUPS` 的 filter 仍直接比 `statusCategory` 字面值，`insightGroup` 欄位目前只被測試讀取。
- **按堂計價工具**（`compare-session-pricing-report.mjs`）：`INSIGHT_GROUPS` 的**分組成員已改由 `CATEGORIES.groupOf` 推導**（群組的標題與提示仍手寫，那是業務判讀文字）。但統計卡仍是多個 `count('CATEGORY')` 字面值。

> 為何不一次接完：統計卡要決定「哪些分類值得獨立一張卡」，這是**閱讀優先序的判斷**，共用層無從推導；而兩台工具的卡片構成意圖不同。在只有兩個真實使用者的情況下先把機制做對（分組成員已推導），卡片選擇留待日後確有需求再接，避免先猜錯形狀。群組的**內容**（哪些分類屬於「需人工確認」）已由 `needsHuman` 與 `groupOf` 表達，不是漏接。

### 9.3 範圍邊界（維持 §1 負向範圍，不得擴張）

operator 已裁示本節工具為**產品外的離線輔助工具**，`§1` 之「不匯入財務報表、不自動對帳」**維持不變**。具體界線：

- **唯讀**：只讀取報表檔與本機 API，不寫入產品資料庫、不修改任何 Run 或計算結果。
- **非產品能力**：不屬產品功能，不得據此規劃自動對帳、報表匯入或雲端部署。
- **人工判讀**：報表與名單存在時間差（發單日 vs 匯出日），差異不預設任一來源為正確；成因標註僅列資料可佐證者，最終正確性由人工判定（延續 D17）。
- **不寫死個資**：script 內不得硬編碼任何學生姓名或人員代碼；差異說明一律由資料推導（詳見 `buildNotes`）。
- **不計算金額**：按堂計價工具**不比對堂數、單價與學費金額**。系統端尚無對應欄位（issue #118），工具若以「金額 ÷ 堂數」推出單價再拿去比對，等於替系統斷言它並未持有的事實，屬 §9.0 禁止的「代為猜測」。兩欄僅作顯示值並標註不可驗證。

#### v3 及後續具快照能力的 run 的 `classCategories` 快照（issue #122 已修正；#112 起語意隨版本而異）

產品端 `applicableRateForClass` 對**具 `categoryBasedBilling` 能力的 run**（v3、v4）走**快照優先**的路徑：以 `run_class_categories` 的快照判斷班級類別；**缺該班快照時回 `not_configured`（無法判定），不退回名稱映射**——名稱映射僅用於沒有快照概念的 v1／v2。此處嚴禁以當前班名猜測（03 §5.3.4）。

**固定 5 天對本班折扣的影響隨規則版本不同（#112）**：v3 下 `fixed_five_days === 1` 會使本班適用折扣回 10000 bps（Q7-A）；**`erp-tag-v4` 起不再如此**，本班折扣完全由 `category` 決定，`none` 班（即使固定 5 天）一律「未設定／無法判定」（02 §9A.3）。因此消費端（畫面 `SummaryTable`、兩台帳務比對工具）**必須把該 run 的 `ruleSetVersion` 一併傳入讀模型**，由 `homeworkDiscountDecoupled` 能力旗標分流；不得由消費端自行字面比較版本。

**原缺陷（已修）**：`GET /api/v1/runs/{id}` 未回傳 `classCategories`，兩台工具因此直接讀 `applicableEnglishBps`／`applicableMathBps` 等學生層欄位，等於**以當前班名重新推導**班級類別，繞過了快照。當快照與名稱映射不一致時，工具讀數會與畫面不同，且**不會產生任何錯誤**。

**分歧面有兩個欄位，不只固定 5 天**：

- `run_class_categories.fixed_five_days` 在 #112 起改由使用者勾選（§3.3 移除班名自動偵測後預設恆為 `false`）；歷史 run 快照保留當時的值，不回寫。
- `run_class_categories.category`（班級類別：care／math／english／none／unset）**同樣可被維護者手動覆寫**。因此不只改固定 5 天旗標會造成偏離，**手動改分類也會**——例如把某個兒童美語班手動改為 `care`，舊行為的工具仍會讀 `applicableEnglishBps`，而畫面會依 `care` 走安親／課輔分支。
- `run_class_categories.category` 在 **#157 起**新增第五個值 **`unset`（使用者尚未指定）**，並**移除班名自動偵測**（06 D53）：類別一律由使用者決定；未對應課表的班一律寫 `unset` 且一律產生 `CLASS_NOT_MAPPED`。舊快照保留當時寫入的值（可能含 `auto`），**讀取時視為 `unset`**，不回寫。

**修正內容**：`getCalculationRun` 載入層一併帶出該 run 的 `classCategories`（`/runs/{id}`、`/runs/current`、`/classes` 兩條以上路徑共用同一讀模型），兩台工具改為把快照傳入 `applicableRateForClass` 的正式路徑。快照形狀契約（底線命名、`fixed_five_days` 為數字 0／1、`undefined` 與 `[]` 語意分離）見 03 §5.3.4。

**工具端在無法判定時不得靜默**：拿到 `not_configured` 時，兩台工具一律標為需人工判讀的獨立分類（顯示為「無法判定」），**不落回「無折扣」、也不略過該筆**（D17：顯眼標記不一致處）。

### 9.4 檔案產出與樣式

報告樣式沿用 `web/src/app/globals.css` 的 design token 與元件版型（`.meta-panel`／`.stat-card`／`.data-table`／`.tabs`），不另立調色盤，以維持與系統一致的視覺語言。
