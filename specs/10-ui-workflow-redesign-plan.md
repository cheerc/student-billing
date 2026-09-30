# UI 重設實作 Plan

> **2026-09-30 註記**：本計畫的 R0–R5 已全數交付並合併（驗收見[progress/ui-redesign-acceptance.md](progress/ui-redesign-acceptance.md)）。下文「本次僅交設計」「尚未執行」是 2026-09-29 撰寫時的口吻，保留原文，不代表目前進度。operator 第一次人工驗收後的修正與後續批次見[11](11-ui-acceptance-fix-plan.md)。

日期：2026-09-29。依據：[06 D33](06-handoff-decisions.md)、[09 UI spec](09-ui-workflow-redesign-spec.md)；驗收矩陣正本在[04 §8](04-tdd-acceptance.md)。基準origin/main `66d6371`（PR #22合併點，設計基準25e0ebf）；開工時比對最新main，保留後續修正。本次僅交設計，以下工作尚未執行。本檔屬根CLAUDE.md §2的執行計畫層，不定義產品規則、不覆寫02–04／09。

## 1. 分批交付

|PR|範圍／主要檔案|先測／完成條件|可見成果|review_class|
|---|---|---|---|---|
|R0|現況baseline、合成fixtures、API欄位盤點；隔離E2E config與scripts（§4）；讀web/AGENTS與Next本地docs|既有typecheck/lint/test/build與**隔離**E2E各跑一次，逐檔記錄原有失敗（§4清單），不修產品行為|有可追溯回歸基準，不重啟需求研究|single|
|R1a|activate採最新已儲存設定（09 §8.2.1，B1，由issue #24落地）、preview／apply的import由server決定（09 §8.2.2，B5，由R1a(B5) PR落地）；activate-import／calculate-run／apply-settings／settings-preview與preview route|UX02／UX03／UX18／UX22（先RED）與UX04的importId case，真SQLite，不改domain公式|「套用設定→匯入新名單→啟用」採新設定；儲存設定不再順便啟用別批名單|dual|
|R1b|schedule-preview application、calculate POST／deductions GET、settings_only、table rebuild migration、空sessions／整班移除語意（09 §8.1／§8.2.3／§8.2.4；由R1b PR落地）、settings頁解除import封鎖（UI，隨R2設定頁重寫，R1b只提供API，見§2）|UX01／UX04–08／UX17–19／UX23／UX24，真SQLite，不改domain公式|空DB可先存課表及讀計算值；逐堂／班級／學生同源|dual|
|R2|layout/globals、app-shell；settings-editor拆schedule-grid/window-editor/impact-dialog/mapping-panel（window-editor只留唯讀顯示）|UX01–10／14–16／24，指定尺寸檢查|展示一：課表主畫面＋即時重疊＋先課表後匯入|single|
|R3|imports頁整合roster-view的activate；預覽、日期、成功導向|UX09–12／19／22，既有imports/active-run測試|匯入頁一次完成使用名單|single|
|R4|page/active-run-view/summary-table/detail-drawer、結果雙頁籤、八欄、班級扣天、更多篩選|UX05–08／11–16／20–21，API同run對照|展示二：按班核對兩種總表，完整走完SOP|single|
|R5|history、文案/a11y、隔離真檔驗收（本機）與交付報告|全套UX與既有回歸、production build|展示三：完整UI可交付|single|

順序R0→R1a→R1b→R2→R3→R4→R5；R2可先用合成read model排版，但展示一不可用假計算。每PR reviewer查相同head，修改後補測再合併。不要等全部後端寫完才展示畫面。

review_class依根CLAUDE.md §7：T04（啟用Run）屬dual。R1a改動activate與apply交易，R1b改動apply交易（settings_only）、run的設定輸入語意與migration，兩者皆dual（`sb-team-reviewer`與`sb-team-reviewer2`各出VERIFIED）；R0與R2–R5屬基礎架構／UI／文件類，single。

## 2. R1a／R1b實作界線

R1a：

