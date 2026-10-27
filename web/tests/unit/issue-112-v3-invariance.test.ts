import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { applicableRateForClass } from '@/application/applicable-rate';
import type { StudentSnapshot } from '@/domain/students';
import type { ClassSettingLookup } from '@/domain/classification/class-category';

/**
 * PR-2 v4 characterization for #112: fixed-five-days and tuition discount are decoupled,
 * special-discount priority remains intact, and extra deduction still follows the grade floor.
 * The persisted v3 applicable-rate projection stays a separate historical read test.
 */

function makeStudent(params: {
  personCode: string;
  grade: number;
  baseNames: string[];
  tagsRaw?: string;
}): StudentSnapshot {
  return {
    personCode: params.personCode,
    name: `學生${params.personCode}`,
    branch: '本校',
    gradeRaw: `${params.grade}年級`,
    grade: params.grade,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: params.tagsRaw ?? '',
    tags: params.tagsRaw ? params.tagsRaw.split(/[,;\s]+/).filter(Boolean) : [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: params.baseNames.map((bn) => ({
      rawToken: `${bn}[團]`,
      yearPrefix: null,
      baseName: bn,
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    })),
  };
}

describe('PR-2: erp-tag-v4 billing invariants', () => {
  it('1. v4 固定 5 天與學費折扣解耦：兩個類別維持兩科折扣率', () => {
    const student = makeStudent({
      personCode: 'V3_INV_1',
      grade: 4,
      baseNames: ['國小輔導-四年級', '國小數學-四A'],
    });

    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', categorySource: 'manual', fixedFiveDays: true }],
      ['國小數學-四A', { category: 'math', categorySource: 'manual', fixedFiveDays: false }],
    ]);

    const resV4 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4',
      classSettings: settings,
    });

    // v4 手算：2 科收取率為 9500；fixedFiveDays 不覆寫課程折扣。
    expect(resV4.applicableRates.tutoring).toBe(9500);
    expect(resV4.applicableRates.math).toBe(9500);
  });

  it('2. v4 特殊折扣優先：帶特殊折扣標籤時，即使固定 5 天，仍依特殊折扣計算（#124 不變式）', () => {
    const student = makeStudent({
      personCode: 'V3_INV_2',
      grade: 4,
      baseNames: ['國小輔導-四年級', '國小數學-四A'],
      tagsRaw: '特殊折扣9折',
    });

    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', categorySource: 'manual', fixedFiveDays: true }],
      ['國小數學-四A', { category: 'math', categorySource: 'manual', fixedFiveDays: false }],
    ]);

    const resV4 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4',
      classSettings: settings,
    });

    expect(resV4.baseDiscountBps).toBe(9000);
    expect(resV4.applicableRates.tutoring).toBe(9000);
    expect(resV4.applicableRates.math).toBe(9000);
  });

  it('3. applicableRateForClass：固定 5 天之 none 班解耦為 not_configured', () => {
    const rateFields = {
      grade: 4,
      applicableAnqinBps: 9500,
      applicableTutoringBps: 9500,
      applicableMathBps: 9500,
      applicableEnglishBps: 9500,
    };

    const snapshotMap = new Map([
      ['國小輔導-寫功課', { base_name: '國小輔導-寫功課', category: 'none', fixed_five_days: 1 }],
    ]);

    const rateV3 = applicableRateForClass(
      '國小輔導-寫功課',
      rateFields,
      {  findSnapshot: (name) => snapshotMap.get(name) }
    );

    expect(rateV3).toEqual({ status: 'not_configured' });
  });

  it('4. v4 天數計算保底與額外扣天順序：固定 5 天受額外扣天扣除，但受年級下限保底（#147 / D51）', () => {
    const student = makeStudent({
      personCode: 'V3_INV_4',
      grade: 4,
      baseNames: ['國小輔導-四年級', '國小數學-四A'],
      tagsRaw: '安課額外扣2天',
    });

    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', categorySource: 'manual', fixedFiveDays: true }],
      ['國小數學-四A', { category: 'math', categorySource: 'manual', fixedFiveDays: false }],
    ]);

    const resV4 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4',
      classSettings: settings,
    });

    // 5 - 2 = 3 天，年級 4 下限保底為 3.0 天
    expect(resV4.careDays.tutoring.days).toBe(3);
  });
});
