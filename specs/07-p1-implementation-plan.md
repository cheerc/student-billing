# P1 implementation plan

日期：2026-09-23。依據：spec v2、P1 review、D17–D23 業務決策與 2026-09-23 最終複核修正。狀態：**計畫完成，以下實作工作均未開始**。

## 1. 交付目標與範圍

完成一個可以在 localhost 使用的學生收費核對 prototype：上傳 ERP 學生檔，按班級／姓名篩選、看去重人數、八項計算、課程適用折扣與 ERP 登記級距差異；維護課程／時間／老師，先看影響再套用；重啟後資料仍在；本機 agent 可讀同一版本 API。

規則以 [02](./02-calculation-rules.md) 為準，測試以 [04](./04-tdd-acceptance.md) 為準。此計畫安排落地順序，不另創收費政策。財務報表匯入、自動對帳、金額計算、點名表輸出、登入／RBAC、Firestore、Vercel部署、Git／CI/CD均不做。不能因P3原生列印未驗收而延後P1。

開發期間依序交付三個垂直切片。每個完成即展示、更新交接進度，持續下一切片；不用等整個P1才看畫面。切片A不是完整P1，計算尚未接入時必須顯示「計算功能尚未完成」，不能以空值或示範數字冒充結果。

## 2. 已選定的實作方案

|項目|本計畫選擇|實作時的確認閘門|
|---|---|---|
|Node|24.x；本機本次唯讀查得24.21.0|以24.21.0起步，`.nvmrc`固定實測patch、engines限定24.x；若安全修補升版記錄並重跑檢查|
|框架|Next.js 16 App Router、React、TypeScript strict；所有資料route用Node runtime|安裝當時選16.x已修補版本及其相容React版本，寫入精確dependencies與lockfile，build通過|
|套件管理|npm，單一package-lock.json|首次bootstrap記錄版本，以後npm ci；不混用pnpm/yarn|
|XLSX|ExcelJS，限server adapter|先通過真實ERP與欄位重排／隱藏fixture；不計算上傳公式|
|SQLite|better-sqlite3，簡單SQL migration；不加ORM|先驗Node24/macOS native module載入、交易rollback、Next production build與start；失敗記原因再決定替代，不同時引入兩個driver|
|schema|Zod作API／設定邊界驗證|純domain不依賴HTTP／DB；輸入與輸出schema共同測試|
|表格|原生語意table＋CSS sticky；server分頁／篩選|先不引入大型grid、虛擬捲動；50筆頁面足夠，確認效能再調整|
|測試|Vitest、Playwright Chromium；合成fixture＋本機私有來源|規則測試、真SQLite integration、真HTTP／瀏覽器流程分層|
|版面|簡單CSS Modules、繁中桌面頁面|三個入口：學生核對、匯入、課程設定；明細用側欄|

此回合沒有安裝套件，因此未假造精確套件patch或相容性測試已通過。bootstrap必須完成上述選版和smoke，不得把「選哪個框架／DB」留成無限研究題。Node內建node:sqlite雖可評估，P1先選better-sqlite3，減少和Node版本中該API穩定度綁定；不是要做兩套SQLite實作。

