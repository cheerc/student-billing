# 12 第二次人工驗收修正 Plan

Source of truth：task `t-20261001152046540233-21323-41`（批次 E）；operator 核准 plan r1 `~/Downloads/student-billing-round2-fix-plan-20261001.md`、decision `d-20261001025011535525-10`（Q1–Q6 全採建議）；第二輪驗收報告（受驗 `ca73cf1`，裁決 REJECTED）。

本檔屬[根 CLAUDE.md](../CLAUDE.md) §2 的執行計畫層，不定義產品規則：規則以 [02](02-calculation-rules.md)／[03](03-architecture-api.md)／[09](09-ui-workflow-redesign-spec.md) 為準，驗收以 [04 §8](04-tdd-acceptance.md) 為準。本檔只記錄第二輪兩項 FAIL 的修正來源與三項驗收工具的操作方式；產品規則的改動不在本檔。

## 0. 與前一批的接續

- [11 第一次人工驗收修正 Plan](11-ui-acceptance-fix-plan.md) 記錄 PR-0、A、B1、B2、C、D 的分批與停止條件；D2c／D2d 為其延伸，細節見該檔 §3 與 [D2c parity 與規格稽核](reviews/d2c-parity-audit.md)。
- 第二次人工驗收於 D2d 合併後執行，兩項 FAIL（R2-F01、R2-F02）由本檔對應的批次 E 收斂；驗收列 UX74–UX77 接續 D2d 已使用的 UX71–UX73（decision `d-20261001050915775646-5`）。
- 批次 E 合併後由 Lead 產出第三次人工驗收清單；本檔 §4 的工具指令供該清單「環境準備」段引用。

## 1. R2-F01：篩選後的班級扣天編輯課表再 Back，丟失頁籤與條件（E02、K01）

**症狀**：首頁 `/` → 學生總表選班＋搜尋 → **以 UI 切到班級扣天**、選老師 → 展開班級 →「編輯此班課表」→ 不修改直接 Back → 回到 `/` 且停在學生總表，老師與班級條件消失（只剩姓名搜尋）。重現 2／2。直接開 `/?view=deductions` 進入的對照路徑可保留。

**根因（實測）**：Back 還原的是**最初導覽**（網址 `/`、無參數）取得的 RSC 快取，server 依該次 `searchParams` 算出的 `initialView`／`initialFilters` 本身就是舊的；元件掛載後的同步網址 effect 隨即把網址改寫回乾淨的 `/`。只同步 router 的 canonical URL 換不掉那份 props（單行 `replaceState(null, …)` 的實測結果：UX74 兩輪各 3 failed，症狀不變）。

**修正**（decision `d-20261001162616375458-385` 前的裁定 `m-20261001154454554519-346`）：留在 client——首次 render 以**當下網址**同步還原頁籤與條件，來源是與 server **同一套** parse／prune 純函式（`src/lib/results-state.ts`，server 的 `resolveResultsView` 改為呼叫它，輸出不變）；單班「本班適用折扣」因 Back 快取的 `initialOptions` 可能不含該班，等待 `ensureApplicableOptions` 的實際 response 後才剪枝，等待期間顯示既有 loading、不顯示舊 props 的列與計數。不用 sessionStorage 另存條件，不改「姓名搜尋不進網址」。

**測試盲點**：`deductions-navigation.spec.ts` 的「編輯→返回仍在班級扣天」案例從 `/?view=deductions` 直接進入，正是能通過的對照路徑。UX74 必須走 operator 的原路徑（先用 UI 切頁籤）。

## 2. R2-F02：儲存課表重算後，核對基準日被改成 UTC 日期（K01、I02）

**症狀**：現行 run 基準日 2026-10-01，凌晨 02:48（台北）儲存課表後新 run 變 2026-09-30；後續每次儲存重算都沿用；舊歷史 run 不變。

**根因（已查證）**：`apply-settings.ts` 呼叫 `executeCalculationRun` 未傳 `asOfDate`；`calculate-run.ts` 回退 `new Date().toISOString().split('T')[0]`（UTC）。台北 00:00–07:59 正是 UTC 前一天。

**規格依據**：asOfDate 只作核對基準日記錄於 run、不選排課版本（03）；「核對基準日由使用者明選」（07）；日期用 `YYYY-MM-DD` 與 Asia/Taipei 語意（03）。

**修正**（operator Q1 採建議 a）：儲存課表重算時**沿用現行 run 的 asOfDate**（在既有交易內讀，不新增查詢路徑）；新增匯入啟用維持由使用者明選；`executeCalculationRun` 的退回值改為既有 helper `todayInTaipei`（`src/lib/datetime.ts`，base 已有，非本批新增）。**既有 run 不回填**（不可變快照）。asOfDate 在計算流程中只被讀入與寫入，domain 層無讀取——UX76 以「同一輸入、只換 asOfDate，業務欄位逐欄相同」鎖定，不把 expected 取自被測函式輸出。

