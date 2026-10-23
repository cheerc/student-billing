import { describe, expect, it } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import type { StudentSnapshot } from '@/domain/students/types';
import { manualCategories } from '../helpers/manual-categories';

const student: StudentSnapshot = {
  personCode: 'SYNTH-D24',
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
  enrollments: [{
    rawToken: 'Synthetic math class',
    baseName: 'Synthetic math class',
    yearPrefix: null,
    groupFlag: null,
    modifiers: [],
    withdrawalDate: null,
    erpBillingTierRaw: null,
    erpBillingTier: null,
    tierParseStatus: 'not_applicable',
    parseStatus: 'ok',
  }],
};

const options = (start: number, end: number) => ({
  ruleSetVersion: 'erp-tag-v4' as const,
  classSettings: manualCategories({ math: ['Synthetic math class'] }),
  scheduleOverride: new Map([
    ['Synthetic math class', [{ weekday: '一', start, end }]],
  ]),
});

describe('v4-only calculator contract', () => {
  it.each(['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'excel-v260922-compat'] as const)(
    'fails closed for new %s calculations',
    (ruleSetVersion) => {
      expect(() => calculateStudentBilling(student, { ...options(990, 1044), ruleSetVersion } as never))
        .toThrow(/請以 v4 明確升級/);
    },
  );

  it('keeps the v4 D24 rounding thresholds at the hand-calculated values', () => {
    const halfDay = calculateStudentBilling(student, options(990, 1044));
    const zeroDays = calculateStudentBilling(student, options(990, 1026));

    // The tutoring window is 990–1170: overlap 54 minutes rounds to 0.5 days;
    // overlap 36 minutes rounds to zero days.
    expect(halfDay.careDays.tutoring.days).toBe(4.5);
    expect(zeroDays.careDays.tutoring.days).toBe(5);
  });
});
