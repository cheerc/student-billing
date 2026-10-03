# TDD 與驗收規格

> 2026-09-29 UI重設補充：先課表流程方向見[06 D33](06-handoff-decisions.md)，UI契約見[09](09-ui-workflow-redesign-spec.md)；UI重設的驗收矩陣UX01–UX24是本檔§8的正式驗收，實作拆分見[10](10-ui-workflow-redesign-plan.md)。2026-09-30第一次人工驗收後，§8修訂UX07、UX13並新增UX25–UX33（見[11](11-ui-acceptance-fix-plan.md)）。計費規則沿用目前D24–D32，不由UI改版變更。

## 1. 測試原則

每個可觀察業務行為先寫會失敗的測試，再寫最小實作，再整理程式。重點是從具體輸入得到獨立預期結果，而不是快照整段 DOM 或用產品計算函式替自己產生 expected。

測試分兩層語意：`excel compatibility` 鎖定原公式；`product validation` 檢查新工具如何顯示缺漏／未知／相容 fallback。把 missing schedule 變成 warning 不代表允許忘記原 Excel 的 0 fallback；也不代表 UI 可以隱藏問題。

現有快取屬 excel-v260922-compat，取自未套用標籤workaround的缺陷狀態，**不得作正式業務golden**。erp-tag-v1另建expected，以原標籤和已確認規則獨立手算／審查結果佐證；建議對副本把標籤複製到備註後以Windows Excel重算並記錄hash，保留原檔。尚無此原生基準時清楚標註，不拿新引擎輸出替自己產生expected。

## 2. Fixture 管理

|fixture|用途|預期值來源|
|---|---|---|
|提供的三份原始 XLSX|人工閱讀、匯入與相容比對；財務檔不進產品流程|SHA-256 manifest 保護原檔|
|cached-summary-baseline.json|只測歷史compat 477人八欄|已知F01缺陷狀態，非業務正確基準；尚未原生重算|
|erp-tag-v1真實樣本expected（待建立）|正式標籤命中、級距、與舊版差異|原標籤＋獨立案例；review數字另需實作重現，不直接複製新引擎輸出|
|匿名合成學生 XLSX|同名、隱藏欄、重排欄、特例備註|人工訂立資料和 expected|
|保形匿名 ERP fixture|以真實ERP檔的OOXML儲存形狀跑I01／I05|複製原檔就地替換`<t>`文字，不經函式庫重寫|
|小型排課 fixtures|邊界時間／負數取整|公式推導＋必要時 Excel 重算|
|模板輸出 fixtures（P3）|0 人、容量邊界、超額、長字串|Windows Excel Print to PDF 基準|

真實樣本留本機，未來Git／CI使用合成或一致匿名化fixture；保留代碼關聯、班名文法及標籤規則語意。備註診斷另匿名化，不能刪除標籤後仍期待優惠命中。

**匿名化必須同時保留來源的OOXML儲存形狀，不只保留值。** 本次唯讀查得ERP匯出檔為非Excel原生結構：無`sharedStrings.xml`、Sheet1全部3,652格為`inlineStr`、無`<dimension>`、`<t xml:space="preserve">`；計算檔則使用sharedStrings並有dimension。以函式庫重新產生可能改變 sharedStrings／inlineStr、dimension 等形狀，取決於版本與選項；不能假定新檔與原 ERP 相同，也不能宣稱函式庫必然使用 sharedStrings。因此匿名化做法是複製原檔並替換 XML 文字值（正確處理跳脫與 xml:space），保留相關結構；ZIP 可重打包，不要求位元組相同。上 CI 前須檢查所有 ZIP entries 中的姓名、代碼、電話、自由備註及文件中繼資料，保形不代表已匿名；至少保留一個此形狀的fixture供I01／I05使用。合成的欄位重排／隱藏fixture可沿用函式庫產生，但不得取代保形fixture。

基準擷取必須包含來源 hash、擷取時間、引擎／Excel 版本、是否重算、學生 personCode、來源列、每個輸出型別。姓名只用定位不作比對鍵。原表 E/F 字串如 `4.5*額` 轉換為數值＋旗標後比較；原「非課輔」映射 not_applicable；空白與零不能互換。

## 3. 規則單元測試矩陣

|ID|輸入／情境|必須觀察到的結果|
|---|---|---|
|U01|13:00–14:00 對安親 13:00–16:00|60 分鐘；raw -1/3|
|U02|12:00–13:00、16:00–17:00 對安親|皆重疊 0|
|U03|12:00–17:00 對安親|180 分鐘而非 300|
|U04|end=18:30；start=16:30|課輔重疊 120，但不觸發嚴格大於 18:30，raw=-2/3|
|U05|16:30–18:31|121 分鐘，特殊課輔 raw=-1|
|U06|17:00–19:00|正式整數分鐘：120 分鐘、raw=-1、取整 -1。**原生 Excel 也走 -1，不是 DIFF-01 實例**：日分數重疊的儲存值是 119.99999999999989（計算檔 S!G10 同型快取即此值），但使用者 2026-09-23 在 Excel 實測 `((19:00-17:00)*24*60)>=120` 為 TRUE。compat 診斷路徑必須得到 -1、**不得**產生 NUMERIC_POLICY_DIFFERENCE。直接用 IEEE754 位元比較會得 `>=120` 不成立、取整 -0.5，這是已知與 Excel 不符的錯誤重建，本案例即其回歸測試。已確認的 DIFF-01 實例見下方「兩堂各 18 分鐘」|
|U07|17:31–19:30|119 分鐘，end 不小於 19:30，raw=-119/180|
|U08|start=17:00，end=19:29/19:30/19:31|重疊149/150/150分鐘；raw=-1/-150÷180/-150÷180|
|U09|R03 扣天量 d=0、1/6、1/3、2/3、0.75、1、1.25、2/9|erp-tag-v1：0、0、-0.5、-0.5、-0.5、-1、-1、0；compat 原公式：0、0、-0.5、-0.5、-1、-1、-1.5、-0.5。兩組 expected 分開，不得共用|
|U10|erp-tag-v1 扣天量小數部分 f=0.3、0.5、0.8 與前後一分鐘|f=0.3→0.5、0.5→0.5、0.8→1；略小於0.3→0、略小於0.8→0.5；以可重現有理數表示。門檻由 ruleSet 參數讀取，另測改參數會產生新 ruleSetVersion、不改舊 run|
|U11|Gino 既有三時段|安親 110 分鐘→-0.5，課輔 70→-0.5|
|U12|同班兩筆各 -1/6|先合計 -1/3→-0.5；不能逐堂先取整成 0 再相加|
|U13|同日兩堂重疊／週六一堂|同日兩堂按每列相加不做 union；週六一堂在 compat 與 erp-tag-v1 仍按時刻重疊相加；erp-tag-v2 (D30) 同星期才算衝堂，星期六對一～五窗口重疊為 0|
|U14|更改安親時間窗成 4 小時|除數仍 180，驗證窗口與收費日長度分開|
|U15|只美語、數學＋美語、輔導＋數學＋美語（v2 行為）|科數 1/2/3，基本率 10000/9500/9000|
|U16|兩個美語班（v2 行為）|科數 1；天數只抽第一班並提示多班|
|U17|國小輔導-寫功課＋數學＋美語（v2 行為）|科數 2；基本率 9500；寫功課自身適用率 10000|
|U18|只有國小輔導-寫功課（v2 行為）|科數 0，基本率 10000|
|U19|無目標三類科別，但其他班名含寫功課（v2 行為）|科數 0，不減為 -1|
|U20|一般輔導＋寫功課＋數學，無其他優惠（v2 行為）|科數1，基本率10000；混合情境needs_review|
|U21|1 科＋兄弟姊妹；2 科＋兄弟姊妹|基本率 9500、9000|
|U22|特殊 95/85/7/8/9 折各一例|分別 9500/8500/7000/8000/9000，覆蓋一般率|
|U23|特殊 95 折＋3 科|仍 9500，不自動取較優惠 9000|
|U24|多特殊標記／多額外扣天標記|依原優先序產出相容值，同時 needs_review|
|U25|標籤四種額外扣天、未命中、空標籤|0.5/1/2/1.5/null；不把null存成零，不從備註補入|
|U26|小一，ma=-0.5、en=-0.5、extra=0|安親 4 天|
|U27|小二，合計負扣天 -2、extra=1|安親下限 3.5，extra flag 保留|
|U28|小三，合計 -2.5、extra=1|課輔下限 3|
|U29|寫功課且有衝堂和 extra|MAX 第三參數令天數 5，仍保留 *額|
|U30|小一沒有安親報名，只有美語（v2 行為）|原年級天數可算，enrolled=false，不建立安親應開項目|
|U31|中班／小班／大班／國一；無／null／空字串／未知字串|前者not_applicable；後者unavailable；樣本「無」1筆|
|U32|數學名含年度、美語含附加級別|正確抽到第一個目標前綴到 [團]，保留全部原文|
|U33|無班名設定、有一般班但無時段、有完整時段但無重疊、部分時段缺漏|分別schedule_not_found/schedule_empty/no_overlap/schedule_incomplete；前兩者0扣天fallback但needs_review，no_overlap才calculated；共用care_window不誤報空時段|
|U34|安親園內生 basic=10000/9500/9000/8500|適用率 9500/9000/9000/9000|
|U35|課輔園內生 basic=9500|不額外減 500，仍 9500|
|U36|寫功課／歷史美安＋園內生|安親情境優先 10000；美安不自動創建現行班|
|U37|美語／數學 vs 國語文／加強班|前兩者基本率；後兩者課程適用率 not_configured|
|U38|無班級、有姓名|科數 null；基本率 10000（無折扣）；保留學生（刻意與原 Excel 樣本 null 分歧，operator 2026-10-03 裁決；開發階段不考慮舊 run）|
|U39|無班級但有特殊率／兄弟姊妹|無報名時特殊折扣仍優先；僅有兄弟姊妹標籤且無特殊折扣時基本率仍為 10000（無折扣）。兩種情境的科數均為 null、課程適用率均為 null；UI 不因此創建應繳項目|
|U40|備註「非園內生」、標籤無園內生|正式false，備註只診斷不fallback；若否定字串出現在標籤，舊substring候選值帶疑義；不用NLP默改|