- （B1，issue #24落地）每一次activate由server解析最新已儲存settings version，寫入run.scheduleVersionId並套用其alias／時段；忽略client傳入的scheduleVersionId；尚無任何已儲存設定才用seed（09 §8.2.1，現況缺陷，UX22先RED）。
- preview／apply的import由`active_state`決定，不信任client importId；不一致即拒絕。無active時維持現行拒絕，settings_only由R1b提供（09 §8.2.2）。UX02、UX04須含「client傳非active的ready批次」case，且不得啟用該批。落地錯誤碼：preview的client importId與server決定值不符（含null、非字串、非active批次）→400 `IMPORT_MISMATCH`；無active import→404 `NO_ACTIVE_IMPORT`（含只有ready批次，不採用它；R1b起由settings_only取代，此404移除）；apply遇預覽鎖定的批次≠現行active→409 `IMPORT_MISMATCH`，CAS與此檢查同交易，apply不再寫`active_import_id`。preview不帶importId合法（不再回`MISSING_IMPORT_ID`）。UX02「儲存課表再activate」與UX04的settings_only競爭屬R1b，本PR只落地importId case。
- 不改domain公式、不動migration。

R1b：

- read model先凍結rowId/class grouping、inactive、empty、incomplete、未知星期、共用窗口的語意；窗口取ruleSet並在回應帶windows，ruleSetVersion由server決定且不得為compat（09 §8.1）。以既有SettingsDraft／ScheduleGridRow轉換，不漏掉不能計算的列。
- 空sessions／整班移除採09 §8.2.4方案A（無時段＝不扣天＋issue，不退回seed）；UX23先RED（現況會退回seed）。read model與run共用同一個draftToScheduleOverride。
- calculate是純計算，不把每次鍵盤輸入持久化；儲存preview才保存完整草稿/hash/revision/TTL。
- server決定settings_only／with_students。只有ready時不能偷偷啟用。
- migration以table rebuild把`settings_previews.import_id`（0004）與`idempotency_records.run_id`（0003）改為可null，並保留0005的`expires_at`（09 §8.2.3）。repository與response runId可null。測舊DB升級（**舊資料逐列保留**）、失敗rollback、成功冪等先於CAS。無學生時不能造假import/run。
- 已有active的班級扣天用run快照；無active用saved settings，草稿另標；舊run不可用當前課表補算。
- 這是先課表SOP必需的服務擴充。不能僅刪除「請先匯入」文字而仍無法儲存。
- 落地內容（R1b PR）：
  - calculate：`POST /api/v1/settings/calculate`，輸入`{draft, requestKey}`（draft採`CalculateDraft`，允許帶可選`rowId`與不完整列：起／迄null或迄≤起），回`{requestKey, draftHash, ruleSetVersion, windows, rows, classes, issues}`；client的`rowId`原樣回傳；不完整列回null＋`missing_time`與`SCHEDULE_INCOMPLETE`問題；班級含不完整列標為`incomplete`，扣天只統計完整列；`draftHash`取去掉不完整列與rowId之「存檔等價draft」計算，與同一份draft的preview`inputHash`完全相同（預覽與提交同源）；client帶`ruleSetVersion`→400 `INVALID_REQUEST`，`careWindows`與ruleSet不同→400 `INVALID_DRAFT`（settings/preview同），payload上限512 KiB→413，班名重複→400，rowId重複→400；狀態分`calculated／no_overlap／unknown_weekday／missing_time／incomplete／shared_window／inactive`，未知星期與缺時間不冒充「無衝堂」；`rawDeduction`為domain負值，UI以正量顯示。提供`gridRowsToCalculateClasses`供R2將平鋪列直接轉為calculate輸入，不漏列且rowId一對一掛回。
  - deductions：`GET /api/v1/settings/deductions?runId=`，回`scope`（`run／active_run／saved_settings／seed`）、`scheduleVersionId`、`settingsRevision`、`ruleSetVersion`；快照不存在→409 `SNAPSHOT_UNAVAILABLE`（不用最新課表補舊run），診斷軌run→422 `UNSUPPORTED_RULESET`，未知runId→404。
  - settings_only：無現行名單時preview回`mode:"settings_only"`，學生影響欄位為`null`；apply只存設定並遞增revision，`runId:null`、不建假run；migration `0006_settings_only_nullable.sql`以table rebuild把`settings_previews.import_id`與`idempotency_records.run_id`改可null（舊資料逐列保留，含`expires_at`）。
  - B4：`draftToScheduleOverride`對active且sessions為空的班級寫入空覆寫（`schedule_empty`），有覆寫時班級不在其中即`schedule_not_found`，兩者皆不退回seed；既有測試以`sessions: []`表「沿用seed」的draft依此改為全量seed draft。
  - 影響預覽的「前」改為目前生效設定（最新已儲存設定，尚無才是seed），不再永遠比對seed。
  - UI不在本PR：settings頁仍在無現行名單時擋下並送`active ?? 最新ready`的importId；設定編輯器尚未處理`mode:"settings_only"`的null欄位，R2須改為不送importId並處理`mode`與null欄位。

