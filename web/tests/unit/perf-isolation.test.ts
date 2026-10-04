import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  summarizeTimings, assertPerformanceBudget, assertRosterPerformanceBudget,
  assertRecomputePerformanceBudget, assertImportToQueryablePerformanceBudget, PERF_PATHS,
} from '../../scripts/perf-contract';

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
    const previous = process.env.PERF_DATABASE_PATH;
    process.env.PERF_DATABASE_PATH = path.join(os.tmpdir(), 'sb-perf-config-test.sqlite');
    const config = await import('../../playwright.perf.config').then((module) => module.default).finally(() => {
      if (previous === undefined) delete process.env.PERF_DATABASE_PATH;
      else process.env.PERF_DATABASE_PATH = previous;
    });
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

  it('1000ms 逐人異動 gate 不在預設並行 suite：無計時斷言，行為斷言仍在', () => {
    const roster = fs.readFileSync(path.join(web, 'tests/integration/roster-changes-performance.test.ts'), 'utf8');
    expect(roster).not.toContain('performance.now');
    expect(roster).not.toContain('toBeLessThan(1000)');
    // 正確性斷言不得隨計時 gate 一起消失（結果必須是真實計算不是空轉）。
    expect(roster).toContain('expect(result.newStudents).toBe(ROSTER_NEW_STUDENT_COUNT)');
    expect(roster).toContain('expect(result.notAppearedStudents).toBeGreaterThan(0)');
    expect(roster).toContain('expect(result.changedStudents).toBeGreaterThan(0)');
    expect(roster).toContain('expect(result.changes.length).toBe(');
  });

  it('roster 獨立 runner 記錄環境、單檔不並行，且沿用與 200ms gate 相同的統計契約', () => {
    const runner = fs.readFileSync(path.join(web, 'scripts/perf-roster-isolated.ts'), 'utf8');
    // 環境記錄：硬體／Node／輪數／統計方式（根 CLAUDE.md §8）。
    expect(runner).toContain("cpu: os.cpus()[0]?.model");
    expect(runner).toContain('node: process.version');
    expect(runner).toContain("p95: 'nearest-rank ceil(0.95*10)=10'");
    expect(runner).toContain("budget: 'p95 < 1000ms'");
    // 單檔、不並行：runner 不 spawn 其他 runner，也不啟動 dev server。
    expect(runner).not.toContain('spawn');
    expect(runner).not.toContain('playwright');
    expect(runner).not.toContain('next start');
    expect(runner).toContain('samples: 10');
    expect(runner).toContain('summarizeTimings(timings)');
  });

  it('roster 1000ms 門檻與 200ms 門檻各自的邊界都失敗，不互相寬容', () => {
    expect(() => assertRosterPerformanceBudget(Array(10).fill(999.99))).not.toThrow();
    expect(() => assertRosterPerformanceBudget([...Array(9).fill(1), 1000])).toThrow(/1000/);
    expect(() => assertRosterPerformanceBudget([...Array(9).fill(1), 2500])).toThrow(/2500/);
    // 1000ms runner 不得接受 200ms 級的樣本數不足或空殼。
    for (const samples of [[], Array(9).fill(1), Array(10).fill(NaN), Array(10).fill(-1)]) {
      expect(() => assertRosterPerformanceBudget(samples)).toThrow();
    }
  });

  it('CI 在 test/build 之後序列跑 roster gate，且 roster runner 不需要 Chromium', () => {
    const ci = fs.readFileSync(path.join(web, '../.github/workflows/ci.yml'), 'utf8');
    expect(ci.indexOf('npm run test:perf:roster-isolated')).toBeGreaterThan(ci.indexOf('run: npm run test'));
    expect(ci.indexOf('npm run test:perf:roster-isolated')).toBeGreaterThan(ci.indexOf('npm run test:perf:isolated'));
    const pkg = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:perf:roster-isolated']).toBe('tsx scripts/perf-roster-isolated.ts');
  });

  it('重算／匯入兩條 gate 不在預設並行 suite：無計時斷言，行為斷言仍在', () => {
    const roster = fs.readFileSync(path.join(web, 'tests/integration/roster-changes-performance.test.ts'), 'utf8');
    // 1000ms 逐人異動門檻不得回預設並行 suite（它與「完整重算 ≤1 秒」不同量測對象）。
    expect(roster).not.toContain('performance.now');
    expect(roster).toContain('expect(result.newStudents).toBe(ROSTER_NEW_STUDENT_COUNT)');
    // runner 與測試檔共用同一份 fixture，名冊不得再各自複製（會靜默漂移）。
    expect(roster).toContain("from '../../scripts/perf-fixture-roster'");
    const runner = fs.readFileSync(path.join(web, 'scripts/perf-roster-isolated.ts'), 'utf8');
    expect(runner).toContain("from './perf-fixture-roster.js'");
    expect(runner).not.toContain('const SEED_CLASSES');
    expect(runner).not.toContain('function makeStudent');
  });

  it('重算／匯入 runner 記錄環境、單檔不並行、每樣本 DB 狀態與量測邊界明示', () => {
    const runner = fs.readFileSync(path.join(web, 'scripts/perf-recompute-isolated.ts'), 'utf8');
    expect(runner).toContain('cpu: os.cpus()[0]?.model');
    expect(runner).toContain('node: process.version');
    expect(runner).toContain('warmup: 1');
    expect(runner).toContain('samples: 10');
    expect(runner).toContain('p95: \'nearest-rank ceil(0.95*10)=10\'');
    expect(runner).toContain('budgets:');
    // 量測邊界必須明示為 in-process，且不得宣稱涵蓋 UI／HTTP。
    expect(runner).toContain('in-process application paths');
    expect(runner).toContain('no HTTP upload, no UI render');
    expect(runner).toContain('dbStatePerSample');
    // 原子性與 trace 不得為了速度關閉。
    expect(runner).toContain('nothing disabled for speed');
    // 單檔、不並行：不 spawn、不啟 server、不需 Chromium。
    expect(runner).not.toContain('spawn');
    expect(runner).not.toContain('playwright');
    expect(runner).not.toContain('next start');
    expect(runner).toContain('summarizeTimings(importSamples)');
    expect(runner).toContain('summarizeTimings(recomputeSamples)');
  });

  it('重算 1000ms 與匯入 3000ms 各自的邊界都失敗，且不放寬就 RED', () => {
    expect(() => assertRecomputePerformanceBudget(Array(10).fill(999.99))).not.toThrow();
    expect(() => assertRecomputePerformanceBudget([...Array(9).fill(1), 1000])).toThrow(/1000/);
    expect(() => assertRecomputePerformanceBudget([...Array(9).fill(1), 3000])).toThrow(/3000/);
    expect(() => assertImportToQueryablePerformanceBudget(Array(10).fill(2999.99))).not.toThrow();
    expect(() => assertImportToQueryablePerformanceBudget([...Array(9).fill(1), 3000])).toThrow(/3000/);
    expect(() => assertImportToQueryablePerformanceBudget([...Array(9).fill(1), 5000])).toThrow(/5000/);
    for (const samples of [[], Array(9).fill(1), Array(10).fill(NaN), Array(10).fill(-1)]) {
      expect(() => assertRecomputePerformanceBudget(samples)).toThrow();
      expect(() => assertImportToQueryablePerformanceBudget(samples)).toThrow();
    }
  });

  it('兩條新 gate 每條都先斷言非空轉，再量時間', () => {
    const runner = fs.readFileSync(path.join(web, 'scripts/perf-recompute-isolated.ts'), 'utf8');
    // 匯入：解析不截斷、run 可查、可查人數一致。
    expect(runner).toContain('解析人數');
    expect(runner).toContain('可查人數');
    // 重算：結果筆數、run 學生數、重算後可查。
    expect(runner).toContain('重算結果');
    expect(runner).toContain('重算後不可查');
    // 斷言必須在量測之前：非空轉檢查出現在第一個 performance.now() 之前。
    const firstMeasure = runner.indexOf('const started = performance.now()');
    expect(firstMeasure).toBeGreaterThan(-1);
    expect(runner.indexOf('if (queried.totalStudents !== EXPECTED_STUDENTS')).toBeLessThan(
      runner.lastIndexOf('const ms = performance.now() - started'),
    );
  });

  it('CI 在 test/build 與既有 gate 之後序列跑重算／匯入 gate', () => {
    const ci = fs.readFileSync(path.join(web, '../.github/workflows/ci.yml'), 'utf8');
    expect(ci.indexOf('npm run test:perf:recompute-isolated')).toBeGreaterThan(ci.indexOf('run: npm run test'));
    expect(ci.indexOf('npm run test:perf:recompute-isolated')).toBeGreaterThan(ci.indexOf('npm run test:perf:roster-isolated'));
    const pkg = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8'));
    expect(pkg.scripts['test:perf:recompute-isolated']).toBe('tsx scripts/perf-recompute-isolated.ts');
  });
});
