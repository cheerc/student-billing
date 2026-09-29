# UI／UX 重設規格：課表 → 匯入 → 核對

日期：2026-09-29。設計基準：origin/main `25e0ebf`；PR #22 合併後（`66d6371`）依[review意見](https://github.com/cheerc/student-billing/pull/22#issuecomment-5885578455)對照`web/src`修正§3、§8，引用現況處附path:line（行號為`66d6371`）。方向依[06 D33](06-handoff-decisions.md)。狀態：設計交付，尚未實作到產品。

## 1. 目的、範圍與依據

行政人員不用理解開發術語，就能先維護課表、匯入學生，再按班級核對收費資訊。此次使用者抽樣未見計算異常；保留現有domain、D24／D25–D32、erp-tag-v2及舊run結果。本文件依D33補充01的畫面流程，並在§8明定03設定生命週期需放寬之處（無學生儲存、activate採已儲存設定）；02計費規則不變，權威層級見根CLAUDE.md §2。

交付：[實作plan](10-ui-workflow-redesign-plan.md)、[可點選示意稿](design/ui-workflow-prototype.html)。示意使用虛構資料、不連API，不是新計算基準；正式契約以本文件為準。不做財務匯入、自動開單、點名表、登入或雲端部署。**不在範圍、需未來operator決策**：安親／課輔窗口編輯、設定有效日期（D33；見§3.1、§8.2.1）。

2026-09-29以Playwright實際開啟localhost四頁（/、/settings、/imports、/history），查看控制項與截圖，另讀source確認空狀態與寫入流程；未提交表單或更動使用者資料。Excel工作表職責依使用者本次逐欄說明及既有spec對照，沒有宣稱重驗原生公式。

|目前觀察|影響|本次改法|
|---|---|---|
|首頁醒目顯示Run長ID、展示B、rev、JSON|不知道應從何開始|資料更新日期一行，技術資訊降層|
|差異卡固定寫預期5人、畫面實際18人|把fixture變成業務目標|只顯示當前資料人數|
|課表前方堆候選、差集及D32說明|真正的89列編輯被推到頁下|課表預設，對應另頁籤|
|只有五個輸入欄，沒有即時重疊|無法判斷編輯後影響|旁列五個只讀計算欄|
|沒有班級原始／實際扣天總覽|無法快速檢查每班取整|增加班級扣天頁籤|
|無importId不能進課表且preview API必填importId（`web/src/app/api/v1/settings/preview/route.ts:18`）|不能先課表再匯入|補無學生儲存設定流程|
|總表代碼及其他課程天數佔據左側|八項主要核對資訊不集中|八欄預設、姓名凍結|

## 2. 資訊架構

延用藍／白／淺灰，寬版工作區＋固定簡潔側導覽，不新增儀表板卡片牆。

|入口|路由|用途|
|---|---|---|
|1 課表設定|/settings?tab=schedule|逐堂時段、老師、唯讀的安親／課輔窗口與重疊|
|2 匯入學生|/imports|選檔、確認名單、使用名單|
|3 核對結果|/?view=students 或 deductions|學生總表、班級扣天|
|匯入紀錄（次入口）|/history|日期／檔名查過去資料|

數字表示順序，不強迫每次重走wizard。已有結果首頁直接到學生總表；初始首頁主動作「先確認課表」、次動作「匯入學生」。seed存在時說「已載入初始課表，請確認」，不假稱人員已確認。沒有學生也可查看班級扣天。

課表設定兩頁籤：課表（預設）、班名對應（待處理數量）。班名對應未匯入時說「匯入名單後，可確認ERP班名」，不阻擋課表。結果頁兩頁籤：學生總表、班級扣天。頁首一個h1、一個主要動作；來源時間／檔名一行，核對基準日另外標明，不混稱月帳期。版本ID、規則碼及診斷JSON放資料資訊的技術摺疊區。

## 3. 課表設定

### 3.1 版面與逐堂欄位

頁首 → 安親／課輔窗口摘要 → 班級搜尋／星期／在用或停用篩選 → 課表 → 固定底部操作列。

窗口**唯讀**：值來自ruleSet（現為安親週一至五13:00–16:00、課輔16:30–19:30，`web/src/domain/schedules/overlap-calculator.ts:9-12`），不提供「調整時段」入口或輸入框；星期依當前v2規則顯示，不在此增加可變星期政策。窗口屬ruleSet參數，變更須建立新版本並重算（根CLAUDE.md §2），且現行計算只讀ruleSet窗口、不讀draft窗口（§8.1），故窗口編輯**不在本次範圍，需未來operator決策**（D33）。示意稿的「調整時段」按鈕與此不符，見[design/README](design/README.md)。

