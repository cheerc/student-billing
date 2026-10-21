# 技術架構、資料模型與 API 契約

> 2026-09-30 驗收修正補充：學生查詢的多值篩選、選項與「無課程」契約見[§5.1](#51-學生查詢多值篩選選項與無課程契約b1-現況)（[06 D36、D38](06-handoff-decisions.md)；目標契約，依[11](11-ui-acceptance-fix-plan.md) B1實作）。§3的設定資料模型不變；班級類別與固定5天的設定欄位、版本快照與ruleSet屬11的D2，D1不改（D1只交付規則版本入口收斂等，見下一則補充）。
>
> 2026-09-29 UI重設補充：依[06 D33](06-handoff-decisions.md)，無學生儲存設定、activate採最新已儲存設定、preview／apply的import由server決定等設定生命週期放寬，見[09 §8](09-ui-workflow-redesign-spec.md)；§4–5其餘交易／版本不變式不變，驗收見[04 §8](04-tdd-acceptance.md)。§3 ScheduleVersion的careWindows與effectiveFrom/To是schema欄位，現行不參與選版或計算；operator已決定安親／課輔窗口固定、不可編輯，有效日期不在範圍（D33）。計費規則沿用目前D24–D32，不由UI改版變更。
>
> 2026-09-30 D1補充（[11 §3 D1](11-ui-acceptance-fix-plan.md)、[06 D40](06-handoff-decisions.md)）：規則版本入口收斂（activate不再接受client的ruleSetVersion、apply用preview記錄的目標版本、歷史run的讀取入口一律讀該run的設定快照）、migration 0007（純增量）、已存設定JSON單一讀取入口與班名比對報告，見本檔 §5.2；v1／v2／compat的計算行為不變。

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
|POST /imports/{previewId}/activate|P1|body 帶 expectedRevision、idempotencyKey、asOfDate（可選）；**不接受 scheduleVersionId，也不接受 ruleSetVersion（帶了回 400 INVALID_REQUEST，含 null；§5.2）**。server 於同一交易內解析最新已儲存設定版本（09 §8.2.1）與規則版本後計算並原子啟用|
|GET /imports|P1|批次基本資料；不回傳全部 raw notes|
|GET /runs/current|P1|回 ActiveState revision 與目前 run；首次空資料回 200、revision=0、run=null|
|GET /classes?runId=...|P1|本批可見班級、科別、去重學生數、設定狀態；**明確帶 runId 時讀該 run 當時的設定快照，快照缺失回 `snapshotStatus:"unavailable"` 與各班 `mappingStatus:"undetermined"`（無法判定，不猜）；未帶 runId 維持讀最新已存設定（§5.2）**|
|GET /students?runId=...&classId=...&q=...|P1|學生總表與篩選；分頁，limit 預設 50、最大 200|
|GET /students/{personCode}/calculation?runId=...&classId=...|P1|八欄、課程適用率、解釋與來源；無匹配 404|
|GET /settings/classes|P1|可維護班級定義含 revision|
|PUT /settings/classes/{classId}|P1|帶 revision；保存課程、別名關係及驗證結果|
|POST /settings/classes|P1|建立新班，不自動加入學生 enrollment|
|POST /settings/preview|P1|傳班級／別名／時段草稿與expectedRevision，回previewId、受影響名單、天數及級距比較前後差異；不寫active|
|GET /settings/schedules|P1|排課版本及時段|
|POST /settings/schedules|P1|建立新設定版本與 run；帶 expectedRevision，失敗保留舊版|
|GET /runs/{runId}/issues|P1|可按學生／班級／規則篩選問題|
|GET /runs/{runId}/comparison|P1|唯讀診斷；`againstRuleSet` 白名單目前只接受 excel-v260922-compat，其餘回 400。**以該 run 的設定快照（別名＋時段覆寫）重算，快照缺失回 409 SNAPSHOT_UNAVAILABLE，不改用最新設定或 seed 補算（§5.2）**。詳見本節後段|
|GET /settings/class-name-report|P1|班名比對報告（唯讀）；參數 `runId`／`importId`，見 §5.2.4|
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

### 5.1 學生查詢：多值篩選、選項與「無課程」契約（B1 現況）

依[06 D36、D38](06-handoff-decisions.md)與[11 §3 B1](11-ui-acceptance-fix-plan.md)。本節為 B1 落地之**現況契約**；適用於 `GET /api/v1/runs/{runId}/students` 與 `GET /api/v1/imports/{previewId}/students`（共用篩選與空狀態解析工具，其可接受參數與白名單依端點區分）。

**B1 修正之現況缺陷（前對照 `e1b1a58`）**：

1. route 以 `readStudentQuery` 保留重複 query key 之多值陣列，不再以 `Record<string,string>` 壓覆舊值。
2. 班級支援多值 OR，支援 `~blank`（無課程＝零 enrollment）與 `~empty`（有 enrollment 但 baseName 為空）。
3. 下列原先未生效或靜默忽略之欄位已落實或明確拒絕：`hasExtraDeduction`（讀持久化 trace 之 `hasExtraFlag`）、`specialDiscount`（以標籤特殊折扣判定）、`applicableDiscountBps`（恰選一班時依暫定 v2 映射生效）；未實作之 `scheduleStatus`、`sort` 在 runs 與 preview 兩側皆明確回 400；preview 之 `mappingStatus` 亦明確回 400（待 D 批班名比對報告與設定快照落實）。`grade` 非整數回 400。
4. `hasClass` runs 端點維持 `subject_count > 0` 既有語意，**不作為「無課程」判定**；「無課程」為獨立語意（零 enrollment），以 `noCourseTotal` 與 `stats.filteredNoCourseCount` 分開回報。
5. cursor 契約升級：編碼綁定 `scope`（run/import）與正規化查詢條件之 SHA-256 identity；條件改變而沿用舊 cursor 一律回 400，防止跨條件分頁污染。
6. `stats.classScopeTotal` 支援多班聯集之去重人數；未選班為全批人數；若設空集合 `~none` 則為 0。
7. options 唯讀端點：以 `GET /api/v1/runs/{runId}/students?options=true` 提供指定 run 全量非個資之去重選項與計數。

**可篩選欄位清單（B1 凍結現況）**：

|表頭／用途|參數|值型別|現況實作|
|---|---|---|---|
|所屬班級|`enrollmentKey`（`classId`為同義單值別名，同時給時`enrollmentKey`優先）|字串＝班名|多值 OR；保留值 `~blank`＝無課程（零 enrollment）；`~empty`＝有 enrollment 但 baseName 空字串；`stats.classScopeTotal`隨多值|
|年級|`grade`|整數|多值 OR；`~blank`＝年級未知；非整數回 400|
|安親天數／課輔天數|`anqinDays`、`tutoringDays`|數字（3、3.5、4、4.5、5）|多值 OR；`~blank`＝null。兩欄可同時篩（AND）；既有 `billingTier`＋`careType` 保留為單值相容|
|額外扣天|`hasExtraDeduction`|布林|真正生效；讀取持久化 trace 之 `hasExtraFlag`（與 UI 額外扣天欄同源）|
|合計折扣（基本率）|`baseDiscountBps`|整數bps|多值 OR；新 run 的無報名學生基本率為 10000（特殊折扣仍優先），不產生 null。`~blank` 的 null 解析／相容仍保留，不回 400；在新 run 此值匹配 0 人，options 不產生此選項。0 仍為有效 bps 值，不與 null 混用|
|本班適用折扣（僅恰選一班）|`applicableDiscountBps`（需`enrollmentKey`或`classId`）|整數bps|多值 OR；僅恰選一班時生效（多班或未選班回 400）。只讀持久化之四個學生層欄位；班級類別採暫定 v2 映射：國小輔導依年級對應 care（1-2年級 anqin、3-6年級 tutoring）、國小數學對應 math、兒童美語對應 english、其餘 not_configured（待 D37 改由設定快照取代）|
|兄弟姊妹折扣|`sibling`|布林|真正生效；多值 true/false 同時給等同該欄未篩選|
|特殊折扣|`specialDiscount`|布林|真正生效；以 `tags_raw` 經 `parseTagDiscounts` 是否含特殊折扣判定；多值 true/false 同時給等同該欄未篩選|
|園內生|`internalStudent`|布林|真正生效；多值 true/false 同時給等同該欄未篩選|
|需確認／問題類型／ERP比較|`hasIssues`（布林）、`issueCode`（字串）、`tierMismatch`（布林）、`tierComparison`（`match`／`mismatch`／`not_applicable`／`unavailable`）|見左|多值 OR；矛盾組合（`hasIssues=false` 且帶 `issueCode`、`tierMismatch` 與 `tierComparison` 衝突）回 400；`scheduleStatus` 明確回 400|
|分校|`branch`|字串|多值 OR，保留 CRLF/LF 換行集合語意。UI 入口待 B2 與 operator 確認，API 參數保留生效|
|學生搜尋|`q`|字串（姓名或代碼子字串）|維持單值搜尋框；LIKE escape `%` 與 `_`（不作為 SQL wildcard）；不入 URL、不多值、不提供 options|
|科別（UI入口已移除）|`subject`|字串|維持單值，參數保留（agent 相容）|
|有無折扣科數|`hasClass`|布林|語意不改（`subject_count > 0`），**不作為無課程判定**|
|控制參數|`cursor`、`limit`、`sort`、`options`|—|`sort` 兩端皆回 400；`cursor` 綁定 identity；`limit` 預設 50、最大 200；`options=true` 進入 options 模式|

**傳輸格式與單值相容**：

- 多值以**重複 query key** 傳送（`grade=3&grade=4`），server 以 `searchParams.getAll` 讀取；不以逗號分隔（避免班名內含逗號時歧義）。
- 既有單值呼叫（每個參數至多出現一次、值不是保留值）視為單元素集合，結果完全相容。
- 布林欄位值為 `true`／`false`；兩者同時出現等同該欄未限制，但視為已設定篩選。
- 無效數值、未知參數一律回 400 並指名該參數，嚴禁靜默忽略。

**四種空狀態語意與跳脫**：

|狀態|傳輸|語意|
|---|---|---|
|未設篩選（全部）|該欄 key 不出現（既有空字串如 `grade=` 視為未設，僅為相容；UI 不送）|該欄不限制|
|選了「(空白)」|保留值 `~blank`，可與一般值並存（OR）|該欄為空：所屬班級＝零報名（無課程，以 `enrollmentKey=~blank` 查詢）；年級／天數／本班適用折扣仍可能為 null 或未知。合計折扣在新 run 不產生 null，無報名且無特殊折扣者歸入 10000；該欄的 `~blank` 仍接受但匹配 0 人，不代表無報名|
|班名無法解析|保留值 `~empty`，僅適用於所屬班級|有 enrollment 但 baseName 為空字串（token 僅中括號等無法解析出班名者）。與 `~blank` 互斥（不可混用回 400）；**不計入無課程**|
|取消全選後按「確定」|保留值 `~none`，**只能單獨出現**；與其他值並存回 400|空集合：0 筆，`totalStudents` 與各項 stats 皆為 0|

保留值以 `~` 開頭；真實資料值若也以 `~` 開頭，傳輸時再前置一個 `~` 跳脫（`~~x`＝字面 `~x`）。非個資篩選條件會寫入 URL，三種狀態皆可自 URL 還原。

**匹配語意與去重**：

- 同一欄多個值為 **OR**；不同欄為 **AND**。
- 複值欄（所屬班級、分校、問題類型、比較狀態）任一命中即匹配，不因多項命中而重複列出學生。
- `totalStudents`、`stats`、`classScopeTotal`、`noCourseTotal` 一律依 `personCode` 去重。
- `stats.mismatchCount` 在目前全部條件的學生範圍內，以與 `tierMismatch=true` 同源的班級層 `tier_comparisons` 判定；選班時不計入該生其他未選班的不一致。
- `stats.issuesCount` 在目前全部條件的學生範圍內，以與 `hasIssues=true` 同源的學生問題旗標判定；只限縮學生集合，不依 issue 的可選 `enrollmentIds` 再分班歸屬。`noCourseTotal` 維持全批，與目前條件內的 `stats.filteredNoCourseCount` 分開。
- `classScopeTotal` 僅套用「所屬班級」條件（含多值 OR）的去重人數；未選班為全批人數；若含 `~none` 則為 0。UI 依此標示「全部N人」「本班N人」「已選N班，共M人」（[09 §5.1](09-ui-workflow-redesign-spec.md)）。

**選項（options）read model**：

- 端點：`GET /api/v1/runs/{runId}/students?options=true`（同一路由唯讀模式，preview 端不提供 options）。
- 各欄的值宇宙取自**指定 run 的全部學生**，包含後頁獨有值，不受分頁 `limit`／`cursor` 限制；歷史 run 讀歷史快照，不讀最新設定。每欄計數套用**其他欄目前已套用的篩選與姓名／代碼搜尋 `q`，排除本欄自身篩選**（D46）。
- 每個選項回傳 `{ value: string, count: number }`，計數為把本欄替換為該單值後的去重學生人數（`COUNT(DISTINCT person_code)`），包含 `~blank`／`~empty`；同一學生同班多個 token 不重複計數。不是在本欄已有OR選值上累加該值的聯集人數。
- server 保留 run 內有效但當下 `count=0` 的值；學生面板隱藏未勾選0人值，已勾選的0人值仍顯示可取消。不因 count=0 自動 prune 合法選值；面板草稿不提前影響計數，按「確定」後才刷新。
- 班名若存在空 baseName 之 token，options 回傳 `{ value: '~empty', count: N, labelKey: 'unparsedClassLabel' }`，**不得以 `value: ''` 輸出**（避免 client 點選後變為未篩選全部）。
- 候選值與其餘已套用條件若構成非法整體查詢（§5.1 衝突規則：`hasIssues=false`＋`issueCode`、`tierMismatch=true`＋`tierComparison=match` 等），該候選仍回傳值但 `count=0`；既有 GET 的 400 契約不變，client 依 C2 隱藏未勾選的 0 人值。
- 敏感欄位（姓名、人員代碼）不提供選項清單，只保留搜尋框；options 回應不含個資。
- 本班適用折扣的 context 依使用者原選班決定；計算某欄選項時的暫時排除不會把原選班誤標為 `requires_class`。本欄適用率選項只排除自己的 `applicableDiscountBps` 條件，仍保留所選班與其他欄。client 必須帶全部已套用條件重取 options，與名單請求使用獨立 abort／sequence 防護，晚到舊回應不覆蓋新面板。
- 適用率選項：可帶單一班級參數（如 `enrollmentKey=國小輔導-一A`）查詢該班適用率選項；若未選班則回傳四欄全量值並標記 `requires_class`；若選了未配置班級則標記 `not_configured` 並回空陣列。
- **B2 前提契約**：B2 篩選面板必須把「(空白)」與「班名無法解析」顯示為兩個不同項目、不得同形；兩者皆不得呈現為空字串。

**一致性、分頁與 cursor 契約變更**：

- 名單、統計、分頁使用同一條件。
- **Cursor 契約變更**：為防止條件改變後仍套用舊分頁，cursor 編碼包含 `scope` 與正規化條件之 SHA-256 identity。條件改變（選值變更、切換 run、改 `q`）而帶舊 cursor 者一律回 400。preview 端 cursor 同步綁定 `importId` 與篩選條件。
- client 於條件改變時必須清空 cursor 並從第一頁重查。

**「無課程」（D38；獨立語意，不重用 hasClass）**：

- **定義**：該學生在 `student_enrollments`（該 run 之 `importId`）**零筆 enrollment** 才算無課程。
- **不算無課程**（仍有課程）：原始班級文字非空但解析失敗者（parser 保留 enrollment，且若 baseName 空則歸入 `~empty`）；只有寫功課、交通車或未列入折扣類別的班；有離班標記的 token。
- **解析器既有盲點**：`token-parser` 對非空 token（如 `[團]`）仍會建立 enrollment 但 baseName 為空；此邊界由查詢與 options 之 `~empty` 承接，不改動 domain parser。
- **計數分離**：全批無課程總數 `noCourseTotal`（整個 run 名冊）與當前條件符合人數 `stats.filteredNoCourseCount` 分開回報。
- **不併入需確認**：無課程本身不新增 issue；該生若另有真實 issue 仍計入需確認人數。
- **兩端同源**：匯入預覽（`GET /imports/{previewId}/students`）與結果頁判定完全相同、人數完全相同。

**驗收與效能**：

- 整合測試：`web/tests/integration/multivalue-query-nocourse.test.ts`（涵蓋超過 200 人後頁選項、同學生兩班去重、OR+AND、0/null、全部取消、切換 run、cursor 條件防禦、邊界案例與無課程一致性）。
- 效能以根 CLAUDE.md §8 為門檻：477 人全量合成名冊的多值篩選與 options 查詢，暖機後 10 次 p95 ≤ 200 ms。實測值屬各 PR 的公開驗證紀錄（每次量測會浮動），不寫成本規格的承諾數字。唯讀 GET 不對資料庫產生任何寫入。

### 5.2 規則版本入口、設定快照讀取與班名比對報告（D1）

依 [06 D40](06-handoff-decisions.md)（operator 2026-09-30 裁決，decision `d-20260930112930661160-25`）；D1 只改「版本與快照從哪裡讀」，v1／v2／compat 的計算輸出逐欄不變（驗收 [04 UX34](04-tdd-acceptance.md)）。

#### 5.2.1 規則版本由 server 決定（F-1／F-2／F-3）

- **單一解析器** `application/rule-set-resolver`：`resolveFormalRuleSetVersion(db)`＝有 active run 且其版本為正式軌則採其值，否則（無 active run，或 active run 為診斷軌 compat）採現行正式軌 `erp-tag-v2`。名單差異、班級扣天、calculate、preview、activate 都經它取得版本；client 一律不得指定。
- **activate**：body 不得含 `ruleSetVersion`（route 與 application 層皆拒絕；HTTP 400 `INVALID_REQUEST`，與 calculate 一致）。新 run 的版本＝`resolveFormalRuleSetVersion(db)`（在與 CAS 同一交易內解析）：現行 run 為 v1 則新 run 沿用 v1，不會靜默變成 v2。冪等雜湊只由 `{importId, expectedRevision, asOfDate}` 決定；D1 之前寫入的紀錄（雜湊含 `ruleSetVersion:"erp-tag-v2"`）同 key 同內容的重送仍回原結果。
- **preview／apply**：`settings_previews.target_rule_set_version`（migration 0007，nullable）記錄 preview 當下由 server 決定的版本（含 settings_only）；apply **只讀這個欄位**建立新 run（`resolveRuleSetForApply`）。欄位為 NULL（0007 之前建立的舊 preview；TTL 15 分鐘，實務上幾乎不存在）＝「建立當時的 active 版本」：apply 與 preview 之間有 revision CAS，active 沒變，所以等於 apply 當下 server 解析的值。記錄值不是正式軌版本（含診斷軌 compat、未知字串）→ 500 `PREVIEW_CORRUPTED`，不建 run、不動 active。
- **能力旗標**：`domain/billing/rule-set` 的 `ruleSetCapabilities(version)` 逐版明列 `sameWeekdayOnly`、`unknownWeekdayWarning`、`scheduleIncompleteOnUnknownWeekday`；原本散在各處、會改變行為的 4 處 `=== 'erp-tag-v2'` 字面比較（billing-calculator 3 處、schedule-preview 1 處）一律改讀旗標。未列出的版本（含 compat、未知字串）全關＝與舊語意相同。D1 不新增 `erp-tag-v3` 型別成員，也不改 `CURRENT_FORMAL_RULE_SET_VERSION`。**D2 新增版本時須逐項明列旗標值，並稽核未進旗標的預設值字面**（預設值字面共 7 處：`calculate-run.ts` 1、`roster-changes.ts` 3、`comparison/route.ts` 1、`billing-calculator.ts` 2；另 `roster-changes.ts` 的 `classSide` 以 `!== 'excel-v260922-compat'` 決定同星期規則——對 v1 與 calculator 的純時刻比對不一致，D1 依「除 F-1／2／3／5／6／7 外不改任何輸出」原樣保留，交 D2 處置）。

#### 5.2.2 歷史 run 一律讀該 run 的設定快照（F-5／F-6／F-7）

run 的設定快照＝`run.scheduleVersionId`：`seed-v250922`（該 run 沒有任何已儲存設定，以 seed 課表計算，不帶別名與時段覆寫）或 `settings_versions.id`。`application/run-snapshot` 的 `loadRunSnapshot` 是所有「讀歷史 run」入口的共用載入函式；快照缺失（設定版本不存在）＝無法判定，**不改用最新設定、也不退回 seed 猜**。

- `GET /runs/{runId}/comparison`：以快照的別名與時段覆寫，重算正式軌與診斷軌；缺失回 409 `SNAPSHOT_UNAVAILABLE`（與 `GET /settings/deductions` 既有契約相同）。
- `GET /classes?runId=`：`settingsScope:"run_snapshot"`、`snapshotStatus:"ok"|"unavailable"`；未帶 runId 時 `settingsScope:"latest_settings"`（維持讀最新已存設定，尚無才用 seed）。
- `roster-changes` 逐班明細（匯入異動）：`classSide` 與 calculator 對「課表來源」的判斷一致——帶 `scheduleOverride`（已有儲存設定）時以其全量 draft 為唯一來源、不退回 seed，否則用 seed（`classMapFor`）。

#### 5.2.3 已存設定 JSON 的單一讀取入口與版本界線（F-11）

`settings_versions.content_json`（與 `settings_previews.draft_json`）只經 `readStoredDraft(json)` 讀取；先前 7 處各自 `JSON.parse(contentJson) as SettingsDraft`（繞過 zod）已收斂，並以 src 掃描測試防止回頭。D1 的 `readStoredDraft` **不改形狀**（不補預設、不去除未知欄位、不改欄位順序），否則 `draftHash`（＝sha256(JSON.stringify(draft))，對欄位順序敏感；不在 D1 範圍，F-12）會與 D1 前不同。版本界線規則（D2 新增設定欄位時遵守）：

1. v1／v2 的計算與讀取永遠不讀新欄位；
2. 欄位缺失＝自動偵測，只在新規則版本讀取當下解析，不回寫舊快照；
3. 新設定快照只寫手動覆寫的值與來源，自動項省略欄位（見 §5.4.1）；新 run 的類別快照則寫出當次實際採用的有效值與來源（見 §5.3.4）。兩者不可混稱為「新快照一律完整」；
4. 新規則版本的 run 建立時，把「實際採用的類別」寫入 `run_class_categories`，之後不再重新偵測（舊 run 不重新分類）。

#### 5.2.4 migration 0007（純增量）與班名比對報告

- migration `0007_rule_set_target_and_run_class_categories.sql`：`settings_previews.target_rule_set_version TEXT`（nullable）與空表 `run_class_categories(run_id, base_name, category, fixed_five_days, mapped, source)`（PK `(run_id, base_name)`，`run_id` 外鍵 `ON DELETE CASCADE`）。D1 不寫入 `run_class_categories`；不重寫、搬移、刪除任何既有列。`getDatabase()` 首次讀取即自動套用 migration，故驗收含 fresh DB 與升級 DB（舊資料逐列不變）、可重跑、故障整段 rollback（[04 UX42](04-tdd-acceptance.md)）。
- **班名比對報告**（`application/class-name-match-report`，純資料比對，與規則版本無關；分類沿用 `classifyErpDualTrack`，與課表設定「班名對應」、匯入預覽待確認班名同源同判斷）：
  - 「米豆奶有／系統無」`rosterOnly`：名冊班名既不是設定裡的班、也沒有被別名解析到設定裡的班；每班附去重學生數與報名筆數；排序依學生數遞減、再依班名。`rosterOnlyStudents` 為涵蓋的不重複學生數（同一人在多班只算 1）。
  - 「系統有／本次名冊無」`systemOnly`：設定裡的班，名冊沒有以該班名**直接**報名者；附 `active`、`aliasCoveredBy`（本次名冊中被別名對到該班的名稱）與 `previousRosterStudents`。**別名不對稱**：米豆奶側，被別名對到系統班的名稱算「已對應」；系統側，只有別名覆蓋而名冊沒有直接報名的班仍列出（不掩蓋真相，01 §4.3）。
  - **上一份名單**（Q12-b，漂移參考）：`resolvePreviousRosterProvenance`——依據成功之 `idempotency_records` activate/apply 收據與 `revision` 序號重建可證實的現行名冊 episode 流（嚴禁以 raw run、timestamp 或未啟用的 ready 批次冒充現行名冊）：目標名冊非現行時參考當前現行名冊；目標名冊為現行時參考該 episode 之前一份現行名冊；可證無前份時狀態為 `none`；若收據毀損、出現 revision gap／衝突或無法證明 run 曾現行則 fail-closed 為 `unavailable`。`previousRosterStudents` 與 `systemOnlyPreviousRosterStudents` 是該班／各班在上一份名單的**去重人數**，並帶 `previousRoster{importId,fileName,createdAt}` 註明來源；沒有上一份名單或無法判定時為 `null`（不寫 0）。`previousRosterStatus` 為 `ok | none | unavailable`。
  - **舊版與各版本 apply 收據的相容判定（D1 r2–r4）**：35c8bde 之前寫入的 apply 收據沒有 `mode` 欄位，且一律建立 run（收據 `idempotency_records.run_id`＝`payload.runId`）；2bea9b8～5daef9c 的 apply 另會把 `active_state.active_import_id` 切為該次名單，dd9f08d 起只更新 `active_run_id`。沒有任何版本寫出過「無 `mode`、`run_id` 為 NULL」的收據；`mode:'settings_only'`＋`run_id` NULL 自 35c8bde 才有。判定一律依 evidence，**不因欄位缺席就信任**：
    - (a) 真實舊形狀（無 `mode`、`payload.runId` 為字串）：`row.run_id` 必須等於 `payload.runId`，該 run 與其名單批次都必須存在。該 run 的名單等於當時現行名冊 → 併入同一 episode（前份不變）；不同於當時現行名冊（舊版曾能切換名單）→ 收據沒有版本標記可區分，**只有被佐證才算切換**：下一個會影響名冊／run 的收據事件顯示現行名冊確為該名單，或它就是最後一個事件且現行狀態（`active_import_id`／`active_run_id`）與它一致；無法佐證 → 整段歷史 fail-closed 為 `unavailable`。
    - 有 `mode` 的收據亦只接受生產者實際寫出的形狀：`settings_only` 須 `row.run_id` 為 NULL 且 `payload.runId` 嚴格為 null（缺席或帶字串一律 `unavailable`，不得填補 revision gap）；`with_students` 須 `payload.runId` 為字串且與 `row.run_id` 相等、存在對應 run，且該 run 所屬名冊必須等於當時現行 episode 之名冊（`apply-settings.ts` 於 preview 名冊非現行時即 409 拒絕、且僅在現行名冊建 run；名冊不一致一律 `unavailable`）。
    - 跨筆唯一性與分支鑑別對稱性（R4-1／R4-2／N-G）：
      - 同一 `runId` 嚴禁跨收據（`activate`、`with_students`、`legacy_apply`）重用（生產者每次 activate／apply 皆新生成全域唯一 runId，冪等重送不插新列；若同一 `runId` 出現在多筆收據，一律 fail-closed 為 `unavailable`，不得填補 revision gap）。
      - 分支鑑別互斥對稱性：`activate` 排斥 `mode`；`with_students` 與 `settings_only` 排斥 `status`、`activeImportId`、`activeRunId`；`legacy_apply` 排斥 `mode`、`status`、`activeImportId`、`activeRunId`。混雜其他分支鑑別欄位之收據一律 `unavailable`。
    - 其餘一律 `unavailable`：無 `mode` 的收據只接受有版本出處的形狀 (a)，其餘一律 `unavailable`。包含：無 `mode` 且無 `runId` 之形狀（歷史上從未寫出過，不得作為 settings_only 填補 revision gap）、`payload.runId` 有值但 run 或批次不存在、`row.run_id` 與 `payload.runId` 不一致、`row.run_id` 為 NULL 但 `payload.runId` 有值、或來歷不明的收據。`appliedAt` 等非關鍵欄位有無不影響判定（2bea9b8／f4f8260 的收據沒有 `appliedAt`）。「有 run、無任何收據」的資料（例如收據遺失）維持 `unavailable`，不猜歷史。
  - 範圍：`{kind:"latest"}`＝最新已存設定（尚無才 seed）；`{kind:"run",runId}`＝該 run 的設定快照，缺失→`snapshotStatus:"unavailable"`，清單與計數皆 `null`（無法判定，不是空清單）。
  - `GET /api/v1/settings/class-name-report?runId=&importId=`：唯讀；未知參數 400 `INVALID_QUERY`；`runId` 未知 404 `RUN_NOT_FOUND`；`importId` 未知或資料庫沒有任何名單 404 `IMPORT_NOT_FOUND`；`runId` 與 `importId` 指向不同名單 400 `INVALID_QUERY`；預設名冊＝現行名單，其次最新 ready 批次。
  - `POST /imports/preview` 回應新增 `classNameReport` 摘要：`{importId, rosterOnlyClassCount, rosterOnlyStudentCount, systemOnlyClassCount, systemOnlyPreviousRosterStudentCount, previousRoster, reportPath}`，`reportPath＝/settings?tab=mapping&import=<batchId>`；既有 `pendingClasses` 不變。課表設定頁以 `?import=<批次 id>`（須為 ready 批次）檢視該批名單的班名對應；儲存設定仍以現行名單為準。
  - D1 的報告與摘要不含「類別」（類別屬 D2）。
- **類別值域與解析純函式**（`domain/classification/class-category`）：`ClassCategory`（`care`／`math`／`english`／`none`／**`unset`**）、`effectiveCategoryOf`（已儲存值 → 有效類別與來源）、`resolveClassEnrollment`（報名班名 → 類別／來源／mapped／固定 5 天）。**班名自動偵測已於 #157 整組移除**（`detectClassCategory`／`detectClassAttributes`／`detectFixedFiveDays` 皆不存在；規則原文見 [06 D40](06-handoff-decisions.md)，版本對照見 [02 §9.1](02-calculation-rules.md)）。D2a 正式接線於計算路徑。

### 5.3 erp-tag-v3 規則核心、班級類別接線與 run 類別快照（D2a）

落實 06 D37、D40（Q1–Q14）之核心規則與計算接線（無 UI 部分，UI 與升級流程屬 D2b）：

#### 5.3.1 規則版本與能力旗標擴充
- `FormalRuleSetVersion` 新增 `'erp-tag-v3'`；`FORMAL_RULE_SET_VERSIONS` 集合同步註冊。
- `RuleSetCapabilities` 新增能力旗標：
  - `categoryBasedBilling`: true（v3 依類別計算科數與 isEnrolled；v1/v2 為 false）。
  - `maxDeductionSelection`: true（v3 衝堂扣天取正量最多；v1/v2 為 false 首班選班）。
  - `missingEnglishScheduleWarning`: true（v3 美語缺課表出警告；v2 凍結不警告）。
  - `diagnosticsDecomposition`: true（v3 兩段式診斷分解；v1/v2 為 false）。
  - `unmappedClassWarning`: true（v3 未對應班出 `CLASS_NOT_MAPPED`；v1/v2 為 false）。
- 禁止以字面 `=== 'erp-tag-v2'` 比較，新舊行為一律經由能力旗標分流。

#### 5.3.2 班級設定草稿資料模型擴充
- `ClassSettingSchema` 支援班級屬性可選欄位：`classType`（'care'|'non_care'，specs/14 §3.1）、`category`（'care'|'math'|'english'|'none'）、`categorySource`（'auto'|'manual'）、`fixedFiveDays`（boolean，specs/14 §3.3 簡化為純布林，移除 fixedSource）。
- 讀取已存舊設定 JSON 時維持 `readStoredDraft` 唯一入口不改形狀，舊快照無新欄位時在 v3 計算當下依班名自動偵測補齊，不回寫舊快照。
- `isSettingsDirty` 支援 `baseline.classAttrs` 與 `currentAttrs` 之變更比對（F-13）。

#### 5.3.3 計算路徑接線與未對應班契約
- 類別解析單一來源：名冊班名有對應系統班級時，採用該系統班級設定；無對應時依米豆奶班名自動偵測（Q1 寫功課優先、Q2 包含式、Q7-A 固定 5 天；優先序 安親課輔 > 數學 > 美語）。
- **未對應班（Q4-b）**：未對應班若自動偵測為 `care`、`math` 或 `english`，出需確認警告 `CLASS_NOT_MAPPED`（「班名未對應課表，請確認米豆奶班名或系統班級名稱」）；若自動偵測為 `none`（如交通車、正音班）則不出警告。未對應之數學／美語班因無時段，扣天沿用 0 fallback。
- **美語缺課表警告（F-8）**：v3 下美語班找不到排課時發出 `SCHEDULE_NOT_FOUND` 需確認警告（對齊數學班）。

#### 5.3.4 run 類別快照與讀模型
- `executeCalculationRun` 於執行 v3 及後續具 `categoryBasedBilling` 的 run 時**產出** `classCategories`，不持久化。`saveCalculationRun` 在新 run 列建立後，於呼叫端的同一交易內**唯一寫入**該 run 採用的有效類別快照至 `run_class_categories`（欄位：`run_id`, `base_name`, `category`, `fixed_five_days`, `mapped`, `source`）；不提供已存在 run 的就地補寫路徑。v1／v2 run 不寫類別快照。
- 讀模型 `applicableRateForClass` 於查詢此類 run 時讀取該 run 之快照：
  - **v3 行為**：固定 5 天之班級（即使類別為 none，如寫功課）之本班適用折扣顯示 100%（10000 bps）而非「未設定」（Q7-A）。
  - **v4 行為（#112、`homeworkDiscountDecoupled = true`）**：不再因 `fixed_five_days === 1` 回傳 10000；本班適用折扣**完全**依快照的 `category` 決定（`care` 依年級取安親／課輔側、`math`、`english`），`none` 一律 `not_configured`（02 §9A.3）。
  - 若該 run 缺失快照，回傳 `not_configured`（無法判定），嚴禁以當前班名猜測。
- **快照形狀契約（#157）**：`run_class_categories` 的 `category` 欄位值域為 `care`／`math`／`english`／`none`／**`unset`**；`source` 欄位值域為 **`manual`**／**`seed`**／**`unset`**（`auto` 已隨班名自動偵測一併移除；舊 run 的列**不重算、不改寫**，仍保留其當時寫入的 `auto` 字串，讀取時視為 `unset`）。**`mapped = 0` 之列一律為 `unset`**（未對應的班不論班名為何都沒有使用者的指定），且該 run 對該生一律產生 `CLASS_NOT_MAPPED`（[02](./02-calculation-rules.md) §9A.6）。
- **設定草稿的類別欄位（#157）**：`ClassSettingSchema` 的 `category` 值域含 `unset`；`categorySource` 值域為 `manual`／`seed`／`unset`／`auto`（`auto` 僅為舊資料的接受值，讀取時其值不採用）。**草稿只寫 `manual`（使用者的決定）與 `unset`（使用者明確撤回）兩種來源**；`seed` 基準由 `SEED_CLASS_CATEGORIES` 在**讀取設定時**套用，**不寫進草稿**——如此全新 DB 與既有 DB 對同一份設定算出相同結果，且草稿內容不被 seed 基準污染。撤回必須寫出 `unset`（不可刪欄位），否則重新讀取時會被基準還原。
- **API 契約（issue #122）**：`GET /api/v1/runs/{runId}` 與 `GET /api/v1/runs/current` 的回應（後者為 `run` 欄位）**必須**包含該 run 的類別快照，欄位名 `classCategories`：
  - **形狀即 `RunClassCategorySnapshot`**：`{ base_name, category, fixed_five_days }`，**底線命名**且 `fixed_five_days` 為**數字 0／1**。不得改名為駝峰、不得轉為布林——讀模型判 `fixed_five_days === 1`，形狀改變會讓 v3 的「固定 5 天 → 100%」靜默失效。
  - **三態語意互斥，不可互相取代**：`undefined`＝此 run 沒有快照概念（v1／v2，走名稱映射）；`[]`＝有快照概念的 run 但查無任何快照列（一律 `not_configured`）；有值＝該 run 的實際採用類別。
  - 判定「是否讀快照」一律走能力旗標 `categoryBasedBilling`（§5.3.1 禁止字面版本比較），**不得**以「查得到列與否」推導，否則零列會退化成 `undefined` 而讓讀模型錯誤地退回名稱映射。
  - 快照由**載入層**（`getCalculationRun`）帶出，非各 route 自行補查：`/runs/{id}`、`/runs/current`、`/classes` 等消費端共用同一份讀模型，避免各補一次而漂移。
  - 消費端（含 `web/scripts/` 下的帳務比對工具）一律將此快照傳入 `applicableRateForClass`，**不得**直接讀 `applicableEnglishBps`／`applicableMathBps` 等學生層欄位自行推導班級類別。
  - **快照語意隨規則版本而異**：`fixed_five_days` 在 v3 會讓本班折扣變 100%，在 v4 不會。消費端必須把該 run 的 `ruleSetVersion` 一併傳入讀模型（`SummaryTable` 的 `classCategoryRuleSetVersion`、工具層 `toApplicableRateContext`），不得由消費端自行字面比較版本決定。

#### 5.3.5 診斷標籤兩段式分解
- `calculate-run` 對具 `diagnosticsDecomposition` 能力的 run（v3、v4）同時計算 formal、shadow(v2) 與 compat：
  - `formal` vs `shadow(v2)` 天數差 → 標記 `RULESET_POLICY_DIFFERENCE`（白話：「新舊規則對這位學生的算法不同。」）。
  - `shadow(v2)` vs `compat` 天數差 → 標記 `NUMERIC_POLICY_DIFFERENCE`。
  - 新 issue code `RULESET_POLICY_DIFFERENCE` 與 `CLASS_NOT_MAPPED` 登錄於 `KNOWN_ISSUE_CODES` 與 `lib/issue-copy.ts`。

### 5.4 班級類別設定 UI、升級確認與讀模型接線（D2b；#112 v4 能力旗標見末段）

#### 5.4.1 設定草稿的類別／固定 5 天欄位與來源
- 班級屬性包含課程類型 `classType`（`care`／`non_care`，specs/14 §3.1）、多科折扣類別 `category`（`care`／`math`／`english`／`none`，帶 `categorySource: 'auto' | 'manual'`），以及固定 5 天 `fixedFiveDays`（布林，specs/14 §3.3/§3.10 移除 auto 偵測與 fixedSource，純布林勾選框）。
- **有效值解析**（`domain/classification/class-attributes` 的 `resolveClassAttributes`）：
  - `classType`：已儲存值優先；未設定時依 8 個 seed `care_window` 班（或歷史已存 `fixedFiveDays: true`）預設為 `care`，其餘預設為 `non_care`。
  - `category`：已儲存值優先；缺值時來源為 `auto` 並依班名自動偵測；手動值恰等於自動偵測值時仍為 `manual`。
  - `fixedFiveDays`：已儲存值優先（specs/14 §3.3/§3.10 移除 fixedSource，純布林勾選框，未設定時為 false）。
  - 舊快照（無新欄位）讀取當下即得到正確的有效值，**不回寫**（03 §5.2 版本界線規則第 2 點）；改班名時未手動者依新名重新解析。
- 寫回 draft 時（`groupGridRowsToClasses`）：每班**必寫入 `classType`**；`category` 與 `categorySource` 僅在手動指定（`manual`）時寫入；`fixedFiveDays` 在有顯式設定值時（existing?.fixedFiveDays !== undefined）隨班寫入。未手動之 `category` 不寫入以維持「缺欄位＝依班名自動偵測」的語意。

#### 5.4.2 班級生命週期（Q9；班名＝分組 key）
以 `rowId` 對 baseline 追蹤（`detectClassLifecycle`，與既有 `detectSplitClasses` 同一資料結構）：

| 情境 | 判定 | 設定繼承 |
|---|---|---|
| 整班改名（原班全部列改成同一新名） | `rename` | 手動值帶到新名；`auto` 者依新名重新偵測（`carryAttributesOnRename`） |
| 拆班（原班的列改成 ≥2 個名） | `split`（沿用 D28 警告） | 原名（若仍有列）保留；新名各自自動偵測 |
| 同名合併（≥2 個 baseline 班併成 baseline 沒有的新名） | `merge` | 設定相同→沿用；**不同→阻擋儲存**並要求選擇（`detectMergeConflicts`） |
| 新班 | `new` | 自動偵測 |
| 停班（`active=false`） | `inactive` | 設定保留；行為同 v2 |
| alias 指向 | 以**目標系統班**的設定為準 | alias 本身不帶類別（Q13） |

**合併衝突的判定基準是各來源班的「有效屬性」**（使用者的指定優先，未指定者為 `unset`；#157 起不再依 baseline 班名自動偵測），不是只看手動值——否則兩班中有一班未指定時會被誤判為不衝突。

#### 5.4.3 影響預覽與 dirty
- `POST /api/v1/settings/preview` 的 `before`（現行已儲存設定）與 `after`（草稿）**都帶 `classSettings`**，因此類別式科數與收費率的變化會進入預覽。
- 明細包含：`dayDeltas`（天數）、`subjectCountDeltas`（已補科數）、`baseDiscountDeltas`（合計折扣 bps），以及 #112 Ruling 2 新增的 `courseRateDeltas`（課程學費折扣收取率 bps，比對各課程收取率），只列出有變化者。
- `affectedStudents` 為四個明細的 **`personCode` 聯集去重計數**（天數、科數、合計折扣、課程學費折扣是同一批學生的不同欄位變化，同一人只能算一次）。**不得相加**——相加會把多項同時有變化的學生重複計算。語意為「受影響去重人數」，與 09 §3.1 一致；四種明細皆空時為 0。`settings_only` 模式下 `affectedStudents` 與各明細皆為 `null`。
- ~~`aliasCategoryNotices`~~（**已於 #157 廢除**，06 D53 Ruling 4）：該欄位報的是米豆奶班名與系統班名「各自會被**自動偵測**成什麼類別、兩者不同」；自動偵測既已不存在，該提示沒有可比較的對象，故整組移除（欄位、`AliasCategoryNotice` 型別、`detectAliasCategoryChanges` 純函式與畫面提示一併拆除）。**別名機制本身不受影響**：alias 仍決定報名班名解析到哪個系統班、並影響該班的類別與時段。
- dirty 只比對**使用者的指定**（`manualAttrs` vs `baselineManualAttrs`）：未指定者一律 `unset`（#157），班名本身已由 rows／baseline 逐列比對涵蓋；若把未指定者的值也帶進 `isSettingsDirty` 的 `classAttrs`，會讓沒有任何指定的空 baseline 與整份班級清單永遠長度不同 → 永遠 dirty。
- 類別／固定 5 天欄位進 draft JSON，因此 `hashSettingsDraft` 自動涵蓋（值與來源都算，改來源即改 hash），且**不改 `hashSettingsDraft` 契約**（仍是 `sha256(JSON.stringify(draft))`）。

#### 5.4.4 升級確認（Q11；S manifest §2；#112 Ruling 1）
- 空 DB 的目標版本為 `TARGET_FORMAL_RULE_SET_VERSION`（D2b 時為 `erp-tag-v3`；#112 起為 **`erp-tag-v4`**；`resolveFormalRuleSetVersion` 在無 active run 時採它）。
- 既有正式軌 run（v1/v2/v3）**不動**：`resolveTargetRuleSetVersion(db, requested)` 在未指定時沿用現行正式軌版本，因此未勾選升級時既有資料庫的 preview／apply／activate 均維持現行規則版本。
- 升級必須是**明確動作**：課表設定頁在現行版本為正式軌且未達目標版本（`isFormalRuleSetVersion(appliedRuleSetVersion) && appliedRuleSetVersion !== TARGET_FORMAL_RULE_SET_VERSION`，即 v1、v2、v3）時顯示「改用新規則（v4）」勾選；勾選後 preview payload 帶 `targetRuleSetVersion: 'erp-tag-v4'`；套用成功後生效版本更新為目標版本，升級橫幅即時收斂消失。
- `SettingsPreviewRequestSchema.targetRuleSetVersion` 以 `z.enum(FORMAL_RULE_SET_VERSION_LIST)` 驗證：非正式軌值（診斷軌、未知字串）一律 400，不猜、不靜默降級。
- preview 記錄的 `target_rule_set_version` 仍是 apply 唯一採用的來源（D1 F-3）：新 run 的版本＝preview 的目標版本，舊 run 的值與分類不變；失敗不切 active（整段在 `db.transaction`），冪等鍵先於 CAS。

#### 5.4.5 讀模型接線（N-8 對齊）
- `applicableRateForClass` 的快照分支改以**注入的快照查詢**（`{ isV3Run／usesSnapshot, ruleSetVersion, findSnapshot }`）取得類別，不再直接吃 `db`：
  - server 端以 `loadRunClassCategories(db, runId)` 一次取出該 run 的快照；
  - client component（學生總表）由 server 以 prop 傳下，**不把 db 帶進瀏覽器**。
- **查詢 key 必須是名冊班名**：快照的 `base_name` 存的就是名冊班名（`executeCalculationRun` 以 `r.base_name` 寫入），畫面 `singleClass` 亦來自名冊報名 key（`exactlyOneClass` → `unescapeWire`），兩者同源。此對齊是隱含契約，由 UI 測試鎖定。
- v1／v2 run 沒有快照 → 不帶 `isV3Run`，沿用名稱映射（既有行為不變）。
- 該 run 缺該班快照 → `not_configured`（無法判定），不以當前班名猜測。
- **固定 5 天是否改寫本班折扣由能力旗標決定**（#112）：`ruleSetVersion` 具 `homeworkDiscountDecoupled`（v4）時，`fixed_five_days` 不參與判定；v3 仍依 Q7-A 回傳 10000。消費端一律傳入該 run 的 `ruleSetVersion`，不得自行字面比較版本。

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