**查證的限制**：「有 import 但找不到 current active run」在現行 `web/src` 的生產流程不可達（activation 與 with-students apply 都在同一交易內先保存 run 再切換 active pointer；無 production run／import 刪除入口）；`active_state` 的兩個 pointer 沒有外鍵，schema 容許外部造成的不一致，但本批沒有證據那是生產可達。備份還原複製整份 DB 檔，不會自行製造該狀態。

## 3. 範圍與排除

- 只改 R2-F01、R2-F02 與 §4 的三項驗收工具；不改 D24 取整、D30 同星期、安親／課輔窗口、既有 run 的值／分類／基準日、v1／v2／v3／compat 的計算輸出與 golden（SHA256 `d5198edf381434ab1df0da8f0f13dfe3e0ffb2ee6ab0f4bd3627523f8c06bc56`）。
- 不新增 migration／schema／依賴；不改 `hashSettingsDraft` 契約；不讀 `data/`、不碰真實名冊；不動 operator 的 3000。
- 不回退 B2（F03／F04）、C（F07 離頁提醒）、D1／D2 任何修正（含 D2d 的 F-1／F-2／F-4 與 `restoreFocusToOpener`）。
- 不修 issue #47（runner `--repeat` 跨輪共用 DB）、issue #48（leave-confirm-dialog 同型 restore）、task -21323-39（opener 同 document 移除 listener 殘留）——各有獨立 task。

## 4. 驗收工具（只放 `web/scripts/`，不改產品 code）

三項工具都只綁 127.0.0.1、只作用在隔離環境，`3000` 與 `data/` 完全不碰；每項各自有 tests-only RED→GREEN 與測試。

### T1 隔離驗收環境（解 B01、K03）

以 `git archive HEAD web` 只取**追蹤檔**（不帶 untracked、`.next`、`data/` 或真實名冊）到 tmpdir，在該處做 production build，再以 `next start` 啟動；source checkout 的 `.next` 不被改動。

```bash
cd web
npx tsx scripts/acceptance-env.ts --port 3300
```

輸出兩行開頭的結構化資料（供後續指令使用）：

```
SESSION {"kind":"student-billing-acceptance","token":"…","head":"<sha>","port":3300,"state":"/…/sb-acceptance-XXXX","database":"/…/app.sqlite","workspace":"/…/web","url":"http://127.0.0.1:3300", …}
READY  {"…同上…"}
控制：npx tsx scripts/acceptance-env.ts --restart|--reset|--stop --state /…/sb-acceptance-XXXX
```

首次啟動需數十秒（production build）；之後 `--restart` 不重建，只重啟服務。

```bash
npx tsx scripts/acceptance-env.ts --restart --state <state>   # 停止後用同一份 DB 再啟動
npx tsx scripts/acceptance-env.ts --reset  --state <state>   # 清空 DB 重來
npx tsx scripts/acceptance-env.ts --stop    --state <state>   # 停止；DB 與 marker 保留
```

- `--restart`／`--reset`／`--stop` 必須附啟動時印出的原始 state 目錄；目錄是 symlink、marker 不符（不同 checkout／不同埠／不是本工具建立）一律拒絕，不啟動也不終止任何服務。
- 拒絕 operator 的 3000 與已占用埠（不終止他人服務）。
- 控制通道是 state 目錄內的 unix socket（0600）；marker 記錄 checkout realpath、session token、port 與 HEAD。
- 停止時只保留 DB 與 marker（build workspace 會被刪除，避免 tmp 堆積）；`--reset` 只刪該 session 的 `app.sqlite`／`-wal`／`-shm`。
- 停止／退出前會等待自己的子程序結束（TERM→5s→KILL，只作用於自己建立的 process group）。

### T2 故障注入代理（解 L06、M01、M02、M04）

在 T1 前放一層本機代理；測試者改用代理埠瀏覽。

```bash
cd web
npx tsx scripts/acceptance-proxy.ts --port 3200 --upstream http://127.0.0.1:3300 --token "$(uuidgen)"
```

輸出 `READY proxy=http://127.0.0.1:3200 upstream=http://127.0.0.1:3300 control=POST /__control (x-proxy-token)`。**token 只顯示在此終端，不寫入任何檔案**；測試者請保存自己啟動時的 token。

設定規則（`curl` 或瀏覽器皆可；以下以 `curl` 為例）：

```bash
curl -s -H "x-proxy-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"rules","rules":[
        {"method":"GET","path":"/api/v1/settings/class-name-report","action":"status","status":500,"times":1},
        {"method":"POST","path":"/api/v1/settings/calculate","action":"abort"},
        {"method":"GET","path":"/api/v1/runs/current","action":"delay","delayMs":3000}
      ]}' http://127.0.0.1:3200/__control
# → {"ok":true,"rules":[{"method":"GET",…,"remaining":1},{"method":"POST",…,"remaining":null},{"method":"GET",…,"remaining":null}]}
```