U01–U40的一般數值expected採正式精確分鐘策略；另跑浮點診斷，不能把兩者差異藏在容差中。U04–U08／U10須成對保存日分數輸入、運算步驟、raw/f值及分支。

**DIFF-01 已由原生 Excel 確認存在，但發生位置與先前 IEEE754 重建的說法不同。**

使用者 2026-09-23 在 Excel 副本以與 S 表相同的分格運算（重疊分鐘 → `-G/60/3` → 同班加總 → C 表取整公式）實測四例：

|案例|Excel 儲存的中間值|被比較的值|原生 Excel|精確分鐘|IEEE754 逐位元比較|
|---|---|---|---:|---:|---:|
|U06 課輔 17:00–19:00，`>=120`|119.99999999999989|119.99999999999989|成立 → -1|-1|-0.5|
|安親單堂 13:00–13:36（36分）|-0.20000000000000015|MOD=0.7999999999999998|**0**|0|-0.5|
|安親單堂 13:00–15:06（126分）|-0.7000000000000002|MOD=0.2999999999999998|**-0.5**|-0.5|-1|
|同班兩堂各 13:00–13:18，加總|-0.20000000000000107|MOD=0.7999999999999989|**-0.5**|**0**|-0.5|

- **Excel 的算術與 IEEE754 重建一致，比較運算則不是逐位元**（S!G10 快取即 119.99999999999989，S 表 93 列重建 0 筆不符）。四例皆符合「兩邊先取 15 位有效數字再比較」的假設模型，此模型亦重現 C 表全部 108 個取整快取（0 筆不符）；但它只是與觀察一致的假設，不是 Microsoft 公開規格，Excel 版本也未記錄。
- **U06 不是 DIFF-01 實例**：原生 Excel 與精確分鐘同為 -1，compat 路徑不得對它產生 NUMERIC_POLICY_DIFFERENCE。
- **已確認的 DIFF-01 實例是「兩堂各 18 分鐘加總」**：精確合計 -1/5、取整 0；原生 Excel 取整 -0.5，差 0.5 天。多堂加總會累積誤差，超出 15 位有效數字的吸收範圍；單堂邊界（36／126 分）的微小誤差則被吸收。
- 先前「單堂 36／120／126 分鐘才會分歧」的特徵是逐位元比較的產物，**作廢**。分歧只能在完整運算鏈（逐列 → 同班加總 → 比較）上逐班實算判定。
- **compat 診斷路徑**：以 IEEE754 算術重建各列與加總，比較時套用上述 15 位有效數字模型；以本表四例為必過的原生錨點。模型若遇到與原生 Excel 不符的新案例，以原生值為準並修正模型，不以容差掩蓋。
- 現有49班兩路徑結果一致，不受影響；實作仍須重現。

仍不得把十進位0.8的IEEE表示本身當成 `<0.8` 的證據，也不得在單元測試中以 IEEE754 位元比較結果充當 Excel expected。

|ID|新增正式規格測試|expected|
|---|---|---|
|U41|標籤有優惠／備註無；標籤無／備註有；兩欄同值；兩欄不同值|正式只取標籤；備註無命中不報衝突；同值只套一次；備註有命中且異於標籤才CONFLICTING_NOTE_SOURCE。真實樣本固定值：CONFLICTING_NOTE_SOURCE 恰1筆（來源列205，備註敘述含「園內生」與「(弟弟園內幼幼班)」而標籤為空）、兩欄同時命中0筆；「兩欄同值」分支樣本無案例，需合成補測|
|U42|員工家屬／有搭車／需月繳|原文保留，無自行產生折扣或費用|
|U43|一般安課 [3_5]/無後綴/[4_5]/未知後綴；美語[W1]|3.5/5/4.5/unavailable；美語not_applicable；ERP值不得回饋計算|
|U44|同學生兩個安課enrollment|各有tierComparison；列表人數仍1，mismatch任一命中可篩出|
|U45|離班標記在過去／未來日期|只解析明確格式、顯示日期；名單、科數、扣天均不排除|
|U46|四年級A/B及無A/B的數學一班|不子字串併班，不自動映射一A；未對應仍在待設定名單|
|U47|缺排課但計算fallback等於ERP級距|tierComparison=match且計算needs_review；不能因match消除警告。真實樣本固定值：13名schedule_not_found學生**全部13人**皆為match，非邊界個案；以tierMismatch=false篩選時這13人仍須出現在hasIssues清單，兩個狀態同時成立|
|U48|同一學生：兒童美語×2／國小數學×2／一般國小輔導×2／寫功課×2／寫功課＋一般輔導（v2 行為）|前三者及寫功課×2產生 DUPLICATE_SUBJECT_ENROLLMENT；一般輔導＋寫功課各一筆不產生此碼但保留U20混合提示。各重複類別列出全部 token 與各自 ERP 級距；**數學／美語扣天仍各取第一班，科數仍依R09含寫功課扣1，數值完全不變**。真實樣本恰 2 人：列52（美語×2）、列43（國小輔導×2）；國小輔導那筆在八欄結果中無任何差異，只能靠本提示發現|
|U49|標籤員工家屬且無三種優惠標記／員工家屬＋特殊折扣／僅有搭車／僅需月繳|第一種產生 STAFF_FAMILY_NO_DISCOUNT，其餘皆不產生；另測員工家屬＋兄弟姊妹／園內生不提示，員工家屬僅有多科一般折扣或額外扣天仍提示（依R18標籤判定）；**任何情況都不推論折扣率**。真實樣本恰 5 人（列117/132/135/195/319）；有搭車16人、需月繳0人不得觸發|
|U50|v3 類別式科數（D37 ①）：一般輔導＋寫功課＋數學（年級 4，Q1 寫功課不列入）|類別種數 {care, math}＝2 科，基本率 9500 bps；加兄弟姊妹 3 科 9000 bps；取代 v2 名稱式與「寫功課減 1」|
|U51|v3 類別式科數：一般輔導＋寫功課（無其他科）＋兄弟姊妹|{care}＝1 科，加兄弟姊妹 effectiveCount＝2，基本率 9500 bps（v2 為 0+1=1 科 10000 bps）|
|U52|v3 衝堂扣天選班（D37 ②）：課輔側（年級 4）重複美語甲（扣 0.5）與乙（扣 1.0）|取正量扣除量最多之乙（扣 1.0），課輔天數 4.0（v2 取首班甲扣 0.5 天數 4.5）|
|U53|v3 衝堂扣天選班：安親側（年級 2）重複美語甲（扣 0.5）與乙（扣 1.0）|取正量最多之乙（扣 1.0），安親天數 4.0（v2 取首班甲扣 0.5 天數 4.5）|
|U54|v3 衝堂扣天選班：適用側決定選班（美語 X 課輔扣 0.5、Y 安親扣 0.5）|年級 2 取 Y 安親天數 4.5；年級 4 取 X 課輔天數 4.5|
|U55|v3 衝堂扣天選班：正量相同平手取報名順序在前者（token_index 較小）|兩班扣天量相同時穩定取首班|
|U56|v3 衝堂扣天選班：首班未排課（schedule_not_found），第二班可計算（扣 0.5）|在可計算候選中選第二班（天數 4.5），且保留首班之 SCHEDULE_NOT_FOUND 需確認警告|
|U57|v3 衝堂扣天選班：含未知星期候選（Q5-B）|以 fail-closed 值參與比較，並保留 UNKNOWN_WEEKDAY 警告|
|U58|v3 固定 5 天下限（R11/R12/Q7-A）：寫功課班且有額外扣 2 天標籤|天數仍為 5 天（固定 5 天在額外扣天之後套用，壓回 5 天），安親/課輔適用率 100%|
|U59|v3 isEnrolled 判定（R17/Q3）：年級 5 學生只有寫功課班|isEnrolledTutoring 為 false（v2 為 true）|
|U60|v3 重複報名提示（R17/Q8）：報名兩班寫功課|出 DUPLICATE_SUBJECT_ENROLLMENT 提示（Q8）；兩班交通車（none 且非固定 5 天）不出|
|U61|v3 美語缺課表警告（F-8）：美語班未排課|出 SCHEDULE_NOT_FOUND 需確認警告（v2 不出）|
|U62|v3 未對應班警告（Q4-b）：未對應班若為 care/math/english|出 CLASS_NOT_MAPPED 需確認警告；none 類別（如交通車）不出|