五個編輯欄順序：班級名稱、帶班老師、星期、上課時間（起）、上課時間（迄）。保留D25/D28逐列獨立改名，不改為只能整班改名。同名多列以細分隔分組；班名搜尋保留該班全部時段。新增時段在工具列，刪列在列尾選單、只改草稿且可取消；整班停用仍active=false。影響學生／別名的刪改在確認視窗呈現，不因有學生就禁止刪列。

右側只讀欄：課程時長（分）、安親重疊（分）、安親扣除（未取整／天）、課輔重疊（分）、課輔扣除（未取整／天）。兩個安親／課輔欄各自分組。單堂不能顯成已取整扣天。

顯示正扣除量（domain負數不改），原始天數最多小數3位，詳細值可在popover看；不可用顯示值計算。0顯示0；缺時間顯「待補」，未知星期有警告；合法週六與週一到五窗口無交集才顯0，不把未知當已驗證無衝堂。

### 3.2 草稿與儲存

有效編輯後200–300ms debounce預覽，重用既有domain及設定轉換器，不複製公式到React。取消舊請求／requestKey保護，晚到回應不得覆蓋新草稿。底部顯「有未儲存的變更」，次動作「取消修改」、主動作「確認變更」。班級／老師／星期／起迄／停用／班名對應的任何編輯都要dirty，並使舊preview失效。

課表預覽標「未儲存」，可展開「本班合計」看草稿總扣天；結果頁預設已儲存run，不靜默混入草稿。

確認視窗：修改班級／時段摘要與「無時段班級」數（§8.2.4）；有active學生顯受影響去重人數、天數前後、拆班／停用／失效對應；無學生顯「尚未匯入學生」，學生影響為null，不能寫0當作驗過。主按鈕有學生為「儲存並更新結果」，無學生為「儲存課表」。只有此時提交。

成功短toast＋「下一步：匯入學生」或「查看核對結果」。失敗保留草稿與舊結果；409／過期說「資料已更新，請重新確認變更」，可重試。送出中disabled且冪等；離頁保留D31未儲存提醒，不每改欄就跳modal。

### 3.3 班名對應

呈現ERP班名、去重學生數、系統班級選擇、狀態。用「ERP班名 → 系統班級」，不顯alias/baseName。D32建議目標維持空白，由人員選擇；動態差集與已對齊隱藏保留，禁止模糊自動批准。區分「選現有班級」與「建立新班級」。本次未出現班級放可展開次區，不自動停用。

對應與課表同一草稿、同一次影響預覽／交易，保留改散與失效警告。數量標班名數，不與學生／報名筆數混用。

## 4. 匯入學生

頁內三態：選擇檔案 → 確認名單 → 完成。上方一行課表儲存時間與查看連結。文案「上傳ERP匯出的學生Excel（.xlsx）」；OOXML等技術字不放主畫面。解析中有狀態，不捏造百分比。

預覽顯檔名、總人數、有班／無班，以及相對目前名單的新增／異動／本次未出現數（需API真實提供）。未使用之前舊結果不變。未知班名是「N個班名待確認」，可查且非整批阻擋；缺必要欄等顯短錯誤＋列號／欄名／修正方式，不能只tooltip或code。

主按鈕「使用這份名單」在本頁接activate，不先返回首頁找另一顆啟用按鈕。顯示可確認的核對基準日；套用最新已儲存課表與班名對應（由server於activate解析，§8.2.1）；版本已變需重新確認。成功顯「已更新N位學生」＋「開始核對」。重傳同檔保留判重與用新課表重算能力。財務報表不是此入口的輸入。

## 5. 核對結果

### 5.1 學生總表

主篩選順序：班級（可搜尋）→ 學生搜尋 → 需確認 → 更多篩選。更多篩選保留分校、年級、科別、基本／課程適用率、天數＋careType、兄弟姊妹、特殊折扣、園內生、額外扣天、ERP比較、問題類型；不能為簡化而移除原能力。

已選條件chips可單獨刪除，清除不改run。view/runId/非個資filters入URL；搜尋q可能含個資，頁內session保存，不寫URL或analytics。返回保留條件及捲動；分頁固定run，查詢debounce／取消舊請求。

