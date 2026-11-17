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

這不是推測，是本 repo 實測出來的行為（2026-10 以一份全輔導、一份全美語報表各跑兩台；
下表只記量級，不記筆數 —— 筆數隨報表與 active run 而變，拿來直接比對沒有意義）：

| 報表內容 | `billing:compare` | `billing:compare:sessions` |
|---|---|---|
| 全部國小輔導 | ✓ `match` 佔絕大多數，其餘為少數 `day`／`discount` | ✗ `match` 為 0，幾乎全部 `unknownClass` |
| 全部兒童美語／國小數學 | ✗ `match` 為 0，全部 `tierUnparsed` | ✓ `match` 佔絕大多數，其餘為少數 `nonStandard` 等 |

兩支工具永遠讀 **active run** 且沒有 `--run` 參數，重新匯入名單後筆數就會變。
**要看的是量級**：`match` 為 0 就代表跑錯工具 —— 這個訊號在換報表、換 run 後依然成立。

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
下面這段讀一次，比問一輪更快也更準。它同時印出後面驗算要用的**學費列數**與**帳單日期範圍**。

腳本必須放在 `web/` 內才解析得到 `exceljs`，且必須是檔案（`npx tsx -e` 不行：它用 cjs 輸出、
不支援 top-level await，會報 `Top-level await is currently not supported`）。整段在一個
subshell 內建立、執行、刪除，`trap` 保證**無論成功或失敗都會刪掉**，不會殘留在專案裡：

```bash
cd web            # 從專案根執行
( trap 'rm -f probe-classes.mjs' EXIT
cat > probe-classes.mjs <<'EOF'
import ExcelJS from 'exceljs';
const [xlsx, asOf] = process.argv.slice(2);   // asOf 可省略，格式 YYYY-MM-DD
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(xlsx);
const ws = wb.getWorksheet('班級營收狀況') || wb.worksheets[0];
const toIso = (cell) => {
  if (cell.value instanceof Date) return cell.value.toISOString().slice(0, 10);
  const m = (cell.text || '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
const byHead = new Map(); const dates = []; let rows = 0; let badDate = 0;
ws.eachRow((row, n) => {
  if (n === 1 || !row.getCell(1).text?.trim()) return;      // 表頭與無姓名列，與工具同規則
  if (row.getCell(7).text?.trim() !== '學費') return;
  rows += 1;
  const h = (row.getCell(4).text?.trim() || '').split(' - ')[0].trim();
  byHead.set(h, (byHead.get(h) ?? 0) + 1);
  const d = toIso(row.getCell(3)); if (d) dates.push(d); else badDate += 1;
});
dates.sort();
console.log([...byHead.entries()].map(([k, v]) => `${k} (${v})`).join('\n'));
console.log(`學費列 ${rows} 筆；帳單日期 ${dates[0] ?? '—'} ~ ${dates.at(-1) ?? '—'}（無法解析 ${badDate}）`);
if (asOf) console.log(`帳單日期晚於 asOf ${asOf}：${dates.filter((d) => d > asOf).length} / ${rows}`);
EOF
npx tsx probe-classes.mjs "<報表.xlsx>" "<asOfDate>" )
git status --short probe-classes.mjs   # 應無輸出
```

輸出格式（班名為示意）：

```
115國小輔導-三年級[團][3] (n) / 兒童美語-某班[團][W9] (n) / …
學費列 N 筆；帳單日期 YYYY-MM-DD ~ YYYY-MM-DD（無法解析 0）
帳單日期晚於 asOf YYYY-MM-DD：k / N
```

班名含「國小輔導」→ 輔導；含「兒童美語」或「國小數學」→ 按堂計價。

### 加強班（按堂計價工具自動處理）

ERP 撈資料只篩「數學」時常會連加強班一起帶出來。班名含「加強班」的列**不進比對**，改列在 HTML
「加強班折扣」區塊：每位學生一列，有折扣者在前，無折扣者在後；並列該生的國小數學折扣、加強班的
其他折扣與扣款明細；名單在席但報表無該班學費列者標「在席未開單」。系統端沒有加強班的參考依據，
**工具不判定對錯**，由人工對照專案報名的手動折扣。附加費用依明細班名前綴歸屬，不會再把加強班的扣款
併進國小數學的學雜費常模。

