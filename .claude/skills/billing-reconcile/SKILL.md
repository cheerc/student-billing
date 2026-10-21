---
name: billing-reconcile
description: 核對米豆奶財務報表與網頁計算結果時使用 —— 產生離線 HTML 差異報告。當使用者說要「對帳」「核對帳務」「比對財務報表」「核對實質帳務」「期中／期末核對」「發單前核對」，或問「某個班／某個學生的天數或折扣對不對」「報表跟我們算的不一樣」，或提到 `billing:compare`、`billing:compare:sessions`、班級營收狀況、米豆奶報表時，都要使用本 skill，即使使用者沒有說出「對帳」兩個字。兩台工具比對的科目互斥（國小輔導 vs 兒童美語／國小數學），選錯會讓整份報告變成雜訊，因此本 skill 的第一件事是判斷該跑哪一台。
---

# 帳務比對（student-billing）

兩台 side script 把網頁系統的 active run 與米豆奶匯出的財務報表 XLSX 逐生比對，
產出離線 HTML 差異報告。它們是**產品外的輔助工具**（CLAUDE.md §9），不是產品功能。

> **本檔是 CLAUDE.md §9 的操作層副本。** §9 是權威來源；兩者不一致時以 §9 為準。
> §9 變更時（例如新增第三台工具、或某條規則被裁示修正）**必須同步更新本檔** ——
> 否則本檔會給出過時指引，而開啟本檔的人看不到 commit message 與 PR 描述。

## 最重要的一件事：先判斷跑哪一台

**兩台的比對科目互斥，跑錯的那台不會報錯，只會讓整份報告變成雜訊。**

這不是推測，是本 repo 實測出來的行為：

| 報表 | `billing:compare` | `billing:compare:sessions` |
|---|---|---|
| 9–10 月（含輔導） | `total: 195, match: 184, day: 5, discount: 3` ✓ | `total: 195, match: 0, unknownClass: 192` ✗ 全是雜訊 |
| 10–11 月（含美語） | `total: 37, match: 0, tierUnparsed: 37` ✗ 全是雜訊 | `total: 37, match: 36, nonStandard: 1` ✓ |

> **上表的具體筆數綁定特定 run**（`run_1791981611504`，名單 asOf 2026-10-14）。兩支工具
> 永遠讀 **active run** 且沒有 `--run` 參數，所以重新匯入名單後筆數就會變 —— 實測：同一份
> 9–10 月報表在 asOf 2026-10-16 的 active run 上得 `match 182 / day 7`。
>
> **要看的不是絕對數字，而是量級**：`match` 為 0 就代表跑錯工具 —— 那這個訊號在換 run 後
> 依然成立。自己的數字與上表不同是正常的，不代表工具壞了。

注意兩台**都沒有**「依班名過濾」。輔導工具會把報表裡的每一筆學費列都吃下去，遇到
沒有級距修飾的美語班就標 `tierUnparsed`；sessions 工具則把輔導班標 `UNKNOWN_CLASS`。
兩者都不會靜默略過，所以**錯誤會被完整呈現、而不是被藏起來** —— 但那意味著你要在
一份全錯的報告裡找出唯一正確的訊號。

### 判斷依據

| 使用者說的 | 跑哪台 |
|---|---|
| 安親、課輔、國小輔導、寫功課、級距、每週收費天數 | `billing:compare` |
| 數學、兒童美語、堂數、單價、按堂計價 | `billing:compare:sessions` |
| 只說「幫我對帳」，沒說科目 | **先問使用者**，或兩台都跑（皆唯讀、互不影響） |

判斷的最快依據是**報表裡開了哪些班**。拿報表檔問使用者不如自己確認 —— 開 Excel 或用
下面這段讀一次科目與班名，比問一輪更快也更準。

把它存成 `web/probe-classes.mjs` 再跑（`npx tsx -e` 不行：它用 cjs 輸出、不支援
top-level await，會直接報 `Top-level await is currently not supported`）：

```js
// web/probe-classes.mjs —— 用完刪掉，別留在專案裡
import ExcelJS from 'exceljs';
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(process.argv[2]);
const ws = wb.getWorksheet('班級營收狀況');
const byHead = new Map();
ws.eachRow((row, n) => {
  if (n === 1) return;
  if (row.getCell(7).text?.trim() !== '學費') return;
  const h = (row.getCell(4).text?.trim() || '').split(' - ')[0].trim();
  byHead.set(h, (byHead.get(h) ?? 0) + 1);
});
console.log([...byHead.entries()].map(([k, v]) => `${k} (${v})`).join('\n'));
```

```bash
cd web            # 若已在專案根；若在別處請先 cd 到專案根
npx tsx probe-classes.mjs "<報表.xlsx>"
```

實測輸出：

```
# 9-10 月報表 → 全部國小輔導
115國小輔導-三年級[團][3] (11) / 115國小輔導-寫功課[團][六年級] (3) / …

# 10-11 月報表 → 全部兒童美語
兒童美語-Dommie[團][W9] (14) / 兒童美語-Archy[團][W7] (9) / 兒童美語-Gino[團][Starter] (14)
```

班名含「國小輔導」→ 輔導；含「兒童美語」或「國小數學」→ 按堂計價。

## 跑之前必須確認

兩件事缺一就會失敗，**先確認再跑，不要先跑再猜原因**：

