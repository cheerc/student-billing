import { describe, expect, it } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import type { StudentSnapshot } from '@/domain/students/types';
import { manualCategories } from '../helpers/manual-categories';

const student: StudentSnapshot = {
  personCode: 'SYNTH-D1',
  name: 'Synthetic student',
  branch: null,
  grade: 4,
  gradeRaw: '4',
  gradeStatus: 'valid',
  contact: null,
  schoolInfo: null,
  tagsRaw: '',
  tags: [],
  notesRaw: '',
  sourceRow: 1,
  enrollments: [
    'Synthetic English A',
    'Synthetic English B',
  ].map((baseName) => ({
    rawToken: baseName,
    baseName,
    yearPrefix: null,
    groupFlag: null,
    modifiers: [],
    withdrawalDate: null,
    erpBillingTierRaw: null,
    erpBillingTier: null,
    tierParseStatus: 'not_applicable' as const,
    parseStatus: 'ok' as const,
  })),
};

function runV4(endB: number) {
  return calculateStudentBilling(student, {
    ruleSetVersion: 'erp-tag-v4',
    classSettings: manualCategories({ english: ['Synthetic English A', 'Synthetic English B'] }),
    scheduleOverride: new Map([
      ['Synthetic English A', [{ weekday: '一', start: 990, end: 1080 }]],
      ['Synthetic English B', [{ weekday: '二', start: 990, end: endB }]],
    ]),
  });
}

describe('v4-only synthetic calculation invariants', () => {
  it('selects the greater same-category deduction and retains the resulting tier trace', () => {
    const result = runV4(1140);

    expect(result.careDays.tutoring.days).toBe(4);
    expect(result.tierComparisons).toHaveLength(2);
    expect(result.tierComparisons.map((tier) => tier.computedTier)).toEqual([4, 4]);
    expect(result.applicableRates.tutoring).toBeDefined();
  });

  it('changes the output when a synthetic schedule input changes', () => {
    const baseline = runV4(1140);
    const mutated = runV4(1080);

    expect(mutated.careDays.tutoring.days).not.toBe(baseline.careDays.tutoring.days);
    expect(mutated.tierComparisons.map((tier) => tier.computedTier))
      .not.toEqual(baseline.tierComparisons.map((tier) => tier.computedTier));
  });
});
