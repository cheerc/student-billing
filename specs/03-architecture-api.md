# 技術架構、資料模型與 API 契約

> 2026-09-30 驗收修正補充：學生查詢的多值篩選、選項與「無課程」契約見[§5.1](#51-學生查詢多值篩選選項與無課程契約b1目標)（[06 D36、D38](06-handoff-decisions.md)；目標契約，依[11](11-ui-acceptance-fix-plan.md) B1實作）。§3的設定資料模型不變；班級類別與固定5天的設定欄位、版本快照與ruleSet屬11的D批，本次不改。
>
> 2026-09-29 UI重設補充：依[06 D33](06-handoff-decisions.md)，無學生儲存設定、activate採最新已儲存設定、preview／apply的import由server決定等設定生命週期放寬，見[09 §8](09-ui-workflow-redesign-spec.md)；§4–5其餘交易／版本不變式不變，驗收見[04 §8](04-tdd-acceptance.md)。§3 ScheduleVersion的careWindows與effectiveFrom/To是schema欄位，現行不參與選版或計算；operator已決定安親／課輔窗口固定、不可編輯，有效日期不在範圍（D33）。計費規則沿用目前D24–D32，不由UI改版變更。

## 1. 技術選擇

建議 TypeScript + Node.js 24。不是所有資料處理工具唯一最佳語言，但本案主要是 Web 操作、確定性規則、檔案解析與未來 Vercel/Firebase 整合，前後端共用型別與純函式測試的價值大於另建 Python 服務。Python 可留作開發期間 Excel 獨立驗證工具，不成為部署依賴。

Vercel 官方已提供 Node 24 的 build / function runtime；專案以 `engines.node: 24.x` 明確指定，實作時鎖定本機實際 minor 版本及依賴 lockfile。來源：[Vercel Node.js 24 公告](https://vercel.com/changelog/node-js-24-lts-is-now-generally-available-for-builds-and-functions)。

建議單一 Next.js（React）應用，使用 Node runtime 的 route handlers；UI 與 API 同專案但业务邏輯獨立。P1 不拆微服務、不做 message queue、不先建 monorepo。Next.js 與各套件確切版本留給實作 plan 在 Node 24 環境確認相容性後鎖定，不能在本規格把尚未驗證的套件版本當既成事實。

|層|建議|原因／界線|
|---|---|---|
|UI|React + TypeScript、可排序表格元件|清楚篩選與明細；表格元件不計算收費規則|
|服務|Next.js Node API + 共用 schema 驗證|供 UI 和未来 agent 使用相同結果|
|規則|純 TypeScript functions|不依赖 Excel 引擎、React、DB、Date.now 或網路|
|XLSX 讀取|解析器 adapter；優先評估 ExcelJS 或 SheetJS|用真實檔驗證字串、隱藏欄、日期、陣列公式讀取；P1 不要求公式執行|
|本機 DB|SQLite，repository 封裝|單機交易、快照切換、重啟保存；不需要裝 DB server|
|DB driver|Node 24 相容 SQLite driver，於 plan 鎖版|node:sqlite 可評估，但其 API 穩定性要查所鎖定的 Node 24 文件；不得拿最新 Node 26 API 誤用|
|測試|Vitest + API integration + Playwright|純規則、真實 SQLite 交易與瀏覽器流程各驗一層|
|未來儲存|Firestore adapter + 物件儲存|規則和外部 API 不因 DB 更換而重寫|

XLSX 模板保真是獨立能力：不可因解析器能讀寫 Excel 就宣稱能保留所有列印設定與 OOXML 物件。P3 必須做專門的模板 round-trip 評估。

## 2. 層次與責任

```
UI / read-only agent client
          ↓ HTTP
application services: import / settings / calculate / query / export
          ↓                         ↓
domain: parser contracts + pure billing rules + provenance
          ↓
repositories / XLSX adapter / clock & ID provider / file store
```

提議目錄（未建立）：`src/domain`、`src/application`、`src/adapters/xlsx`、`src/adapters/sqlite`、`src/app`、`tests/unit`、`tests/integration`、`tests/e2e`、`tests/fixtures`、`data`。避免為未來每個可能平台先寫空 interface；只封裝本案確有替換需求的 persistence 和 workbook IO。

金額目前不計算；折扣使用整數 basis points，時間使用整數分鐘，天數用半天單位或明確 number（結果只允許 0.5 倍數）。跨日課程 P1 明確拒絕，不能用 end<start 自動加 24 小時。日期使用 `YYYY-MM-DD` 與 Asia/Taipei 語意，時間戳使用 UTC ISO 字串；計算傳入基準日，不偷偷使用系統今天。

## 3. 邏輯資料模型

每張實體具有 id、schemaVersion、建立時間；來源記錄不隨後續匯入修改。下表為邏輯模型，不強迫一對一映射成 Firestore collection。

|實體|核心欄位|限制|
|---|---|---|
|ImportBatch|id、fileName、fileHash、contentHash、sheet、headerMap、parserVersion、scopeNote、rowCount、status、createdAt|批次不可變；檔名不是識別；contentHash 用於同內容不同檔判別|
|StudentSnapshot|importId、personCode、rawName、displayName、englishName、gradeRaw、grade、branches、classText、tagsRaw、notesRaw、contactRaw、schoolRaw、sourceRow|唯一(importId, personCode)；標籤與備註不互覆；年級無／空為未知|
|EnrollmentSnapshot|enrollmentId、importId、personCode、tokenIndex、rawClassToken、yearPrefix、baseName、groupFlag、modifiers、withdrawalDate、parseStatus、erpBillingTierRaw、erpBillingTier、tierParseStatus|不可變解析資料；不在此保存隨設定變更的classId|
|EnrollmentResolution|runId、enrollmentId、classId?、mappingStatus、aliasVersion|解析對應固定於run，不查目前最新alias反改舊結果|
|ClassDefinition|classId、name、subject、active、teacher、revision|停用保留，不提供硬刪除；無 classId 主鍵前不做更名（以停用舊班＋新增新班替代）|
|ClassAlias|aliasId、rawToken、classId、scope、effectiveFrom/To、revision|同一有效範圍 alias 不可同時對多班|
|ScheduleVersion|id、effectiveFrom/To、careWindows、createdAt、source|整套設定版本；初始草稿攜帶 seed 全文 89 筆平鋪時段，消除空 sessions 雙義性|
|ScheduleSession|scheduleVersionId、sessionId、classId、weekday、startMinute、endMinute、order|一班多時段；重複警告，不自動去重|
|RuleSet|id、version、parameters、description|P1 用程式定義的版本；parameters 至少含 minutesPerBillingDay、取整門檻 zeroBelow／fullAtOrAbove、課輔整日特例條件（D24）；改參數即新版本；不建任意公式编辑器|
|CalculationRun|runId、importId、scheduleVersionId、classCatalogVersion、aliasVersion、ruleSetVersion、numericPolicy、asOfDate、status、issueCounts|正式erp-tag-v1；歷史compat診斷不可啟用；輸入版本全固定|
|StudentCalculation|runId、personCode、subjectCount、baseDiscountBps、careDays、flags、issues、trace|穩定輸入產生穩定業務結果|
|ClassStudentResult|runId、classId、personCode、enrollmentIds、enrolled、applicableDiscount、billingTier、tierComparisons[]、issues|每個enrollment各比較，班級人數去重；不覆寫domain原值|
|ActiveState|activeImportId、activeRunId、revision|原子更新，UI/API 只能看到完整 run|
|TemplateDefinition（P3）|templateId、version、fileHash、bindings、capacity、datePolicy、printManifest|範本版本與每次輸出綁定|
|ExportRecord（P3）|exportId、runId、templateVersion、classId、dateRange、studentOrder、fileHash|可重現當時結果|

`careDays` 含 anqin/tutoring 兩個結果，每個都有 value（數值或 null）、legacyDisplay、status、enrolled、reason。基本折扣、課程適用率分開存。學生沒有班級仍保留 StudentSnapshot；不建立假 Enrollment。

tierComparisons 各有 enrollmentId、computed、erpDeclared、status（match/mismatch/not_applicable/unavailable）、issues；計算不得讀erpDeclared回填。scheduleStatus 為 schedule_not_found/schedule_empty/schedule_incomplete/no_overlap/has_overlap/care_window；前3種令相依結果needs_review。無alias的解析token也可展示其ERP級距與依年級算出的fallback，比較結果不消除mapping警告。

ClassDefinition、ClassAlias、ScheduleSession 及解析對應均須可由run引用到不可變版本內容，不只保存版本字串；名稱／科別／老師更新不得改變歷史結果。P1可用整套設定JSON快照，無需建立通用事件溯源框架。

最小 provenance：來源檔 hash、工作表、列號／標頭、命中規則 ID、schedule session IDs、原始重疊、每班 raw／rounded 扣天、額外扣天、下限套用前後、輸出值。不要把所有 raw PII 複製到每個 API response。

## 4. 交易、版本與持久化

匯入生命週期：uploaded → parsed → validation_failed 或 ready → calculating → completed。啟用只允許 completed。使用者可取消 ready 批次。P1 可同一請求同步完成，但資料狀態與失敗回復仍須定義。

SQLite 使用交易：先寫不可見的新批次／結果，完成驗證與計算後才一次切 activeState；任何步驟失敗，現行結果不變。設定保存同理。並行兩次變更使用 revision 比對，過期更新回 409，不最後寫入者無聲覆蓋。

同檔 hash 再上傳顯示已匯入，不重複建立學生；若排課改變可用同 import 新建 run。不同檔案同內容可提示重用；不以檔名直接判重。ActiveState 初始化為 revision=0、activeImportId/activeRunId=null；初始設定 seed 使用獨立冪等初始化流程，不需要先有 run。首次 activate 仍以 revision=0 做 CAS。preview 固定設定版本並設 TTL 逾期防 stale，僅跑正式 erp-tag-v1 規則；preview／apply 過期回409，不悄悄改用最新設定；activate 則由 server 於同一交易內解析最新已儲存設定版本（[09 §8.2.1](09-ui-workflow-redesign-spec.md)）：run.scheduleVersionId＝該版本 id，忽略 client 傳入的 scheduleVersionId，尚無已儲存設定才用 seed。idempotencyKey 必須附加隨機後綴（如 `apply-{timestamp}-{random}`）；相同 idempotencyKey/body 的成功重送先回原成功結果，再處理新請求的 revision 檢查，避免首次成功後網路重試得到錯誤409；失敗不留成功紀錄。比對基準採初始 seed 盤點（49 班基準）與目前設定視圖（active classes ＋ 已核准 aliases）雙軌並存。

P1 整批重算可接受，5000 筆規模未證明有瓶頸前不實作複雜增量計算。

本機資料放專案 `data/`，包含 SQLite 與按 hash 存放的原始來源／模板。備份須包含 DB + 設定 + 模板／來源 manifest，而不只是單一 DB 檔。P1 至少提供停機後可依 README 完整複製還原的方法；P2 可做 UI 備份還原。

瀏覽器不是唯一儲存，清 localStorage 不得清掉學生資料。原始來源檔永不覆寫，最新批次也不回填根目錄使用者 Excel。

## 5. P1 API 最小契約

路徑 prefix `/api/v1`。正式結果查詢可指定 `runId`；未指定才解析目前 activeRun。imports、ready preview及設定端點使用各自的批次／設定版本，不套此規則。列表回 `runId`，後續 detail／page 固定使用此值。跨頁 activeRun 改變不應造成混合版本。

|方法與路徑|階段|行為|
|---|---|---|
|POST /imports/preview|P1|multipart file；解析驗證，回 previewId、標頭、數量、issues、差異摘要|
|POST /imports/{previewId}/activate|P1|body 帶 expectedRevision、idempotencyKey、asOfDate（可選 ruleSetVersion）；不接受 scheduleVersionId，server 於同一交易內解析最新已儲存設定版本（09 §8.2.1）後計算並原子啟用|
|GET /imports|P1|批次基本資料；不回傳全部 raw notes|
|GET /runs/current|P1|回 ActiveState revision 與目前 run；首次空資料回 200、revision=0、run=null|
|GET /classes?runId=...|P1|本批可見班級、科別、去重學生數、設定狀態|
|GET /students?runId=...&classId=...&q=...|P1|學生總表與篩選；分頁，limit 預設 50、最大 200|
|GET /students/{personCode}/calculation?runId=...&classId=...|P1|八欄、課程適用率、解釋與來源；無匹配 404|
|GET /settings/classes|P1|可維護班級定義含 revision|
|PUT /settings/classes/{classId}|P1|帶 revision；保存課程、別名關係及驗證結果|
|POST /settings/classes|P1|建立新班，不自動加入學生 enrollment|
|POST /settings/preview|P1|傳班級／別名／時段草稿與expectedRevision，回previewId、受影響名單、天數及級距比較前後差異；不寫active|
|GET /settings/schedules|P1|排課版本及時段|
|POST /settings/schedules|P1|建立新設定版本與 run；帶 expectedRevision，失敗保留舊版|
|GET /runs/{runId}/issues|P1|可按學生／班級／規則篩選問題|
|GET /runs/{runId}/comparison|P1|唯讀診斷；`againstRuleSet` 白名單目前只接受 excel-v260922-compat，其餘回 400。詳見本節後段|
|GET /imports/{previewId}/students|P1|ready 批次預覽名單；與正式查詢共用篩選工具，但只接受不依賴計算的參數，其餘回 400。詳見本節後段|
|GET /exports/review.csv?runId=...|P2|指定篩選核對清單，防公式注入|
|GET /openapi.json|P2|正式機器可讀契約；P1 先以此文件與契約測試維護|
|POST /exports/attendance|P3|綁定 run、templateVersion、class、日期區間及排序|

`POST /settings/schedules` 的 P1 UX 可提供「儲存並重算」；不要自動改舊 scheduleVersion。初始草稿直接攜帶 seed 全量 89 筆時段，消除空 sessions 雙義性。無 classId 主鍵前不做更名功能；停用班級一律透過 active=false，不提供硬刪除歷史。

影響計算的設定保存需帶previewId與expectedRevision；預覽hash綁定草稿、import、設定、ruleSet，任一改變回409要求重預覽。預覽草稿設定 TTL 防止陳舊操作，且預覽只跑正式 erp-tag-v1 規則以保證反應速度。保存不得接收與預覽不同草稿。GET /classes 可含 mappingStatus=unmapped 的待設定項目及暫定候選鍵；GET /students 可用 enrollmentKey 查該清單，不因缺classId失去學生。列表 API 執行脫敏保護（不回傳完整電話與自由備註），單一學生明細抽屜 API（GET /students/{personCode}/calculation）按需查閱完整原文；學生資料字元一致性走依人員代碼排序之逐 key SHA-256 hash 比對。就學資料只存不篩。

GET /runs/{runId}/comparison?againstRuleSet=excel-v260922-compat 為P1唯讀診斷，固定同輸入，列欄位前後值、來源與差異分類；不切換active。可先在明細／診斷頁顯示107筆率差，不要求P1做通用報表平台。診斷值是固定輸入的純函式，**預存或即時計算皆可**，兩者結果必須相同；P1預設即時計算不落庫，避免結果表多出一份與正式結果等大的資料，待bench顯示診斷頁影響操作再改預存。即時計算仍不得寫入任何資料。run 保存 diagnosticAlgorithmVersion 與必要浮點輸入；程式升級不得用另一版本診斷覆蓋舊run的意義。舊版本不支援時明確回409 DIAGNOSTIC_VERSION_UNAVAILABLE。正式 run 的 NUMERIC_POLICY_DIFFERENCE 與 hasIssues 在建立run時就計算、保存，不能等使用者開診斷頁才產生。只比較同來源／同映射／同取整規則下的兩種 numericPolicy 以判定此問題碼，來源、alias 或取整規則（D24）差異另分類。

GET /imports/{previewId}/students 供ready批次在啟用前查看名單，與正式查詢共用同一套篩選工具，資料入口不同。只接受參數：classId、enrollmentKey、subject、grade、branch、hasClass、q、sort、cursor、limit、erpBillingTier、mappingStatus。傳入正式 run 專用參數（runId、baseDiscountBps、applicableDiscountBps、billingTier、careType、sibling、specialDiscount、internalStudent、hasExtraDeduction、tierMismatch、tierComparison、hasIssues、scheduleStatus、issueCode）一律回400並指名該參數，不默默忽略、不回傳未計算的空值假裝已比對。其他未知參數亦回400。erpBillingTier 使用不可變解析值；classId／mappingStatus 依 preview 建立時固定的設定快照解析，只採已核准映射，候選不等於已對應。subject優先依核准班級，未映射時用02的已知token文法分類，未知列待設定、不猜科別。未映射者用 enrollmentKey 查名單。preview response 回設定版本，cursor 綁 previewId、設定版本與 filters/sort；後續設定改變不偷偷改舊預覽，新建 preview 才更新對照。此為中途預覽契約，不是第二套收費API。

學生查詢額外參數：subject、grade、branch、hasClass、baseDiscountBps、applicableDiscountBps（需 classId）、billingTier（需 careType）、sibling、specialDiscount、internalStudent、hasExtraDeduction、hasIssues、sort、cursor。只接受白名單值；無效值回 400，不默默忽略。不同類型篩選 AND；姓名 q 為字面子字串，不作 regex，姓名排序相同時以 personCode 穩定排序。

增加tierMismatch=true/false、tierComparison、erpBillingTier、mappingStatus、scheduleStatus、enrollmentKey、issueCode。issueCode 為單一已定義問題碼，至少支援 DUPLICATE_SUBJECT_ENROLLMENT、STAFF_FAMILY_NO_DISCOUNT、CONFLICTING_NOTE_SOURCE、NUMERIC_POLICY_DIFFERENCE，未知碼400；與其他篩選AND，hasIssues=false 同時指定issueCode回400。學生層級提示在選班後仍保留；班級／enrollment問題在所選範圍內比對。careType 僅接受 anqin/tutoring，billingTier 必须同時帶 careType。tierMismatch=true表示選定班／科別範圍內任一enrollment為mismatch；false只包含所選範圍內至少一筆match、沒有mismatch或unavailable者；not_applicable不算match也不構成不一致。tierComparison可明確選未知／不適用；與tierMismatch矛盾回400。班級未指定時總人數仍是去重學生數，另回comparisonCounts標示enrollment筆數。

以下是示意 response，不是現有學生：

```json
{
  "runId": "run-example-001",
  "importId": "import-example-001",
  "ruleSetVersion": "erp-tag-v1",
  "numericPolicy": "integer-minute-rational-v1",
  "scheduleVersionId": "schedule-example-001",
  "asOfDate": "2026-09-22",
  "totalStudents": 1,
  "nextCursor": null,
  "items": [{
    "personCode": "DEMO-001",
    "name": "示範學生",
    "grade": "小一",
    "subjectCount": 2,
    "baseDiscountBps": 9500,
    "anqin": {"value": 4.5, "status": "calculated", "enrolled": true},
    "tutoring": {"value": null, "status": "not_applicable", "enrolled": false},
    "applicableDiscount": {"classId": "class-example", "valueBps": 9000, "status": "calculated"},
    "issues": [],
    "ruleIds": ["R09", "R10", "R11", "R13"]
  }]
}
```

ERP token 可有明確離班日期，依使用者決策只顯示不排除。財務檔有排課起迄日但不匯入本工具；學生檔沒有完整入班／異動歷史。asOfDate只作核對基準日記錄於run，不選排課版本（課表版本一律取最新已儲存設定，09 §8.2.1），不用離班日自動改名單或科數，不能重建任意日期真實enrollment。

錯誤格式：`{error:{code,message,details,requestId}}`；結構錯誤 400，缺必要欄／重複代碼等資料驗證 422，版本衝突 409，檔案過大 413，未找到 404，內部錯誤 500。一般 response 不附 stack 或完整學生備註。

### 5.1 學生查詢：多值篩選、選項與「無課程」契約（B1，目標）

依[06 D36、D38](06-handoff-decisions.md)與[11 §3 B1](11-ui-acceptance-fix-plan.md)。本節是**目標契約**，由B1實作；「現況」對照`e1b1a58`的`web/src/app/api/v1/runs/[runId]/students/route.ts`（下稱route）與`web/src/application/query-students.ts`（下稱query）。主要適用`GET /runs/{runId}/students`；`GET /imports/{previewId}/students`與正式查詢共用篩選工具（見上），其可接受的參數集合與禁用清單不變，本節的傳輸與空狀態語意同步適用。

**現況盤點（B1的RED依據）**：

1. route把query string轉成`Record<string,string>`（route:15-18），同一個key出現多次只留最後一個。
2. 班級只查單一值：`enrollmentKey`優先於`classId`，兩者都比對`student_enrollments.base_name`，並非classId主鍵（query:199-211）。
3. 下列參數在白名單內，卻**沒有任何WHERE條件**（被靜默忽略，與上文「無效值回400，不默默忽略」不符）：`specialDiscount`、`hasExtraDeduction`、`scheduleStatus`、`sort`（結果恆以`person_code`升冪）。`applicableDiscountBps`只驗證必須帶班級，同樣沒有條件。`grade`傳非整數時亦被靜默忽略（query:213-220）。
4. `hasClass`在兩個端點語意不同：runs端點是`subject_count > 0`（有無折扣科數，query:268-276）：零enrollment（`subject_count`為null）、只有寫功課／交通車、以及一般輔導加寫功課依現行科數規則算成0科的學生，都落入`hasClass=false`；預覽端點是「有無enrollment」（`web/src/application/roster-query.ts`）。
5. 每頁`limit`預設50、上限200（query:172-180）；`cursor`只編碼最後一筆`personCode`的base64，不綁篩選條件。
6. `stats.classScopeTotal`是「只套用班級條件」的人數（未選班＝全批），與其他篩選無關。

**可篩選欄位清單**（現況對照`e1b1a58`；「目標」欄是B1要達成的狀態；除註明者外，多值＝同一參數重複出現，語意見下）：

|表頭／用途|參數|值型別|現況|目標|
|---|---|---|---|---|
|所屬班級|`enrollmentKey`（`classId`為同義單值別名，同時給時`enrollmentKey`優先）|字串＝班名（現況比對`base_name`；班級識別鍵待11 S-B節凍結後回填本列）|單值，生效|多值；保留值`~blank`＝無課程（見下）；`stats.classScopeTotal`隨多值|
|年級|`grade`|整數|單值，生效；非整數被靜默忽略|多值；`~blank`＝年級未知；非整數回400|
|安親天數／課輔天數|`billingTier`＋`careType`（`anqin`／`tutoring`）|數字（3、3.5、4、4.5、5）|單值，生效（比對`anqin_days`／`tutoring_days`）；`billingTier`必須帶`careType`|多值；`~blank`＝null（非適用或無法判定）。兩欄要能同時篩，故B1新增多值參數`anqinDays`、`tutoringDays`（語意同上）；`billingTier`＋`careType`保留為單值相容|
|額外扣天|`hasExtraDeduction`|布林|**未生效**|必須生效；判定與UI「額外扣天」欄一致|
|合計折扣（基本率）|`baseDiscountBps`|整數bps|單值，生效|多值；`~blank`＝null|
|本班適用折扣（僅恰選一班）|`applicableDiscountBps`（需`enrollmentKey`或`classId`）|整數bps|只驗證需班級，**未生效**|必須生效；取值來源依11 S-B節（未配置不當100%）|
|兄弟姊妹折扣|`sibling`|布林|生效（`tags_raw`含「有兄弟姊妹折扣」）|布林亦可重複|
|特殊折扣|`specialDiscount`|布林|**未生效**|必須生效|
|園內生|`internalStudent`|布林|生效（`tags_raw`含「園內生」）|布林亦可重複|
|需確認／問題類型／ERP比較|`hasIssues`（布林）、`issueCode`（字串）、`tierMismatch`（布林）、`tierComparison`（`match`／`mismatch`／`not_applicable`／`unavailable`）|見左|皆單值，生效（`issueCode`、`tierComparison`以JSON文字比對）；`scheduleStatus`**未生效**|`issueCode`、`tierComparison`多值；`scheduleStatus`生效或改回400（二擇一，B1定稿）；既有矛盾檢查（`tierMismatch`與`tierComparison`、`hasIssues=false`與`issueCode`）維持|
|分校|`branch`|字串（換行複值集合語義）|單值，生效|多值；預設欄位沒有分校欄，UI入口待11 B2確認|
|學生搜尋|`q`|字串（姓名或人員代碼的字面子字串）|單值，生效|維持單值搜尋框；不多值、不提供選項、不入URL|
|科別（UI入口已移除）|`subject`|字串|單值，生效（`base_name`／`raw_token`子字串）|**參數保留不刪**（agent相容），維持單值|
|有無折扣科數|`hasClass`|布林|runs端點：`subject_count > 0`|**語意不改**，且**不作為「無課程」判定**（見下）|
|控制參數|`cursor`、`limit`、`sort`|—|`sort`未生效|`sort`生效或改回400（二擇一，B1定稿）；`runId`是路徑參數，不作篩選|

**傳輸格式與單值相容**：

- 多值以**重複query key**傳送（`grade=3&grade=4`），server以`searchParams.getAll`讀取；不以逗號分隔（班名等值可含逗號）。route不得再把同key多值壓成一個。
- 既有單值呼叫（每個參數至多出現一次、值不是保留值）的語意與結果，與`e1b1a58`相同，視為單元素集合。刻意的例外只有：上表「未生效」與「靜默忽略」者改為生效或回400。
- 布林欄位的可用值為`true`／`false`；兩者同時出現等同該欄未篩選，但仍算「已設篩選」（供chips顯示）。
- 無效值、未知參數一律回400並指名該參數，不靜默忽略。

**三種空狀態（分開，不得以空字串一律代表全部）**：

|狀態|傳輸|語意|
|---|---|---|
|未設篩選（全部）|該欄的key不出現（既有的空字串`grade=`仍視為未設，僅為相容；UI不送）|該欄不限制|
|選了「(空白)」|保留值`~blank`，可與一般值並存（OR）|該欄為空的學生：所屬班級＝零報名（＝無課程）；年級／天數／折扣＝該欄為null或未知|
|取消全選後按「確定」|保留值`~none`，**只能單獨出現**；與其他值並存回400|空集合：0筆，`totalStudents`與stats各項皆為0|

保留值以`~`開頭；真實資料值若也以`~`開頭，傳輸時再前置一個`~`跳脫（`~~x`＝字面`~x`）。因非個資的篩選條件會寫入URL（[09 §5.1](09-ui-workflow-redesign-spec.md)），三種狀態都必須能由URL還原。

**匹配語意與去重**：同一欄多個值為**OR**；不同欄為**AND**。複值欄（所屬班級、問題類型）以「任一報名班／任一問題命中」判定，不因命中多個所選值而重複列出。`totalStudents`、`stats`、`classScopeTotal`一律依`personCode`去重，多班不相加。`classScopeTotal`＝只套用「所屬班級」條件（含多值）後的去重人數；未選班＝全批。UI依此標示「全部N人」「本班N人」「已選N班，共M人」（[09 §5.1](09-ui-workflow-redesign-spec.md)）。

**選項（options）read model**：各欄的選項取自**指定run的全部學生**，不受頁碼與`limit`限制；歷史run不讀最新設定；每個選項附去重人數，並含「(空白)」的人數。姓名、人員代碼等敏感欄位**不提供選項清單**，只保留搜尋框；options回應不含個資。唯讀、無副作用（同UX19）。端點路徑與回應形狀由B1定稿並回填本節。「全選搜尋結果」只是UI把搜尋命中的選項加入已選集合，不清除搜尋範圍外既有的選取。

**一致性、分頁與cursor**：名單、統計、分頁使用**同一條件**。條件（任一欄選值、`q`、run）改變時，client必須丟棄cursor並從第一頁重查，晚到回應不得覆蓋新條件的結果（requestKey保護，同[09 §3.2](09-ui-workflow-redesign-spec.md)）。cursor維持只編碼最後一筆`personCode`（不綁條件）；不合法的cursor回400。

**「無課程」（D38；獨立語意，不重用`hasClass`）**：

- **定義**：以不可變import名冊的報名資料判定，該學生在`student_enrollments`（該run的`importId`）**零筆enrollment**才算無課程。
- **不算無課程**（仍有課程）：原始班級文字非空但解析失敗者——解析器對每個非空token都保留一筆enrollment（`needs_review`者與未知班名皆然），並保留問題提醒；只有寫功課、交通車或其他未列入折扣類別的班；有離班標記（withdrawal date）的token——保留的離班token仍算有課程，不依基準日另行過濾。
- **與`hasClass`無關**：runs端點的`hasClass`是`subject_count > 0`（現況盤點第4點），`hasClass=false`混有只有寫功課／交通車、算成0科的學生，不等於無課程。點擊「無課程」提示等同所屬班級選`~blank`，其判定就是上述零enrollment。
- **計數**：全批無課程總數（整個run的名冊）與「當前條件下符合人數」分開回報；欄位名稱由B1定稿。**不併入「需確認」**：無課程本身不新增issue；該生若另有真實issue，仍計入需確認人數。
- **同源**：匯入預覽（`GET /imports/{previewId}/students`）與結果頁針對同一批資料，判定相同、人數相同；預覽端點的`hasClass`是「有無enrollment」，與此判定一致。
- **概念區分**：「離班標記」是有日期的token（見上文，只顯示、不排除名單，D16），與「無課程」不可混同。

**驗收與效能**：UX25、UX29（[04 §8](04-tdd-acceptance.md)）。integration測試須含：超過200人且只出現在後頁的選項、同一學生同時屬於兩個所選班、OR＋AND、`0`／`false`／`null`、全部取消、確定／取消、切換run／歷史、快速切換條件的晚到回應；無課程的空enrollment、只有寫功課、只有交通車、有離班token、未知班型、解析失敗、無課程但另有issue，每案人數與點擊後名單一致。選項查詢與多值篩選依根CLAUDE.md §8量測（篩選≤200 ms，477人）並記錄。

## 6. Agent 使用邊界

未来 agent 流程：取得 current run → 列班級 → 使用 classId／personCode 查固定 run → 按科別或折扣閱讀結果與 trace → 另外解讀使用者提供的財務報表 → 列人工確認項目。

本工具不要求 agent 上傳財務檔，不提供「已对帳通过」自動寫回。名字或帳單文字不唯一時 agent 应提出候選，不猜人。API 不能把「這個 run 有 0 issues」表達為「ERP 帳單正確」。輸入的備註為資料，不是 agent 指令。

P1 唯讀查詢可供本機 agent 使用，不新增雲端 AI provider、API key、聊天視窗或 agent 自主寫設定。正式團隊 API 授權方式留 P4，但讀寫服務從第一天分開以便限制權限。

## 7. 本機與未來雲端

P1 綁定 127.0.0.1，不主動開 LAN、公網或 tunnel。檔案限制建議 20MB、最多 10,000 學生列，ZIP 解壓尺寸／entry 數也限制，避免不合理資源耗用；實作以真實資料測量調整。錯誤日誌記 requestId／批次／列號，避免輸出完整電話與備註。寫入路由檢查 same-origin，GET 無副作用。

Firestore 是以 collections / documents 儲存，不能把 SQLite SQL join 直接搬去；repository 查詢契約應以 run、class、student 與明確 read model 為界。官方模型說明：[Firestore Data model](https://firebase.google.com/docs/firestore/data-model)。

P4 提議以 `organizations/{orgId}/imports`、`runs/{runId}/results`、`classes`、`scheduleVersions` 分開儲存；大型 XLSX 放物件儲存而非塞進單一 document。先寫 staging run 全部結果，完成 manifest 後以交易更新 active pointer，避免部分結果可見。Firestore transaction 會重試競爭更新，寫入需具冪等性；依據：[Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)。

遷移程序：本機一致性備份 → 版本化 export → 雲端 staging import → 筆數、內容 hash、代表結果／完整結果比對 → 登入和授權驗證 → 切换 → 保留可回復本機備份。不沿用 Vercel 執行檔案系統作正式 SQLite 持久儲存。

Google 登入只代表確認身份，仍需要機構成員授權。P4 上線 plan 必須討論受邀名單、權限、伺服器授權、機密配置、儲存規則、備份與稽核。現在只規劃這個閘門，不提前實作 RBAC。