1. **本機伺服器已啟動**。未啟動時報錯訊息是 `fetch failed`，對第一次用的人毫無診斷價值。
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/v1/runs/current
   ```
   回 `200` 即可。不是 200 就先問使用者要不要啟動（`cd web && npm run dev`）——
   **不要自己啟動**，那是使用者的服務，可能正在使用中。
2. **已有完成的 active run**。沒有時工具會明確回報「找不到 active run」。
   ```bash
   curl -s http://127.0.0.1:3000/api/v1/runs/current | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('run') or {}; print(r.get('asOfDate'), r.get('ruleSetVersion'), r.get('status'))"
   ```

**注意 `asOfDate` 與報表的帳期會有落差** —— 名單是某一時間點的快照，報表是整段期間的開單。
這是差異的正常成因之一，不是工具出錯。落差通常會讓部分學生落入「名單已無此人」
（期中離班／換班），數量不多就屬正常。

## 執行

使用者通常只需要給你報表路徑，其餘由你補上。所有 npm 指令都在 `web/` 目錄內執行
（CLAUDE.md §4）。

```bash
cd web            # 從專案根執行（CLAUDE.md §4：所有 npm 指令在 web/ 內）

# 國小輔導（級距 ＋ 折扣）：比對每週收費天數與適用折扣
npm run billing:compare -- --xlsx "<財務報表.xlsx>" [--out "<報告.html>"] [--base http://127.0.0.1:3000]

# 兒童美語／國小數學（僅折扣）：按堂計價無級距制度，故不比對天數
npm run billing:compare:sessions -- --xlsx "<財務報表.xlsx>" [--out "<報告.html>"] [--base http://127.0.0.1:3000]
```

不給 `--out` 會輸出到 `~/Downloads/`。**必須是專案外的路徑** —— 報告含全體學生姓名與
人員代碼，屬敏感個資（CLAUDE.md §3），工具會直接拒絕寫進專案內並以 exit 1 結束。
這是刻意的，不是故障。

## 讀懂輸出

主控台會印出差異統計，鍵名來自各工具的 `defineCategories` 宣告：

```bash
# billing:compare（國小輔導）
{ total, match, day, discount, both, notInWeb, noTuition, unpairable, tierUnparsed, rateUnparsed }

# billing:compare:sessions（按堂計價）
{ total, match, discount, nonStandard, rateUnparsed, unknownClass,
  webRateNotConfigured, notInWeb, noTuition, unpairable }
```

各欄意義：

- **match** — 兩邊一致。若 `match` 為 0 而報表不是空檔，先確認沒跑錯工具。
- **day / discount / both**（僅輔導）— 天數差、折扣差、兩者皆差。
- **nonStandard**（僅按堂計價）— 報表有非「課程費 NN折」格式但帶金額算式的明細，
  多為期中補加收。**該生兩邊折價率可能完全一致**，正是光看數字看不出問題的那種，
  所以獨立列為需人工確認。工具刻意不把它併入折價率。
- **tierUnparsed / rateUnparsed** — 報表格式不在工具認得的範圍。**不要代為猜測**，
  這是需要人工確認報表的訊號，不是 bug。
- **unknownClass**（僅按堂計價）— 班級不屬美語／數學／輔導，需人工歸類。
- **notInWeb / noTuition / unpairable** — 名單已無此人、報表無學費項、姓名無法唯一配對。

**回報時要做的事**：把 HTML 路徑與各類差異筆數回報給使用者。

**回報時不要做的事**：不要代使用者判斷「哪一邊才對」。報表與名單存在時間差，
差異不預設任一來源為正確 —— 這是專案最高原則 D17。列出差異與資料可佐證的可能成因，
最終正確性由使用者判斷。

## 需要注意的兩個已知限制

**按堂計價工具不計算單價。** 報表有堂數與學費金額，但系統端沒有對應欄位（issue #118），
報告上那兩欄標為「不可驗證」。若使用者問「單價對不對」「金額怎麼算」，答案是：
系統目前沒有這個概念，這也是 #118 要解決的；不要用「金額 ÷ 堂數」反推單價再宣稱比對過。

**固定 5 天對本班折扣的影響隨規則版本不同（#112）。** 兩台工具都把 run 的
`classCategories` 快照傳入產品端 `applicableRateForClass`（issue #122 起），並一併傳入該 run 的
`ruleSetVersion`：`erp-tag-v3` 下固定 5 天的班本班折扣顯示 100%（Q7-A）；**`erp-tag-v4` 起改為
完全依 `category` 決定**，`none` 班（即使固定 5 天）標為「無法判定」。若同一份 run 的畫面與工具
讀數不同，先確認是否有人手動改過班級類別。細節見 CLAUDE.md §9.3。

## 其他

- **唯讀**：只讀報表檔與本機 API，不寫入產品資料庫、不修改任何 Run 或計算結果。
- **走 npm 入口而非 `node`**：兩檔都 import 產品領域層的 TS，而那些檔案內部使用無副檔名
  import，裸 `node` 會 `ERR_MODULE_NOT_FOUND`。`npm run` 走既有 `tsx` 才解析得動。
- 報告含真實姓名與人員代碼，**不可**貼進 Git、PR、訊息或任何公開介面。回報時只引用
  來源座標或差異筆數。