### 混合科目報表（兩種班都有）

兩台工具都**沒有**班別篩選參數（只有 `--xlsx`、`--out`、`--base`、`--help`），報表裡另一科目的列
不會被略過，而是進入差異：輔導工具標 `tierUnparsed`；按堂計價工具標 `unknownClass`，而且它的
在席反查以「報表上有開單的班」為準，會對另一科目的班也推出 `rosterNotBilled`。這些都會灌進
差異筆數與需人工判讀。工具端篩選另案裁決（#239 範圍外），目前擇一處理：

1. **拆分報表（建議）**：在 Excel 把報表另存兩份，各只保留一科的列（保留第 1 列表頭與工作表名
   `班級營收狀況`；同一學生的折扣、雜費列跟著該生的學費列走），再各跑對應的工具。
   拆出的檔案含個資，同樣放專案外。
2. **整份跑兩台、只讀對應科目**：每份報告只看該工具科目的班；另一科目班的 `tierUnparsed`／
   `unknownClass`／`rosterNotBilled` 視為雜訊，不計入回報。此時統計卡的差異筆數、需人工判讀與
   主控台 `total` 都含雜訊，**不可直接引用**，回報時要自行扣除並說明扣了什麼。

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

**比對報表班級與系統課程類型**（跑之前做）。報表裡的班若在系統是 `unset`／`none`，整班學生都會
落成 `webRateNotConfigured`，這是課表設定問題，不是學生個別差異。用探測腳本印出的班名（去掉開頭
年度數字與 `[…]` 修飾）對照：

```bash
curl -s http://127.0.0.1:3000/api/v1/classes | python3 -c "import sys,json; [print(i['baseName'], i['category'], i['mappingStatus']) for i in json.load(sys.stdin)['items'] if i['category'] in ('unset','none')]"
```

出現在報表裡的班又列在這份輸出中，就在回報開頭先說明，並提醒使用者先到課表處理再重跑。

**比對報表帳單日期範圍與 `asOfDate`**（跑之前做，結果寫進回報）。名單是 `asOfDate` 當下的
快照，報表是一段期間的開單；兩者落差是差異的正常成因之一，不是工具出錯。落差**不一定**表現為
「名單已無此人」—— 實測（2026-11 一份按堂計價報表，多數學費列的帳單日期晚於 `asOfDate`）
`notInWeb` 為 0，落差表現在 `rosterNotBilled` 與 `discount`。三者都可能出現，不預設哪一種。

1. 用上面的探測腳本帶入 `asOfDate`，取得帳單日期範圍與「晚於 asOf」的學費列數。
   HTML 報告的中繼資訊也並列「網頁系統名單」（asOfDate）與「核定發單日」（各生帳單日期的中位數）。
2. **`asOfDate` 落在帳單日期範圍之外，或過半學費列的帳單日期晚於 `asOfDate`** → 在回報開頭
   警示時間落差（列出兩個日期與比例），說明在席未開單、折扣差異、名單已無此人可能因此產生，
   並建議使用者考慮重新匯入較接近帳單日期的名單後再跑。**仍照樣產出報告，不代為判斷哪邊正確**（D17）。

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
{ total, match, day, rosterNotBilled, discount, both, notInWeb, noTuition, unpairable, tierUnparsed, rateUnparsed, webRateNotConfigured }

# billing:compare:sessions（按堂計價）
{ total, match, discount, nonStandard, sessionAnomaly, rosterNotBilled, rateUnparsed, unknownClass,
  webRateNotConfigured, notInWeb, noTuition, unpairable }
