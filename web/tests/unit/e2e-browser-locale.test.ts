import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { utf8BrowserEnv } from '../../scripts/e2e-browser-env';

/**
 * Issue #269：容器沒有 LANG/LC_* 時 Chromium 以 POSIX locale 執行，會把非 ASCII 的下載檔名
 * （`課表.xlsx`）改成 "download"。E2E 測試環境必須讓瀏覽器在 UTF-8 locale 下啟動，
 * 本機／雲端／nightly 才行為一致（CLAUDE.md §8）。
 */
describe('#269：E2E 瀏覽器 UTF-8 locale', () => {
  it('沒有任何 locale 變數：補上 UTF-8 locale', () => {
    const env = utf8BrowserEnv({ PATH: '/usr/bin' });
    expect(env.LC_ALL).toMatch(/UTF-?8/i);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('LANG=C／POSIX（非 UTF-8）：覆寫為 UTF-8', () => {
    expect(utf8BrowserEnv({ LANG: 'C' }).LC_ALL).toMatch(/UTF-?8/i);
    expect(utf8BrowserEnv({ LANG: 'POSIX' }).LC_ALL).toMatch(/UTF-?8/i);
  });

  it('LC_ALL 為非 UTF-8 時優先於 LANG，仍須修正', () => {
    const env = utf8BrowserEnv({ LANG: 'en_US.UTF-8', LC_ALL: 'C' });
    expect(env.LC_ALL).toMatch(/UTF-?8/i);
  });

  it('已是 UTF-8（LANG／LC_ALL／LC_CTYPE）：不覆寫既有設定', () => {
    const a = utf8BrowserEnv({ LANG: 'zh_TW.UTF-8' });
    expect(a.LANG).toBe('zh_TW.UTF-8');
    expect(a.LC_ALL).toBeUndefined();
    const b = utf8BrowserEnv({ LC_ALL: 'en_US.utf8' });
    expect(b.LC_ALL).toBe('en_US.utf8');
    const c = utf8BrowserEnv({ LANG: 'C', LC_CTYPE: 'en_US.UTF-8' });
    expect(c.LC_ALL).toBeUndefined();
  });

  it('不修改傳入的 env 物件', () => {
    const input: NodeJS.ProcessEnv = { LANG: 'C' };
    utf8BrowserEnv(input);
    expect(input).toEqual({ LANG: 'C' });
  });

  it.each(['playwright.config.ts', 'playwright.isolated.config.ts', 'playwright.perf.config.ts'])(
    '%s 以 launchOptions.env 套用 utf8BrowserEnv',
    (file) => {
      const src = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
      expect(src).toMatch(/utf8BrowserEnv\(/);
      expect(src).toMatch(/launchOptions:\s*\{[^}]*env:\s*utf8BrowserEnv\(/s);
    },
  );
});
