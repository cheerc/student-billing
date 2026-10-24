import { describe, expect, it } from 'vitest';
import { buildDiscountExplanation, type DiscountExplanationInput } from '@/application/discount-explanation';

const saved = {
  applicable: { anqin: 10000, tutoring: 10000, english: 10000, math: 10000 },
};

function input(overrides: Partial<DiscountExplanationInput> = {}): DiscountExplanationInput {
  return {
    ruleSetVersion: 'erp-tag-v4',
    subjectCount: 1,
    baseDiscountBps: 10000,
    applicable: saved.applicable,
    rawTags: '',
    hasRawTags: true,
    ...overrides,
  };
}

describe('Issue #158：只讀折扣說明投影', () => {
  it('無優惠時四個因素都能明確判定為無，空標籤與 null 標籤是已知來源', () => {
    const empty = buildDiscountExplanation(input());
    const nullTags = buildDiscountExplanation(input({ rawTags: null }));

    expect(empty.status).toBe('verified_v4');
    expect(empty.factors).toMatchObject({
      sibling: false,
      siblingToken: null,
      specialDiscountBps: null,
      specialDiscountTokens: [],
      internalStudent: false,
      internalStudentToken: null,
      effectiveCount: 1,
      effectiveCountExpression: '1 科',
    });
    expect(nullTags.status).toBe('verified_v4');
    expect(nullTags.factors?.sibling).toBe(false);
  });

  it.each([
    { subjectCount: 1, rawTags: '有兄弟姊妹折扣', baseDiscountBps: 9500, effectiveCount: 2, expression: '1 + 1 = 2 科' },
    { subjectCount: 2, rawTags: '有兄弟姊妹折扣', baseDiscountBps: 9000, effectiveCount: 3, expression: '2 + 1 = 3 科' },
  ])('兄弟姊妹依有效科數級距說明：$expression', ({ subjectCount, rawTags, baseDiscountBps, effectiveCount, expression }) => {
    const result = buildDiscountExplanation(input({
      subjectCount,
      rawTags,
      baseDiscountBps,
      applicable: { anqin: baseDiscountBps, tutoring: baseDiscountBps, english: baseDiscountBps, math: baseDiscountBps },
    }));

    expect(result.status).toBe('verified_v4');
    expect(result.factors).toMatchObject({
      sibling: true,
      siblingToken: '有兄弟姊妹折扣',
      effectiveCount,
      effectiveCountExpression: expression,
    });
  });

  it('特殊 85 折優先於科數級距，園內生只改安親且最低收費率為 9 折', () => {
    const result = buildDiscountExplanation(input({
      subjectCount: 2,
      rawTags: '有兄弟姊妹折扣, 特殊折扣85折, 園內生',
      baseDiscountBps: 8500,
      applicable: { anqin: 9000, tutoring: 8500, english: 8500, math: 8500 },
    }));

    expect(result.status).toBe('verified_v4');
    expect(result.factors).toMatchObject({
      sibling: true,
      specialDiscountBps: 8500,
      specialDiscountTokens: ['特殊折扣85折'],
      internalStudent: true,
      internalStudentToken: '園內生',
      effectiveCount: 3,
      effectiveCountExpression: '2 + 1 = 3 科',
      internalLabelNeedsReview: false,
    });
  });

  it('無特殊折扣時，園內生使安親率比基本率低 5 個百分點；其他課程沿用基本率', () => {
    const result = buildDiscountExplanation(input({
      subjectCount: 2,
      rawTags: '園內生',
      baseDiscountBps: 9500,
      applicable: { anqin: 9000, tutoring: 9500, english: 9500, math: 9500 },
    }));

    expect(result.status).toBe('verified_v4');
    expect(result.factors?.internalStudent).toBe(true);
    expect(result.factors?.internalStudentToken).toBe('園內生');
  });

  it('無報名不計算兄弟姊妹科數，且四個 null 適用率仍是無對應適用率', () => {
    const result = buildDiscountExplanation(input({
      subjectCount: null,
      rawTags: '有兄弟姊妹折扣',
      baseDiscountBps: 10000,
      applicable: { anqin: null, tutoring: null, english: null, math: null },
    }));

    expect(result.status).toBe('verified_v4');
    expect(result.factors).toMatchObject({
      sibling: true,
      effectiveCount: null,
      effectiveCountExpression: null,
    });
  });

  it('0 科仍可加兄弟姊妹 +1；與無報名分開', () => {
    const result = buildDiscountExplanation(input({
      subjectCount: 0,
      rawTags: '有兄弟姊妹折扣, 園內生',
      baseDiscountBps: 10000,
      applicable: { anqin: 9500, tutoring: 10000, english: 10000, math: 10000 },
    }));

    expect(result.status).toBe('verified_v4');
    expect(result.factors).toMatchObject({ effectiveCount: 1, effectiveCountExpression: '0 + 1 = 1 科' });
  });

  it('特殊折扣命中多筆時沿用正式固定優先序並提示人工核對', () => {
    const result = buildDiscountExplanation(input({
      subjectCount: 3,
      rawTags: '特殊折扣85折, 特殊折扣95折',
      baseDiscountBps: 9500,
      applicable: { anqin: 9500, tutoring: 9500, english: 9500, math: 9500 },
    }));

    expect(result.status).toBe('verified_v4');
    expect(result.factors).toMatchObject({
      specialDiscountBps: 9500,
      specialDiscountTokens: ['特殊折扣95折', '特殊折扣85折'],
      hasMultipleSpecialDiscounts: true,
    });
  });

  it('標籤命中「非園內生」時照實標出 parser 命中並要求人工核對', () => {
    const result = buildDiscountExplanation(input({
      rawTags: '非園內生',
      applicable: { anqin: 9500, tutoring: 10000, english: 10000, math: 10000 },
    }));

    expect(result.status).toBe('verified_v4');
    expect(result.factors).toMatchObject({ internalStudent: true, internalLabelNeedsReview: true });
  });

  it('合法 null 標籤與 trace 缺少 rawTags 欄位分別是無優惠與來源不足', () => {
    expect(buildDiscountExplanation(input({ rawTags: null })).status).toBe('verified_v4');
    expect(buildDiscountExplanation(input({ rawTags: undefined, hasRawTags: false })).status).toBe('source_unavailable');
  });

  it.each(['erp-tag-v3', 'excel-v260922-compat', 'unknown', null])('歷史或未知版本 %s 不套用 v4 說明', (ruleSetVersion) => {
    const result = buildDiscountExplanation(input({ ruleSetVersion }));
    expect(result.status).toBe('historical_limited');
    expect(result.factors).toBeNull();
  });

  it('v4 已保存數值和標籤推導不一致時不輸出未驗證的因素鏈', () => {
    const result = buildDiscountExplanation(input({
      subjectCount: 2,
      rawTags: '特殊折扣85折',
      baseDiscountBps: 9000,
      applicable: { anqin: 9000, tutoring: 9000, english: 9000, math: 9000 },
    }));

    expect(result.status).toBe('snapshot_inconsistent');
    expect(result.factors).toBeNull();
  });

  it('必要保存欄位型別錯誤時 fail closed', () => {
    const result = buildDiscountExplanation(input({ subjectCount: undefined }));
    expect(result.status).toBe('source_unavailable');
    expect(result.factors).toBeNull();
  });
});
