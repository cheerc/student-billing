import { describe, it, expect } from 'vitest';
import {
  calculateSubjectCountByCategory,
  calculateBaseDiscountBps,
  parseTagDiscounts,
} from '@/domain/billing/discount-rules';
import { calculateCareDays } from '@/domain/billing/care-days';
import { parseClassTokens } from '@/domain/students/token-parser';

describe('U15–U30: 科數、基本率、標籤優惠與安親課輔天數測試', () => {
  it('U15: current v4 counts distinct resolved categories, then applies R10 rates', () => {
    expect(calculateSubjectCountByCategory(['english'])).toBe(1);
    expect(calculateBaseDiscountBps(1, false, null)).toBe(10000);

    expect(calculateSubjectCountByCategory(['math', 'english'])).toBe(2);
    expect(calculateBaseDiscountBps(2, false, null)).toBe(9500);

    expect(calculateSubjectCountByCategory(['care', 'math', 'english'])).toBe(3);
    expect(calculateBaseDiscountBps(3, false, null)).toBe(9000);
  });

  it('U16: multiple classes in one category count once', () => {
    expect(calculateSubjectCountByCategory(['english', 'english'])).toBe(1);
  });

  it('U17: explicitly non-discount categories do not add to subject count', () => {
    expect(calculateSubjectCountByCategory(['none', 'math', 'english'])).toBe(2);
    expect(calculateBaseDiscountBps(2, false, null)).toBe(9500);
  });

  it('U18: none category has zero effective subjects', () => {
    expect(calculateSubjectCountByCategory(['none'])).toBe(0);
    expect(calculateBaseDiscountBps(0, false, null)).toBe(10000);
  });

  it('U19: empty enrollment set remains null while an explicit none set is zero', () => {
    expect(calculateSubjectCountByCategory([])).toBeNull();
    expect(calculateSubjectCountByCategory(['none'])).toBe(0);
  });

  it('U20: v4 classification counts care and math independently from class names', () => {
    expect(calculateSubjectCountByCategory(['care', 'none', 'math'])).toBe(2);
    expect(calculateBaseDiscountBps(2, false, null)).toBe(9500);
  });

  it('U21: 1 科＋兄弟姊妹、2 科＋兄弟姊妹 → 基本率 9500、9000', () => {
    expect(calculateBaseDiscountBps(1, true, null)).toBe(9500);
    expect(calculateBaseDiscountBps(2, true, null)).toBe(9000);
    expect(calculateBaseDiscountBps(3, true, null)).toBe(9000);
  });

  it('U22: 特殊 95/85/7/8/9 折各一例 → 分別 9500/8500/7000/8000/9000', () => {
    expect(calculateBaseDiscountBps(1, false, 0.95)).toBe(9500);
    expect(calculateBaseDiscountBps(1, false, 0.85)).toBe(8500);
    expect(calculateBaseDiscountBps(1, false, 0.7)).toBe(7000);
    expect(calculateBaseDiscountBps(1, false, 0.8)).toBe(8000);
    expect(calculateBaseDiscountBps(1, false, 0.9)).toBe(9000);
  });

  it('U23: 特殊 95 折＋3 科 → 仍為 9500，不自動取較優惠 9000', () => {
    expect(calculateBaseDiscountBps(3, false, 0.95)).toBe(9500);
  });

  it('U24: 多特殊標記／多額外扣天標記 → 依原優先序取值並標記 needs_review', () => {
    const tag1 = '特殊折扣95折, 特殊折扣85折';
    const res1 = parseTagDiscounts(tag1);
    expect(res1.specialDiscount).toBe(0.95);
    expect(res1.hasMultipleSpecialDiscounts).toBe(true);

    const tag2 = '安課額外扣0.5天, 安課額外扣1天';
    const res2 = parseTagDiscounts(tag2);
    expect(res2.extraDeduction).toBe(0.5);
    expect(res2.hasMultipleExtraDeductions).toBe(true);
  });

  it('U25: 標籤四種額外扣天、未命中、空標籤 → 0.5/1/2/1.5/null', () => {
    expect(parseTagDiscounts('安課額外扣0.5天').extraDeduction).toBe(0.5);
    expect(parseTagDiscounts('安課額外扣1天').extraDeduction).toBe(1.0);
    expect(parseTagDiscounts('安課額外扣2天').extraDeduction).toBe(2.0);
    expect(parseTagDiscounts('安課額外扣1.5天').extraDeduction).toBe(1.5);
    expect(parseTagDiscounts('其他標籤').extraDeduction).toBeNull();
    expect(parseTagDiscounts('').extraDeduction).toBeNull();
    expect(parseTagDiscounts(null).extraDeduction).toBeNull();
  });

  it('U26: 小一，ma=-0.5、en=-0.5、extra=0 → 安親 4 天', () => {
    const res = calculateCareDays({
      grade: 1,
      mathDeductionAnqin: -0.5,
      mathDeductionTutoring: 0,
      englishDeductionAnqin: -0.5,
      englishDeductionTutoring: 0,
      extraDeduction: null,
      hasHomeworkOrMeian: false,
    });
    expect(res.anqin.days).toBe(4);
    expect(res.anqin.status).toBe('calculated');
    expect(res.tutoring.status).toBe('not_applicable');
  });

  it('U27: 小二，合計負扣天 -2、extra=1 → 安親下限 3.5，extra flag 保留', () => {
    const res = calculateCareDays({
      grade: 2,
      mathDeductionAnqin: -1,
      mathDeductionTutoring: 0,
      englishDeductionAnqin: -1,
      englishDeductionTutoring: 0,
      extraDeduction: 1,
      hasHomeworkOrMeian: false,
    });
    // 5 - 2 - 1 = 2 < 3.5 -> 3.5
    expect(res.anqin.days).toBe(3.5);
    expect(res.anqin.hasExtraFlag).toBe(true);
    expect(res.anqin.displayDays).toBe('3.5*額');
  });

  it('U28: 小三，合計 -2.5、extra=1 → 課輔下限 3', () => {
    const res = calculateCareDays({
      grade: 3,
      mathDeductionAnqin: 0,
      mathDeductionTutoring: -1.5,
      englishDeductionAnqin: 0,
      englishDeductionTutoring: -1.0,
      extraDeduction: 1,
      hasHomeworkOrMeian: false,
    });
    // 5 - 2.5 - 1 = 1.5 < 3 -> 3
    expect(res.tutoring.days).toBe(3);
    expect(res.tutoring.hasExtraFlag).toBe(true);
    expect(res.tutoring.displayDays).toBe('3*額');
  });

  it('U29: v4 applies fixed-five floor first, then extra deduction, subject to grade floor', () => {
    const result = calculateCareDays({
      grade: 1,
      mathDeductionAnqin: -0.5,
      mathDeductionTutoring: 0,
      englishDeductionAnqin: -0.5,
      englishDeductionTutoring: 0,
      extraDeduction: 0.5,
      hasHomeworkOrMeian: true,
    });
    // baseVal = MAX(5 - 0.5 - 0.5, 5) = 5; MAX(3.5, 5 - 0.5) = 4.5
    expect(result.anqin.days).toBe(4.5);
    expect(result.anqin.hasExtraFlag).toBe(true);
    expect(result.anqin.displayDays).toBe('4.5*額');
  });

  it('U30: 小一沒有安親報名，只有美語 → 原年級天數可算，enrolled=false', () => {
    const tokens = parseClassTokens('兒童美語-EA[團]');
    const isCareEnrolled = tokens.some((t) => t.baseName.includes('國小輔導'));
    expect(isCareEnrolled).toBe(false);

    const res = calculateCareDays({
      grade: 1,
      mathDeductionAnqin: 0,
      mathDeductionTutoring: 0,
      englishDeductionAnqin: -0.5,
      englishDeductionTutoring: 0,
      extraDeduction: null,
      hasHomeworkOrMeian: false,
    });
    expect(res.anqin.days).toBe(4.5);
    expect(res.anqin.status).toBe('calculated');
  });
});