```

### 計數口徑：先驗算再回報

主控台的 `total` 是**紀錄數**（各分類加總），不是報表列數：

- **按堂計價**：紀錄數＝學費列紀錄＋`rosterNotBilled`＋`noTuition`。HTML 的「報科學費筆數」卡
  只計學費列，應**等於**探測腳本印出的學費列數 —— 不等就先停下來回報，不要繼續解讀。
  分頁「全部」、「差異筆數」與「折扣一致」百分比的分母都是紀錄數（含 `rosterNotBilled`），
  所以「全部」會比「報科學費筆數」多出 `rosterNotBilled`＋`noTuition`。
- **加強班**（按堂計價工具）：班名含「加強班」的學費列已自動分流到 HTML「加強班折扣」區塊，不在 `total`、不在差異筆數。所以探測腳本的學費列數 ＝ 「報科學費筆數」卡 ＋ 加強班學費列數；主控台會另印加強班學生數與有折扣人數。
- **國小輔導**：一生一筆；`total` 與「報表學生總數」卡都含 `rosterNotBilled`（名單反查推入，
  報表上沒有此人）。報表學生數＝`total` − `rosterNotBilled`。

回報時寫清楚引用的是哪一個數字（學費列數或紀錄數）。

### 各欄意義

- **match** — 兩邊一致。若 `match` 為 0 而報表不是空檔，先確認沒跑錯工具。
- **day / both**（僅輔導）— 天數差、天數與折扣皆差。
- **discount** — 折扣差（兩邊折價率不同）。按堂計價工具中，折價率不同時歸此類**優先於**非標準折扣；
  若該列另有非標準明細，仍會留在需人工判讀（統計卡副標「非標準（分類在他處）」）。
- **rosterNotBilled**（兩台皆有）— 在席未開單需確認。學生在名單中為在席狀態（未標記離班），且所屬班級已於本次報表開單，但報表中無該生之學費列。提示操作員人工確認是否漏開單。
- **sessionAnomaly**（僅按堂計價）— 堂數或單價異常需確認：**原本兩邊一致、但帶有偏離**的學費列。偏離有四種：
  - 只對按堂計價班（類別快照為美語、數學）檢查：同班**堂數偏離**常規眾數（例如全班多數 16 堂、少數 8 堂；標籤「堂數偏離」）、學費除以堂數**無法整除**、可整除但**同班每堂單價不一致**（以折扣前學費列計；標籤「單價不一致」）。安親課輔等月費班不檢查；類別無法判定者不檢查並在說明寫「未執行」。
  - 報表上所有有學費列的班都檢查：**學雜費偏離同班常模**（同班半數以上學生收同一非零金額即為常模；標籤「<科目>偏離常模」）。車資項不計入常模。
  - 已是其他分類（例如 `discount`、`nonStandard`）的列有偏離時**不改分類**，只帶偏離旗標；它仍計入需人工判讀（統計卡副標「偏離（分類在他處）」）與 HTML「堂數或單價異常」群組，但**不計入** `sessionAnomaly` 的數字。
- **nonStandard**（僅按堂計價）— 報表有非「課程費 NN折」格式但帶金額算式的明細，
  多為期中補加收，且兩邊折價率一致（或報表折價率無法判定）。**正因為數字一致才看不出問題**，
  所以獨立列為需人工確認。工具刻意不把它併入折價率。
- **tierUnparsed / rateUnparsed** — 報表格式不在工具認得的範圍。**不要代為猜測**，
  這是需要人工確認報表的訊號，不是 bug。
- **unknownClass**（僅按堂計價）— 班級不屬美語／數學（含輔導班），需人工歸類。
- **webRateNotConfigured** — 系統端無適用折扣值。成因有兩種，說明文字會分開寫，先看是哪一種：
  快照列不存在（名單沒有該班）；或快照列存在但類別是 `unset`（課表沒指定課程類型，或名冊班名沒對應到
  課表班）／`none`（課表設成「其他班」，`erp-tag-v4` 下一律無法判定）。後者要去課表改課程類型，
  不是漏班。這類列常整班一起出現，先查 `/api/v1/classes` 該班的 `category`／`mappingStatus`。
- **notInWeb / noTuition / unpairable** — 名單已無此人、報表無學費項、姓名無法唯一配對。

**車資明細**（僅按堂計價 HTML 報告）：主表下方獨立一區，列出科目或明細含「車資」的項目
（學生、班級、名目原文、金額，表尾筆數與合計）。這是**資訊列**：不計入差異筆數、不計入需人工
判讀、不判定對錯；車資也不計入學雜費常模。使用者問車資時從這裡讀。

### 待查項要看哪裡

**「需人工判讀」不等於全部待查。** 兩種待查項要分開看：

1. **需人工判讀集合** —— 統計卡「需人工判讀」、HTML 分頁「需人工判讀」、本機 TUI 待查清單三者
   是同一集合、數字相同。按堂計價工具的集合包含：需人工分類（`sessionAnomaly`、`nonStandard`、
   `rosterNotBilled`、`unknownClass`、`notInWeb` …）、帶偏離旗標的列、以及帶非標準明細的折扣差異列。
   國小輔導工具沒有旗標，集合就是需人工分類。
2. **純折扣差異**（以及輔導的 `day`／`both`）—— 兩邊數字不同的硬性差異，**不在**上面的集合，
   **不會**出現在 TUI，只在 HTML 對應分頁。

**完整待查範圍＝HTML「僅差異」分頁＝「差異筆數」**（紀錄數 − `match`），它同時涵蓋 1 和 2。
回報時以「差異筆數」為總量，再拆成「需人工判讀 n 筆」與「其餘硬性差異 m 筆」。

### 本機 TUI 待查清單與個資安全邊界

執行完畢後，終端機會在差異統計下方直接格式化輸出「需人工確認明細（本機 TUI 檢視）」，
內容是上一節的**需人工判讀集合**（不含純折扣差異）。帶旗標而分類在他處的列以原分類標示
（例如 `[折扣差異]`），成因寫在說明裡：
```text
需人工確認明細（本機 TUI 檢視）：
  - [在席未開單需確認] 測試生甲 (S001) - 兒童美語-Dommie: 名單在席但報表無學費列
  - [堂數或單價異常需確認] 測試生乙 (S002) - 兒童美語-Archy: 學費 $7,350 除以 16 堂無法整除（459.38 元）
