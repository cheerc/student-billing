# 學生收費核對工具 (student-billing)

本專案為校務人員核對學生收費與 ERP 登記級距之 **localhost P1 原型工具**。

---

## 1. 系統需求與環境

- **Runtime**: Node.js 24.x LTS (本機驗證版本：v24.21.0，參考 `.nvmrc`)
- **套件管理**: npm (單一 `package-lock.json`)
- **網路安全政策**: 開發與執行伺服器一律僅綁定 `127.0.0.1:3000` (localhost)，禁止綁定 `0.0.0.0` 或開啟公網 tunnel。

---

## 2. 快速上手與啟動

```bash
# 進入 web 目錄
cd web

# 安裝依賴 (含 better-sqlite3 原生編譯)
npm install

# 執行資料庫測試與整合驗證
npm test

# 啟動開發伺服器 (綁定 127.0.0.1:3000)
npm run dev

# 執行生產建置
npm run build

# 啟動生產伺服器 (綁定 127.0.0.1:3000)
npm run start
```

---

## 3. 開發指令表 (npm scripts)

| 指令 | 說明 |
|---|---|
| `npm run dev` | 以開發模式啟動 Next.js (強制綁定 `127.0.0.1:3000`) |
| `npm run build` | 執行 Next.js 生產最佳化建置 (含 native module 外部打包相容) |
| `npm run start` | 啟動生產伺服器 (強制綁定 `127.0.0.1:3000`) |
| `npm run test` | 執行 Vitest 單元測試與整合測試 |
| `npm run typecheck` | 執行 TypeScript 型別檢查 (`tsc --noEmit`) |
| `npm run lint` | 執行 ESLint 程式碼品質檢查 |
| `npm run test:e2e:isolated` | 隔離執行 Playwright E2E（另一埠、臨時 DB、不重用 3000 服務；見下方「E2E 隔離執行」） |
| `npm run billing:compare` | 帳務比對輔助工具・國小輔導（side script；見下方 §4.2） |
| `npm run billing:compare:sessions` | 帳務比對輔助工具・按堂計價（side script；見下方 §4.3） |

---

## 4. 目錄架構與模組劃分

```text
web/
├── package.json / package-lock.json / .nvmrc
├── next.config.ts           # Next.js 配置 (serverExternalPackages: better-sqlite3)
├── tsconfig.json            # TypeScript Strict 設定
├── vitest.config.ts         # Vitest 測試配置
├── playwright.config.ts     # Playwright E2E 配置（3000 埠；**不要在有使用者服務時直接執行**）
├── playwright.isolated.config.ts  # 隔離 E2E 配置（另一埠、臨時 DB、不重用 server）
├── src/
│   ├── app/                 # Next.js App Router 頁面與 API Route Handlers
│   ├── components/          # 視覺元件 (表格、篩選、明細側欄)
│   ├── domain/              # 純業務邏輯 (students, billing, schedules)
│   ├── application/         # 應用服務 (import, calculate, query, settings)
│   ├── contracts/           # API Schemas 與 Zod 契約
│   ├── adapters/
│   │   ├── sqlite/          # SQLite 資料庫連線、Transaction 與 Migration 機制
│   │   ├── xlsx/            # ERP XLSX 解析與排課 Seed 讀取
│   │   └── files/           # 本地檔案儲存與安全檢查
├── scripts/                 # 開發、驗收與帳務比對工具（皆不屬產品程式碼）
│   ├── shared/              # 兩台帳務比對工具的共用層（報表解析、分類註冊、API 讀取、報告外殼、路徑守衛）
│   ├── compare-billing-report.mjs        # billing:compare（國小輔導：級距＋折扣）
│   └── compare-session-pricing-report.mjs # billing:compare:sessions（按堂計價：僅折扣）
├── tests/
│   ├── unit/                # 領域規則單元測試
│   ├── integration/         # 資料庫與 API 整合測試
│   ├── e2e/                 # Playwright 瀏覽器流程驗收
│   └── fixtures/            # 保形匿名測試資料
```
*(資料庫位於專案根目錄 `/data/`，被 `.gitignore` 排除)*

---

## 4.1 E2E 隔離執行

現行 `playwright.config.ts` 以 `npm run dev`（寫死 3000 埠）搭配 `reuseExistingServer: !CI`：本機若已開著使用者的 3000 服務，E2E 會直接重用它並連到真實資料庫。**E2E 一律用隔離執行器**（在 `web/` 目錄）：