R2：
- 側邊導覽序號化與 App Shell（1 課表設定、2 匯入學生、3 核對結果、匯入紀錄），去除日常介面中顯眼的技術標籤。
- 課表設定頁（`/settings`）：解除無名單時的阻擋卡片，空 DB 直接進入排課；預設課表頁籤，唯讀安親／課輔窗口（D33 窗口固定無編輯）；89 列平鋪排課網格，左側 5 編輯欄＋右側 5 唯讀計算欄；編輯時段 250ms debounce 呼叫 `/api/v1/settings/calculate` 即時計算，requestKey 晚到取消保護；不完整列標「待補」與 `SCHEDULE_INCOMPLETE`。
- 固定底部操作列：有未儲存變更提示，取消修改還原 baseline，確認變更開啟 ImpactDialog。
- ImpactDialog 儲存確認視窗：無學生時顯示「尚未匯入學生」，受影響人數為 null，主按鈕「儲存課表」（送 `mode: "settings_only"` 不帶 `importId`，落地先課表後匯入）；有 active 學生時顯示受影響去重人數與天數明細，主按鈕「儲存並更新結果」。
- 班名對應頁籤：無名單時提示「匯入名單後，可確認ERP班名」，不阻擋課表維護；有名單時保留動態差集與已對齊隱藏。
- 響應式 1440/1280/1024/768 支援，寬表表內捲動，姓名 sticky，Esc 關閉 dialog。

R3：
- 匯入頁三態流程（`/imports`）：選擇檔案 → 確認名單 → 完成，頂部顯示課表儲存時間與查看連結；文案去技術化（「上傳ERP匯出的學生Excel」，移除 OOXML／inlineStr 等開發術語）。
- 名單預覽：顯示檔名、總人數、有班／無班／離班人數；新增 `rosterDiff` 差異統計（相對於現行名單的新增／異動／未出現）。R4 起「異動」不再用 person_code ＋ 報名 token 指紋，改以 before/after **計算結果**判定（折扣與安親／課輔扣除天數，operator 裁決 d-20260929111803466480-4／-5）：報名改但計費不變不算異動，年級或標籤變而計費變才算；API 整批計算並附逐人明細（折扣、天數 before → after、逐班扣天），預覽以三個數字與可展開明細呈現；重傳同檔判重提示（`isDuplicate`／`duplicateReason`）不阻擋；未知班名提示「N 個班名待確認」。
- 頁內閉環啟用：主按鈕「使用這份名單」直接呼叫 `/api/v1/imports/[previewId]/activate`（expectedRevision、idempotencyKey、asOfDate 核對基準日），不需返回首頁；伺服器自動套用最新已儲存課表與班名對應（#24 契約）。
- 完成導向：顯示「N 位學生資料已備妥」＋主要動作「開始核對 →」導向核對結果頁。
- 去技術化補完（specs/09 §7）：`roster-view`「展示A／預覽名冊」改「尚未啟用」、啟用按鈕改「啟用為正式 Run ▶」；`active-run-view`「展示B／版本 rev N」改「核對基準日」，Run ID／rev 收納進「技術資訊」摺疊區。

## 3. TDD矩陣

UX01–UX24的矩陣正本在[04 §8](04-tdd-acceptance.md)，此處不再複製，避免兩處漂移；各PR對應的UX見§1表。UX22、UX23的RED對應09 §8.2.1、§8.2.4記載的現況缺陷，先證明失敗再修。保留原U/I及08測試；每個可觀察行為先red再green，expected來自既有domain固定案例／已確認案例，不用新UI自己生成。