人數一行：「本班N人 · 符合篩選M人 · N位需確認」，標明scope；學生去重。若後端stats只有全批，不能標成本班，須補同範圍查詢。載入保留舊表但明示更新中，不能宣稱是新篩選結果。

預設欄位：姓名（凍結）、年級、所屬班級、安親天數、課輔天數、額外扣天、合計折扣、已補科數、兄弟姊妹折扣、特殊折扣、園內生、需確認。人員代碼、美語／數學／中文天數、寫功課等既有欄移到欄位選擇／明細，不刪功能。

合計折扣對應基本率，說明「指定課程可能另有調整」。選班後加本班適用折扣，不能覆蓋基本率。顯示95折／9折及收取比例的tooltip；未配置不當100%，0/null/非適用/未知分開。未選班的適用率說「選班後顯示」。班名最多兩行＋另N班可點展開。

簡短徽章：天數不同、缺課表、重複報名、優惠待查、來源不同。popover展示ERP與計算前後值。無警告不堆綠色badge，不宣告帳單已對帳正確。

學生明細抽屜分「收費結果」「課程與扣天」「原始資料」「技術資訊」（摺疊），原始備註／標籤按需讀取，保留D27列表脫敏。維護代碼、raw trace與JSON仍可查但不預設倒出。

### 5.2 班級扣天

對應Excel C表。欄：班級、老師、上課時間摘要、安親原始扣除、安親實際扣除、課輔原始扣除、課輔實際扣除、狀態。四個扣除欄單位天，正量顯示；原始三位小數、實際半天單位，domain依原規則先整班相加再取整。

篩班名／老師／需確認／有重疊；點班級展開全部時段與逐堂五個計算欄，連結「編輯此班課表」。缺時段、共用窗口、無重疊分開。

有active run時同學生總表讀該run課表快照與規則；無active時讀已儲存課表，標「尚未匯入學生，可先檢查扣天」。歷史run不得套用最新設定，資料不足要明示不可重建。

## 6. 視覺與可及性

沿用tokens：背景#f8fafc、白卡、正文#0f172a、次文#475569、邊框#e2e8f0、主色#2563eb／hover#1d4ed8。琥珀＝需確認、紅＝失敗／阻擋、綠＝成功，不把ERP差異一律染紅。

1440桌面側欄184–200px、內容padding24px、可伸展到1600px；標題24px、正文14px、表格13–14px、列高至少44px、input36–40px、圓角8–12px。數字tabular-nums靠右、單位表頭。

寬表只在表內捲動，表頭／姓名sticky、邊緣陰影提示。1280仍可讀核心值；1024以下可用選定列計算側欄，不縮字到10px。768導航收合，非完整手機編輯驗收但不可有死遮罩。

tooltip短句、數值；hover/focus/click均可開、Esc可關。多步說明用popover/drawer，可固定／複製；阻擋錯誤、需確認後果不可只藏hover。icon有accessible name，target至少24px並留間距。modal focus trap／aria-modal／標題／關閉返回焦點，表單有真label、錯誤關聯與aria-live；導航aria-current，頁籤鍵盤可操作，不以emoji作唯一狀態。

## 7. 文案與所有狀態

|舊字串|日常介面|
|---|---|
|P1／展示A/B／localhost原型|移除；版本資訊另層|
|Run／rev／長ID|資料更新時間；技術資訊可查|
|alias／baseName|班名對應／ERP班名|
|seed本批未出現|本次名單未出現的班級|
|dry-run／active|確認變更／目前使用的資料|
|OOXML／inlineStr／DB路徑|維護文件，不在日常流程|
|預期5人|移除，只在fixture|
|雙軌差異JSON|計算說明的技術摺疊入口|
|PREVIEW_EXPIRED／REVISION_CONFLICT|預覽過期／資料已更新，請重新確認；code留詳細|

須有初始、只有課表、名單預覽、現行資料、草稿、計算中、待確認、儲存中、成功、驗證失敗、409／過期、空篩選、查詢失敗、歷史唯讀畫面。每態有明確動作，不用教學長文代替流程。

## 8. 必要API／持久化銜接

「現況」皆對照`66d6371`的`web/src`；本文件只定義目標契約，不修改程式。8.2.1、8.2.2、8.2.4是**既有缺陷**，非本次UI改版新增，但先課表流程會放大它們。

