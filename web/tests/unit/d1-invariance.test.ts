import { describe, it, expect } from 'vitest';
import d1V4Golden from '../fixtures/d1-v4-current-golden.json';
import pr1RunGolden from '../fixtures/d1-invariance-pr1-run-golden.json';
import legacyGolden from '../fixtures/d1-invariance-golden.json';
import { computeInvarianceSnapshot, type InvarianceSnapshot } from '../helpers/d1-invariance-snapshot';

const G = d1V4Golden as {
  sourceBaseSha: string;
  normalization: string;
  snapshot: InvarianceSnapshot;
};
const PR1_RUN = pr1RunGolden as {
  sourceBaseSha: string;
  normalization: string;
  run: Record<string, unknown>;
};

function firstDiffs(actual: string[], expected: string[], limit = 5): string {
  const out: string[] = [];
  for (let i = 0; i < Math.max(actual.length, expected.length) && out.length < limit; i++) {
    if (actual[i] !== expected[i]) out.push(`#${i}:${expected[i]}→${actual[i]}`);
  }
  return out.join(', ');
}

describe('D1 invariant: current v4 output against immutable PR-1 baseline', () => {
  let actual: InvarianceSnapshot;

  it('keeps the v4 golden provenance and historical direct-calculator goldens intact', () => {
    expect(G.sourceBaseSha).toBe('99de0e7f23c57d3129bcf9c93d69db5f7069d078');
    expect(G.normalization).toContain('excluding only NUMERIC_POLICY_DIFFERENCE and RULESET_POLICY_DIFFERENCE');
    expect(PR1_RUN.sourceBaseSha).toBe('606750c9a070027f4ca3a1ee7ae909605cb04a85');
    // The direct v1/v2/compat output golden remains fixed as independent historical evidence.
    expect(Object.keys(legacyGolden.calculator).sort()).toEqual([
      'saved/erp-tag-v1',
      'saved/erp-tag-v2',
      'saved/excel-v260922-compat',
      'seed/erp-tag-v1',
      'seed/erp-tag-v2',
      'seed/excel-v260922-compat',
    ]);
    expect(Object.keys(G.snapshot.calculator).sort()).toEqual(['saved/erp-tag-v4', 'seed/erp-tag-v4']);
    expect(Object.keys(G.snapshot.run).sort()).toEqual(['saved/erp-tag-v4', 'seed/erp-tag-v4']);
  });

  it('recomputes the synthetic 477-student fixture with v4 only', async () => {
    actual = await computeInvarianceSnapshot();
    expect(actual.fixtureStudents).toBe(477);
  });

  for (const key of Object.keys(G.snapshot.calculator)) {
    it(`calculateStudentBilling ${key}: every student digest and issue count matches`, () => {
      const a = actual.calculator[key];
      const g = G.snapshot.calculator[key];
      expect(firstDiffs(a.digests, g.digests), `${key} per-student differences`).toBe('');
      expect(a.rollup).toBe(g.rollup);
      expect(a.issueCodeCounts).toEqual(g.issueCodeCounts);
      expect(a.anqinDaysSum).toBe(g.anqinDaysSum);
      expect(a.tutoringDaysSum).toBe(g.tutoringDaysSum);
    });
  }

  for (const key of Object.keys(G.snapshot.run)) {
    it(`executeCalculationRun ${key}: per-student numeric/display/summary/tier/trace digests match`, () => {
      const a = actual.run[key];
      const g = G.snapshot.run[key];
      expect(firstDiffs(a.digests, g.digests), `${key} per-student differences`).toBe('');
      expect(a.rollup).toBe(g.rollup);
      expect(a.count).toBe(g.count);
      expect(a.anqinDaysSum).toBe(g.anqinDaysSum);
      expect(a.tutoringDaysSum).toBe(g.tutoringDaysSum);
      expect(a.runIssueCounts).toEqual(g.runIssueCounts);
      expect(a.runIssueCounts).not.toHaveProperty('NUMERIC_POLICY_DIFFERENCE');
      expect(a.runIssueCounts).not.toHaveProperty('RULESET_POLICY_DIFFERENCE');
    });
  }

  it('settings schedule calculation preview is compared to the v4 baseline', () => {
    expect(actual.schedulePreview).toEqual(G.snapshot.schedulePreview);
  });
});