```

- **本機檢視**：終端機輸出真實姓名與代碼是為了現場操作員肉眼快速核對，屬於本機臨時 stdout。
- **公開邊界（個資零容忍）**：Git commit message、PR 說明、CI 輸出與儲存於 repo 內之任何測試檔案**絕對禁止**出現任何真實姓名、身分證或電話等個資。回報時僅能以來源座標（如「列 205」）或匿名代碼指涉。

**回報時要做的事**：把 HTML 路徑、計數驗算結果（學費列數是否對得上）、時間落差警示（若有）、
差異筆數與其拆分（需人工判讀／其餘硬性差異）回報給使用者；混合報表要說明扣除了哪些雜訊。

**回報時不要做的事**：不要代使用者判斷「哪一邊才對」。報表與名單存在時間差，
差異不預設任一來源為正確 —— 這是專案最高原則 D17。列出差異與資料可佐證的可能成因，
最終正確性由使用者判斷。

## 需要注意的已知限制

**按堂計價工具的「金額 ÷ 堂數」是暫行例外，不是單價比對。** 報表有堂數與學費金額，但系統端沒有每堂單價欄位（issue #118），
報告上那兩欄仍標為「不可驗證」。依 2026-11-15 擁有者裁決（issue #238），工具**暫時**只做兩件事，用途僅是列出需人工檢查的項目：
學費除不盡堂數 → 需人工確認；可除盡者，同一班級的每堂單價應相同，不同 → 需人工確認。
這兩項只適用按堂計價班（兒童美語、國小數學），安親／課輔是月費，不做；類別取自 Run 快照，無法判定時不執行並於說明註明「未執行」。
若使用者問「單價對不對」「金額怎麼算」：不要拿「金額 ÷ 堂數」去宣稱系統單價比對過，也不要判定報表或系統哪一邊才對（D17）；
系統目前沒有每堂單價的概念，這也是 #118 要解決的。**#118 新增每堂單價欄位後，此暫行例外須重新評估。**

**D60 單一現行規則與單一現況留存。** 系統全面採 `erp-tag-v4`（D60 Migration 0012/0013），
資料庫僅留存單一 active run、單一現況名單與單一課表版本。固定 5 天在 `erp-tag-v4` 下
不影響折扣，折扣完全由 `category` 決定（02 §9A.3）。兩台工具一律以 active run 快照傳入產品讀模型。

## 其他

- **唯讀**：只讀報表檔與本機 API，不寫入產品資料庫、不修改任何 Run 或計算結果。
- **走 npm 入口而非 `node`**：兩檔都 import 產品領域層的 TS，而那些檔案內部使用無副檔名
  import，裸 `node` 會 `ERR_MODULE_NOT_FOUND`。`npm run` 走既有 `tsx` 才解析得動。
- 報告含真實姓名與人員代碼，**不可**貼進 Git、PR、訊息或任何公開介面。回報時只引用
  來源座標或差異筆數。