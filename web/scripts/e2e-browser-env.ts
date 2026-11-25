/**
 * Issue #269：E2E 瀏覽器的 UTF-8 locale。
 *
 * 容器（雲端 session、部分 CI）沒有 LANG／LC_* 時，Chromium 以 POSIX locale 執行，
 * 會把非 ASCII 的下載檔名（例如 `課表.xlsx`）改成 "download"。測試環境必須讓
 * 本機／雲端／nightly 行為一致（CLAUDE.md §8），因此 playwright config 以
 * `use.launchOptions.env` 套用本函式的結果。僅作用於測試瀏覽器，不影響產品或 webServer。
 */

const UTF8 = /utf-?8/i;

/** 實際生效的 locale：LC_ALL > LC_CTYPE > LANG（POSIX 優先序，空字串視為未設定）。 */
function effectiveLocale(env: Record<string, string | undefined>): string {
  return env.LC_ALL || env.LC_CTYPE || env.LANG || '';
}

/**
 * 回傳供瀏覽器使用的環境變數（新物件，不修改輸入）。
 * 生效 locale 已是 UTF-8 時原樣保留；否則以 LC_ALL=C.UTF-8 覆寫
 * （LC_ALL 優先於其他變數，才能蓋過既有的非 UTF-8 設定）。
 */
export function utf8BrowserEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
  if (!UTF8.test(effectiveLocale(env))) out.LC_ALL = 'C.UTF-8';
  return out;
}