## 4. 本機驗證與執行

本repo採no-CI（decision d-20260923084544894113-3：GitHub Actions額度不足）。merge證據是Reviewer在獨立worktree跑的本機全量結果（typecheck、lint、vitest、playwright、production build），不是CI。現有`.github/workflows/ci.yml`只跑npm ci、typecheck、lint、test、build，無Playwright job；R5可加browser install與E2E job，但**不作gate**。

**E2E隔離**（R0建立；指令`npm run test:e2e:isolated`，說明見web/README §4.1）：

- DB：環境變數`DATABASE_PATH`（`web/src/adapters/sqlite/db.ts:11`）指向測試專用sqlite，不指`/data/app.sqlite`。
- config：現行`web/playwright.config.ts`的webServer固定`npm run dev`（:19），該script寫死`-p 3000`（`web/package.json:9`），baseURL與url為3000（:9、:20），`reuseExistingServer: !process.env.CI`（:21）——使用者開著的3000服務會被重用而寫入真資料。隔離config須：webServer.command直接呼叫`next dev -H 127.0.0.1 -p 3100`（不經`npm run dev`）、baseURL與url同改3100、`reuseExistingServer: false`，並以`env`傳入`DATABASE_PATH`。**不得在使用者3000服務跑會寫入的測試**，只用合成／匿名fixtures。

**R0既有本機E2E失敗清單**：PR #22 review記錄下列4個spec在本機失敗（`specs/progress/p1-acceptance.md:79`記錄P1當時6個suite全通過）。R0須以隔離config重跑取得實際輸出，逐檔記錄，未重現者自清單移除。

|spec|內容|處置|
|---|---|---|
|`roster-filter.spec.ts`|展示A：上傳→首頁持久化→班級與條件篩選|R4結果頁改版時重寫（UX13／UX14）|
|`active-run.spec.ts`|展示B：上傳→啟用→八欄→篩選5筆差異→明細|R3（匯入頁使用名單，UX11）與R4（八欄／明細，UX14）重寫；「5筆差異」是fixture，不是業務目標（09 §1）|
|`recovery-ui.spec.ts`|T06：上傳→啟用→歷程→問題定位→待設定提示→重置篩選|R4／R5（歷史與空狀態，UX21）重寫|
|`settings-preview-apply.spec.ts`|T05：勾選數學一→一A→preview 13人／-0.5／5→18→套用|R2（UX03／UX09／UX10）重寫；13人／-0.5／5→18是D18預期結果，重寫後仍須斷言|

這些spec在R2–R4被改寫前，R0已存在的失敗不記為R1–R5造成的回歸；重寫的PR描述須列「舊spec→新UX」對照，被取代的舊斷言若刪除須逐條說明，不得悄悄刪檔。

命令依現有scripts：npm run typecheck、npm run lint、npm test、npm run build；E2E為`npx playwright test`搭配隔離config。新scripts同PR提供。本次specs PR（#22與其rework）只驗文件，不假稱產品已通過。

不換框架、不引大型grid／UI套件、雲端或分析服務。若需accessible primitive提出必要性即可，禁止為畫面先重構全部domain。Next改碼依web/AGENTS先讀本地docs。

量測同機器課表輸入到預覽完成p95（debounce最多300ms）、篩選及原477人P1目標；慢時顯示計算中，不能顯舊值冒充完成。此回合不變更原P1效能門檻。

## 5. Reviewer與交付

reviewer不只檢查截圖或字串，需驗先課表可持久化、activate採最新已儲存設定、空時段不退回seed、單堂和整班差別、同run來源、取消／409、警告不遺失、既有計費不變。UI更新後仍能追溯技術診斷，但行政流程不必經JSON頁。

R5交specs/progress/ui-redesign-acceptance.md，含commit、每UX結果、三次展示、隔離方式（隔離config與`DATABASE_PATH`）、截圖、回歸／效能／a11y與未完成項；merge證據為本機隔離E2E結果（§4），不是CI。真資料截圖與報告留本機，repo只放合成內容。真檔測試在隔離副本，不改使用者DB／原檔。

本次設計PR只改specs，合併不會讓localhost產品自動換版。後續team lead按R0–R5派impl/reviewer，不重新做P1或回退D30/D32。
