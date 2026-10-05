# 人工驗收歷次收斂紀錄（第一至七輪）

本檔記錄瀏覽器人工驗收各輪的裁決、FAIL → 修正的對照，以及第七輪的簽核範圍與限制。它是**索引與結論層**：第一輪的完整驗收報告（Plan 10 R5，2026-09-29／09-30）保留在[ui-redesign-acceptance.md](ui-redesign-acceptance.md)，該檔 §12 記錄第一次人工驗收 REJECTED 的逐條更正，兩者不互相取代。

> **來源界線**：人工驗收報告與截圖是 operator／其派遣 agent 的本機工作資料，含匿名學生姓名與「驗收老師」等現場資訊，**不納入 repo**。本檔只寫結論與可核對的 repo 座標（issue／PR／commit），不含截圖、證據檔或本機絕對路徑。
>
> **不得混淆**：本檔的人工結果不等於自動化測試結果。反之亦然——PR 上的 CI／E2E 綠燈不構成人工驗收通過。兩者只在同一列並列，不互相推論。

## 1. 各輪裁決

日期欄只填 repo 或 issue 內可核對者；「未記錄」表示該輪日期沒有留在 repo 的紀錄中，本檔不推測。

|輪次|日期|受驗 SHA|裁決|觸發的修正|
|---|---|---|---|---|
|第一輪|2026-09-30|`e1b1a58`|REJECTED（F01–F08、O01–O03）|R2、R3、R4、R5、R6 五個修正循環|
|第二輪|未記錄|`ca73cf1`|REJECTED（R2-F01、R2-F02）|R3|
|第三輪|未記錄（issue 開於 2026-10-02）|`84a7238`|REJECTED（R3-F01、R3-F02 及其他）|R4|
|第四輪|未記錄|未記錄（該輪修正 PR #75–#78 的 base 為 `46a3b6a`）|REJECTED（R4-F01～R4-F03、R4-S01）|R5|
|第五輪|未記錄|`fce99b6f`|REJECTED（R5-F01）|R6|
|第六輪|未記錄（issue 開於 2026-10-05）|`446db17`|REJECTED（R6-F01、R6-F02）|—（無後續 FAIL）|
|**第七輪**|**2026-10-05**|**`6aacb6c1`**|**PASS**|—|

**交付基準**：release tag **v0.0.1** = `main` `e4b4efcee7a8871f5ffd53714c37b572387b69d3`。tag 之後 main 僅多 PR #98（`e4b4efc`，將 `sharp` 宣告為 devDependency，非產品碼）。第七輪的受驗 SHA `6aacb6c1`（PR #97 merge）是該 tag 的祖先，二者之間的差異只在相依宣告。

> `web/package.json` 的 `version` 欄為 `0.1.0`，與 tag 名 `v0.0.1` 不是同一個版本號。交付基準以 tag 為準；本文件不把兩者寫成同一版本。

## 2. FAIL → 修正對照

各列的「修正」欄給出可在 repo 核對的座標（merge commit／PR／issue）；不重述每項修正的實作細節（那是各 PR 描述與對應 issue 的責任）。

### 第一輪 → 第二、三、四、五、六輪