- 規則以 `method`＋**完整 pathname**比對（不含 query）；`action` 為 `status`（回指定狀態碼）、`abort`（直接中斷連線）、`delay`（延遲後照常轉發，或搭配 `status`）。`times` 省略＝持續生效，給 `N`＝只生效 N 次並在回應中回報剩餘次數。
- 清除：`curl -s -H "x-proxy-token: $TOKEN" -H 'content-type: application/json' -d '{"action":"rules","rules":[]}' http://127.0.0.1:3200/__control`（或 `{"action":"clear"}`）。
- 停止：`curl -s -H "x-proxy-token: $TOKEN" -H 'content-type: application/json' -d '{"action":"stop"}' http://127.0.0.1:3200/__control`。
- 每次命中印一行 `HIT <method> <pathname> action=<action> at=<ISO>` 作為證據；**不記 query、學生 body、token**。
- 轉發不緩衝：RSC／streaming／上傳 body 逐片原樣串接；請求與回應標頭原樣轉發（hop-by-hop 標頭除外）。
- upstream 只接受 `http://127.0.0.1` 且拒絕 3000；規則本身對 `/__control` 無效（控制請求不受注入影響）。

### T3 純合成驗收測試檔產生器（解 F03、G02、L04、L05）

一次產出整組**全合成、匿名**的 xlsx 到 repo 外。

```bash
cd web
npx tsx scripts/round3-fixtures.ts                              # 預設 ~/Downloads/student-billing-round3-fixtures
npx tsx scripts/round3-fixtures.ts --out /tmp/round3-$(date +%s)  # 自訂目錄（必須在 repo 與 data 之外，且是空目錄）
```

輸出：

```
round3-A.xlsx：2 人（全合成）；<dir>/round3-A.xlsx
round3-B.xlsx：3 人（全合成）；<dir>/round3-B.xlsx
round3-C.xlsx：4 人（全合成）；<dir>/round3-C.xlsx
摘要：<dir>/manifest.json；A=2人、B=3人、C=4人；B 有1位非空解析失敗原文
```

- 三批**內容與人數皆不同**，依 A→B→C 的順序匯入可在「前一份名冊」欄位辨識批次；B 含 1 位非空但無法解析的班級原文（`[團]`）與 1 個可有效對應的班名（manifest 的 `alias` 目標為**設定中實際存在**的班）；C 含 null 適用率與 8500 特殊率案例。
- 檔案格式與產品認得的米豆奶匯出一致（inlineStr、無 sharedStrings）；**不讀任何真實名冊**，不修改既有 golden。
- 目標目錄已有檔案時不覆寫（改用新的 `--out`）。
- manifest 的預期人數、alias 目標與 F03 各子項可達性由**產生器內明列的列資料**寫出，不以產品 parser 輸出回填。

**F03「0 天學生」的處置（與 plan r1 的修正）**：plan r1 假設 T3 可製造天數 0 的學生；實測不成立——`executeCalculationRun` 的八項總表天數來自靜態 seed 的場次數（seed 49 班的 sessions 皆 ≥1，未命中數學／美語時退回 2），安親／課輔另有 3.5／3 天下限；儲存空課表（`sessions: []`）只影響扣天與 `SCHEDULE_EMPTY`，不改這個場次來源。因此 T3 **不宣稱**提供 0 天案例，manifest 以 `f03.zeroDays.status = "unreachable"` 如實標示，並改提第三項子項（零科數、`false`、null 適用率、特殊率）。F03 驗的是**顯示語意**，不是要求天數欄一定是 0。

## 5. 停止條件

- R2-F01 若必須改伺服器端讀取網址的契約，或必須放棄「姓名搜尋不進網址」→ 停下回報（本批未觸發）。
- R2-F02 若發現 asOfDate 實際影響任何業務欄位 → 停下回報（與 03 矛盾；本批未觸發，見 §2）。
- 任何工具若必須修改產品 code 或新增依賴才能做到 → 停下回報。
- 需改 D24／D30／窗口或既有 run；需 migration／schema；效能超門檻（重算 ≤1s、篩選 ≤200ms、匯入至可查 ≤3000ms）；真實個資進 repo；同一 PR 審查連續兩次 REJECTED → 停下與 operator 討論。

## 6. 與既有文件的接續

- 驗收列 UX74–UX77 在 [04 §8](04-tdd-acceptance.md)；本檔只記錄來源與工具。
- 第三次人工驗收清單由 Lead 產出於 `~/Downloads/`，其「環境準備」段引用本檔 §4 的指令與預期輸出，不複製產品規則。
- 根 [CLAUDE.md](../CLAUDE.md) §2 的執行計畫層加入本檔。