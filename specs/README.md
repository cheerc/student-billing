# 學生收費核對工具：規格與交接入口

版本：2026-10-27。D60 決策定案：系統全面減法，以單一現況留存模型為核心（唯一一份最新已啟用學生名單、唯一一份最新課表設定、唯一一筆當前計算 Run，移除 /history），計算一律使用單一現行規則 `erp-tag-v4`，收斂為 3 頁 UI 與 11 條 API（4 條 Agent 查帳 GET API + 7 條 Web 操作工作流路由）。

UI 重設（先課表 → 匯入 → 核對）R0–R5 已交付並合併，驗收見[progress/ui-redesign-acceptance.md](progress/ui-redesign-acceptance.md)。人工驗收已歷七輪修正：第一輪（2026-09-30，受驗 `e1b1a58`）裁決 REJECTED，開啟 R2–R6 的修正循環；**第七輪（2026-10-05，受驗 `6aacb6c1`）簽核 PASS**，R6-F01、R6-F02 在指定條件下皆未重現。交付基準為 release tag **v0.0.1**（`main` `e4b4efce`；`web/package.json` 的 `version` 欄為 `0.1.0`，與 tag 名稱不一致，兩者不是同一個版本號，本文件不作合併）。歷次 FAIL → 修正的對照與第七輪簽核範圍見[progress/manual-acceptance-rounds.md](progress/manual-acceptance-rounds.md)。第一輪的修正計畫與決策如下：

> **進度同步（2026-10-23）**：本段以下較早的 v2/v3 進度說明均保留作歷史記錄。現行新計算版本、explicit v4 upgrade gate 與 historical read-only projection 見 [02 §9A](02-calculation-rules.md)、[03 §5.6](03-architecture-api.md)、[06 D57](06-handoff-decisions.md)。Class semantics registry/snapshot 見 [03 §5.7](03-architecture-api.md)、[06 D58](06-handoff-decisions.md)；PR-4 current consumers 與 operator-approved one-time `legacy_migration` 見 [03 §5.8](03-architecture-api.md)、[04 UX102](04-tdd-acceptance.md)、[06 D59](06-handoff-decisions.md)。

- [09 UI／UX 重設規格](09-ui-workflow-redesign-spec.md)（含 2026-09-30 修訂的目標契約）
- [10 UI 重設實作 Plan](10-ui-workflow-redesign-plan.md)（R0–R5，已交付）
- [11 第一次人工驗收修正 Plan](11-ui-acceptance-fix-plan.md)（PR-0、A、S、B1、B2、C、D 分批；決策見[06 D34–D39](./06-handoff-decisions.md)）
- [12 第二次人工驗收修正 Plan](12-round2-acceptance-fix-plan.md)（R2-F01／R2-F02 與驗收工具 T1／T2／T3；第三次人工驗收清單由 Lead 依其 §4 產出）
- [13 人工驗收歷次收斂紀錄](progress/manual-acceptance-rounds.md)（第一至七輪的 FAIL → 修正對照、第七輪簽核範圍與已知限制）
- [可點選介面示意（合成資料）](design/ui-workflow-prototype.html)

**待裁示的後續事項（已開 issue，皆不擋本次交付）**：

