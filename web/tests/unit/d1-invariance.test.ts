import { describe, it, expect } from 'vitest';
import golden from '../fixtures/d1-invariance-golden.json';
import pr1RunGolden from '../fixtures/d1-invariance-pr1-run-golden.json';
import { computeInvarianceSnapshot, type InvarianceSnapshot } from '../helpers/d1-invariance-snapshot';

/**
 * D1 核心驗收（specs/11 §3 D1、04 §8 UX34）：v1／v2／compat 的計算輸出在 D1 前後逐欄相同。
 *
 * golden（tests/fixtures/d1-invariance-golden.json）由**未修改的 8961c03** 執行
 * `npx tsx tests/helpers/generate-d1-invariance-golden.ts` 產生（可在 8961c03 的 worktree 重跑驗證，
 * 內容 byte-identical）。本檔對目前程式碼重算並比對。
 *
 * 政策邊界（operator 裁決 d-20260930131128030911-29 授權）：
 * 本項測試屬於狹義之 pre-change baseline 差異特徵化（differential characterization），僅用於證明 D1 重構
 * 前後之計算行為「未發生非預期改變」；本 golden 不是業務計算正確性之獨立 oracle。新規則、新行為或 bug 修正
 * 之測試 expected，仍必須依據規格獨立手算或由外部驗證建立。
 *
 * 比對粒度：合成 fixture 477 人 × {seed 設定、已儲存設定（含 alias／週六時段／整班移除／未知星期／停班）}
 * × {v1、v2、compat}（calculateStudentBilling），以及 run 層 {seed、saved} × {v1、v2} 的業務總數。
 * PR-1 刻意停止新 run 的 compat／shadow 診斷，因此 run-level 原始 issues digest 與舊 golden 的差異是核准的行為變更；
 * 此處仍比對學生數、天數總和與去除兩種退役診斷碼後的業務 issueCounts。加上讀模型 buildSchedulePreview（v1、v2）。業務欄位涵蓋天數、科數、基本折扣、課程適用率、
 * 級距比較、issue code 集合（另含訊息文字）。
 */

const G = golden as unknown as InvarianceSnapshot;
const PR1_RUN = pr1RunGolden as {
  sourceBaseSha: string;
  normalization: string;
  run: InvarianceSnapshot['run'];
};

function firstDiffs(actual: string[], expected: string[], limit = 5): string {
  const out: string[] = [];
  for (let i = 0; i < Math.max(actual.length, expected.length) && out.length < limit; i++) {
    if (actual[i] !== expected[i]) out.push(`#${i}:${expected[i]}→${actual[i]}`);
  }
  return out.join(', ');
}

describe('D1 不變式：v1／v2／compat 計算基準與 PR-1 新 run 投影', () => {
  let actual: InvarianceSnapshot;

  it('前提：golden 涵蓋 477 人、calculator 6 組（2 情境 × 3 版本）、run 4 組、讀模型 2 組', () => {
    expect(G.fixtureStudents).toBe(477);
    expect(Object.keys(G.calculator).sort()).toEqual([
      'saved/erp-tag-v1',
      'saved/erp-tag-v2',
      'saved/excel-v260922-compat',
      'seed/erp-tag-v1',
      'seed/erp-tag-v2',
      'seed/excel-v260922-compat',
    ]);
    expect(Object.keys(G.run).sort()).toEqual(['saved/erp-tag-v1', 'saved/erp-tag-v2', 'seed/erp-tag-v1', 'seed/erp-tag-v2']);
    expect(Object.keys(G.schedulePreview).sort()).toEqual(['erp-tag-v1', 'erp-tag-v2']);
  });

  it('PR-1 run golden 來自固定 base 並只正規化兩種退役問題及其 hasIssues 投影', () => {
    expect(PR1_RUN.sourceBaseSha).toBe('606750c9a070027f4ca3a1ee7ae909605cb04a85');
    expect(PR1_RUN.normalization).toContain('remove issues with code NUMERIC_POLICY_DIFFERENCE or RULESET_POLICY_DIFFERENCE');
    expect(Object.keys(PR1_RUN.run).sort()).toEqual(['saved/erp-tag-v1', 'saved/erp-tag-v2', 'seed/erp-tag-v1', 'seed/erp-tag-v2']);
  });

  it('前提：各版本在「已儲存設定」情境確實走到不同狀態（否則不變式沒有鑑別力）', () => {
    // v2 才有未知星期警告；v1／compat 沒有
    expect(G.calculator['saved/erp-tag-v2'].issueCodeCounts.UNKNOWN_WEEKDAY).toBe(14);
    expect(G.calculator['saved/erp-tag-v1'].issueCodeCounts.UNKNOWN_WEEKDAY).toBeUndefined();
    expect(G.calculator['saved/excel-v260922-compat'].issueCodeCounts.UNKNOWN_WEEKDAY).toBeUndefined();
    // 整班移除與 alias 使 SCHEDULE_NOT_FOUND 由 13 降為 9
    expect(G.calculator['seed/erp-tag-v2'].issueCodeCounts.SCHEDULE_NOT_FOUND).toBe(13);
    expect(G.calculator['saved/erp-tag-v2'].issueCodeCounts.SCHEDULE_NOT_FOUND).toBe(9);
    // 週六時段讓 v1 與 v2 的 saved rollup 不同
    expect(G.calculator['saved/erp-tag-v1'].rollup).not.toBe(G.calculator['saved/erp-tag-v2'].rollup);
  });

  it('重算目前程式碼（同一 import、同一設定快照、同一版本）', async () => {
    actual = await computeInvarianceSnapshot();
    expect(actual.fixtureStudents).toBe(G.fixtureStudents);
  });

  for (const key of Object.keys(G.calculator)) {
    it(`calculateStudentBilling ${key}：477 人逐人摘要與 rollup 相同`, () => {
      const a = actual.calculator[key];
      const g = G.calculator[key];
      expect(firstDiffs(a.digests, g.digests), `${key} 逐人差異（前 5 筆）`).toBe('');
      expect(a.rollup).toBe(g.rollup);
      expect(a.issueCodeCounts).toEqual(g.issueCodeCounts);
      expect(a.anqinDaysSum).toBe(g.anqinDaysSum);
      expect(a.tutoringDaysSum).toBe(g.tutoringDaysSum);
    });
  }

  for (const key of Object.keys(G.run)) {
    it(`executeCalculationRun ${key}：normalized per-student output digest, rollup, and business issueCounts match fixed base`, () => {
      const a = actual.run[key];
      const g = PR1_RUN.run[key];
      expect(firstDiffs(a.digests, g.digests), `${key} per-student normalized differences (first 5)`).toBe('');
      expect(a.rollup).toBe(g.rollup);
      expect(a.count).toBe(g.count);
      expect(a.anqinDaysSum).toBe(g.anqinDaysSum);
      expect(a.tutoringDaysSum).toBe(g.tutoringDaysSum);
      expect(a.runIssueCounts).toEqual(g.runIssueCounts);
      expect(a.runIssueCounts).not.toHaveProperty('NUMERIC_POLICY_DIFFERENCE');
      expect(a.runIssueCounts).not.toHaveProperty('RULESET_POLICY_DIFFERENCE');
    });
  }

  it('buildSchedulePreview（v1、v2）讀模型摘要相同', () => {
    expect(actual.schedulePreview).toEqual(G.schedulePreview);
  });
});