官方資料查核於2026-09-22：[Next.js安裝要求](https://nextjs.org/docs/app/getting-started/installation)、[Next.js支援政策](https://nextjs.org/support-policy)、[ExcelJS](https://github.com/exceljs/exceljs)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)、[Node 24 SQLite文件](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。工具與版本的實際可用性仍由bootstrap驗證，文件查核不取代測試。

## 3. 專案位置與模組邊界

於 `web/`（原 `student-billing/`，依 Issue #7 D+ 方案更名）建立應用程式，避免框架初始化碰到來源Excel及既有夏令營資料。不使用會自動git init的預設流程；手動建立package與目錄，或明確禁用初始化Git。本文件以後的程式路徑皆相对此應用目錄。

```text
web/
  package.json / package-lock.json / .nvmrc
  src/app/                     頁面與薄route handlers
  src/components/              表格、篩選、明細、設定表單
  src/domain/
    students/                  標頭、姓名／年級正規化、班名token
    billing/                   R01–R18、級距比較、issues、trace
    schedules/                 時段驗證與完整性
  src/application/             preview、activate、query、settings、diagnostics
  src/contracts/               API schemas與錯誤碼
  src/adapters/xlsx/           ERP讀取、一次性排課seed讀取
  src/adapters/sqlite/         db、repository、migrations
  src/adapters/files/          受限上傳、hash與來源儲存
  scripts/                     seed、測試基準檢查、bench等開發工具
  tests/{unit,integration,e2e,fixtures}/
  README.md                    本機啟動、使用、备份、限制
```
*(資料庫與來源副本位於專案根目錄 `/data/`，被 `.gitignore` 排除)*

只封裝WorkbookReader、Repositories、FileStore及clock/id等必要依賴。domain輸入為普通型別，輸出為確定性結果；不得從domain讀Excel、查DB或拿今天日期。共用同一application query給UI/API，不另寫一份agent算法。不得建立通用公式引擎、任意規則DSL或完整事件溯源架構。

## 4. 工作順序與展示節點

依賴順序：T00 → T01 → T02 → **展示A** → T03 → T04 → **展示B** → T05 → T06 → T07 → **P1展示C／驗收**。開發者逐項完成，不能先把全部後端寫完才接UI。

### T00：最小環境與存取骨架

**目的**：得到可啟動頁面與真實SQLite連線，為第一個名單切片服務。

- 建立上述專案、strict TS、lint、Vitest／Playwright設定、127.0.0.1啟動script、空首頁與upload入口。
- SQLite migration採編號SQL及schema_migrations表，啟動只執行未完成migration，失敗停止寫入，不能自動刪DB重建。
- server-only DB/FileStore；檢查Next打包外部native module的配置，對production build/start做一次smoke。
- 建立schema版本與最小批次表；其餘表在需要的切片加入，不先做完整雲端資料抽象。

**先測**：DB建檔／重開、交易rollback、migration重跑不重複。**完成**：瀏覽器看到空狀態，指向正確本機資料路徑，無Git、無學生示範假資料。

### T01：真實匯入、token與預覽

**主要檔案**：`src/adapters/xlsx/erp-reader.ts`、`src/domain/students/*`、`src/application/import-preview.ts`、`src/app/imports/page.tsx`。

- 先寫I01–I06/I13的失敗測試，再实现按標頭讀取。標籤、備註分開；必需欄缺失、重複標頭、代碼重複或缺失阻止啟用。
- ExcelJS轉為中立raw row；不跳隱藏列欄。必要欄含公式拒絕；rich text等儲存型態須有明確可測的文字化規則，不能轉成`[object Object]`。
- adapter契約測試必須涵蓋真實ERP檔的OOXML形狀（無sharedStrings、全inlineStr、無`<dimension>`），三項獨立斷言：inlineStr可讀；缺`<dimension>`時筆數仍為477且不以max_row推估；`<t xml:space="preserve">`的前後空白依02 §2規則處理。合成的重排／隱藏fixture可能改變inlineStr／sharedStrings或dimension形狀，**不得取代**保形fixture（見04 §2）。
- 上傳大小與ZIP展開限制（I13）在此一併落地，不留到T06；T01即開放真實上傳，限制必須同時存在。
- 工作表辨識：Sheet1優先候選、必要標頭前20列；多個有效候選回選表預覽，不悄悄選第一張。
- 原文保存，換行拆token，解析yearPrefix/baseName/groupFlag/modifiers/withdrawalDate與級距；未知語法可匯入但進待設定，不要求先整理全部班名才能看名單。
- 顯示477／384／93、離班標記、標頭對應、問題清單、來源檔名／時間、範圍備註。

**先測**：U31/U32/U43–46、I01–06/I13。**完成**：上傳提供ERP即可看到真实預覽，來源Excel不變；同名不合併、未知token不消失。

### T02：名單篩選與持久化——展示A

**主要檔案**：`src/application/roster-query.ts`、SQLite repositories、`src/app/page.tsx`、`src/components/student-table.tsx`。

- 保存已驗證批次，提供班級候選／enrollmentKey、姓名與代碼搜尋、年級／有無班級篩選、分頁、去重人數。
- 第一展示點使用「匯入预覽名單」查詢，不把未計算資料標成completed run。可持久保存ready批次並重開查看；正式`activate`於T04接計算後才開放。這避免先建立不完整activeRun，再於後面補洞。
- 班級候選以結構化identity精確匹配；四年級A/B分開；不同級距可呈同一候選班；未核准alias狀態清楚標示。
- ready批次預覽用`GET /imports/{previewId}/students`，與正式run查詢共用篩選工具、不同資料入口。此為P1中途／匯入預覽契約，不是另一份收費API。參數白名單、正式run專用參數的400、preview設定快照與cursor依03 §5完整契約實作；未知參數亦400。不要另維護不完整的參數清單。
- T02先完成seed的班名清單擷取／唯讀manifest，供候選對照與I19使用；完整時段轉換與持久化留T03。不得要求T02使用尚未存在的T03產物，亦不以候選批准alias。
- 初始班名對照總量納入`verify:fixtures`：ERP 95 token收斂54 baseName，42自動候選／12待設定／0歧義，seed側7個本批未出現。與「一般輔導2待設定＋1本批未出現」並列並各自標明範圍，避免子集數字被當成全機構總量。

**先測**：I07–08/I12/I19總量斷言，ready資料列表API及一條上傳→篩選E2E。**展示A驗收**：使用者可以自己上傳、選班、搜尋並看到人數；資料真實、重新整理仍在、未做的計算清楚標示。完成即展示，不等T03–T07。

### T03：排課seed與可解釋計算

**主要檔案**：`src/adapters/xlsx/schedule-seed-reader.ts`、`src/domain/billing/*`、`src/domain/schedules/*`、`scripts/verify-baseline.ts`。

- 從計算Excel的S表手動欄A:E、兩組care windows擷取seed，保留原始Excel時間數值供浮點診斷；不用S/C/D的公式快取當正式運算輸入。
- 49班、89非空班名列，40有時段、8care_window、1一般數學empty；保留老師／星期／無時間差異，不用空時段補00:00。
- 依下表順序red-green-refactor規則。每組完成即接入單一學生detail試算，不等所有報表才驗資料流。
- erp-tag-v1正式只讀標籤；excel-v260922-compat獨立診斷入口讀備註，不能啟用為正式run。沒有必要寫兩套重複核心，差異集中在來源策略／數值策略／legacy查找與顯示轉換。
- 時間整数分鐘與整數分子／分母比較，累加順序按規格；numericPolicy差異單獨標示。浮點路徑只模擬已知公式，不建立Excel通用引擎。

|次序|測試先行範圍|最小實作輸出|
|---|---|---|
|1|U01–14、U33及DIFF-01成對測試（**U06為原生Excel錨點**：使用者實測Excel判`>=120`成立，compat與正式皆 -1、不得產生 NUMERIC_POLICY_DIFFERENCE；IEEE754位元比較得 -0.5 屬錯誤重建。**DIFF-01原生實例為同班兩堂各13:00–13:18加總**：精確0、Excel -0.5，須產生 NUMERIC_POLICY_DIFFERENCE。compat比較採04 §3的15位有效數字模型並以該段四例為錨點）|每堂overlap、每班raw/rounded deduction、scheduleStatus|
|2|U21–25/U40–42|標籤命中、特殊／兄弟姊妹／園內生／extra，備註診斷來源|
|3|U15–20/U26–32/U38–39|科數、基本率、年級天數、fallback與不適用狀態|
|4|U34–37/U43–49|課程適用率、enrollment級距比較、R17重複類別與R18員工家屬提示、issues與trace|

**完成**：U01–U49對應行為均有測試；seed可計算，不以模板名判班；錯誤資料與0結果可分辨。unknown課程適用折扣不擅填。

### T04：正式run、核對總表與API——展示B

**主要檔案**：`src/application/calculate-run.ts`、`activate-import.ts`、`query-students.ts`、計算結果repository、明細drawer與`/api/v1` routes。

- 接入ready→calculate→completed→activate，保存完整input版本與結果，切換active採原子交易。`activate`依03必須帶`expectedRevision`（取自`GET /runs/current`的ActiveState revision）與idempotencyKey：交易內重比對，版本不符回409。否則兩個分頁各開不同previewId先後啟用時，body不同使idempotencyKey無效，第二次會無聲覆蓋active而不報錯。
- 總表接八欄結果、基本／課程適用折扣、ERP級距比較、兄弟姊妹／特殊／園內／extra，以及问题篩選。正式run與預覽run清楚區分。
- API一次查固定run，列表／detail／issues共用已存正式結果；comparison依固定輸入重建診斷。NUMERIC_POLICY_DIFFERENCE須在建立run時計算保存，不能延後到開comparison頁；GET不重新寫入資料。頁面篩選只查結果不重算。
- 實作03所有P1讀取endpoint（含表內的`GET /runs/{runId}/comparison`與`GET /imports/{previewId}/students`）、query白名單與錯誤格式；未指定runId解析current後回傳，後續頁面固定該run。診斷比較的輸入在run內全部固定，是純函式，**P1預設即時計算不落庫**（避免結果表多一份與正式結果等大的資料），即時計算依03固定diagnosticAlgorithmVersion，不同版本不得靜默重解舊run；即時計算同樣不得寫入；待bench顯示診斷頁影響操作再改為建立run時預存，兩種做法結果必須相同。
- 用真實樣本跑兩條gate並生成私有差異JSON報告。來源欄缺陷、數值政策、alias變更分欄解釋，不能把來源修正全歸入浮點誤差。

**先測**：I09/I16–17、首次revision=0的啟用、成功冪等重送、activate的409、列表與detail契約、版本固定分頁、empty/null、不適用及needs_review。**展示B驗收**：上傳→啟用→按班查看計算→開明細，並能篩出5筆級距差異及13人排課缺漏（固定fixture）。那13人全部tierComparison=match，因此驗收條件是**以`tierMismatch=false`篩選時這13人仍出現在hasIssues清單**——若match吃掉缺排課警告，他們會同時從兩個篩選消失而讓驗收假性通過。修改ERP後重上傳可得到新完整run，舊run可讀。

### T05：課程、別名、時段的preview→apply

**主要檔案**：`src/app/settings/page.tsx`、`src/application/settings-preview.ts`、`apply-settings.ts`、設定快照repository。

- CRUD涵蓋新增／改名／老師／科別／停用、時段、care windows、ERP alias及生效區間；停用不硬刪歷史、不自動退班。
- 顯示雙向對照、空時段、部分時段不完整；一般輔導A/B為2待設定＋舊班1本批未出現，明確顯示此為該科別範圍。全科別初始總量為42自動候選／12待設定／7個seed本批未出現。
- 待設定清單與「seed本批未出現」清單**同畫面並列**，讓人工配對不必跨頁目視。初始資料含3組純命名漂移（`國小國語文-小三四`↔`國小國語文-小三小四`、`小六國文加強班`↔`小六加強班-國文`、`小六數學加強班`↔`小六加強班-數學`），自動候選規則永遠配不上，必須人工選；仍維持不自動批准。
- 先做無副作用dry-run，顯示受影響學生、天數前後、級距match/mismatch轉換與問題數；再按「套用並重算」。取消草稿不改任何active資料。
- `POST /settings/preview`接完整草稿＋expectedRevision；回previewId及inputHash。既有class/schedule寫入routes統一委派同一apply service，帶previewId與revision，禁止繞過預覽直接更新一半。
- 一次操作可含班級與時段／alias的變動，封存成一個設定快照和一個run；不用先改class再改schedule造成暫時錯配。保存payload必须等於預覽草稿，版本改變回409。
- 生效日期為整套快照的適用區間；P1一次run只用一套版本。重疊版本需明選，跨期不拆帳。無alias時學生仍可查看原token与計算fallback。

**先測**：I10–11/I15/I18–20與preview API；舊run老師／alias不受新設定污染。**完成**：數學一→一A的preview正確展示13人各-0.5與mismatch 5→18。依D18該對應已是確認的業務事實，因此設定頁應把它列為**候選**供人員一次確認；軟體仍不自動批准（D15不變）。套用後的18筆mismatch是預期狀態，不得當成回歸。使用者可維護真實新班。

### T06：故障恢復、本機操作與剩餘UI契約

- 補齐全部P1篩選、去重人數、學費／折扣欄位預設、待設定清單、問題定位、批次清單与舊run查閱。P2的保存篩選／CSV／通用歷程比較不做。
- 測無資料、無結果、匯入錯誤、DB寫入失敗、計算例外、重複點擊、重啟、stale preview等畫面，不只測console。
- 執行完整HTTP寫入版本檢查、same-origin防護、路徑限制、大小／ZIP限制；錯誤日誌不記整段電話與備註。
- 補使用README、停機備份與還原實測。整份data備份包含DB、來源、manifest，不能只複製正在寫入的sqlite主檔。

**先測**：I09–14，完整E2E旅程及同時修改409。**完成**：關閉重開後資料一致，失敗操作仍是先前active版本，備份能在另一個空data目錄恢復。

### T07：效能、回歸與P1完成報告——展示C

- 跑typecheck、lint、unit、integration、API、production build、E2E及兩條資料gate。
- 使用477真實資料與5000合成學生量測解析／計算／寫入各段、總時長、查詢時間和瀏覽器篩選耗時；與03的原子性、trace功能同時開啟，不用關掉驗證換取速度。
- 固定production build、瀏覽器與硬體，記錄冷啟動1次、暖機後10次的中位數和p95。目標：477筆匯入至可查結果3秒內、重算1秒內、篩選更新200ms內（以p95評估）；首次Next編譯另列。5000筆記數據及無截斷、不崩潰，不冒稱spec已設定相同秒數門檻。
- **獨立 API 效能回歸量測**：在 `web/` 執行 `npm run test:perf:isolated`（可帶 `-- --port <非3000埠>`）。Runner 建立自有 tmp DB，以 application／adapter 準備 477 位全合成學生，執行 `next build`／`next start`（production），由 Chromium 同源 fetch 依序量四條 GET 路徑：grade／branch 多值、options、options＋tierMismatch=true、選班＋tierMismatch=true。專用單一 spec／單一 worker，不與其他測試檔同時執行，不重用既有服務、不 retry。預設 `npm run test` 保留 API 回應／GET 不寫 DB 的行為驗證，不承擔此計時 gate。CI 在原 job 的全套 test／build 之後序列執行 Chromium 安裝與量測；Chromium 用 `npx playwright install --with-deps chromium` 安裝，未設定瀏覽器 cache。
- **量測環境記錄**：每次輸出 CPU 型號、logical cores、RAM、OS／架構、Node 版本、Chromium 版本、build 模式、worker／retry 數。每條路徑記首次請求 1 次（不等同獨立 process 冷啟動；前一路徑可暖化共用資源），另暖機 1 次後量 10 次；保留未排序的全部原始 ms，中位數為排序第 5 與第 6 個樣本平均，nearest-rank p95＝ceil(0.95×10)＝第 10 個（最大值）。每一輪獨立 gate p95 < 200ms，不以多輪 p95 中位數遮掉慢樣本；交付連跑至少 5 次，各次數值及失敗皆列出，不重跑到過。
- **量測邊界**：計時從 Chromium fetch 開始，到 response body 完整讀取為止，包含 HTTP 與 API 執行，不含 JSON parse 或瀏覽器 render。**本量測不含瀏覽器 render；UI 篩選更新的 200ms 未由此自動化覆蓋**。不把此 API gate 宣稱為完整瀏覽器篩選耗時驗收；實際 UI 更新仍須另以固定瀏覽器／硬體量測。
- 如果效能未達，先定位parser／運算／DB／UI哪一段；只有證據需要才增加索引、結果cache或worker，不直接引入佇列／微服務。
- 交P1完成報告、可啟動指令、操作網址、測試結果、已知needs_review與仍未原生Excel驗證項目。無法達成門檻要列未完成，不宣稱全通過。

## 5. 重要落地細節

### 5.1 初始班名、排課與alias

seed工具從指定計算XLSX唯讀擷取「手動值」產生本機seed manifest：來源hash、sheet／row、49班與時段、care windows、parser版本。不讀使用者之後每次上傳ERP就覆蓋排課，也不從 data/evidence 快取假造session。

seed本身冪等，以來源hash＋seed版本辨識；首次空DB可匯入，已有人員編輯過則只能預覽，不能重置。先做版本未限定年度的seed，核對基準日由使用者明選；不要從舊模板日期猜排課生效日。

提供可解釋的alias候選預覽：完整baseName相等且無歧義的年度／已知級距正規化可提出候選，使用者一次確認清單後才保存；不自動批准。unknown modifier保留、四年級A/B與無A/B不模糊配對。未確認也可看名單與legacy精確seed計算fallback。

班名判科別用明確seed對照及已知文法，不能只靠學生年級把所有「國小輔導」改同一班。一般一年／二年輔導為安親、三至六為課輔，寫功課先分出；文法不明進待設定。這是用於UI情境，R09的舊科數存在性算法仍按spec。

### 5.2 SQLite最小物理模型

不將spec每個邏輯實體機械地拆成很多表。建議物理表：schema_migrations、imports、students、enrollments、settings_versions（整套JSON＋hash）、previews、runs、results、enrollment_results、active_state、operation_keys。設外鍵、unique(import_id,person_code)，以及run/class/student必要索引。

students/enrollments存原文與不可變解析；resolution放run結果中。settings_versions保存班級、alias、老師、時段與生效區間的完整內容；舊run不可讀最新設定補欄。results以runId/personCode一列，enrollment_results負責每報名級距與classId對應；trace可JSON，不需要把每一步算式獨立建表。

設定draft驗證與計算可在交易外完成，但提交交易內重新比對active revision與所有input hash；insert完整結果後CAS更新active_state，任何失敗rollback。保留同步單機流程，不做背景job。解析檔案先寫隨機暫存檔，hash檢查後原子rename至來源儲存，DB只引用已落盤來源；DB失敗可留下未引用blob，不得留下指向不存在檔案的active資料。

idempotencyKey綁操作body hash，成功重送同key/body先回原結果（優先於新請求revision檢查），異body回409；操作結果與active切換同一交易提交。重上傳同檔可重用import；有新課表仍產生新run。contentHash以標頭正規化後的有效資料含原始列序生成（欄位換序／隱藏不改值，列序改變會影響名單預設順序，不當成完全同輸入）。

### 5.3 Query與錯誤狀態

固定run下先套相同filter求totalStudents，再分頁；不要以當頁長度顯示班級總人數。tierComparison總數為enrollment單位，要分開標名。cursor綁runId、filters hash、sort與最後鍵；stale／不相容cursor回400，不能自動換run接下一頁。

缺班設定、空session、部分時段缺漏、no_overlap、care_window均有reason code；UI顯示「原因＋數值來源」。not_configured作課程適用率的reason：value=null、status=unavailable，避免API額外創第五套互不相容status。grade未知時年級相依值unavailable，不影響可由標籤／科別算出的基本率。

簡單核對入口可展示學費／折扣兩組欄位；學雜費等無規則顯示未配置，不產生虛構金額。每次GET資料带runId、ruleSet、numericPolicy、來源時間，agent不會讀到混合版本。

### 5.4 雙軌對照與差異歸因

測試用baseline維持原477×8快取，讀其businessCorrectnessBaseline=false。正式expected由原始標籤、明確案例及獨立參考計算建立；參考工具不得import產品billing函式或其輸出生成expected。

比較分三個診斷步驟：A備註＋legacy浮點（IEEE754算術、比較依04 §3的15位有效數字模型）／查找；B只換標籤但保持A數值和查找；C正式精確分鐘及本run核准映射。A對舊快取，A→B定位F01，B→C需再拆成B→B2（只换精確numericPolicy，取整與映射不變）、B2→B3（只换D24取整規則）與B3→C（只换本run核准映射），分別定位DIFF-01、取整規則變更與映射變更。正式結果的NUMERIC_POLICY_DIFFERENCE另以同一正式映射下成對政策比較判定，不把alias造成的天數變動誤報為浮點問題。B2、B3是內部診斷中間值，不新增模式。B是診斷中間值，不新增可啟用ruleSet或使用者模式。對已人工改alias的run，107等原fixture數字不適用。

固定fixture gate：

|項目|期望／證據|
|---|---|
|原始學生|477總數、384有班、93無班；同代碼唯一|
|正式標籤|兄弟姊妹133／園內生97／特殊14／extra14；備註171非空保留|
|歷史差異|正式基本率差107人、課輔天數差12人；不是要求回舊錯值|
|一般輔導級距|179筆，174match、5mismatch；列30/35/43/51/52|
|排課問題|13人not_found，1數學班empty，8care_window非錯誤；那13人**全部**tierComparison=match，`tierMismatch=false AND hasIssues=true` 必須包含這13人；限定該數學一班缺排課來源後才驗恰13人，不限制全域問題總數|
|來源欄衝突|CONFLICTING_NOTE_SOURCE恰1筆（列205）；兩欄同時命中0筆|
|提示類|DUPLICATE_SUBJECT_ENROLLMENT恰2筆（列43國小輔導、列52美語）；STAFF_FAMILY_NO_DISCOUNT恰5筆（列117/132/135/195/319）|
|初始班名對照|ERP 95 token→54 baseName：42候選群組／12無精確對應／0歧義（baseName盤點，非批准alias或class identity數）；seed側7個本批未出現；含3組純命名漂移需人工映射|
|離班／年級|34人37token不排除；年級「無」1人unavailable|
|alias影響|數學一→一A：preview顯示13人各-0.5、mismatch5→18；取消不改資料。此對應經D18確認為事實，列候選待人員確認，非軟體自動套用|
|名單差異|四年級A/B分開、未映射可見；各排課班legacy對照差異皆可解釋|

Windows重算workaround副本仍未取得，可用獨立手算／參考計算繼續prototype，但完成報告必須列原生驗證待完成。DIFF-01實際有結果差異時提示needs_review，不宣稱完全Excel相容。

## 6. 執行與交付約定

以下為實作後必須提供的scripts，不代表現在已存在：

|指令（在web目錄）|目的|
|---|---|
|npm ci|按lockfile安裝|
|npm run dev|開發，127.0.0.1:3000|
|npm run build / npm run start|正式build及本機驗收啟動|
|npm run db:migrate|安全升級schema，不重置資料|
|npm run seed:schedules -- --source <計算檔絕對路徑>|一次性seed預覽／匯入，來源唯讀|
|npm run typecheck / npm run lint|靜態檢查|
|npm run test:unit / npm run test:integration / npm run test:e2e|分層測試|
|npm run verify:fixtures|檢查來源hash、歷史parity、正式標籤／級距及差異報告|
|npm run bench|477／5000性能量測，寫私有報告|

Node已有24.21.0，不需為本案升級全機Node；若另一機器沒有Node24，README指示用該機既有版本管理器或Node官方安裝方式，不能直接覆寫使用者全域工具。首次安裝會下載依賴／測試瀏覽器，依當時執行權限處理。本次plan不執行安裝。

本機DB預設專案根目錄 `data/app.sqlite`，另有sources、private-fixtures、reports。所有測試使用獨立temporary DB；E2E以環境變數指定測試data，不能清掉真實資料。正式dev/start綁127.0.0.1，no-auth版本不開LAN或tunnel。

停機備份：停止服務、確保DB連線關閉後複製完整data及manifest到新位置，記錄schema/app版本。還原至新data目錄啟動，驗筆數、activeRun和代表查詢；成功才人工切回。禁止在連線中只複製sqlite主檔忽略WAL，也禁止以還原指令無提示覆蓋原資料。

P1完成時建立`specs/progress/p1-acceptance.md`，至少包含：應用實際版本、啟動位置／URL、A/B/C展示結果、測試命令與通過／失敗數、來源hash與fixture對照、性能結果、備份還原結果、剩餘問題與未原生驗證聲明。進度只勾選已完成項目。

## 7. 完成定義與風險處理

- [ ] T00–T02：真實上傳與名單展示A完成，沒有假計算。
- [ ] T03–T04：U01–U49相關測試、正式計算／明細／API／雙軌資料gate通過，activate的expectedRevision 409通過，展示B完成。
- [ ] T05：設定dry-run/apply、alias影響、409、舊run不變通過。
- [ ] T06：I01–I20、完整瀏覽器旅程、備份恢復、原始檔不變通過。
- [ ] T07：production build與性能目標驗證、完成報告和展示C交付。

依D17–D23，5筆差異照實呈現、13人課表關係已確認、A/B由人員設定；業務決策與尚未在工具內套用的設定須分開。初始fixture保留5筆mismatch，確認D18別名後為18筆；不為得到全綠而修改原資料。只有要把相應結果作為已確認開單依據時，才需要人員依實際情況處理。

ExcelJS解析未通過fixture，先定位cell型態／shared string／日期，不以cache替代真實值；若須換adapter，沿用同一契約測試。better-sqlite3載入或打包失敗，在T00處理，不拖到最後。浮點原生邊界已有四個原生錨點（04 §3 DIFF-01段），比較模型仍屬假設；遇到不符的新案例以原生值為準，記錄限制，不自行改其他收費规则。

實作開始後若spec出現相互矛盾，先提出具體矛盾及最小澄清，持續不依賴該問題的工作；不擴成P2/P3。完成任一展示節點應提供可操作入口，不能只有程式碼、terminal輸出或「已完成後端」。
