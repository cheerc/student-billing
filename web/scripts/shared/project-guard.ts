/**
 * 共用層：報告輸出的路徑守衛。
 *
 * 報告含全體學生姓名與人員代碼，屬 CLAUDE.md §3 的敏感個資，不得輸出至專案內。
 *
 * ## 為何 `projectRoot` 由呼叫端傳入，而非本模組自行推導
 *
 * 原本的寫法是 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')`，
 * 這在 `web/scripts/*.mjs` 那一層**恰好**等於專案根。但本檔在 `web/scripts/shared/`
 * （深一層），同樣的相對路徑會算成 `web/`——**保護範圍被靜默縮小，不會報錯**：
 * 輸出到 `web/report.html` 仍會被擋下，但輸出到 `docs/`、`specs/` 等
 * repo 根下的其他目錄就會靜默放行。
 *
 * 深度一變就靜默弱化的守衛，比沒有守衛更危險：它看起來在運作。因此：
 * 1. 由**入口**（`web/scripts/*.mjs`，深度正確的地方）算出路徑後傳入；
 * 2. 本模組用哨兵驗證傳入值真的是專案根，不是就**啟動時立刻大聲失敗**。
 */
import fs from 'fs';
import path from 'path';

/**
 * 專案根的哨兵檔。
 *
 * `CLAUDE.md` 與本專案的目錄結構（§4：specs/ 在根、web/ 為應用程式目錄）
 * 足夠定義「這是本專案的根」；`web/package.json` 則確保我們站在 repo 根
 * 而不是 `web/` 內部——`CLAUDE.md` 單獨存在於巢狀 agent 環境時會誤判。
 *
 * 刻意**不**要求根目錄有 `package.json`：本專案的 npm 指令一律在 `web/`
 * 執行（CLAUDE.md §4），根目錄本來就沒有 package.json。要求一個不存在的
 * 檔案會讓守衛在任何一次正確呼叫時都拋錯——那是誤報，不是保護。
 */
const SENTINELS = [
  { path: 'CLAUDE.md', why: '專案根的開發指南（CLAUDE.md §4 規定 specs/ 與 web/ 同在根目錄）' },
  { path: path.join('web', 'package.json'), why: 'web/ 為應用程式目錄；此檔可區分專案根與 web/ 內部' },
] as const;

/**
 * 驗證 `startDir` 確實是專案根；不是就拋錯。
 *
 * 設計意圖：把「深度算錯」從**靜默弱化**變成**啟動即失敗**。守衛的價值全在
 * 于此——一個不會報錯的守衛比沒有守衛更危險。
 */
export function assertProjectRoot(startDir: string): string {
  const resolved = path.resolve(startDir);

  for (const sentinel of SENTINELS) {
    if (!fs.existsSync(path.join(resolved, sentinel.path))) {
      throw new Error(
        [
          `專案根驗證失敗：${resolved}`,
          `找不到哨兵 ${sentinel.path}（${sentinel.why}）。`,
          '',
          '這代表呼叫端算錯了相對深度。請確認由 web/scripts/*.mjs 呼叫，',
          '以 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")` 傳入——',
          '若在 scripts/shared/ 內寫死 ".." 會得到 web/ 而非專案根，守衛將被靜默弱化。',
        ].join('\n'),
      );
    }
  }

  return resolved;
}

/**
 * 斷言 `outputPath` 不在專案內；是就拋錯。
 *
 * 報告含姓名與人員代碼，寫進 repo 即構成 §3 的個資外洩。
 */
export function assertOutputOutsideProject(projectRoot: string, outputPath: string): string {
  const resolved = path.resolve(outputPath);

  // 用 path.sep 結尾比對，避免 /repo-other 這種同名前綴被誤判為在專案內；
  // path.resolve 先正規化，避免 "../" 穿越繞過檢查。
  const insideProject =
    resolved === projectRoot || resolved.startsWith(projectRoot + path.sep);

  if (insideProject) {
    throw new Error(
      [
        `報告含學生姓名與人員代碼，屬敏感個資（CLAUDE.md §3），不得輸出至專案內。`,
        `拒絕路徑：${resolved}`,
        '',
        '請改用專案外路徑，例如：--out ~/Downloads/report.html',
      ].join('\n'),
    );
  }

  return resolved;
}