```bash
npm run test:e2e:isolated                         # 每個 spec 檔各用全新 server＋全新臨時 DB（預設；結果與檔案順序無關）
npm run test:e2e:isolated -- --shared             # 全部 spec 共用同一個 server＋DB，依檔名順序
npm run test:e2e:isolated -- --repeat 2          # 連跑 2 輪；每輪新 server＋全新 DB（穩定性檢查：兩輪都從乾淨狀態通過）
npm run test:e2e:isolated -- --shared --repeat 2 --keep-db  # 診斷 opt-in：2 輪沿用同一個臨時 DB（重現 DB 狀態跨輪殘留）
npm run test:e2e:isolated -- --repeat 2 --keep-db tests/e2e/a11y.spec.ts  # 單一 spec 的跨輪殘留：不加 --shared，每個 spec 檔各有自己的 DB 並跨輪沿用
npm run test:e2e:isolated -- tests/e2e/imports.spec.ts   # 只跑指定 spec
```

- `--repeat N` 預設每輪開始前刪除 `app.sqlite` 與 `-wal`／`-shm`（server 首次開啟時重建並 migrate）；帶 `--seed-v2-active` 時每輪再從同一份 seed 複製。要刻意重現跨輪殘留（issue #25 的診斷用途）才加 `--keep-db`（`--shared` 是把**全部** spec 併成一組共用同一個 server＋DB；只想重現某個 spec 自己的跨輪殘留時不要加 `--shared`，直接指定該 spec 檔，如上面最後一行）：它只在 `--repeat N`（N≥2）時有意義，且與 `--seed-v2-active` 互斥（兩者都會被執行器明確拒絕，不靜默忽略）。
- 埠預設 3100（`--port` 可改，**不可為 3000**）；只綁 `127.0.0.1`；`reuseExistingServer:false`（埠被占用即失敗）。
- `DATABASE_PATH` 指向系統臨時目錄下的獨立 sqlite，結束即刪；守衛（`scripts/e2e-isolation.ts`）會拒絕 3000 埠、預設資料庫與專案 `data/` 目錄。
- 只使用 `tests/fixtures/` 的合成／匿名資料；E2E spec 不得引用資料庫檔或 `data/`（`tests/unit/e2e-specs-no-real-db.test.ts` 守衛）。
- 與 `next dev` 共用 `.next/` 目錄：若你在同一個工作樹已開著 `npm run dev`，隔離 server 會因 Next 的目錄鎖而失敗（安全失敗，不會重用你的服務）。

---

## 4.2 帳務比對輔助工具（side script，產品外，手動核對用）

`scripts/compare-billing-report.mjs` 把**米豆奶匯出的 active run** 與**米豆奶財務報表 XLSX** 逐生比對國小輔導的每週收費天數與適用折扣，產出離線 HTML 差異報告。

```bash
npm run billing:compare -- --xlsx "<財務報表.xlsx>" [--out "<報告.html>"] [--base http://127.0.0.1:3000]
```

- 需先啟動本機伺服器且已有完成的 active run；報表工作表名固定為 `班級營收狀況`。
- 走 npm 入口而非 `node`：本檔直接複用產品領域層的級距解析（`parseSingleClassToken`），需 `tsx` 才能載入 TS。
- 預設輸出 `~/Downloads/`，工具會拒絕輸出至專案內。**唯讀**：不寫入產品資料庫、不修改 Run 或計算結果。
- 屬 side script，非專案交付的一部分；範圍邊界見根目錄 `CLAUDE.md` §9。

---

## 4.3 按堂計價帳務比對輔助工具（side script，產品外，手動核對用）

`scripts/compare-session-pricing-report.mjs` 是 §4.2 的姊妹工具，比對**兒童美語**與**國小數學**。與 §4.2 的關鍵差異：按堂計價採**堂數 × 單價**、**沒有收費級距制度**，故本工具**僅比對適用折扣**，不設任何天數相關分類。

```bash
npm run billing:compare:sessions -- --xlsx "<財務報表.xlsx>" [--out "<報告.html>"] [--base http://127.0.0.1:3000]
```

- 前置條件、報表工作表名、輸出路徑守衛、唯讀性與 npm 入口的理由，皆同 §4.2。
- **一名學生可能產生多筆紀錄**：報表的學費明細是一列一筆，同時修美語與數學者會有兩列，各自成筆並路由到自己的系統適用率欄位（`applicableEnglishBps`／`applicableMathBps`）。
- **堂數與學費金額僅為顯示值**：系統端尚無對應欄位（issue #118），工具不做換算、不驗證，報告上標為「不可驗證」。若以「金額 ÷ 堂數」推出單價再比對，等於替系統斷言它並未持有的事實。
- **報表金額欄依同名表頭定位**：欄 9 起為每班一欄（各班單價不同），必須依表頭與班名配對；不可取「第一個數字欄」。雜費、商品、車資等落在「非學費費用」欄，報告中只列為其他科目，不參與折扣比對。
- **非標準折扣需人工確認**：期中補加收之類不含「課程費 NN折」字樣、但帶金額算式的明細（例如 `本校_扣3/9-4/29 學費 15*40=600`），兩邊折價率可能完全一致卻仍需人工核對，故獨立列為分類且**不**併入折價率。
- 兩台工具的完整差異對照表、v3 `classCategories` 快照繞過的已知限制，見根目錄 `CLAUDE.md` §9.2／§9.3。