非法起迄、星期不是1–7、跨日、缺姓名／代碼各測拒絕；未知科別／alias為可見待設定，不阻止整批名單匯入。參數不可接受任意eval。

### 3.3 D2b：班級類別與固定 5 天設定 UI、升級確認（U63–U74）

|ID|測試|驗收|層|
|---|---|---|---|
|U63|有效類別與固定 5 天（無手動覆寫）|有效值＝依班名自動偵測，四個欄位來源皆 auto|unit|
|U64|手動設定類別／固定 5 天（Q7-A 兩者獨立）|有效值＝手動值，來源 manual；另一項的來源不受影響|unit|
|U65|手動值恰等於自動偵測值|仍為 manual（來源是使用者意圖，不因值相同降回 auto）|unit|
|U66|整班改名帶走手動值（Q9）|manual 跟到新名且來源仍 manual；auto 者依新名重新偵測|unit|
|U67|同名合併且各來源設定不同（Q9）|產生衝突（阻擋儲存、要求選擇）；設定相同則不阻擋|unit|
|U68|拆班／新班／整班改名的生命週期判別|以 rowId 追蹤得 split／new／rename；merge 只在目標名不在 baseline 時成立|unit|
|U69|空 DB 的目標規則版本（Q11）|`resolveFormalRuleSetVersion` 回 erp-tag-v3|integration|
|U70|既有 v2 active run 未明確要求升級（Q11）|目標版本維持 erp-tag-v2（不靜默切換）；明確帶入 erp-tag-v3 時才升級|integration|
|U71|升級 apply（Q11）|新 run 版本＝preview 記錄的目標版本並成為 active；舊 v2 run 的值與分類逐欄不變；冪等重送不產生第二個 run|integration|
|U72|類別變更進完整影響預覽|科數與合計折扣差異列入 `subjectCountDeltas`／`baseDiscountDeltas`；只改類別不改時段時天數不變但折扣差異仍呈現|integration|
|U73|讀模型走完整生產呼叫鏈（N-6）|固定 5 天的「不列入折扣」班回 100%（以非 10000 的適用率確保斷言落在該分支）；缺快照回 not_configured|integration|
|U74|alias 解析與手動來源的快照（N-7）|alias 解析後 mapped=1 且不出 CLASS_NOT_MAPPED；`categorySource:'manual'` 的快照 source 為 manual|integration|

## 4. 匯入與儲存整合測試

|ID|測試|驗收|
|---|---|---|
|I01|原 ERP 檔|477 筆、384 有班、93 無班，人員代碼唯一|
|I02|相同內容欄位重排、檔名不同、隱藏班級／標籤／備註欄|正規化學生結果等價；標籤不可漏讀|
|I03|必要標頭缺失／重複正規化標頭／未知新增欄|前兩者阻止啟用；未知欄可忽略並列預覽|
|I04|標頭上方新增標題列／多個候選表|唯一匹配可辨識；歧義需明確選擇|
|I05|隱藏列、Excel 已篩選、空白列、尾端格式列|有效資料全讀，完全空白跳過，不以 max_row 當筆數|
|I06|同名不同代碼／同代碼兩列|前者保持兩人；後者 422，不默默第一筆／最後一筆|
|I07|上傳同檔兩次、換名同內容|不重複增加學生，回已存在／內容相同提示|
|I08|新批次缺一人|新快照未出現；舊快照仍在；不得當全機構退班|
|I09|解析、DB 寫入或重算中途故障|activeRun 與舊資料完全不變|
|I10|更改課表／別名並重算|建立新 run，舊 run 可查，資料版本一致|
|I11|兩次設定修改相同 revision|第一成功、第二 409；無 lost update|
|I12|關閉重開應用程式|學生、設定、run、active pointer 保留|
|I13|超過大小／ZIP 展開限制、非 XLSX、加密檔、必要欄公式|明確拒絕；舊資料安全|
|I14|超過 1000 行的合成資料|不截断至原 Excel 上限|
|I15|新班、停用班仍有學生、變更老師|可查名單；缺設定警告；停用不刪歷史|

對真實 SQLite temporary database 跑 transaction tests；只 mock repository 無法證明 rollback 正確。

新增I16：標籤命中133/97/14/14，未知標籤14/46/1、備註171筆保留，額外1.5天／特殊95折用合成fixture。
新增I17：固定原檔原排課且無新增alias，一般輔導179 tokens，174match/5mismatch，來源列30/35/43/51/52；13人schedule_not_found、1數學班schedule_empty、8care_window不誤報。狀態與值都要驗，不能只比較數字。另斷言這13人全部包含於 `tierMismatch=false AND hasIssues=true` 結果集；再限定該數學一班的 schedule_not_found 問題來源，才斷言恰為這13人。全域 hasIssues 還包含映射、R17／R18、來源衝突等問題，不能硬限總數13，也不能因match消除警告。
新增I18：一班→一A的dry-run顯示13人各-0.5天、mismatch5→18；取消不改active；預覽後版本變更回409。這是影響測試，不是預設要套用的修正。
新增I19：一般輔導雙向差集為ERP待設定2、設定本批未出現1；部分匯出不得自動停用。另產每個排課班的legacy roster與classId roster差異，每筆說明，四年級A/B不可併名單。

I19另須斷言**全科別的初始對照總量**，避免只驗一般輔導子集而誤以為那是全機構數字：ERP 95個不同token收斂為54個baseName，其中**42個與seed唯一精確相符**（baseName層級的候選群組，不是已核准alias筆數）、**12個seed無對應**（進待設定）、**歧義0個**；seed側有**7個baseName本批ERP未出現**。12個待設定為交通車、小六國文加強班、小六數學加強班、小六英文加強班、正音A班、正音B班、國小輔導-寫功課、國小輔導-四年級A、國小輔導-四年級B、國小數學-一、國小國語文-小三四、美語等班。其中`國小輔導-寫功課`因seed無此班而待設定，屬預期，不是漏建。

依 D26 未作廢部分，seed 基準盤點＋設定視圖並存、人核准、一次整表 preview 維持；D26「具名候選沿用 D18 模式」部分由 D32-C 取代作廢（見下）。下列3組純命名漂移（`國小國語文-小三四`↔seed`國小國語文-小三小四`、`小六國文加強班`↔seed`小六加強班-國文`、`小六數學加強班`↔seed`小六加強班-數學`；另seed有`小六加強班-自然`而ERP有`小六英文加強班`，兩邊各有一科無對應）不再具名寫死，改由動態引擎於當批差集中自動產生候選行。待設定第三動作「標記待調 ERP」砍除（以既有 issue 承載）；使用者於介面逐項填目標＋勾選後，發起一次整表 dry-run preview，看到前後衝擊再原子套用。這些科別都不參與`國小數學-`／`兒童美語-`抽取，也不改科數，故只影響名單與設定可操作性，不影響計算。

新增I19-D32C（D32-C 動態候選引擎，C10 作廢）：`NAMED_CANDIDATES` hardcode 已移除；候選行由當批 ERP baseName vs 系統現行班級＋已核准 alias 差集自動組裝（rawBaseName＋去重人數 COUNT DISTINCT person_code＋token 筆數＋建議目標；後果數字一律由 preview 產生，不再寫死 reason）。驗收：12 個待設定全數進候選、42 個對齊不進、已 alias 覆蓋不進、改名對齊自動消失；建議目標凍結為空由人工填寫（不做模糊匹配）；引擎為純函式，不建 alias、不改 active 設定（嚴禁自動批准）。I19 54/42/12/7 錨點維持可重現，seedInventory 軌數字不變。
上述54／42／12／7為baseName盤點統計錨點維持不變，不是正式class identity數或全部mappingStatus=unmapped數。實際映射保留年度、範圍、修飾與完整token，按02規則逐一預覽核准，不能以這些統計作自動合班依據。

新增I20：離班34人37 tokens仍保留；修改alias/老師後讀舊run，內容不變；待設定token可由API查到。

## 5. 黃金比對

建立對照報告：personCode、原 row、field、Excel cached、normalizedExpected、actual、ruleId、差異分類。計數／布林／折扣 basis points／最終半天天數精確相等；原始 fractional day 中間值可允許 1e-9 的表示誤差，但不得用容差跨越 R03 分支。

分兩條gate：歷史compat逐格比477人八欄與49班seed快取（40有時段／8care_window／1empty），只驗公式診斷；正式erp-tag-v1驗標籤命中、級距、狀態及課程折扣，預期基本率差107人、課輔天數差12人。差異分類增加已確認來源欄位缺陷F01、DIFF-01數值策略、D24取整規則、名單碰撞修正；依已確認決策可建立新expected，原compat fixture不覆寫。

狀態測試用產品expected獨立驗證（舊Excel没有status），不能把舊0 fallback自動視為calculated。數值相同但缺needs_review仍失敗；erp-tag正式值不同於缺陷快取不算回歸失敗。match數字也不能替代班名／排課完整性gate。

原 Excel／歷史 compat 對照仍保留93個無班級基本率空白，僅作歷史比對，不作正式軌 expected。正式版依[02 R10](02-calculation-rules.md)與 operator 裁決 d-20261002160111112854-66：無報名且無特殊折扣時基本率為 10000（無折扣），特殊折扣仍優先；科數仍為 null、課程適用率仍為 null。不可為對齊舊快取而清掉標籤。原始 compat fixture／Excel 不改；本次未原生重算，後續用副本驗證。

