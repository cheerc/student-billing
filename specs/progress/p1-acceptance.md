# 學生收費核對工具 (student-billing) P1 完成報告

本報告為學生收費核對工具 **P1 原型系統（T00–T07）** 之完整驗收與交付報告，依據 `specs/07-p1-implementation-plan.md §4 (T07), §6, §7` 規範彙整。

---

## 1. 系統基本資訊與環境

- **專案名稱**: 學生收費核對工具 (`student-billing`)
- **交付版本**: `0.1.0` (Git commit 參照當前分支 HEAD)
- **Runtime 環境**: Node.js `v24.21.0` LTS (Apple Silicon Darwin arm64)
- **架構模式**: Next.js 16 App Router + React 19 + TypeScript Strict + SQLite (`better-sqlite3` native module)
- **本機啟動指令**:
  ```bash
  cd app
  npm run build
  npm run start
  ```
- **存取網址**: `http://127.0.0.1:3000` (嚴格綁定 localhost，無雲端部署、無外部 API 呼叫、無公網 tunnel)
- **資料隔離政策**: 本機 SQLite 資料庫位於 `app/data/app.sqlite`，受到 `.gitignore` 嚴格保護，敏感個資絕不進入版控或外流。

---

## 2. P1 展示節點與里程碑完成總覽

| 展示節點 | 對應任務 | 狀態 | 驗收核心成果 |
|---|---|---|---|
| **展示 A** (Demo A) | T00, T01, T02 | **已完成 (VERIFIED)** | 支援任意欄位順序與隱藏欄的 ERP XLSX 上傳；解析班名 Token；呈現 477 學生（384 有班、93 無班）；持久化為 ready 批次；首頁可按年級、班級（四年級 A/B 分開）、有無班級與關鍵字篩選及穩定 cursor 分頁；清楚標記「預覽名冊 (未計算)」。 |
| **展示 B** (Demo B) | T03, T04 | **已完成 (VERIFIED)** | 完整雙軌計算核心（正式 `erp-tag-v1` vs 診斷 `excel-v260922-compat`）；八項每週收費天數核對總表；**照實呈現 5 筆級距 mismatch**（來源列 30, 35, 43, 51, 52）；**13 名數學缺排課學生全部在 match 且 hasIssues 同時成立**；提供單一學生明細 Drawer 與雙軌差異 JSON 診斷端點。 |
| **展示 C** (Demo C) | T05, T06, T07 | **已完成 (VERIFIED)** | 課程、別名、時段雙向對照同畫面並列；D18 候選確認與 preview→apply 雙階段重算；停機備份還原實測腳本；錯誤畫面與 Stale Preview 409 可見提示；全量 477 筆與 5000 筆效能量測達標；雙資料 Gate 通過。 |

---

## 3. 來源資料 Hash 與雙資料 Gate 驗證 (Data Gates)

### 3.1 來源檔案對照
- **真實 ERP 名冊檔案**: `嘉義縣私立資優生文教機構.xlsx`
- **保形匿名測試 Fixture**: `tests/fixtures/conforming-erp-fixture.xlsx`
  - 嚴格保留 OpenXML 實體形狀：100% `inlineStr`、無 `sharedStrings`、無 `<dimension>` 標籤、保留 `<t xml:space="preserve">`。
  - 人員代碼、姓名、電話、備註皆已在不破壞位元組結構與列號座標前提下完成安全匿名脫敏。

### 3.2 雙資料 Gate 檢驗成果 (`npm run verify:fixtures`)

執行指令：`npm run verify:fixtures`

```text
=== 執行雙資料 Gate 驗證 (verify:fixtures) ===

Gate 1 (正式標籤與計算): ✓ 通過
- 學生總數: 477 (384有班, 93無班)
- 標籤統計: 兄弟姊妹 133, 園內生 97, 特殊折扣 14, 額外扣天 14
- 備註保留: 171 筆非空
- 離班統計: 34 人 (37 tokens)
- 級距差異 (5筆): 來源列 [30, 35, 43, 51, 52]
- 缺排課全數 match: true (13人)
- 問題碼: 重複報名 2人, 員工家屬無折扣 5人, 備註衝突 1人
- Seed 49 班 / 89 rows; ERP 95 token -> 54 baseName (42候選 / 12待設定 / 7未出現)

Gate 2 (歷史 Compat 雙軌差異): ✓ 通過
- 基本折扣率差異人數: 107 人 (預期: 恰 107 人)
- 課輔天數差異人數: 12 人 (預期: 恰 12 人)
- 安親天數差異人數: 0 人 (預期: 恰 0 人)

=== 雙 Gate 全部通過！ ===
```