|issue|主題|
|---|---|
|[#99](https://github.com/cheerc/student-billing/issues/99)|課表分組界線因 `border-collapse: separate` 由 1px 變約 2px，待裁示是否修|
|[#100](https://github.com/cheerc/student-billing/issues/100)|學生明細「各課程適用率」與學生總表格式不一致（% vs 折、- vs —），待裁示|
|[#101](https://github.com/cheerc/student-billing/issues/101)|E2E（49 spec）尚未進 CI，需裁示範圍與時間成本|

先課表 → 匯入 → 核對的方向記於[06 D33](./06-handoff-decisions.md)；操作介面契約見09，實作分批見10與11（執行計畫），驗收矩陣見[04 §8](./04-tdd-acceptance.md)。窗口固定、不可編輯，有效日期不在範圍（D33）；D24–D32計算決策不變，計算規則變更（D37）只走 11 的 D2 與新 ruleSet 版本（D 批依 [06 D40](./06-handoff-decisions.md) 拆為 D1 入口收斂與 D2 v3）。

## 閱讀順序

1. [產品與分階段規格](./01-product-spec.md)：範圍、使用流程、prototype 驗收。
2. [Excel 規則與來源](./02-calculation-rules.md)：必須保留的公式語意、課程情境折扣、待釐清差異。
3. [資料模型與 API](./03-architecture-api.md)：TypeScript / Node 24、本機儲存、agent 查詢、未來雲端遷移。
4. [TDD 與驗收](./04-tdd-acceptance.md)：先測什麼、如何比對 Excel、哪些地方不能只靠現有樣本。
5. [點名表範本規格](./05-attendance-templates.md)：六種範本、Excel A4 保真、日期與容量。
6. [交接與待確認事項](./06-handoff-decisions.md)：下一個 session 的 plan 邊界與未決事項。
7. [Review 修正對照](./reviews/spec-review-resolution-20260922.md)：F01–F15處理、採納方式與剩餘驗證。
8. [P1 implementation plan](./07-p1-implementation-plan.md)：T00–T07順序、三個展示節點、技術選擇、TDD與完成定義；尚未開始實作。

9. [UI／UX 重設規格](./09-ui-workflow-redesign-spec.md)：先課表→匯入→核對的畫面與操作契約（含 2026-09-30 修訂的目標契約）。
10. [UI 重設實作 Plan](./10-ui-workflow-redesign-plan.md)：R0–R5 分批（已交付）。
11. [第一次人工驗收修正 Plan](./11-ui-acceptance-fix-plan.md)：驗收修正的分批、順序、停止條件；決策全文在 [06 D34–D39](./06-handoff-decisions.md)。
12. [第二次人工驗收修正 Plan](./12-round2-acceptance-fix-plan.md)：第二輪兩項 FAIL 的修正來源、驗收列 UX74–UX77，以及隔離驗收環境／故障注入代理／合成測試檔三項工具的指令與限制。
13. [P1 最終複核與修正](./reviews/p1-final-verification-20260923.md)：最新契約修正、驗證範圍與啟動條件；較早review保留歷史原文。
14. [課程類型分類與課表設定重構 Plan](./14-class-type-settings-plan.md)：課表設定改為依課程類型的分頁籤（安親課輔班／非安親課輔班）；固定 5 天旗標與課程學費折扣解耦。
15. [系統全面減法、單一現況收斂與 Agent 查帳 API 整理 Plan](./15-class-semantics-simplification-plan.md)：D60 決策落實，拆除 #148 語意面板、退役 6 欄點名表天數、單一現行規則 erp-tag-v4、單一現況留存模型（移除 /history）、收斂為 3 頁 UI + 11 條 API。
16. [五種課程類型重構、「是／否」單選統一與未填時間醒目警示 Plan](./16-five-class-types-yes-no-refactor-plan.md)：D61 決策落實，課程類型擴充收斂為 5 種、布林設定全面統一為 YesNoRadioGroup 單選、2×2 計費解耦、其他班所見即所得扣天、1c 未填時間雙重視覺警示、Excel 9 欄五類型匯出入契約。
17. [班名同步重構 Plan](./17-class-name-sync-plan.md)：D62 決策落實，名冊班名與課表班名改採嚴格同名比對，差異一次一列由使用者選擇合併或新增，不建立新別名、不提供批次同步。
18. [夜間全量 E2E 復原 Plan](./18-nightly-e2e-d61-recovery-plan.md)：Issue #188 的 D61 契約落差修復，族 A 導覽 helper、族 B 淘汰選取器、族 C 幾何前提、族 D 空白星期契約，並以「失敗集合」而非重跑綠燈驗收。

## 已確認的方向

- 第一階段就必須有 localhost 可操作頁面：匯入 ERP 學生檔、維護班級時間、篩選班級／學生／科目、看到計算結果。
- 財務報表不匯入此工具。人員在 ERP 財務報表按班級、會計科目逐一核對；未來 agent 可讀此工具 API，另行解讀財務報表。
- 5 天指週一到週五；3、3.5、4、4.5、5 是每週收費天數／收費級距，不是當月實到天數。
- 寫功課課程不列入折扣計算；美安是歷史班名，目前未實際開班。
- 新 Run 固定 `erp-tag-v4`，從「標籤」計算優惠，備註原文保留、不 fallback。舊版讀備註的歷史 Run 僅唯讀展示；舊診斷表與 raw issue values 保留，不參與新計算。
- v4 語意 consumer 使用 immutable Run `classSemantics`／`classCategories`；summary roles 只對接八個既有欄位，ERP tier parsing 依明確 applicability。非 seed 舊設定只有經明確一次性 `legacy_migration` 才保存；舊 Run 不回填。
- 一般安課班名[3_5]為3.5天、無級距後綴為5天，與計算值並列比較、不互相覆寫；離班標記不排除名單。
- 先不做登入／RBAC；本機測試。未來 Firestore + Vercel + Google 登入，上線前另行規劃。
- 不串 ERP、不自動開帳單、不在本 session 實作。

## 證據與限制

根目錄三份來源 Excel 皆保持原檔。`data/evidence/workbook-inspection.json` 保存 SHA-256、工作表結構、全部公式文字（含陣列公式）、既存快取值及列印設定。`data/evidence/cached-summary-baseline.json` 保存 477 筆學生的八個總表輸出快取，供後續逐列比對。

本次以 openpyxl 讀取及 OOXML 層級結構分析，沒有在 Windows Excel 重新計算／列印，沒有執行產品測試。因此快取是「參考基準」，不是已驗證的新引擎結果；列印設定也不等於已通過 A4 實印驗收。下一個 session 必須依 TDD 文件完成比對，不能宣稱本 spec 已證明替代引擎正確。

v2不更改原快取數值，只補其ruleSet與F01缺陷metadata。正式測試另建expected；review提供的使用者確認與建議須區分，處理方式見修正對照。

證據檔位於 `/data/evidence/`（含學生代碼與部分公式快取，屬本機工作資料，被 `.gitignore` 排除）；`specs/` 目錄保持乾淨無個資。