### 8.1 唯讀計算read model

新增application calculateSchedulePreview，重用overlap-calculator與相同設定轉換（draftToScheduleOverride，語意見8.2.4），v2明確帶sameWeekdayOnly。不要前端自算第二套。

**窗口唯讀**：窗口是ruleSet參數（`RuleSetOptions.anqinWindow／tutoringWindow`，`web/src/domain/schedules/overlap-calculator.ts:36-37`，預設常數`CARE_WINDOWS`同檔9-12）。現況`draftToScheduleOverride`只轉換sessions（`web/src/adapters/sqlite/settings-repository.ts:165-181`），draft的careWindows沒有進入計算。故read model一律用ruleSet窗口，回應帶`windows`供畫面唯讀顯示，不讀draft窗口，避免預覽與正式run不同源。`SettingsDraft.careWindows`仍是schema必填（`web/src/contracts/settings.ts:300-303`），UI一律帶ruleSet值；server收到不同值回400 INVALID_DRAFT，不靜默忽略。

建議POST /api/v1/settings/calculate：輸入draft、requestKey（**不含ruleSetVersion**）；回requestKey、draftHash、ruleSetVersion、windows、rows、classes、issues。rows含rowId/classKey/durationMinutes、兩組overlapMinutes/rawDeduction/status；classes含兩組totalOverlapMinutes/raw/rounded/status/rowIds。rowId保持穩定，空時段列仍回null與issue。這個POST僅純計算，不建立preview／run、不寫DB，仍驗same-origin與payload限制。

**ruleSetVersion由server決定**，做法同`web/src/application/settings-preview.ts:125-132`：有active run採其ruleSetVersion，無則採現行正式軌erp-tag-v2。新增要求：值必須是正式軌；若active run為診斷軌excel-v260922-compat（activate現未限制版本，`web/src/application/calculate-run.ts:29`）則改採現行正式軌。client不得指定，任何情況不得選compat（診斷軌不作正式值，根CLAUDE.md §2）。

新增GET /api/v1/settings/deductions?runId=：指定run讀固定快照；無指定有active則active，無active才saved settings；回scope及版本，不寫DB。不可用最新課表補舊run。

### 8.2 activate與儲存的資料來源

**8.2.1 activate採最新已儲存設定（現況缺陷）**

現況：roster-view送出activate只帶expectedRevision／idempotencyKey／asOfDate（`web/src/components/roster-view.tsx:84-91`）；route只轉交asOfDate／scheduleVersionId／ruleSetVersion（`web/src/app/api/v1/imports/[previewId]/activate/route.ts:22-32`）；activateImport以此options呼叫executeCalculationRun（`activate-import.ts:112`），options沒有aliasMap／scheduleOverride（`web/src/application/calculate-run.ts:92-93,99-100`皆為undefined），scheduleVersionId預設`seed-v250922`（同檔28）。結果：「套用設定→匯入新名單→啟用」的新run計算退回seed課表、不套班名對應，且run.scheduleVersionId（同檔200）標成seed。D17要求照實呈現，這是靜默丟失人工設定。apply路徑則正確傳入（`web/src/application/apply-settings.ts:129-135`）。

目標契約：**每一次**activate，server於同一交易內解析最新已儲存settings version（`getLatestSettingsVersion`，`settings-repository.ts:62-69`，取revision最大者，不依日期）：有則經draftToAliasMap／draftToScheduleOverride（同apply）計算，run.scheduleVersionId＝該version id；尚無任何已儲存設定才用seed（scheduleVersionId維持`seed-v250922`）。client傳入的scheduleVersionId一律忽略（現況它只被寫成run標籤，會讓run宣稱用了實際沒用的版本），冪等hash不含它。activate的ruleSetVersion維持現行可由client指定正式軌（既有測試`web/tests/integration/api-t06-routes.test.ts:157`依此驗erp-tag-v1不可變契約），本文件不改。activate與設定變更之間的競爭由revision CAS擋下（apply與settings_only皆遞增revision）。

`effectiveFrom／effectiveTo`現況只在apply寫入（`apply-settings.ts:121-122`），沒有任何選版或計算讀取，設定編輯器也無此欄；本文件不描述、不提供有效日期能力，屬**不在範圍、需未來operator決策**（須先定義輸入者、選版規則與核對基準日asOfDate的關係，D33）。

**8.2.2 儲存的import由server決定**