---

## 5. 資料庫與 Migration 機制

- **儲存位置**: 預設路徑為專案根目錄 `data/app.sqlite`，可透過環境變數 `DATABASE_PATH` 覆蓋（測試環境使用獨立臨時 DB）。
- **Migration 策略**:
  - Migration 檔案置於 `src/adapters/sqlite/migrations/`，採編號命名（例如 `0001_init.sql`）。
  - 使用 `schema_migrations` 資料表記錄已套用之版本編號與時間。
  - 伺服器或測試啟動時僅執行未套用的 Migration；每個檔案皆在獨立資料庫 Transaction 內執行。
  - **失敗防護**: 若 Migration 發生錯誤立即 Rollback 並中止，**絕不自動刪除 DB 重建**。

---

## 6. 停機備份與災難還原指南 (Backup & Disaster Recovery SOP)

依據 `specs/07-p1-implementation-plan.md §6` 與 `specs/04-tdd-acceptance.md I12` 規範，系統提供標準化的停機備份與災難還原機制：

### 核心安全契約 (Hard Invariants)
- **禁止在連線中只複製主檔**: SQLite 於 WAL 模式下，交易記錄暫存於 `app.sqlite-wal`。備份時必須複製完整 `data/` 目錄（包含 `app.sqlite`, `app.sqlite-wal`, `app.sqlite-shm` 與來源檔案），或先執行停機 WAL Checkpoint。切勿僅複製 `app.sqlite` 主檔而遺失最新交易！
- **禁止無提示覆蓋現有資料**: 還原程序嚴格禁止在未經操作者明確確認的情形下，直接覆蓋已有資料檔案的目錄。目標目錄非空時必須使用 `--force` 旗標確認，防範災難性資料丟失。

### 操作指令表

| 操作 | 指令 | 說明 |
|---|---|---|
| **自動停機備份** | `npm run backup [備份目標路徑]` | 執行 WAL checkpoint、複製完整 data 目錄、產出包含 SHA-256 雜湊與 activeState 的 `backup-manifest.json` |
| **災難還原** | `npm run restore <備份來源路徑> [還原目標路徑] [--force]` | 還原檔案至指定空目錄，並自動連線執行 `PRAGMA integrity_check` 與指標驗證 |
| **完整性驗證** | `npx tsx scripts/backup-restore.ts verify [資料目錄]` | 連線檢驗 SQLite 檔案完整性、學生筆數、計算筆數與 ActiveState revision |

### 手動停機備份與還原標準作業程序 (SOP)

1. **停機備份步驟**:
   ```bash
   # 1. 停止運行中的開發或生產伺服器 (Ctrl+C 或停止行程)，確保所有連線關閉
   # 2. 執行自動化備份腳本 (或指定目標目錄)
   npm run backup /path/to/backups/backup-$(date +%Y%m%d%H%M%S)

   # 3. 檢查備份目錄下已產出 backup-manifest.json 與完整資料檔案
   ls -la /path/to/backups/backup-*/
   ```

2. **災難還原步驟**:
   ```bash
   # 1. 確保目標伺服器處於停機狀態
   # 2. 執行還原至乾淨的空 data 目錄
   npm run restore /path/to/backups/backup-20260923 /path/to/data

   # 3. 若目標目錄已存在檔案，需主動帶入 --force 明確確認覆蓋
   npm run restore /path/to/backups/backup-20260923 /path/to/data --force

   # 4. 驗證還原完整性與代表性查詢
   npx tsx scripts/backup-restore.ts verify /path/to/data

   # 5. 重新啟動伺服器
   npm run start
   ```

3. **自動化驗證測試**:
   本專案包含整合測試 `tests/integration/backup-restore.test.ts`，每次 CI 與本機測試均會自動模擬「建立真實資料 → 完整停機備份 → 還原至空目錄 → 5 筆 mismatch 與 13 人排課缺漏比對」之端到端檢驗。

---

## 7. 負向範圍與安全性邊界 (P1 Hard Boundaries)

- **個資保護**: 真實學生名單、身分證字號、聯絡電話嚴禁提交至 Git 或 CI。
- **無雲端相依**: 不部署至 Vercel、不使用 Firestore、不連線外網。
- **無自動開單與對帳**: 本工具僅提供人數、天數、折扣與 ERP 級距比對，不直接與 ERP 連線自動改動資料。