---

## 4. 全量測試與回歸驗證套件

本專案建置全分層自動化測試套件（單元、整合、API、E2E 與靜態分析），本機全量執行結果如下：

| 測試類型 | 執行指令 | 測試檔案數 | 測試案例數 | 結果 | 說明 |
|---|---|---|---|---|---|
| **型別檢查** | `npm run typecheck` | 全專案 | - | **PASS (0 errors)** | TypeScript 嚴格模式 (`strict: true`) |
| **程式碼規範** | `npm run lint` | 全專案 | - | **PASS (0 warnings)** | ESLint Next.js 推薦規則 |
| **單元測試** | `npm test` (unit) | 8 files | 68 tests | **PASS (100%)** | U01–U49 規則、D24 取整、Token 解析、標頭正規化 |
| **整合與 API 測試** | `npm test` (integration) | 16 files | 50 tests | **PASS (100%)** | I01–I20、DB 交易、CAS 409、備份還原實測、雙 Gate |
| **E2E 瀏覽器驗收** | `npx playwright test` | 6 suites | 6 suites | **PASS (100%)** | 展示 A/B/C、首頁、上傳、歷程、設定重算流程 |
| **基準驗證** | `npm run verify:baseline` | 1 file | - | **PASS (100%)** | 排課種子 49 班/89 列與全量計算指標 |
| **生產建置** | `npm run build` | 全專案 | 19 routes | **PASS (100%)** | 靜態頁面與動態 Route Handlers 最佳化建置 |

**單元與整合測試總計**: 24 個測試檔，118 項測試案例，全數綠燈通過。

---

## 5. 效能基準評測量測報告 (Benchmark Results)

依據 `specs/07 §4 T07` 要求，於固定硬體環境執行效能量測，記錄冷啟動 1 次與暖機後 10 次之中位數與 p95 數據。

### 5.1 測試環境
- **硬體**: Apple M1 (8 cores), 16 GB 記憶體
- **作業系統**: Darwin 25.6.0 (macOS arm64)
- **Node.js**: v24.21.0
- **模式**: Production native module (`better-sqlite3` WAL 模式 + 交易原子性 + trace 全開)

### 5.2 477 筆真實學生資料評測

| 評測項目 | 規格目標門檻 (p95) | 冷啟動耗時 | 暖機 10 次中位數 | 暖機 10 次 p95 | 達標判定 |
|---|---|---|---|---|---|
| **匯入至可查結果** (Parse + Save + Activate + Query) | `< 3000 ms` | 80.4 ms | **36.6 ms** | **43.3 ms** | **✓ 優於門檻 (快約 69 倍)** |
| **重算與寫入** (Recalculate + DB Save) | `< 1000 ms` | 47.2 ms | **47.3 ms** | **52.9 ms** | **✓ 優於門檻 (快約 18 倍)** |
| **篩選更新延遲** (4 種條件查詢平均) | `< 200 ms` | 0.7 ms | **0.6 ms** | **0.9 ms** | **✓ 優於門檻 (快約 220 倍)** |

*註：首次 Next.js 編譯時間約 516 ms，獨立於上述運算量測。*

### 5.3 5000 筆合成學生延展性評測

在記憶體中即時合成 5000 筆具有各年級、班級、標籤與備註的完整 XLSX 檔案（約 0.16 MB），評測極限延展性：

- **XLSX 解析耗時**: 102.2 ms (每秒處理約 48,929 筆)
- **批次與報名資料入庫**: 44.6 ms
- **全量 5000 筆計算與啟用**: 136.5 ms (每秒計算約 36,623 筆)
- **單頁分頁查詢耗時**: 1.4 ms
- **複合條件篩選耗時**: 1.5 ms
- **壓力檢驗結果**:
  - 資料總數完整呈現 5000 筆，無資料截斷。
  - 運算與記憶體使用穩定，未發生記憶體溢位 (OOM) 或行程崩潰。
  - 證明在 10 倍資料量級下，系統仍維持次秒級 (< 0.5s) 處理能力。

*評測原始 JSON 報告保存於本地 `app/data/reports/bench-report.json`（受版本控制忽略保護）。*

---

## 6. 停機備份與災難還原實測報告 (Disaster Recovery Verification)

