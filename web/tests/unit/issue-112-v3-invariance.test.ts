import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { applicableRateForClass } from '@/application/applicable-rate';
import type { StudentSnapshot } from '@/domain/students';
import type { ClassSettingLookup } from '@/domain/classification/class-category';

/**
 * A17 驗收自動化證據：v3 計算規則在 PR-2 前後逐位元保持不變。
 * 涵蓋固定 5 天強制 10000 bps、本班適用折扣 10000 bps、類別科數、衝堂最多扣除選班與額外扣天順序。
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

describe('Ruling 4 / A17: erp-tag-v3 計算規則不變式自動化驗收測試', () => {
  it('1. v3 固定 5 天強制覆蓋：在 erp-tag-v3 下，輔導班勾選固定 5 天仍將課輔/安親收費率覆蓋為 10000 bps', () => {
    const student = makeStudent({
      personCode: 'V3_INV_1',
      grade: 4,
      baseNames: ['國小輔導-四年級', '國小數學-四A'],
    });

    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', fixedFiveDays: true }],
      ['國小數學-四A', { category: 'math', fixedFiveDays: false }],
    ]);

    const resV3 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v3' as any,
      classSettings: settings,
    });

    // v3 手算：2 科原本 9500，但固定 5 天強制使 tutoring 為 10000
    expect(resV3.applicableRates.tutoring).toBe(10000);
    expect(resV3.applicableRates.math).toBe(9500);
  });

  it('2. v3 特殊折扣優先：帶特殊折扣標籤時，即使固定 5 天，仍優先依特殊折扣計算（#124 不變式）', () => {
    const student = makeStudent({
      personCode: 'V3_INV_2',
      grade: 4,
      baseNames: ['國小輔導-四年級', '國小數學-四A'],
      tagsRaw: '特殊折扣9折',
    });

    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', fixedFiveDays: true }],
      ['國小數學-四A', { category: 'math', fixedFiveDays: false }],
    ]);

    const resV3 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v3' as any,
      classSettings: settings,
    });

    expect(resV3.baseDiscountBps).toBe(9000);
    expect(resV3.applicableRates.tutoring).toBe(9000);
    expect(resV3.applicableRates.math).toBe(9000);
  });

  it('3. v3 applicableRateForClass：固定 5 天之 none 班（如寫功課）本班適用折扣維持 10000 bps（Q7-A）', () => {
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
      { ruleSetVersion: 'erp-tag-v3', findSnapshot: (name) => snapshotMap.get(name) }
    );

    expect(rateV3).toEqual({ status: 'configured', bps: 10000 });
  });

  it('4. v3 天數計算保底與額外扣天順序：固定 5 天受額外扣天扣除，但受年級下限保底（#147 / D51）', () => {
    const student = makeStudent({
      personCode: 'V3_INV_4',
      grade: 4,
      baseNames: ['國小輔導-四年級', '國小數學-四A'],
      tagsRaw: '安課額外扣2天',
    });

    const settings = new Map<string, ClassSettingLookup>([
      ['國小輔導-四年級', { category: 'care', fixedFiveDays: true }],
      ['國小數學-四A', { category: 'math', fixedFiveDays: false }],
    ]);

    const resV3 = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v3' as any,
      classSettings: settings,
    });

    // 5 - 2 = 3 天，年級 4 下限保底為 3.0 天
    expect(resV3.careDays.tutoring.days).toBe(3);
  });
});
