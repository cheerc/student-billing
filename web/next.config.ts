import type { NextConfig } from 'next';
import fs from 'fs';
import path from 'path';

/**
 * T1 驗收環境（scripts/acceptance-env.ts）只需要能起 production server，不驗證型別；
 * 在該路徑跳過型別檢查，以免整段 tsc 佔滿 T1 的 120s 預算。
 *
 * 判斷要**兩個條件同時成立**，這是刻意的：
 *
 *   1. ACCEPTANCE_ENV === '1' —— T1 明確宣告自己正在啟動 T1 workspace。
 *   2. cwd 的**上一層**存在 acceptance-session.json —— T1 workspace 專屬的結構事實。
 *
 * 為什麼需要條件 2：條件 1 走 process.env，而 process.env 會被 `{ ...process.env }`
 * 繼承。T1 的 env 物件若被同源的效能／驗收腳本繼承（例如使用者在 T1 執行期間另開
 * 終端跑量測），條件 1 會被意外開啟。條件 2 不吃環境變數 —— 外部環境無法往專案
 * 目錄的父層偽造檔案，因此它是結構事實而非環境宣告。檔名已列入 .gitignore，讓
 * 「這個檔名只可能出現在 T1 暫存目錄」有忽略規則支撐，而不是巧合。
 *
 * 條件 2 防什麼、不防什麼，別過度推論它的強度：
 *   - 防：外部環境偽造 ACCEPTANCE_ENV 這個 env 變數（繼承或手設）。
 *   - 不防：在專案目錄放置 marker 檔。.gitignore 只擋得住誤提交，擋不住
 *     fs.existsSync —— 那是兩件事。.gitignore 的作用是讓這個檔名不進版本控制，
 *     不是讓它無法被造出來。
 *   - 不比對 marker 內容（session.kind 等）：state 目錄已是 0o700 且只有 T1 寫入，
 *     內容比對的安全增量極小，卻讓條件依賴 JSON 內部欄位 —— 改名或改格式就會
 *     靜默失效。存在性比對是較不脆弱的選擇。
 *
 * 條件 2 嚴格限定 path.dirname(cwd) 而非「任意祖先層級」：T1 的 workspace 是
 * state/web、marker 在 state/，只有相鄰上一層成立；若放寬成祖先搜尋，
 * sb-acceptance-XXX 底下任何子目錄都會誤判通過。
 *
 * 兩道防線守不同方向，都不可刪：
 *   - 這裡的條件 2 防「外部偽造／結構不符仍想跳過」。
 *   - scripts/perf-isolated.ts 的 ACCEPTANCE_ENV: undefined 防「T1 的 env 物件被
 *     繼承」—— 條件 2 抓不到那條路徑，因為繼承 env 時 cwd 仍在專案目錄、條件 2 為
 *     false（閘控確實關閉）；但同一個 env 物件若在 T1 workspace 內被使用，條件 2 就
 *     成立而條件 1 的語意會被稀釋。刪掉任何一個都會讓另一個方向失去防護。
 *
 * 取捨要說清楚，別把「型別防護未被削弱」講得太滿：
 *
 * 1. ACCEPTANCE_ENV 全 repo 只出現在 scripts/acceptance-env.ts（設值）與本檔（讀取），
 *    ci.yml 不設定它 —— 所以 CI 的 `npm run build` 照常型別檢查。
 * 2. ci.yml 步驟 2 的 `npm run typecheck`（tsc --noEmit）早於步驟 5 的 build，且
 *    tsconfig 的 exclude 僅 node_modules，實測涵蓋 140 個產品原始碼檔（src/ 112、
 *    scripts/ 28）。**這部分原始碼的型別錯誤確實獨立於 build 被擋下**（實測注入
 *    TS2322 後 typecheck exit 2）。
 * 3. 但 route 型別（next-env.d.ts 與 .next/types/）**只在 build 期產生與檢查**：
 *    typecheck 執行時 build 尚未跑，這些檔不存在，tsc 會靜默略過（實測
 *    tsc --noEmit --listFiles 對這兩者命中數為 0）。所以 T1 路徑不驗證 route 型別 ——
 *    這是本設定**有意接受的取捨**，不是零成本。
 */
const isAcceptanceWorkspace =
  process.env.ACCEPTANCE_ENV === '1' &&
  fs.existsSync(path.join(path.dirname(process.cwd()), 'acceptance-session.json'));

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3', 'exceljs'],
  typescript: {
    ignoreBuildErrors: isAcceptanceWorkspace,
  },
};

export default nextConfig;
