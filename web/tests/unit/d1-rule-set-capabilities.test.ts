import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { buildSchedulePreview } from '@/application/schedule-preview';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { historicalRuleSetMetadata } from '@/domain/billing/rule-set';
import type { CalculateDraft } from '@/contracts/settings';
import { makeStudent } from '../helpers/d1-test-kit';

describe('PR-2 calculation boundary and historical schedule read projection', () => {
  it('fails closed when a retired calculator version is passed directly', () => {
    const student = makeStudent('SYNTH-159-D1', ['國小數學-X'], { grade: 4 });
    for (const version of ['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'excel-v260922-compat']) {
      expect(() => calculateStudentBilling(student, {
        ruleSetVersion: version,
        scheduleOverride: new Map([['國小數學-X', [{ start: 990, end: 1080, weekday: '一' }]]]),
      })).toThrow(/請以 v4 明確升級/);
    }
  });

  it('calculates only v4 and preserves the same-weekday D24 rule', () => {
    const student = makeStudent('SYNTH-159-D2', ['國小數學-X'], { grade: 4 });
    const result = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4',
      scheduleOverride: new Map([['國小數學-X', [{ start: 990, end: 1080, weekday: '一' }]]]),
      classSettings: new Map([['國小數學-X', { category: 'math', categorySource: 'manual', fixedFiveDays: false }]]),
    });
    expect(result.careDays.tutoring.days).toBe(4.5);
    expect(result.issues.map((issue) => issue.code)).not.toContain('UNKNOWN_WEEKDAY');
  });
});

describe('historical schedule projection uses read-only saved version metadata', () => {
  it('retains the exact-base fixed-five-days historical rate flag for v1/v2/v3', () => {
    expect(historicalRuleSetMetadata('erp-tag-v1').fixedFiveDaysAffectsRate).toBe(true);
    expect(historicalRuleSetMetadata('erp-tag-v2').fixedFiveDaysAffectsRate).toBe(true);
    expect(historicalRuleSetMetadata('erp-tag-v3').fixedFiveDaysAffectsRate).toBe(true);
    expect(historicalRuleSetMetadata('excel-v260922-compat').fixedFiveDaysAffectsRate).toBe(true);
    expect(historicalRuleSetMetadata('erp-tag-v4').fixedFiveDaysAffectsRate).toBe(false);
  });

  function draftWith(weekday: string): CalculateDraft {
    const seed = buildSeedDraft();
    return {
      ...seed,
      classes: [{
        baseName: '國小數學-X',
        subject: '國小數學',
        teacher: null,
        active: true,
        sessions: [{ weekday, startMinutes: 990, endMinutes: 1080 }],
      }],
    } as unknown as CalculateDraft;
  }

  it('retains v1/v2 weekday interpretation for read-only historical snapshots', () => {
    const v2 = buildSchedulePreview(draftWith('六'), 'erp-tag-v2');
    const v1 = buildSchedulePreview(draftWith('六'), 'erp-tag-v1');
    expect(v2.rows[0].tutoring).toMatchObject({ overlapMinutes: 0, status: 'no_overlap' });
    expect(v1.rows[0].tutoring).toMatchObject({ overlapMinutes: 90, status: 'calculated' });
    expect(v2.classes[0].tutoring.rounded).toBe(0);
    expect(v1.classes[0].tutoring.rounded).toBe(-0.5);
  });

  it('retains historical unknown-weekday behavior without exposing it to new calculation', () => {
    const v2 = buildSchedulePreview(draftWith('八'), 'erp-tag-v2');
    const v1 = buildSchedulePreview(draftWith('八'), 'erp-tag-v1');
    expect(v2.rows[0].tutoring.status).toBe('unknown_weekday');
    expect(v2.issues.map((issue) => issue.code)).toEqual(['UNKNOWN_WEEKDAY']);
    expect(v1.rows[0].tutoring.status).toBe('calculated');
    expect(v1.issues).toEqual([]);
  });
});
