import { test, expect } from '@playwright/test';
import { PERF_PATHS, summarizeTimings, assertPerformanceBudget } from '../../scripts/perf-contract';

/** 單一 spec、單一 test 依序量四條路徑；無 retry，任何一次超標都保留原始數值並失敗。 */
test('477 人 production API 四路徑：暖機後 10 次 p95 < 200ms（不含 UI render）', async ({ page, browser }) => {
  const runId = process.env.PERF_RUN_ID;
  expect(runId, 'runner 必須提供合成資料 runId').toBeTruthy();
  // JSON 文件沒有 React hydration／背景 fetch，不把其他 UI 請求混入計時。
  await page.goto('/api/v1/runs/current');
  console.log('[perf browser] Chromium ' + browser.version());
  const measure = (url: string) => page.evaluate(async (target) => {
    const start = performance.now();
    const response = await fetch(target, { cache: 'no-store' });
    const text = await response.text();
    const ms = performance.now() - start;
    return { ms, status: response.status, body: JSON.parse(text) };
  }, url);
  for (const route of PERF_PATHS) {
    const url = `/api/v1/runs/${runId}/students?${new URLSearchParams(route.pairs)}`;
    const cold = await measure(url);
    expect(cold.status).toBe(200);
    if (route.name === 'options') {
      expect(cold.body.totalStudents).toBe(477);
      expect(cold.body.options.enrollmentKey.length).toBeGreaterThan(0);
    } else if (route.name === 'options-mismatch') {
      expect(cold.body.options.enrollmentKey.some((option: { count: number }) => option.count > 0)).toBe(true);
    } else {
      expect(cold.body.totalStudents).toBeGreaterThan(0);
      expect(cold.body.items.length).toBeGreaterThan(0);
    }
    expect((await measure(url)).status).toBe(200);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await measure(url);
      expect(result.status).toBe(200);
      samples.push(result.ms);
    }
    const summary = summarizeTimings(samples);
    console.log('[perf result] ' + JSON.stringify({ path: route.name, coldMs: cold.ms, samplesMs: samples, ...summary }));
    assertPerformanceBudget(samples);
  }
});
