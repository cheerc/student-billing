import { describe, expect, it } from 'vitest';
import { isCurrentRunResponse } from '@/application/run-scope';

describe('Run 範圍的非同步回應', () => {
  it('接受目前 Run 的最新回應', () => {
    expect(isCurrentRunResponse({
      expectedRunId: 'run-new',
      responseRunId: 'run-new',
      requestSequence: 4,
      currentSequence: 4,
      requestActive: true,
    })).toBe(true);
  });

  it('忽略切換 Run 後才回來的舊 Run 回應', () => {
    expect(isCurrentRunResponse({
      expectedRunId: 'run-new',
      responseRunId: 'run-old',
      requestSequence: 1,
      currentSequence: 2,
      requestActive: true,
    })).toBe(false);
  });

  it('忽略同一 Run 已被更新請求取代或已中止的晚到回應', () => {
    expect(isCurrentRunResponse({
      expectedRunId: 'run-new',
      responseRunId: 'run-new',
      requestSequence: 1,
      currentSequence: 2,
      requestActive: true,
    })).toBe(false);
    expect(isCurrentRunResponse({
      expectedRunId: 'run-new',
      responseRunId: 'run-new',
      requestSequence: 2,
      currentSequence: 2,
      requestActive: false,
    })).toBe(false);
  });
});
