# 學生收費核對工具：規格與交接入口

版本：2026-09-29。P1 已有本機實作；目前正式規則為 erp-tag-v2（D30），班名候選依D32動態產生。歷史規劃文件中的「尚未實作」不代表目前進度。

本次新增 UI 設計交付，尚未修改產品介面：

- [09 UI／UX 重設規格](09-ui-workflow-redesign-spec.md)
- [10 UI 重設實作 Plan](10-ui-workflow-redesign-plan.md)
- [可點選介面示意（合成資料）](design/ui-workflow-prototype.html)

先課表 → 匯入 → 核對；09/10優先定義新操作介面，02與D24–D32計算決策不變。

## 閱讀順序

1. [產品與分階段規格](./01-product-spec.md)：範圍、使用流程、prototype 驗收。
2. [Excel 規則與來源](./02-calculation-rules.md)：必須保留的公式語意、課程情境折扣、待釐清差異。
3. [資料模型與 API](./03-architecture-api.md)：TypeScript / Node 24、本機儲存、agent 查詢、未來雲端遷移。
4. [TDD 與驗收](./04-tdd-acceptance.md)：先測什麼、如何比對 Excel、哪些地方不能只靠現有樣本。
5. [點名表範本規格](./05-attendance-templates.md)：六種範本、Excel A4 保真、日期與容量。
6. [交接與待確認事項](./06-handoff-decisions.md)：下一個 session 的 plan 邊界與未決事項。
7. [Review 修正對照](./reviews/spec-review-resolution-20260922.md)：F01–F15處理、採納方式與剩餘驗證。
8. [P1 implementation plan](./07-p1-implementation-plan.md)：T00–T07順序、三個展示節點、技術選擇、TDD與完成定義；尚未開始實作。

9. [P1 最終複核與修正](./reviews/p1-final-verification-20260923.md)：最新契約修正、驗證範圍與啟動條件；較早review保留歷史原文。

## 已確認的方向

- 第一階段就必須有 localhost 可操作頁面：匯入 ERP 學生檔、維護班級時間、篩選班級／學生／科目、看到計算結果。
- 財務報表不匯入此工具。人員在 ERP 財務報表按班級、會計科目逐一核對；未來 agent 可讀此工具 API，另行解讀財務報表。
- 5 天指週一到週五；3、3.5、4、4.5、5 是每週收費天數／收費級距，不是當月實到天數。
- 寫功課課程不列入折扣計算；美安是歷史班名，目前未實際開班。
- 正式erp-tag-v2（D30）從「標籤」計算優惠，備註原文保留、不fallback。舊版讀備註的快取含已確認來源缺陷，僅作診斷。
- 一般安課班名[3_5]為3.5天、無級距後綴為5天，與計算值並列比較、不互相覆寫；离班標記不排除名單。
- 先不做登入／RBAC；本機測試。未來 Firestore + Vercel + Google 登入，上線前另行規劃。
- 不串 ERP、不自動開帳單、不在本 session 實作。

## 證據與限制

根目錄三份來源 Excel 皆保持原檔。`data/evidence/workbook-inspection.json` 保存 SHA-256、工作表結構、全部公式文字（含陣列公式）、既存快取值及列印設定。`data/evidence/cached-summary-baseline.json` 保存 477 筆學生的八個總表輸出快取，供後續逐列比對。

本次以 openpyxl 讀取及 OOXML 層級結構分析，沒有在 Windows Excel 重新計算／列印，沒有執行產品測試。因此快取是「參考基準」，不是已驗證的新引擎結果；列印設定也不等於已通過 A4 實印驗收。下一個 session 必須依 TDD 文件完成比對，不能宣稱本 spec 已證明替代引擎正確。

v2不更改原快取數值，只補其ruleSet與F01缺陷metadata。正式測試另建expected；review提供的使用者確認與建議須區分，處理方式見修正對照。

證據檔位於 `/data/evidence/`（含學生代碼與部分公式快取，屬本機工作資料，被 `.gitignore` 排除）；`specs/` 目錄保持乾淨無個資。
