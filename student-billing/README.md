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
# 進入 student-billing 目錄
cd student-billing

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
student-billing/
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

- **儲存位置**: 預設路徑為 `student-billing/data/app.sqlite`，可透過環境變數 `DATABASE_PATH` 覆蓋（測試環境使用獨立臨時 DB）。
- **Migration 策略**:
  - Migration 檔案置於 `src/adapters/sqlite/migrations/`，採編號命名（例如 `0001_init.sql`）。
  - 使用 `schema_migrations` 資料表記錄已套用之版本編號與時間。
  - 伺服器或測試啟動時僅執行未套用的 Migration；每個檔案皆在獨立資料庫 Transaction 內執行。
  - **失敗防護**: 若 Migration 發生錯誤立即 Rollback 並中止，**絕不自動刪除 DB 重建**。

---

## 6. 本機備份與還原指南

由於本機資料庫包含匯入之名單快照與設定，備份必須完整包含資料目錄：

1. **停機備份**:
   確保應用程式未在寫入狀態（關閉伺服器或離峰時），複製整個 `student-billing/data/` 目錄：
   ```bash
   cp -R student-billing/data/ /path/to/backup/data-$(date +%Y%m%d)/
   ```
2. **災難還原**:
   將備份的 `data/` 目錄複製回 `student-billing/data/`，重新啟動伺服器即可恢復全部狀態。

---

## 7. 負向範圍與安全性邊界 (P1 Hard Boundaries)

- **個資保護**: 真實學生名單、身分證字號、聯絡電話嚴禁提交至 Git 或 CI。
- **無雲端相依**: 不部署至 Vercel、不使用 Firestore、不連線外網。
- **無自動開單與對帳**: 本工具僅提供人數、天數、折扣與 ERP 級距比對，不直接與 ERP 連線自動改動資料。
