/** Issue #269 — RED stub: 尚未補 UTF-8 locale。 */
export function utf8BrowserEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}
