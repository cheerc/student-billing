import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { buildClassSettingMap } from '@/application/calculate-run';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { StudentSnapshot } from '@/domain/students';

/**
 * 09 §8.2.4（方案 A）：帶入 scheduleOverride（＝已儲存設定版本的全量 draft）時，它是班級與時段的
 * 唯一來源——班級不在其中即 schedule_not_found，不退回 seed；未帶 scheduleOverride（尚無已儲存設定）
 * 才用 seed。國小數學-一A 是 seed 內有明確時段的班（D18），用來偵測是否誤退回 seed。
 */
const student: StudentSnapshot = {
  personCode: 'T-B4-1',
  name: '測試生',
  branch: '本校',
  gradeRaw: '小一',
  grade: 1,
  gradeStatus: 'valid',
  contact: null,
  schoolInfo: null,
  tagsRaw: '',
  tags: [],
  notesRaw: '',
  enrollments: [
    {
      rawToken: '國小數學-一A[團]',
      yearPrefix: null,
      baseName: '國小數學-一A',
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    },
  ],
  sourceRow: 1,
};
const classSettings = buildClassSettingMap(buildSeedDraft());

describe('scheduleOverride 為班級與時段的唯一來源（帶入時不退回 seed）', () => {
  it('未帶 scheduleOverride：使用 seed 課表（一A 有時段 → 有扣天）', () => {
    const res = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4', classSettings });
    expect(res.careDays.anqin.days).toBeLessThan(5);
    expect(res.tierComparisons.every((c) => !c.issues.includes('SCHEDULE_NOT_FOUND'))).toBe(true);
  });

  it('帶入不含該班的 scheduleOverride：schedule_not_found、不扣天（5 天），不退回 seed 一A 時段', () => {
    const override = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
      ['其他班', [{ start: 780, end: 900, weekday: '一' }]],
    ]);
    const res = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4', scheduleOverride: override, classSettings });
    expect(res.careDays.anqin.days).toBe(5);
    expect(res.issues.map((i) => i.code)).toContain('SCHEDULE_NOT_FOUND');
    expect(res.tierComparisons.every((c) => c.issues.includes('SCHEDULE_NOT_FOUND'))).toBe(true);
  });

  it('帶入該班的空覆寫：schedule_empty、不扣天（5 天），tier 比較帶 SCHEDULE_EMPTY', () => {
    const override = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([['國小數學-一A', []]]);
    const res = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4', scheduleOverride: override, classSettings });
    expect(res.careDays.anqin.days).toBe(5);
    expect(res.tierComparisons.every((c) => c.needsReview && c.issues.includes('SCHEDULE_EMPTY'))).toBe(true);
  });
});