第一輪的 FAIL 清單（F01–F08、O01–O03）與逐條 disposition 完整保留在[ui-redesign-acceptance.md §12](ui-redesign-acceptance.md#12-2026-09-30-更正operator-第一次人工驗收)；修正計畫見[11](../11-ui-acceptance-fix-plan.md)，決策見[06 D34–D39](../06-handoff-decisions.md)。本表不重複該清單。

### 第二輪 → 第三輪

|FAIL|主題|修正|
|---|---|---|
|R2-F01|篩選後的班級扣天編輯課表再 Back，丟失頁籤與條件（E02、K01）|PR #49（merge `84a7238`）|
|R2-F02|儲存課表重算後，核對基準日被改成 UTC 日期（K01、I02）|PR #49（merge `84a7238`）|

### 第三輪 → 第四輪

|FAIL|主題|修正|
|---|---|---|
|R3-F01（N02／UX65）|類別異動預覽缺科數／合計折扣明細|[#54](https://github.com/cheerc/student-billing/issues/54) → PR #56（merge `020e6c5`）|
|R3-F02（N09／UX70）|改名儲存後報告與候選表／頁籤計數未同步|[#55](https://github.com/cheerc/student-billing/issues/55) → PR #58（merge `30bf01d`）|
|第三輪清單其餘項|[#57](https://github.com/cheerc/student-billing/issues/57)（T2 代理 Host／Origin）→ PR #68（merge `cd15b4d`）；[#59](https://github.com/cheerc/student-billing/issues/59)（`tierMismatch=false` 語意）→ PR #60（merge `6c80a71`）|

### 第四輪 → 第五輪

|FAIL|主題|修正|
|---|---|---|
|R4-F01|［重新載入］帶自動重試，未轉［重新整理頁面］|PR #77（merge `b9d431b`）|
|R4-F02|同頁連續匯入第二次啟用 409（CAS 過期）|PR #75（merge `9a6099c`）|
|R4-F03|篩選到 0 人時表頭與表頭篩選入口消失|PR #76（merge `100b36d`）|
|R4-S01|學生明細顯示內部 `null` 字樣|PR #78（merge `ec4803f`）|

### 第五輪 → 第六輪

|FAIL|主題|修正|
|---|---|---|
|R5-F01|課表兩列表頭捲動後重疊，窗口標題被蓋住|[#87](https://github.com/cheerc/student-billing/issues/87) → PR #90（merge `c907c76`）|

### 第六輪 → 第七輪

|FAIL|主題|修正|
|---|---|---|
|R6-F01|課表兩層表頭接縫露出資料列字樣|[#96](https://github.com/cheerc/student-billing/issues/96) → PR #97（merge `6aacb6c1`）|
|R6-F02|核對結果頁學生總表姓名表頭被資料列姓名按鈕蓋住|[#96](https://github.com/cheerc/student-billing/issues/96) → PR #97（merge `6aacb6c1`）|

PR #97 修正 R6-F01 時將 `.schedule-table` 由 `border-collapse: collapse` 改為 `separate` + `border-spacing: 0`（11 個堆疊／背景候選皆量測為無效後採此方向）。該改動的副作用（分組界線 1px → 約 2px）已開 [#99](https://github.com/cheerc/student-billing/issues/99) 待裁示。

## 3. 第七輪簽核（2026-10-05，受驗 `6aacb6c1`）

operator 2026-10-05 裁示「進入交付」。第七輪由 operator 派 agent 執行瀏覽器人工驗收，**簽核 PASS**。

### 3.1 範圍

- 五組必驗流程（第一次人工驗收清單的必驗項）全部 PASS。
- **R6-F01**（課表兩列表頭接縫露字）與 **R6-F02**（核對結果頁姓名表頭被蓋住）在指定條件下皆未重現。
- R5-F01（課表兩列表頭捲動重疊）未重現。

### 3.2 限制（照驗收報告原文）

- **以目視截圖為主**：結論來自目視觀察截圖，不是像素差分比對。
- **未做像素差分**：沒有對畫面做自動化像素級比較，因此「未重現」的判定力受目視解析度限制。
- **未重驗過去各輪的完整清單**：第七輪未逐條重跑第一至六輪的完整驗收清單，其餘項目沿用前輪結論與 PR 的自動化證據。

### 3.3 本節不宣稱的事

- 本節不主張產品「全部驗收通過」，只主張第七輪指定範圍內 PASS。
- 本節不主張先前各輪的 FAIL 已被同一輪重驗。
- 本節的 PASS 不與自動化測試 PASS 混稱（見檔首「來源界線」）。

## 4. 待裁示的後續（不擋交付）

|issue|主題|狀態|
|---|---|---|
|[#99](https://github.com/cheerc/student-billing/issues/99)|課表分組界線因 `border-collapse: separate` 由 1px 變約 2px|OPEN，待裁示是否修|
|[#100](https://github.com/cheerc/student-billing/issues/100)|學生明細「各課程適用率」與學生總表格式不一致|OPEN，待裁示|
|[#101](https://github.com/cheerc/student-billing/issues/101)|E2E（49 spec）尚未進 CI|OPEN，需裁示範圍與時間成本|

這三項是第七輪觀察到但未列為 FAIL 的事項，依 operator 裁示不阻擋本次交付。