現況：preview接受任意client importId（`settings/preview/route.ts:16-26`，`settings-preview.ts:117-120`只檢查該批有學生），apply把`active_state.active_import_id`設為preview.importId（`apply-settings.ts:140-142`）。client可傳非active的ready批次，儲存設定的同時把它啟用，等於繞過匯入頁activate的確認。

目標契約：preview／apply的import一律由server依`active_state`決定：有active→active import（with_students）；無active→settings_only，即使存在ready批次也不啟用它。契約刪除client的importId；過渡期若仍收到，僅做一致性檢查，與server決定值不符（含client以null繞過active、傳入非active批次）即以400／409拒絕，絕不採用client值。ready批次只能經匯入頁activate啟用（§4）。

**8.2.3 無學生儲存與migration**

沿用settings/preview與apply，mode由server判：settings_only／with_students。settings_only影響人數為null、apply只保存設定並遞增revision，runId=null、不建假run、不改active_state；with_students仍原子設定＋新run＋active。與activate競爭仍CAS／409，preview hash／TTL／冪等不變。

欄位限制：`settings_previews.import_id NOT NULL`在`web/src/adapters/sqlite/migrations/0004_settings_versions.sql:14-23`；`idempotency_records.run_id NOT NULL`在`0003_runs_and_calculations.sql:51-57`（不在0004）。SQLite不能以ALTER移除NOT NULL，新增向前migration以**table rebuild**：建新表（欄位可null）→INSERT…SELECT逐列複製→DROP舊表→RENAME→重建索引；settings_previews須含0005新增的`expires_at`（`0005_settings_previews_expires_at.sql:3`）。不能刪DB重建；repository型別與response的runId同步可null。舊資料逐列保留列為必要測試（UX17）。

**8.2.4 空時段與整班移除語意（現況缺陷）**

現況：draftToScheduleOverride對active且sessions為空的班級不寫入override（`settings-repository.ts:174`）；gridRowsToClasses丟掉缺起訖或迄≤起的列（`contracts/settings.ts:136-137`）；resolveClassSessions找不到override就退回seed課表（`web/src/domain/billing/billing-calculator.ts:55-63`）。結果：某班所有列時間清空／刪光，或整班自draft消失時，畫面顯示「待補」（§3.1、§8.1），學生run卻仍用seed舊時段扣天，逐堂、班級、學生三者不同源，違反03 §3 ScheduleVersion「消除空sessions雙義性」。

目標語意，二擇一，**採A**：

- A（採用）：存在已儲存設定版本時，班級與時段的唯一來源是該版本的全量draft（D25），seed只作「尚無任何已儲存設定」的初始值。班級存在但sessions為空＝無時段：不扣天、status=schedule_empty（既有分支`billing-calculator.ts:57-58`），read model對該班回null並列issue，學生run同樣不扣天並帶issue。班級不在該版本＝無此班，落schedule_not_found並列issue。兩者皆不得退回seed。
- B（不採用）：apply拒絕含空時段班級的draft。

理由：(1) D29明定單列時段可刪、整班以active=false軟停用，B會使「刪光時段」或改名散班無法儲存；(2) D25／03已規定draft攜全量以消除空sessions雙義，A是其落實，且與現有active=false→空時段（`settings-repository.ts:170-172`）同語意；(3) B逼使用者為了儲存其他修改而填入假時段，違反D17。確認視窗須列出「N個班級無時段：學生不扣天並列入問題」（§3.2）。

**8.2.5 dirty與同源**

dirty helper涵蓋班級／老師／星期／起迄／停用／班名對應；窗口唯讀不進dirty。計算預覽和提交的draft須完全一致。

### 8.3 查詢與歷史

維持run固定分頁、白名單。移除UI UNMAPPED_CLASSES固定集合做狀態判斷（`web/src/components/active-run-view.tsx:19,499`），改讀當前resolution／D32動態候選。不能把最新已批准的D30同星期規則退回舊v1。歷史UI只讀，不新增「恢復為現行」寫入功能。

## 9. 完成門檻

依[04 §8](04-tdd-acceptance.md) UX矩陣：空DB先課表、逐堂／班級／學生同來源（含空時段與整班移除）、activate採最新已儲存設定、server決定import、窗口唯讀、八欄直接可見、工程字降層而警告不消失、舊domain與歷史值不變、設定only與有學生交易都可用。設計稿不算產品已完成，不代表帳單已正確。