**D30 同星期衝堂規則版本（`erp-tag-v2`）**：
新增正式軌版本 `erp-tag-v2`，落實 D30 同星期衝堂比對（星期六對一～五窗口重疊為 0）。
對照分析：
1. S 表 49 班排課種子中，僅 4 個週六班級（小六加強班-自然、小六加強班-國文、國小國語文-小三小四、國小國語文-小五）在 `erp-tag-v1` 計算出 -0.5 天安親扣天，在 `erp-tag-v2` 下因週六排除而精確為 0 天。
2. 抽取扣天之數學與美語班：種子中所有週六時段（EF, EK, EL, EM, 一A, 二A, 二B, EB）均排在上午（09:00–10:30 或 10:30–12:00），在舊時刻比對下重疊即為 0。因此在 477 筆真實學生資料中：
   - 5 筆級距 mismatch（列 30, 35, 43, 51, 52）維持 5 筆。
   - 13 筆數學缺排課學生（國小數學-一[團]）維持 match + hasIssues。
   - Gino 三時段（一/三/五平日）維持安親 110 分鐘 (-0.5)、課輔 70 分鐘 (-0.5)。
   - Hopper（一/三/五平日）天數完全不變。
   - D18 具名候選套用後果（13 位小一安親各 -0.5 天，mismatch 5→18）完全不變。
3. 舊版本 `erp-tag-v1` run 結果完全不變（位元不可變快照）。
4. 未知星期（F3/K2，方案 (a) 皆 fail-closed）：v2 下時段星期缺失或無法識別一律衝堂計 0，並出 `UNKNOWN_WEEKDAY` 告警＋`tierComparisons` 標 `SCHEDULE_INCOMPLETE`（needs_review）。U13/K2 單元測試與 `same-weekday-r01-d30.test.ts` §4 覆蓋缺失／非法／空字串三態；v1/compat 不檢查星期，行為凍結。
5. 穩態 preview（F1/K4）與版本隔離（F2）回歸測試：`settings-preview-apply.test.ts` 覆蓋有／無 active run 兩態皆不 throw 且跟隨正確正式版本；`activate-run.test.ts` 覆蓋同 key 同版本冪等命中、同 key 異版本拒絕。

## 6. API 與瀏覽器驗收

API 契約測試另涵蓋：空DB GET current 回revision=0/run=null後可首次啟用；同key/body成功重送回原結果而不被新revision拒絕；兩分頁新操作同revision只有一筆成功；preview參數允許／拒絕矩陣與固定設定版本；issueCode篩選（R17/R18）、tierMismatch=false不包含unavailable且至少一筆match；未開comparison頁也有數值政策issues，GET前後DB不變。設定seed在無active run時可初始化。

API 契約測試：同 run 同篩選 UI 和 API 名單／人數一致；詳細 trace 來源完整；無效 query 回 400；不存在學生／run 404；穩定排序與分頁無重複漏列；跨頁時 active run 變更仍查固定 run；唯讀 GET 無副作用；不回傳不需要的電話、完整備註。

Playwright 最小完整旅程：

1. 空資料啟動 → 上傳原檔 → 檢視 477 筆預覽 → 啟用。
2. 選班 → 用姓名搜尋 → 查看人數和計算明細 → 清除搜尋恢復。
3. 選安親與園內生案例，看到基本與適用率兩欄及差異解釋。
4. 修改班級時段 → 儲存重算 → 顯示新 run 與新結果 → 舊 run 可讀。
5. 上傳缺標籤欄（另測缺備註欄）檔案 → 明確錯誤 → 先前資料不變。
6. 重啟伺服器 → 資料仍存在。

無班級／無結果／缺排課／停用班／重複代碼皆須有可操作畫面狀態，不能只用 console.log。

## 7. 每階段測試閘門

- P1：typecheck、lint、規則單元、真 SQLite 整合、核心 API、上述 E2E、完整樣本差異報告、實測效能結果。與 P1 無關的 P3 不得阻擋 demo。
- P2：增加讀取 API 契約、CSV 注入防護、保存篩選、差異報告與還原測試。
- P3：每模板每欄值、版型 XML、容量、日期、Windows Excel A4 Print to PDF／實印。純 screenshot 比對不足以證明內容正確。
- P4：登入／授權、跨機構資料隔離、多人競爭、Firestore migration 對照、備份還原、部署 smoke。GitHub CI 建立時只搬已有效的本機命令，不先建空 pipeline。
- UI 重設（09）：各 PR 對應的 UX 項目見 §8 與 [10 §1](10-ui-workflow-redesign-plan.md)；驗收修正批（UX25–UX33）見 [11 §3](11-ui-acceptance-fix-plan.md)；本專案 no-CI，merge 證據為本機隔離 E2E 與全量本機結果（10 §4）。

覆蓋率不是唯一gate；R01–R18與班名／級距／來源政策各分支都有案例。U01–U49、I01–I20為規劃清單，不是已執行的產品測試。P1只需簡單red-green-refactor記錄。

## 8. UI 重設驗收矩陣（UX01–UX73）

依 [06 D33](06-handoff-decisions.md) 與 [09](09-ui-workflow-redesign-spec.md)；本節是 UI 重設的正式驗收，實作拆分與各 PR 對應項目見 [10](10-ui-workflow-redesign-plan.md) §1。UX 為新增驗收，保留原 U/I 及 08 測試。每個可觀察行為先 red 再 green；expected 來自既有 domain 固定案例／已確認案例（獨立手算），不用新 UI 自己生成。UX22、UX23 的 RED 對應 09 §8.2.1、§8.2.4 記載的現況缺陷。UX07、UX13 於 2026-09-30 修訂，UX25–UX33 為第一次人工驗收後新增（依 [06 D34–D39](06-handoff-decisions.md)、[09](09-ui-workflow-redesign-spec.md) 目標契約與 [03 §5.1](03-architecture-api.md)，實作批次見 [11 §3](11-ui-acceptance-fix-plan.md)）；UX34–UX47 為 D1（規則版本入口收斂、班名比對報告、類別偵測純函式，[11 §3 D1](11-ui-acceptance-fix-plan.md)、[06 D40](06-handoff-decisions.md)）；UX48–UX53 為 D2b（班級類別與固定 5 天設定 UI、升級確認、讀模型接線；[11 §3 D2](11-ui-acceptance-fix-plan.md)）；UX54–UX70 為 D2c 定稿的驗收目標（依 S manifest §6／§7／§9／§11）。測試層欄為目標或已有覆蓋，**不等於整列已完成**；部分覆蓋與待補項依下表註記。D2d 任務 `t-20261001030245156576-75458-17` 收斂已知缺口（decision `d-20261001030238623979-12`）；D2d 依 decision `d-20261001050915775646-5` 新增 **UX71／UX72／UX73**（原 A–E 三項在 §8 無對應列：Q10 選中班摘要天數、併入既有班、空課表候選警告），並更新 UX54／55／60／61／67／68／69 的層級與狀態；批次 E 自 UX74 起編，與本批無重疊。狀態標記只在**該列寫明的缺口確實閉合**時才更新：標為「D2d 閉合」者附測試檔與手算依據；本批 A–E 的 RED 已全部轉綠，UX61／67／68／69／71／72／73 皆已閉合。`web/tests/unit/d2c-parity-gate.test.ts` 為手算 policy suite；fixture baseline 在 `web/scripts/parity-d2b.mts`，完整逐情境／逐欄表外差異閘門由 D2d F 補於 `web/tests/unit/d2d-parity-gate.test.ts`。