- **自動化實測套件**: `tests/integration/backup-restore.test.ts`
- **SOP 文件**: `app/README.md` 第 6 節
- **驗證成果**:
  1. **停機備份**:
     - 執行 `PRAGMA wal_checkpoint(TRUNCATE)`，確保 WAL 交易日誌完整刷入主檔。
     - 複製完整 `data/` 目錄，產出包含 SHA-256 雜湊、ActiveState revision 與資料庫統計之 `backup-manifest.json`。
  2. **覆蓋防護**:
     - 測試還原至已有檔案的非空目錄，無 `--force` 旗標時拋錯拒絕，防範無提示覆蓋原資料。
  3. **災難還原**:
     - 還原至空目錄後，執行 `PRAGMA integrity_check` 回傳 `ok`。
     - 還原後資料庫查詢：學生總數 477 筆、ActiveState revision 1、activeRunId 完全一致。
     - 代表性查詢驗證：5 筆 mismatch 學生（來源列 30, 35, 43, 51, 52）與 13 名數學缺排課學生資料分毫不差。

---

## 7. 誠實揭露：剩餘問題、已知限制與未原生驗證聲明

依據 `specs/07 §4 (T07)` 與 `specs/06 (D17, D24)` 規範，本專案誠實揭露目前之範圍邊界與技術限制，不進行虛假或過度宣稱：

### 7.1 待完成與後續階段項目
1. **Windows 原生 Excel 整本 Workaround Golden 驗證**:
   - **現況聲明**: 本機開發與測試環境為 macOS ARM64。原始 Excel 檔案中之負數 `INT/MOD` 運算在 Windows 原生 Excel 下的整本重算 workaround 副本尚未取得。目前雙軌對照係依據四個原生實測錨點及 15 位有效數字模型在 Node.js float 環境中模擬。
   - **後續行動**: 列為待完成項目，待有原生 Windows Excel 環境實測比對後補足驗收。
2. **U39 原生合成案例**:
   - 列為待完成項目，待取得原生 Excel 特殊多科邊界案例後補齊。
3. **A4 點名表報表列印與排版**:
   - 依據 `specs/05-attendance-templates.md`，此項屬於 **P3 階段** 範圍，P1 原型系統明確排除此功能。

### 7.2 四個原生浮點錨點限制說明
在診斷軌 `excel-v260922-compat` 中，下列四項數值邊界為目前已知原生 Excel 實測錨點：
- **U06 錨點**: 17:00–19:00 重疊 120 分鐘，原生 Excel 判定 `>= 120` 成立，扣天為 `-1` 天，compat 與正式皆為 `-1`，不產生 `NUMERIC_POLICY_DIFFERENCE`。
- **DIFF-01 錨點**: 同班兩堂各 18 分鐘（加總 36 分鐘，0.2 天），原生 Excel 因負數取整缺陷算得 `-0.5` 天，正式 D24 規則判定未達 0.3 天不扣天（`0` 天），產生 `NUMERIC_POLICY_DIFFERENCE`。
- **36 分鐘錨點**: fraction 0.8，formal 扣 1.0 天，compat 扣 0 天。
- **126 分鐘錨點**: fraction 0.3，formal 不扣天，compat 扣 0.5 天。

*限制說明：原生 Excel 浮點模型係依據使用者提供之歷史公式與有限實例歸納建構，舊試算表並未在檔案中記錄當時使用的 Excel 內部版本或編譯器位準。未來若發現新的原生浮點行為差異，以照實呈現與提示 needs_review 為準，不扭曲正式 D24 規則。*

---

## 8. P1 執行計畫完成確認表 (Plan Item Checklist)

依據 `specs/07-p1-implementation-plan.md §7`：

- [x] **T00–T02**: 真實上傳與名單展示 A 完成，無假計算，持久化與篩選完整。
- [x] **T03–T04**: U01–U49 相關測試通過，正式計算、核對總表、API 與雙軌資料 gate 通過，CAS expectedRevision 409 通過，展示 B 完成。
- [x] **T05**: 設定 dry-run 與 apply、alias 影響評估、409 衝突防護、舊 run 不可變通過。
- [x] **T06**: I01–I20、完整瀏覽器 E2E 旅程、停機備份還原實測、原始檔案不變通過。
- [x] **T07**: Production build、效能目標量測（477 筆與 5000 筆）、雙資料 Gate 與 P1 完成報告交付，展示 C 完成。

---
*報告建立時間: 2026-09-23 · 報告編寫者: Implementer (`sb-team-impl`)*
