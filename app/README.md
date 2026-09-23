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
# 進入 app 目錄
cd app

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

---

## 4. 目錄架構與模組劃分

```text
app/
├── package.json / package-lock.json / .nvmrc
├── next.config.ts           # Next.js 配置 (serverExternalPackages: better-sqlite3)
├── tsconfig.json            # TypeScript Strict 設定
├── vitest.config.ts         # Vitest 測試配置
├── playwright.config.ts     # Playwright E2E 配置
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
├── tests/
│   ├── unit/                # 領域規則單元測試
│   ├── integration/         # 資料庫與 API 整合測試
│   ├── e2e/                 # Playwright 瀏覽器流程驗收
│   └── fixtures/            # 保形匿名測試資料
└── data/                    # 本地 SQLite 資料庫與來源副本 (被 .gitignore 排除)
```

---

## 5. 資料庫與 Migration 機制

- **儲存位置**: 預設路徑為 `app/data/app.sqlite`，可透過環境變數 `DATABASE_PATH` 覆蓋（測試環境使用獨立臨時 DB）。
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
   npm run restore /path/to/backups/backup-20260923 /path/to/app/data

   # 3. 若目標目錄已存在檔案，需主動帶入 --force 明確確認覆蓋
   npm run restore /path/to/backups/backup-20260923 /path/to/app/data --force

   # 4. 驗證還原完整性與代表性查詢
   npx tsx scripts/backup-restore.ts verify /path/to/app/data

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
