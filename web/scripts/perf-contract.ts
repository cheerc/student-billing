export const PERF_PATHS: Array<{ name: string; pairs: Array<[string, string]> }> = [
  { name: 'multivalue', pairs: [['grade', '1'], ['grade', '2'], ['branch', '北校'], ['branch', '南校']] },
  { name: 'options', pairs: [['options', 'true']] },
  { name: 'options-mismatch', pairs: [['options', 'true'], ['tierMismatch', 'true']] },
  { name: 'class-mismatch', pairs: [['enrollmentKey', '國小輔導-一A'], ['tierMismatch', 'true']] },
];

export function summarizeTimings(samples: number[]): { medianMs: number; p95Ms: number } {
  if (samples.length !== 10 || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('效能量測必須提供 10 個有限且非負的 ms 樣本');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { medianMs: (sorted[4] + sorted[5]) / 2, p95Ms: sorted[9] };
}

export function assertPerformanceBudget(samples: number[]): void {
  const { p95Ms } = summarizeTimings(samples);
  if (p95Ms >= 200) throw new Error(`篩選 API p95=${p95Ms}ms，必須 < 200ms（不重試）`);
}
