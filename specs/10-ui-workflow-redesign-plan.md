# UI 重設實作 Plan

日期：2026-09-29。依據：[09 UI spec](09-ui-workflow-redesign-spec.md)。基準origin/main 25e0ebf；開工時比對最新main，保留後續修正。本次僅交設計，以下工作尚未執行。

## 1. 分批交付

|PR|範圍／主要檔案|先測／完成條件|可見成果|
|---|---|---|---|
|R0|現況baseline、合成fixtures、API欄位盤點；讀web/AGENTS與Next本地docs|既有test/typecheck/lint/build，記錄原有失敗|有可追溯回歸基準，不重啟需求研究|
|R1|schedule-preview application、calculate POST／deductions GET、settings_only preview/apply、必要migration、settings頁解除import封鎖|UX01–08／17–19，真SQLite，不改domain公式|空DB可先存課表及讀計算值|
|R2|layout/globals、app-shell；settings-editor拆schedule-grid/window-editor/impact-dialog/mapping-panel|UX01–10／14–16，指定尺寸檢查|展示一：課表主畫面＋即時重疊＋先課表後匯入|
|R3|imports頁整合roster-view的activate；預覽、日期、成功導向|UX09–12／19，既有imports/active-run測試|匯入頁一次完成使用名單|
|R4|page/active-run-view/summary-table/detail-drawer、結果雙頁籤、八欄、班級扣天、更多篩選|UX05–08／11–16／20–21，API同run對照|展示二：按班核對兩種總表，完整走完SOP|
|R5|history、文案/a11y、隔離真檔驗收、CI E2E與交付報告|全套UX與既有回歸、production build|展示三：完整UI可交付|

順序R0→R1→R2→R3→R4→R5；R2可先用合成read model排版，但展示一不可用假計算。每PR reviewer查相同head，修改後補測再合併。不要等全部後端寫完才展示畫面。

## 2. R1實作界線

- read model先凍結rowId/class grouping、inactive、empty、incomplete、未知星期、共用窗口的語意。以既有SettingsDraft／ScheduleGridRow轉換，不漏掉不能計算的列。
- calculate是純計算，不把每次鍵盤輸入持久化；儲存preview才保存完整草稿/hash/revision/TTL。
- server決定settings_only／with_students。只有ready時不能偷偷啟用；首次activate採最新已儲存有效設定。
- 向前migration檢查settings_previews.import_id、idempotency_records.run_id、repository與response runId可null。測舊DB升級、失敗rollback、成功冪等先於CAS。無學生時不能造假import/run。
- 已有active的班級扣天用run快照；無active用saved settings，草稿另標；舊run不可用當前課表補算。
- 這是先課表SOP必需的服務擴充。不能僅刪除「請先匯入」文字而仍無法儲存。

## 3. TDD矩陣

UX為新增驗收，保留原U/I及08測試。每個可觀察行為先red再green；expected來自既有domain固定案例／已確認案例，不用新UI自己生成。

|ID|輸入／操作|expected|層|
|---|---|---|---|
|UX01|空DB先改課表→確認→儲存→重啟|設定存在、revision遞增、run仍null|integration/E2E|
|UX02|只有ready批次，儲存課表再activate|不自動啟用ready；activate用最新確認設定|integration|
|UX03|有active改時段，取消／失敗／成功|前兩者active不變；成功設定和新run原子切換|integration/E2E|
|UX04|settings_only儲存與另一tab activate競爭|一成功另一409；同key/body成功重送回原結果|integration|
|UX05|週一15:20–16:50，v2預設窗口|課長90、安親40分／40÷180、課輔20分／20÷180；正量顯示、負數domain不改|unit/API|
|UX06|同班一15:20–16:50、三15:30–17:00、五同一|安親110÷180→實扣0.5、課輔70÷180→0.5，先合計|unit/API|
|UX07|週六／未知星期／缺起迄／care_window／inactive|合法六為0，未知／缺漏警告非無衝堂，共用窗口不捏造session|unit/component|
|UX08|改時間、窗口、有效日，舊回應晚到|dirty與preview失效，最新request才可顯示，總覽不讀draft|component/integration|
|UX09|改散同班名、刪列、停班、alias失效|D28/D29提示與後果可見，草稿可取消，確認才提交|integration/E2E|
|UX10|新ERP／新設定產生差集|D32動態候選與去重人數，不自動批准，對齊消失|integration/E2E|
|UX11|上傳→預覽→使用→核對；缺標頭錯誤|單頁接activate，失敗舊run不變，成功真實人數與日期|E2E|
|UX12|同檔／過期／版本變更|不重複學生，短中文錯誤＋重試，raw code不是唯一說明|integration/E2E|
|UX13|選班→搜尋→更多篩選→明細→返回|同run同filter名單／人數一致，狀態保留，q不入URL|API/E2E|
|UX14|八欄null／false／0／特殊率／不適用|型別不混，合計與本班率分開，八欄可達、姓名sticky|component/E2E|
|UX15|級距match但有issue，未知issue code|警告仍在、不硬限13人；未知碼短標需確認且可查原因|unit/E2E|
|UX16|tab／focus／click tooltip，drawer/modal Esc|focus trap／回復，label/aria-live，錯誤不只hover|E2E/人工|
|UX17|舊DBmigration／故障／備份還原|歷史settings/runs/冪等紀錄保留，不清DB|integration|
|UX18|相同input計算前後比對|erp-tag-v2與舊run值不變，不藉UI改D24/D30|regression|
|UX19|多次calculate POST／deductions GET|DB/active/preview行數與內容不變，無多餘PII|API/integration|
|UX20|1440×900、1280×800、1024×768、768寬|無整頁橫向溢出，表內可捲，sticky與底部不遮操作|視覺/E2E|
|UX21|歷史／空篩選／loading／失敗|唯讀、來源日期清楚；可清filter，不能假成功|E2E|

## 4. CI與執行

現CI有npm ci、typecheck、lint、Vitest、build，無Playwright job。R5增加browser install與隔離E2E，指定test data目錄及另一埠（如3100），環境變數名稱依repo DB adapter確認。現playwright.config.ts會reuseExistingServer，**不得在使用者3000服務跑會寫入的測試**。改測試config並禁止reuse user server，只用合成／匿名fixtures。

命令依現有scripts：npm run typecheck、npm run lint、npm test、npm run build；E2E為npx playwright test搭配隔離config。新scripts需同PR提供。本次docs/mock PR只驗文件與mock互動，不假稱產品已通過。

不換框架、不引大型grid／UI套件、雲端或分析服務。若需accessible primitive提出必要性即可，禁止為畫面先重構全部domain。Next改碼依web/AGENTS先讀本地docs。

量測同機器課表輸入到預覽完成p95（debounce最多300ms）、篩選及原477人P1目標；慢時顯示計算中，不能顯舊值冒充完成。此回合不變更原P1效能門檻。

## 5. Reviewer與交付

reviewer不只檢查截圖或字串，需驗先課表可持久化、單堂和整班差別、同run來源、取消／409、警告不遺失、既有計費不變。UI更新後仍能追溯技術診斷，但行政流程不必經JSON頁。

R5交specs/progress/ui-redesign-acceptance.md，含commit、每UX結果、三次展示、隔離方式、截圖、回歸／效能／a11y與未完成項。真資料截圖與報告留本機，repo只放合成內容。真檔測試在隔離副本，不改使用者DB／原檔。

本次設計PR只改specs，合併不會讓localhost產品自動換版。後續team lead按R0–R5派impl/reviewer，不重新做P1或回退D30/D32。
