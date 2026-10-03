import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { summarizeTimings, assertPerformanceBudget, PERF_PATHS } from '../../scripts/perf-contract';

const web = path.resolve(__dirname, '../..');

describe('獨立效能量測契約', () => {
  it('10 個樣本用兩個中央值的平均與 nearest-rank p95，不改動原始樣本', () => {
    const samples = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(summarizeTimings(samples)).toEqual({ medianMs: 5.5, p95Ms: 10 });
    expect(samples).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('200ms 邊界與單一慢樣本都失敗，不以多輪中位數遮掉', () => {
    expect(() => assertPerformanceBudget(Array(10).fill(199.99))).not.toThrow();
    expect(() => assertPerformanceBudget([...Array(9).fill(1), 200])).toThrow(/200/);
    expect(() => assertPerformanceBudget([...Array(9).fill(1), 250])).toThrow(/250/);
  });

  it('拒絕樣本不足、負數與非有限值，不接受空殼結果', () => {
    for (const samples of [[], Array(9).fill(1), Array(11).fill(1), Array(10).fill(NaN), Array(10).fill(Infinity), Array(10).fill(-1)]) {
      expect(() => summarizeTimings(samples)).toThrow();
    }
  });

  it('四條路徑涵蓋多值、options、contextual options 與選班 mismatch', () => {
    expect(PERF_PATHS.map((route) => route.name)).toEqual(['multivalue', 'options', 'options-mismatch', 'class-mismatch']);
    expect(new URLSearchParams(PERF_PATHS[0].pairs).getAll('grade')).toEqual(['1', '2']);
    expect(new URLSearchParams(PERF_PATHS[0].pairs).getAll('branch')).toEqual(['北校', '南校']);
    expect(new URLSearchParams(PERF_PATHS[2].pairs).get('tierMismatch')).toBe('true');
    expect(new URLSearchParams(PERF_PATHS[2].pairs).get('options')).toBe('true');
    expect(new URLSearchParams(PERF_PATHS[3].pairs).get('enrollmentKey')).toBe('國小輔導-一A');
    expect(new URLSearchParams(PERF_PATHS[3].pairs).get('tierMismatch')).toBe('true');
  });

  it('專用 config 單檔、單 worker、無 retry、不重用服務，使用 next start 與 loopback', async () => {
    const { default: config } = await import('../../playwright.perf.config');
    expect(config.testDir).toBe('./tests/perf');
    expect(config.testMatch).toBe('filter-api.spec.ts');
    expect(config.workers).toBe(1);
    expect(config.fullyParallel).toBe(false);
    expect(config.retries).toBe(0);
    expect(config.webServer).toMatchObject({ reuseExistingServer: false });
    const server = config.webServer as { command: string; env: Record<string, string>; url: string };
    expect(server.command).toContain('next start -H 127.0.0.1');
    expect(server.env.NODE_ENV).toBe('production');
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('真實 runner 在啟動前拒絕 operator 3000，不建立服務或碰資料庫', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/perf-isolated.ts', '--port', '3000'], { cwd: web, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain('E2E 埠不可為 3000');
  });

  it('預設 suite 與 CI wiring：不執行 perf spec，效能 step 在 test/build 之後且不重試', () => {
    const vitest = fs.readFileSync(path.join(web, 'vitest.config.ts'), 'utf8');
    expect(vitest).toContain('**/tests/perf/**');
    const ordinary = fs.readFileSync(path.join(web, 'tests/integration/multivalue-query-nocourse.test.ts'), 'utf8');
    expect(ordinary).not.toContain('performance.now');
    expect(ordinary).not.toContain('toBeLessThan(200)');
    expect(ordinary).toContain('expect(snapshot()).toEqual(before)');
    const ci = fs.readFileSync(path.join(web, '../.github/workflows/ci.yml'), 'utf8');
    expect(ci.indexOf('npm run test:perf:isolated')).toBeGreaterThan(ci.indexOf('run: npm run build'));
    expect(ci).toContain('playwright install --with-deps chromium');
    const pkg = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:perf:isolated']).toBe('tsx scripts/perf-isolated.ts');
  });
});

// config import 也使用現有 isolation 守衛；測試不啟動 webServer。
process.env.PERF_DATABASE_PATH ??= path.join(os.tmpdir(), 'sb-perf-config-test.sqlite');