|ID|輸入／操作|expected|層|
|---|---|---|---|
|UX01|空DB先改課表→確認→儲存→重啟|設定存在、revision遞增、run仍null|integration/E2E|
|UX02|只有ready批次，儲存課表再activate；另含client傳非active／null的importId|儲存不啟用ready，client importId被拒（active_state不變）；activate後run.scheduleVersionId＝最新已儲存設定id|integration|
|UX03|有active改時段，取消／失敗／成功|前兩者active不變；成功設定和新run原子切換|integration/E2E|
|UX04|settings_only儲存與另一tab activate競爭；含importId與server決定值不符|一成功另一409；同key/body成功重送回原結果；importId不符被拒且不啟用任何批次|integration|
|UX05|週一15:20–16:50，v2預設窗口|課長90、安親40分／40÷180、課輔20分／20÷180；正量顯示、負數domain不改|unit/API|
|UX06|同班週一15:20–16:50、週三15:30–17:00、週五15:20–16:50|安親40+30+40＝110分，110÷180→實扣0.5；課輔20+30+20＝70分，70÷180→0.5；先合計再取整|unit/API|
|UX07（修訂）|(原) 週六／未知星期／缺起迄／care_window／inactive；(新，11 A) 瀏覽器把某列星期改為非法非空值；另清空；另模擬calculate失敗|(原) 合法六為0，未知／缺漏警告非無衝堂，共用窗口不捏造session；(新) 該列可聚焦「需確認」警告＋原因；舊值立即失效不冒充；失敗不顯示「無重疊」；合法週六為0|unit/component（原）＋E2E（新）|
|UX08|改班名／老師／星期／起迄，舊回應晚到|dirty與preview失效，最新request才可顯示，總覽不讀draft|component/integration|
|UX09|改散同班名、刪列、停班、alias失效|D28/D29提示與後果可見，草稿可取消，確認才提交|integration/E2E|
|UX10|新ERP／新設定產生差集|D32動態候選與去重人數，不自動批准，對齊消失|integration/E2E|
|UX11|上傳→預覽→使用→核對；缺標頭錯誤|單頁接activate，失敗舊run不變，成功真實人數與日期|E2E|
|UX12|同檔／過期／版本變更|不重複學生，短中文錯誤＋重試，raw code不是唯一說明|integration/E2E|
|UX13（修訂）|表頭篩選選班→搜尋學生→開明細→返回；切頁籤再回來|名單／人數同run同條件一致；條件與捲動保留；兩頁籤條件獨立；姓名不入URL|API/E2E|
|UX14|八欄null／false／0／特殊率／不適用|型別不混，合計與本班率分開，八欄可達、姓名sticky|component/E2E|
|UX15|級距match但有issue，未知issue code|警告仍在、不硬限13人；未知碼短標需確認且可查原因|unit/E2E|
|UX16|tab／focus／click tooltip，drawer/modal Esc|focus trap／回復，label/aria-live，錯誤不只hover|E2E/人工|
|UX17|舊DB migration（settings_previews、idempotency_records table rebuild）／故障／備份還原|歷史settings/runs/冪等紀錄逐列保留（含expires_at、response_payload），不清DB|integration|
|UX18|相同input計算前後比對|erp-tag-v2與舊run值不變，不藉UI改D24/D30|regression|
|UX19|多次calculate POST／deductions GET|DB/active/preview行數與內容不變，無多餘PII|API/integration|
|UX20|1440×900、1280×800、1024×768、768寬|無整頁橫向溢出，表內可捲，sticky與底部不遮操作|視覺/E2E|
|UX21|歷史／空篩選／loading／失敗|唯讀、來源日期清楚；可清filter，不能假成功|E2E|
|UX22|已apply設定（自訂時段＋班名對應）→匯入新批次→activate；另帶不同的client scheduleVersionId|先RED（現況run用seed-v250922、不套班名對應）；GREEN：run.scheduleVersionId＝最新已儲存設定id，逐堂／班級／學生天數與對應皆採該設定，client scheduleVersionId被忽略；尚無已儲存設定時仍為seed-v250922|integration/E2E|
|UX23|刪光某班全部時段／清空所有列時間／移除整班|逐堂預覽、班級扣天、學生run三者一致：無時段→不扣天＋issue（schedule_empty），不在該版本→schedule_not_found＋issue，皆不退回seed（先RED）|unit/integration|
|UX24|開課表頁；送出careWindows與ruleSet不同的draft|畫面無窗口輸入／調整入口，顯示值＝ruleSet（窗口固定，D33）；calculate回應windows＝ruleSet；server對不同careWindows回400 INVALID_DRAFT|component/API|
|UX25|表頭▾輸入「數學」→全選搜尋結果→確定；再加一欄；取消；移除chip；清除全部；鍵盤全程操作；768×600開面板；選班後開其他欄；快速切換已套用條件|值宇宙涵蓋整個run（含後頁獨有值），不受limit／cursor限制；每欄計數依其他欄已套用篩選（含選班、q、特殊值），排除本欄，等於將本欄替換為該單值後的人數，同生多班／同班多token去重。server回0人值，UI隱藏未勾選0人、已勾選0人仍可取消且不被prune。統計mismatchCount與所選範圍tierMismatch=true同源、issuesCount與範圍內hasIssues=true同源，noCourseTotal仍全批、classScopeTotal仍只按選班。options只在已套用條件變動刷新，abort／sequence拒絕晚到舊回應；適用率context保留單班／未選班／未配置三分支。同欄OR跨欄AND；取消不改條件；三種空狀態分開；面板不被裁切、確定鈕可見、Esc回焦點|unit/integration/E2E|
|UX26|班級只有課輔側重疊；一側未知|狀態不為「無重疊」；未知不被另一側掩蓋|component/E2E|
|UX27|班級扣天展開→編輯此班課表；直接開`/?view=deductions`；重新整理／返回|課表定位該班全部時段；頁籤依網址；返回不丟頁籤|E2E|
|UX28|恰選一班／選兩班／未選班|恰一班顯示本班適用折扣並與基本率並列（兩者不同的合成案例值正確）；多班與未選班不出現「本班」與本班率|component/E2E|
|UX29|名冊含[03 §5.1](03-architecture-api.md)無課程各案例|人數＝點擊後名單；不含只有寫功課／交通車／有離班token／解析失敗者；另有issue者仍計入需確認；匯入預覽同數|integration/E2E|
|UX30|合成fixture 477人，資料載入穩定後，學生總表未篩選|1440×900：完整可見資料列≥10列；768×600：完整可見資料列≥4列（計數方式：列的上下緣都在表格可視區內；門檻經operator 2026-09-30確認）|E2E|
|UX31|課表修改後：點側欄、品牌連結、班級編輯入口、瀏覽器Back；計算在途取消／pointerdown與up間啟動計算取消；儲存成功後離開；未修改離開；修改後reload|dirty各入口皆確認（繼續編輯保留草稿／捨棄後離開）；唯讀計算在途不阻擋取消，取消即時還原baseline、dirty歸零、守衛與歷史清理；儲存成功與未修改不打擾；reload觸發原生提醒|E2E|
|UX32|有active時確認課表變更；上傳損毀檔；課表頁尾；問題類型選項|D39四處文案；主畫面無mismatch／D24／INVALID_XLSX／英文issue code|E2E|
|UX33|匯入時間、課表儲存時間、核對橫幅|同一格式`YYYY-MM-DD HH:mm`（Asia/Taipei）|component/E2E|
|UX34|D1 前後不變式：同一 import、同一設定快照、同一版本，分別以 erp-tag-v1、erp-tag-v2、excel-v260922-compat 計算（calculator 6 組＝2 情境 × 3 版本、run 4 組、班級扣天讀模型 2 組）；既有 UX18 golden 與 `calculation-invariance-ux18.test.ts` 不動|業務欄位（天數、科數、基本折扣、課程適用率、級距比較、issue code 集合與訊息）逐人摘要與 rollup 與 D1 前（8961c03 生成的 golden）逐欄相同；不比較識別／時間欄位；前提測試證明各版本在「已儲存設定」情境確實走到不同狀態（有鑑別力）。**政策邊界**：依 operator 裁決 `d-20260930131128030911-29` A 授權，本項屬狹義 baseline 差異特徵化，固定 8961c03 生成，僅驗重構前後未改變，不作演算法正確性 oracle；新行為與修正仍須獨立手算 expected|regression|
|UX35|規則版本能力旗標：`ruleSetCapabilities` 逐版明列；calculateStudentBilling／buildSchedulePreview 逐版觀察（週六時段、未知星期「八」、合法星期一）|v2：sameWeekdayOnly／unknownWeekdayWarning／scheduleIncompleteOnUnknownWeekday 全開；v1、compat、未知字串全關；週六 16:30–18:00：v2 課輔 5 天、v1／compat 4.5 天；未知星期只有 v2 出 UNKNOWN_WEEKDAY 與 schedule_incomplete；正式軌成員只有 v1、v2，不新增 v3|unit|
|UX36|activate：body 帶 ruleSetVersion（v2／v1／compat／未知字串／null）；application 層直接帶；active 分別為無、v1、v2、compat；D1 前寫入的冪等紀錄重送|一律 400 INVALID_REQUEST 且不建 run、active 不變；application 層同樣拒絕（ActivateError 400）；不帶版本時新 run＝現行 run 的正式軌版本（無 active→v2、v1→v1、v2→v2、compat→v2）；冪等雜湊只含 importId／expectedRevision／asOfDate；D1 前紀錄同 key 同內容仍回原結果、不同內容仍拒絕|integration|
|UX37|preview→apply：active 為 v1／v2／compat／無現行名單（settings_only）；手動把記錄的目標改為 v1、NULL、compat、未知字串|preview 記錄 `target_rule_set_version`（v1→v1、v2→v2、compat→v2、settings_only→v2）；apply 只讀記錄值建 run（active 為 v1 時新 run＝v1，D1 前為 v2）；NULL＝建立當時 active 版本；非正式軌值 500 PREVIEW_CORRUPTED，不建 run、不動 active；解析器 `resolveFormalRuleSetVersion`／`resolveRuleSetForApply` 逐案例|integration|
|UX38|comparison：run 的設定快照含三A 週六＋週一時段；快照缺失；seed 課表的 run；缺／錯 againstRuleSet；找不到 run|差異清單依 02/D24/D30 規格獨立手算常數比對（三A 週六時段 formal 4.5 天 vs compat 4.0 天，差異 0.5 天，CARE_DAYS_DIFFERENCE）；不依賴待測函式輸出回填 expected；退回 seed 課表時差異為 0 故具鑑別力；快照缺失 409 SNAPSHOT_UNAVAILABLE（不改用最新設定或 seed）；seed run 維持與 seed 直接計算相同；400／404 不變|integration|
|UX39|classes：兩代設定快照（舊快照有別名、最新設定無別名且三A 停用）；指定歷史 run／較新 run／快照缺失／不帶 runId|指定 run＝該 run 快照的別名與啟用狀態（snapshotStatus ok）；快照缺失＝snapshotStatus unavailable、各班 mappingStatus undetermined、目標與啟用狀態 null（不猜）；不帶 runId 維持讀最新已存設定|integration|
|UX40|匯入異動逐班明細：before 設定（有 override）不含該班、after 設定含該班；兩側都無儲存設定|before 側 statusBefore＝schedule_not_found、扣除量 null（與 calculator 一致，D1 前為 calculated）；after 側 calculated、扣 0.5；無儲存設定時仍走 seed（特徵化）|unit|
|UX41|已存設定 JSON 讀取：亂序欄位、未知欄位、缺欄位、無效 JSON；掃描 src|`readStoredDraft` 與 JSON.parse 逐位元相同（不補預設、不去欄位、不改順序），hashSettingsDraft 往返不變；無效 JSON 拋 SyntaxError；src 內除定義處外沒有任何直接 `JSON.parse(…contentJson…)`（7 處已收斂）|unit|
|UX42|migration 0007：fresh DB；v6 升級（含舊 preview／run／冪等紀錄）；重跑；故障；run_class_categories 外鍵|fresh：版本 1–7、`settings_previews.target_rule_set_version` TEXT nullable、`run_class_categories` 欄位／PK／外鍵 CASCADE 符合契約且為空表；升級：舊列逐欄不變、新欄位為 NULL、新表為空；重跑不再套用；故障整段 rollback（仍在 v6、舊資料完整、無殘留欄位或表）；未知 run 不可寫入、run 刪除連帶刪除、同 run 同班名不可重複|integration|
|UX43|類別自動偵測純函式（未接線）：安親課輔／寫功課／美安／數學／美語／不列入各案例與優先序|Q1 寫功課優先→不列入且固定 5 天；Q2 包含國小輔導／安親／課輔且排除寫功課→安親課輔班；含國小數學→數學班；含兒童美語→美語班；其餘不列入；固定 5 天＝含寫功課或美安，與類別獨立（國小輔導美安＝安親課輔班＋固定 5 天）；優先序 安親課輔＞數學＞美語；src 內沒有任何檔案 import 它|unit|
|UX44|班名比對報告 read model：latest／run 範圍；別名；同班多筆報名；seed 課表；快照缺失|米豆奶有／系統無：每班去重學生數與筆數、涵蓋的不重複學生數（跨班去重）；系統有／本次名冊無：只看直接報名，別名覆蓋者仍列出並標 aliasCoveredBy；run 範圍讀該 run 快照，同一名冊兩個範圍結果不同；快照缺失＝unavailable，清單與計數為 null；報告任何層級沒有「類別」欄位|integration|
|UX45|上一份現行名冊（Q12-b / F2）：依據成功之 activate/apply 收據與 revision 序號追溯可證之現行 episode 流|目標名冊非現行時參考當前現行名冊；目標名冊為現行時參考該 episode 之前一份現行名冊；A 啟用(X=2)→B 只上傳(X=7)→C 啟用：C 啟用前後上一份名冊均為 A（2人），絕不取未啟用的 B；同名冊重算前份不變；重啟用 A→C→A 正確錨定；可證無前份時狀態為 none；收據毀損或出現 gap 時 fail-closed 為 unavailable|integration|
|UX46|課表設定「班名對應」：開 `/settings?tab=mapping&import=<批次>`；成功 apply alias 刷新（F3）|兩份清單並排、預設展開不需點擊；各附班數與影響人數；別名不對稱有文字說明；系統有／名冊無 顯示上一份名單人數與來源檔名，沒有上一份名單時明說「沒有上一份名單可參考」；報告區沒有「類別」字樣；窄螢幕改上下排列；清單資料列具備中性色彩語意（非琥珀非綠，N2）；同頁成功儲存別名後，班名比對報告即時刷新，已對應班級立即消失，不需 reload（F3）；刷新維持畫面檢視的名單（`?import=` 指定的未啟用批次刷新後仍是該批，與同範圍 API 一致，不跳成現行名單，r2 B1）；儲存成功但重新取得報告失敗時，先**自動重試 2 次**（約 1s、3s 間隔；任一次成功即正常顯示，使用者不見錯誤畫面）；重試期間報告區顯示一行中性佔位「更新中…」（非錯誤樣式、無說明文字），**不顯示儲存前的舊數字**；候選表鎖定（控制項 disabled）。重試皆失敗才顯示單行「無法取得最新的班名比對報告。」＋［重新載入］（只重新取得報告，不整頁 reload）；［重新載入］再失敗則按鈕改為［重新整理頁面］，按下才整頁 reload（不自動 reload、不跳確認視窗）。恢復後標示消失、候選表解鎖並以最新報告重建（r2 B2、operator 裁決 `d-20261002162913018695-69`；重試中再次套用時舊序列回應不得覆蓋新結果）|E2E|
|UX47|匯入預覽：上傳合成 fixture（首次；另有現行名單時）；`GET /api/v1/settings/class-name-report` 參數|「使用這份名單」之前顯示摘要：米豆奶有／系統無 12 個班影響 191 位學生、系統有／本次名冊無 7 個班（fixture 手動盤點值；與 I19 錨點 54＝42＋12、seed 49 班中 7 個未出現一致）；有上一份名單時註明來源檔名與該班人數合計，沒有時明說；連結 `/settings?tab=mapping&import=<批次>` 開完整報告，兩處數字同源；既有「N 個班名待確認」不變；API：未知參數 400、未知 run／名單 404、run 與名單不符 400、快照缺失 200＋unavailable|integration/E2E|
|UX48|課表設定「折扣類別與固定 5 天」：逐班顯示自動偵測值與來源；手動選四選項；勾選固定 5 天；恢復自動|預設依班名自動偵測（國小數學-四A→數學班、國小輔導-四年級→安親課輔班），來源標「自動」；手動後來源標「手動」且改班名不再重偵測（值隨班帶到新名）；恢復自動後回到依**目前**班名重新偵測的值；固定 5 天與類別各自獨立（手動其一不影響另一）；來源以文字標示不只靠顏色，控制項鍵盤可達|E2E|
|UX49|只改類別（不動時段）→ 確認變更 → 儲存；再按取消修改|只改類別即變成「有未儲存的變更」；確認變更的影響預覽含類別造成的科數／合計折扣差異；取消修改後回到未儲存狀態且類別回到自動偵測值（未儲存的覆寫不留存）|E2E|
|UX50|同名合併（Q9）：把兩班的所有時段列改成同一個新班名；兩者類別／固定 5 天設定不同|畫面顯示「無法儲存：班級合併設定衝突」並列出衝突內容，「確認變更」停用；要求先選擇要保留的設定或改回不同班名，不靜默取其一；兩者設定相同時不阻擋|E2E|
|UX51|升級確認（Q11）：現行 run 為 v2 時開課表頁；另測空 DB|現行 v2 時顯示「改用新規則（v3）」勾選，說明會重算全部學生且舊結果不被改寫；未勾選時一切照現行規則（既有 v2 DB 不因目標版本改為 v3 而被靜默升級）；空 DB 不顯示此勾選（該次啟用即建立於目標版本）|integration/E2E|
|UX52|本班適用折扣讀 run 類別快照（N-8）：v3 run 恰選一班；同樣以名冊班名查；v1／v2 run；v3 run 缺該班快照|v3 run 依該 run 的類別快照判斷（不因 v3 給相同類別的班比 v2 給不同值的班更接近）；固定 5 天的「不列入折扣」班顯示 100% 而非「未設定」；查詢 key 為名冊班名（與快照 base_name 同源）；v1／v2 維持名稱映射；v3 缺快照顯示「未設定」|integration/E2E|
|UX53|UI 不再顯示舊 `subject`（科別）欄位（Q14）|學生總表、明細、課表設定與班名比對報告皆無 `subject` 欄位；相容欄位仍在 API／資料中保留且不作計算依據|unit/E2E|
|UX54|拆班：把某班的部分時段列改名為新班名（原班仍存在）|判為 split 而非 rename：原班保留原本的時段數，新班只含被改名的列；畫面顯示拆班警告且**不阻擋**儲存（使用者可以只改一列）；未改名的列不受影響。**D2d 閉合**（decision `d-20261001050915775646-5`：班級生命週期不再擴充瀏覽器旅程，改以真實呼叫鏈覆蓋）：`detectClassLifecycle` 判為 splits 而非 renames／merges，`detectSplitClasses`（contracts/settings.ts）與 helper 對同一組列給出同一判定；`gridRowsToClasses` → `previewSettingsChange` → `applySettingsPreview` → `readStoredDraft` 後，原班時段數由 2 減為 1、新班只含被改名的那列且時段內容未被捏造。測試：`web/tests/integration/d2d-class-lifecycle-persistence.test.ts`|integration|
|UX55|合班：把兩班的所有時段列改成同一個新班名，兩者設定**相同**|沿用該設定、不阻擋儲存；合併後只有一班。**D2d 閉合**（同 decision）：`detectClassLifecycle` 判為同名合併（目標名不在 baseline）；完整儲存→讀回後只剩一班、兩班時段皆保留（2 堂）、來源班名不再存在，且未殘留來源班的 manual 欄位（缺欄位＝自動偵測，03 §5.2）。實測並記錄：同一組列也會被記成兩個 rename，合併判定與改名繼承是兩條並行輸出。測試：`web/tests/integration/d2d-class-lifecycle-persistence.test.ts`|integration|
|UX56|合班且設定**不同**（類別或固定 5 天）|畫面顯示「無法儲存：班級合併設定衝突」並列出衝突內容、「確認變更」停用；判定基準是各來源班的**有效屬性**（已儲存手動值優先，未手動者依 baseline 班名自動偵測），不是只比手動值|E2E/integration|
|UX57|整班改名後手動值的去留|手動覆寫（類別／固定 5 天）**隨班帶到新名**且來源仍 manual；未手動者依**新名**重新偵測|unit/E2E|
|UX58|「恢復自動」：已儲存手動值 → reload → 恢復 → 儲存 → reload|點擊後移除該班的手動覆寫，依**目前**班名重新偵測；類別與固定 5 天在儲存後重新載入仍為自動；整班改名後恢復亦依新名偵測，不能重新繼承來源班的已儲存手動值；新設定快照不含已移除的 manual 欄位，舊快照不變；「恢復自動」按鈕只在該項為手動時出現（自動時顯示「—」）。測試：`web/tests/e2e/d2c-restore-auto.spec.ts`、`web/tests/integration/d2c-restore-auto-persistence.test.ts`|E2E/integration|
|UX59|手動設定的類別與班名關鍵字不符|手動值優先且來源標「手動」；畫面不因班名不含關鍵字而改回自動，也不得靜默改寫手動值|unit/E2E|
|UX60|舊 run 的類別快照不被重新分類|已產生的舊 run 讀**當時**的 `run_class_categories` 快照；改課表或改類別都不回溯改寫舊 run 的分類；v1／v2 run 無快照時維持名稱映射。**D2d 閉合**（decision `d-20261001050915775646-5`：補專項旅程）：舊 v3 run → 改該班類別 → `previewSettingsChange` → `applySettingsPreview` 產生新 run，舊 run 快照**逐列**不變（連 `source`／`mapped` 一起比，不只比讀模型 SELECT 的三欄）；負向保證新 run 快照確實反映新類別（否則「舊的不變」只是因為都沒寫）；`student_calculations` 不回溯改寫；各 `settings_versions.contentJson` 保持當時的值。測試：`web/tests/integration/d2d-snapshot-immutability-journey.test.ts`|integration|
|UX61|v2 active run 的升級流程：完整預覽 → 儲存 → 產生新 run|勾選「改用新規則（v3）」後的「確認變更」以 v3 目標版本預覽並儲存，產生新的核對結果並成為 active；**舊 v2 run 的值與分類逐欄不變**；未勾選時維持 v2（既有 v2 DB 不靜默升級）。**D2d 閉合**（decision `d-20261001050915775646-5`）：`settings-preview.ts` 的 before 側改用 `resolveFormalRuleSetVersion`（active 版本）、after 側用 target；`settings-editor.tsx` 的 `isDirty` 納入 `upgradeChanged`。**D2d r3 閉合**（decision `d-20261001080032667353-28`；PR #46 第 2 輪 primary REJECTED 的 F-1／F-2，以及本輪新增的 F-4）：**(1) F-1** `resetDraft`（「取消修改」與離頁守衛「捨棄修改」共用）補 `setUpgradeConfirmed(false)`——原本只還原 rows／aliases／manualAttrs／restoredAutoNames，漏了升級勾選 → `upgradeChanged` 恆 true → `isDirty` 恆 true，使用者按了取消修改畫面卻仍標示「有未儲存的變更」且無法再清除；**r3 前只有取消勾選框一條路徑會清除它**。**(2) F-2** 改用本地 state 追蹤「目前生效的版本」（`appliedRuleSetVersion`，初始取 server prop），套用成功後設為 **apply 記錄的** `targetRuleSetVersion`（apply 的結果才是權威，不主動猜 v3）使 `canUpgrade` 轉 false、banner 消失、`isDirty` 歸零、離頁守衛不再攔截；缺值時 `?? null` 守衛不改狀態。**刻意不加 `router.refresh()`／`revalidatePath()`**：那會連帶重新取得 rows／baseline／manualAttrs，把「就地更新 baseline」這條既有路徑整段作廢並擴大回歸面。**(3) D2f** `/api/v1/settings/preview` route 原本只解構 `{importId, draft, expectedRevision}`，丟棄 client 傳來的 `targetRuleSetVersion` → preview 與 `settings_previews.target_rule_set_version` 都退回 active 版本 → 畫面顯示 0 人受影響、套用後仍是 v2，即整條升級旅程在瀏覽器層從未成立；既有 D2b integration 直接呼叫 `previewSettingsChange` 繞過 HTTP，故未發現。（route 修正本身來自 `5273c2a`，r3 補上的是 vitest 層的 route 防護。）**歷程**：`aed979e` 曾把測試與產品修正放在同一個 mixed commit，違反 CLAUDE §8／Fleet §3.10，已由 `672ca40` append-only 撤回（tree SHA 與 `e2e3547` 相同），改以三個 tests-only commit （`2cf4c3b`／`ffb004a`／`f087c1f`）先行再 GREEN（`2a138f8`），**不追認原時序**。測試：`web/tests/integration/d2d-upgrade-preview-versions.test.ts`（6/6，含 route 層 2 條）、`web/tests/e2e/d2d-upgrade-journey.spec.ts`（`--seed-v2-active --repeat 2` 每輪 2 passed）、`web/tests/e2e/d2d-upgrade-restore.spec.ts`（F-1／F-2，`--seed-v2-active --repeat 2` 每輪 3 passed、0 skipped）|integration/E2E|
|UX62|settings_only → 之後匯入新名單|空 DB 儲存課表只保存設定（影響人數為 null，不寫 0 當作驗過）；之後匯入並啟用的名單**直接採用**該設定計算，不需重做任何事|integration|
|UX63|重傳同一份檔案|以檔案雜湊／內容雜湊判定為同一份，不重複匯入成第二份名單；既有啟用中的名單不受影響|integration|
|UX64|課表設定頁與學生總表的類別來源同源|兩處讀同一份資料（run 快照或有效設定），不得出現「課表顯示數學班、學生總表顯示未設定」|integration/E2E|
|UX65|只改類別（不動任何時段）也產生影響預覽|天數差異為 0，但科數／合計折扣差異仍列出；受影響學生數是三類差異的 personCode **聯集去重計數**（不得相加；同一人只計一次）|integration/E2E|
|UX66|CAS／冪等與失敗不切換 active|兩個 preview／apply 競爭時一個成功、一個 409（revision CAS）；同一冪等鍵重送不產生第二個 run；套用失敗時 active 維持原狀（整段交易回滾）|integration|
|UX67|max 選班的邊界：兩班扣天皆為 0 或負|取**正量最多**；若所有候選的正量都不為正，不得因此任選一班當作「有扣天」，須維持 D-24 的下限與「無扣天」語意。**D2d 閉合**（decision `d-20261001050915775646-5`）：既有 `d2a-class-category-billing.test.ts` 只驗非零扣天案例，D2d 補三個邊界——① 兩班扣天皆 0（週六不在課輔窗口星期內 → 重疊 0）→ 天數維持 5 天而非 4.x；② 全缺（兩班都不在課表 → `schedule_not_found`）→ 0 扣天 fallback、天數 5、`SCHEDULE_NOT_FOUND`、需確認；③ 全空（兩班都已對應但時段為空 → `schedule_empty`）→ 扣天 0、天數 5、需確認（`SCHEDULE_EMPTY` issue 屬 UX73／D，不在此重複）。測試：`web/tests/unit/d2d-selection-boundary-discrimination.test.ts`|unit|
|UX68|平手|兩班扣天相同時取**報名順序在前者**（token_index 較小），結果與 v2 的首班語意一致；不因排序不穩定而每次不同。**D2d 閉合**：既有 `d2a-class-category-billing.test.ts:234` 只斷言 `days === 4.5`，而該案例甲乙兩班時段完全相同、扣天必然相同，**無法區分選中的是甲還是乙**。D2d 補兩條鑑別斷言（① 扣天相同時必須斷言選中 `token_index` 較小的甲；② 調換報名順序後選中者跟著換成乙，避免前者只是碰巧），讀 calculator 新增的 `selection` 輸出（含 `tieBreak`）；現已全綠。測試：`web/tests/unit/d2d-selection-boundary-discrimination.test.ts`|unit|
|UX69|未知星期候選|星期為非空非法值或空白時，該候選以 fail-closed 值參與比較並保留 `UNKNOWN_WEEKDAY` 需確認警告；未知列內部扣除值為 0、合法列照算（Q5-B／Q6-A），UI 不得把未知狀態冒充「已驗證無衝堂」。**D2d 部分閉合**：既有 `:278`（Q5-B）只涵蓋非空非法值「八」，D2d 補空白星期與全部不可計算——① 空白星期候選以 fail-closed 0 參與比較、保留 `UNKNOWN_WEEKDAY` 與需確認，合法列照算；② 全部候選皆空白星期 → 天數維持 5 且 `UNKNOWN_WEEKDAY` 仍在（不得因等於無扣天就靜默）；③ 全部候選皆 `schedule_not_found` → 天數 5、出 `SCHEDULE_NOT_FOUND` 而**不**出 `UNKNOWN_WEEKDAY`（「查無課表」不得誤報成「星期無法識別」）。UI 層：學生層需確認顯示已由既有 E2E 承載（`web/tests/e2e/active-run.spec.ts`、`recovery-ui.spec.ts`），本批不新增瀏覽器旅程。測試：`web/tests/unit/d2d-selection-boundary-discrimination.test.ts`|unit／integration|
|UX70|動態候選的隱藏與浮現|已在有效班級中的米豆奶班名不進候選；對應一旦消失（班名被改）候選自動重新出現；引擎為純函式，不建立 alias、不改 active 設定|integration|
|UX71（D2d 新增）|Q10-A：重複報名同一折扣類別（數學／美語）多班，v3 選班以「適用側扣除正量最多」選出一班；v1／v2 維持首班語意|八項總表的 `englishDays`／`mathDays` 與匯入異動明細在 v3 取**選中班**的時段數（不是報名順序第一班），並與計算結果的天數同源；名稱判斷與「seed 場次數」的來源不變（v1／v2 輸出不變）。**D2d 閉合**：calculator 新增 `selection`（`ClassSelection`／`StudentSelection`，含 `tieBreak`、`candidateCount`、`isCalculable`），`calculate-run.ts` 的 englishDays／mathDays 與 `roster-changes.ts` 的 `countedRawTokens`（原本註解明寫「鏡像第一個含國小數學／兒童美語」，是首班鏡像）皆改讀同一份選班結果；v1／v2／compat 無 `selection`、維持首班語意。測試：`web/tests/unit/d2d-selection-output.test.ts`（production 呼叫鏈 englishDays＝2）、`tests/unit/roster-changes.test.ts`＋`tests/integration/roster-diff.test.ts`（25/25 未回退）|integration|
|UX72（D2d 新增）|併入**既有班**：X 班整班改名為 baseline 已存在的班級名 Z，兩者的有效類別／固定 5 天設定不同|以 **Z 現在的設定為準**：X 的手動值不帶入、不覆寫 Z；**不阻擋儲存**、不新增合併管理。保留：整班改成「baseline 不存在的新名」時手動值跟著走（D37／UX57）；保留：≥2 個舊班合併成新名且設定不同時阻擋（Q9／UX56）。**D2d 閉合**：裁定依 operator 產品原則（課程設定＝核對者認知的「現在」班級狀態，系統不管理狀態轉換，有差異由使用者自行修正），decision `d-20261001043317183960-21`。`carryAttributesOnRename` 新增 `baselineNames` 參數（辨認「併入既有班」需 baseline 的**完整班名集合**，含未手動、靠自動偵測的班；既有第三參數只收已儲存手動值，不足以辨認）。目標名已在 baseline 時改用 Z 自己的現有值：Z 有手動值就用它，Z 未手動者依 Z 班名重新偵測。`detectClassLifecycle` 的 `continue` 與 Q9 阻擋刻意不動；整班改成 baseline 不存在的新名時手動值仍跟著走（D37／UX57）。測試：`web/tests/unit/d2d-merge-into-existing.test.ts`（4/4）|unit|
|UX73（D2d 新增）|空課表候選：某折扣類別（數學／美語）的候選班級**已對應**課表但時段為空（`schedule_empty`），與其他可計算候選並存；或該類別所有候選皆為空|只在**可計算**候選中選班（依 S-D 8／D-07）；不可計算的空課表候選**保留需確認警告**（`SCHEDULE_EMPTY` 與 `needsReview`），不得因未被選中就靜默；天數沿用 0 扣天 fallback。v2 行為不變（F-8：v2 凍結，空課表候選不因此新增警告）。**D2d 閉合**：數學與美語兩處選班區塊都對 `schedule_empty` 發 `SCHEDULE_EMPTY` 警告（原本只對 `schedule_not_found`；美語側 F-8 的 `missingEnglishScheduleWarning` 旗標仍只守 `schedule_not_found`，`schedule_empty` 不受該旗標限制）。另修正 `tierComparisons` 原先每個 enrollment 共用同一個 `schStatus`（只取選中班狀態）——新增 `statusByRawToken` 記錄每個候選自己的狀態，逐列比對優先用自己那一列，無逐列資訊（v1／v2／compat、非數學／美語候選）時才退回原共用值。選班本身不變（仍只在可計算候選中選正量最多）；v2 凍結。測試：`web/tests/unit/d2d-schedule-empty-warning.test.ts`（5/5），`schedule_empty` 靜默|unit|
|UX74（批次 E 新增）|R2-F01：首頁 `/` 或歷史頁 `/history/[runId]`（**無 query 參數的入口**）→ 學生總表選班＋姓名搜尋 → **以 UI 切到班級扣天**並選老師（含 `(空白)` 的 `~blank` wire）→ 展開班級 →「編輯此班課表」→ 不修改按 Back；另測：直接重載同一網址、兩次 Back／Forward、單班＋有效／失效的「本班適用折扣」|回到**班級扣天**；老師條件與學生總表的班級條件各自保留；網址參數與畫面一致；姓名搜尋照舊不進網址；Forward 回到課表定位。**Back 還原的頁面內容必須由當下網址重建**：有效的單班適用折扣保留；已失效者以與 server 相同的規則移除、顯示同一則提示，結果與「直接用同一網址重新整理」一致；等待期間顯示既有 loading，不顯示舊 props 的列與計數。測試：`web/tests/e2e/batch-e-navigation.spec.ts`（home／history／空白老師，`--repeat 2` 每輪 3 passed）、`web/tests/e2e/batch-e-applicable-navigation.spec.ts`（有效／失效與重載對照，每輪 2 passed）|E2E|
|UX75（批次 E 新增）|R2-F02：匯入啟用時**明選**一個不同於今天的核對基準日 D → 在課表頁改動 → 預覽 → 儲存並更新結果；不需控制伺服器時鐘|New run 的 asOfDate ＝ D（儲存課表不是重新啟用名單，使用者沒有重選基準日）；核對頁與來源橫幅的基準日不變；舊歷史 run 不變。`settings_only`（尚無名單）不建 run。測試：`web/tests/integration/batch-e-as-of-date.test.ts`（UX75／UX77）、`web/tests/e2e/batch-e-as-of-date.spec.ts`（UI 明選日期→儲存→畫面與歷史 run，`--repeat 2` 每輪 1 passed）|integration/E2E|
|UX76（批次 E 新增，characterization）|同一 import、同一設定，只換 asOfDate 計算兩次|天數（八項總表）、科數、基本折扣、四項課程適用率、級距比較結果與 issue code 集合**逐欄相同**；`asOfDate` 只記於 run。expected 依 02／03 規格獨立手算（如：小一、只報一般輔導、無優惠 → 1 科、基本 100%、安親 5 天），不以被測函式輸出回填；本列在修正前即成立，固定的是 03 §「asOfDate 不參與計算」的語意|integration|
|UX77（批次 E 新增）|`executeCalculationRun` 未帶 asOfDate（例如 API 呼叫端省略）|退回值為 **Asia/Taipei 的今天**，不是 UTC 日期：固定時鐘於台北 00:30（UTC 前一日 16:30）時，未帶日期的計算得到台北當日；帶入 D 時得到 D（UX75／UX76 涵蓋）。測試：`web/tests/integration/batch-e-as-of-date.test.ts`|integration|
|UX78（PR-2 改寫）|匯入預覽的逐人明細（先以現行名單啟用，再上傳第二份名單；先展開「查看逐人明細」）。**欄位＝學生｜狀態｜報名異動｜折扣變動｜安親天數｜課輔天數**（6 欄；移除「折扣」「適用率」「原因」三欄，展開列 colSpan=6）。畫面全區不得出現禁用詞：合計折扣、適用率、科數、類別、token、bps。狀態：異動；整位新學生「新學生」、整位不在本次名單「已不在名單」（這兩種列的報名異動／折扣變動顯示「—」）。報名異動（一行一件）：「新增 <班名>」「退出 <班名>」「換班 <舊班> → <新班>」（switched 成對只一行）；kept 不顯示；無則「—」。折扣變動（一行一班）：「<班名>　<原本> → <現在>　<原因>」，原本／現在沿用 `formatDiscountBps` 既有短標；原因依 -76：新增 <班名>／退出 <班名>／加上標籤「X」／移除標籤「X」，多個以「、」並列不加「同時」；reasons 空陣列 →「名單資料變動」；原因欄不寫數字、不寫「因為」。not_configured 的班不列；未報名一側不取值（不產生假異動）；同類多班各一項不合併。資料來源＝application 層 `RosterChange.enrollmentChanges`／`classDiscountChanges`（PR65，decisions -68／-75），**畫面只呈現、不自行推導**；`rateChange` 已無呈現 consumer，隨 PR-2 移除；學生層舊原因短標仍用於 `discountChange.reason` 與既有 API／測試，保留但不再呈現。天數兩欄與逐班扣天展開列保留，展開列詞彙改為退出／新增／保留與報名異動一致。畫面層測試 `web/tests/unit/roster-changes-details-ui.test.ts`；真入口 E2E `web/tests/e2e/roster-changes-details.spec.ts`（`--repeat 2`）|unit/E2E|
