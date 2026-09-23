import { describe, it, expect } from 'vitest';
import {
  calculateApplicableRate,
  calculateBaseDiscountBps,
} from '@/domain/billing/discount-rules';
import {
  detectStudentIssues,
  compareTier,
} from '@/domain/billing/issues-detector';
import { parseClassTokens } from '@/domain/students/token-parser';

describe('U33–U49: 課程適用折扣、排課狀態與問題診斷測試', () => {
  it('U34: 安親園內生 basic=10000/9500/9000/8500 → 適用率 9500/9000/9000/9000 (max(0.9, basic - 0.05))', () => {
    // 安親情境: max(9000, basic - 500)
    expect(calculateApplicableRate('anqin', 10000, true, false)).toBe(9500);
    expect(calculateApplicableRate('anqin', 9500, true, false)).toBe(9000);
    expect(calculateApplicableRate('anqin', 9000, true, false)).toBe(9000);
    expect(calculateApplicableRate('anqin', 8500, true, false)).toBe(9000); // 8500 - 500 = 8000 < 9000 -> 9000
  });

  it('U35: 課輔園內生 basic=9500 → 不額外減 500，仍為 9500', () => {
    // 課輔無園內生額外優惠
    expect(calculateApplicableRate('tutoring', 9500, true, false)).toBe(9500);
    expect(calculateApplicableRate('tutoring', 10000, true, false)).toBe(10000);
  });

  it('U36: 寫功課／歷史美安＋園內生 → 安親情境優先 10000 (全額不折)', () => {
    expect(calculateApplicableRate('anqin', 9500, true, true)).toBe(10000);
    expect(calculateApplicableRate('tutoring', 9500, true, true)).toBe(10000);
  });

  it('U37: 美語／數學 vs 國語文／加強班 → 前者基本率，後者 not_configured', () => {
    expect(calculateApplicableRate('english', 9500, false, false)).toBe(9500);
    expect(calculateApplicableRate('math', 9000, false, false)).toBe(9000);
    expect(calculateApplicableRate('enrichment', 9500, false, false)).toBeNull();
    expect(calculateApplicableRate('chinese', 9500, false, false)).toBeNull();
  });

  it('U38: 無班級、有姓名 → 科數 null，基本率 null', () => {
    expect(calculateBaseDiscountBps(null, false, null)).toBeNull();
  });

  it('U39: 無班級但有特殊率／兄弟姊妹 → 基本率依標籤，但課程適用率皆為 null', () => {
    // 特殊 95 折，無班級 (subjectCount = null)
    const baseDiscount = calculateBaseDiscountBps(null, false, 0.95);
    expect(baseDiscount).toBe(9500);
  });

  it('U40: 備註「非園內生」、標籤無園內生 → 正式 false，備註只診斷不 fallback', () => {
    const issues = detectStudentIssues({
      personCode: 'STU001',
      tagsRaw: '',
      notesRaw: '家長表示非園內生',
      enrollments: [],
      sibling: false,
      internalStudent: false,
      specialDiscount: null,
      isStaffFamily: false,
    });
    // 不會把園內生誤判為 true
    expect(issues.some((i) => i.code === 'CONFLICTING_NOTE_SOURCE')).toBe(false);
  });

  it('U41: 備註有命中且異於標籤才產生 CONFLICTING_NOTE_SOURCE', () => {
    // 標籤無園內生，備註有園內生敘述
    const issues = detectStudentIssues({
      personCode: 'STU205',
      tagsRaw: '',
      notesRaw: '園內生 (弟弟園內幼幼班)',
      enrollments: [],
      sibling: false,
      internalStudent: false,
      specialDiscount: null,
      isStaffFamily: false,
    });
    expect(issues.some((i) => i.code === 'CONFLICTING_NOTE_SOURCE')).toBe(true);

    // 兩者皆有園內生（同值）-> 不產生衝突
    const noConflict = detectStudentIssues({
      personCode: 'STU206',
      tagsRaw: '園內生',
      notesRaw: '曾就讀園內生',
      enrollments: [],
      sibling: false,
      internalStudent: true,
      specialDiscount: null,
      isStaffFamily: false,
    });
    expect(noConflict.some((i) => i.code === 'CONFLICTING_NOTE_SOURCE')).toBe(false);
  });

  it('U42: 員工家屬／有搭車／需月繳 → 原文保留，無自行產生折扣或費用', () => {
    const issues = detectStudentIssues({
      personCode: 'STU001',
      tagsRaw: '有搭車, 需月繳',
      notesRaw: '',
      enrollments: [],
      sibling: false,
      internalStudent: false,
      specialDiscount: null,
      isStaffFamily: false,
    });
    expect(issues).toHaveLength(0);
  });

  it('U47: 缺排課但計算 fallback 等於 ERP 級距 → tierComparison=match 且 needs_review', () => {
    // ERP 登記 5 天，排課未找到走 fallback 5 天
    const comp = compareTier({
      computedTier: 5,
      erpDeclaredTier: 5,
      scheduleStatus: 'schedule_not_found',
    });
    expect(comp.status).toBe('match');
    expect(comp.needsReview).toBe(true);
    expect(comp.issues).toContain('SCHEDULE_NOT_FOUND');
  });

  it('U48: 重複科別報名提示 (DUPLICATE_SUBJECT_ENROLLMENT, R17)', () => {
    // 美語 x 2
    const tokensEnglish2 = parseClassTokens('兒童美語-EA[團]\n兒童美語-EG[團]');
    const issues1 = detectStudentIssues({
      personCode: 'STU052',
      tagsRaw: '',
      notesRaw: '',
      enrollments: tokensEnglish2,
      sibling: false,
      internalStudent: false,
      specialDiscount: null,
      isStaffFamily: false,
    });
    const dupEnglish = issues1.find((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT');
    expect(dupEnglish).toBeDefined();
    expect(dupEnglish?.category).toBe('兒童美語');

    // 國小輔導 x 2
    const tokensCare2 = parseClassTokens('國小輔導-三年級[團][5]\n國小輔導-三年級[團][4]');
    const issues2 = detectStudentIssues({
      personCode: 'STU043',
      tagsRaw: '',
      notesRaw: '',
      enrollments: tokensCare2,
      sibling: false,
      internalStudent: false,
      specialDiscount: null,
      isStaffFamily: false,
    });
    const dupCare = issues2.find((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT');
    expect(dupCare).toBeDefined();
    expect(dupCare?.category).toBe('國小輔導');

    // 一般輔導 1 筆 + 寫功課 1 筆 -> 不觸發 DUPLICATE_SUBJECT_ENROLLMENT (R17)
    const tokensMix = parseClassTokens('國小輔導-三年級[團][5]\n國小輔導-寫功課[團]');
    const issues3 = detectStudentIssues({
      personCode: 'STU044',
      tagsRaw: '',
      notesRaw: '',
      enrollments: tokensMix,
      sibling: false,
      internalStudent: false,
      specialDiscount: null,
      isStaffFamily: false,
    });
    expect(issues3.some((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT')).toBe(false);
  });

  it('U49: 員工家屬無折扣提示 (STAFF_FAMILY_NO_DISCOUNT, R18)', () => {
    // 1. 員工家屬且無三種優惠標記 -> 觸發提示
    const issues1 = detectStudentIssues({
      personCode: 'STU117',
      tagsRaw: '員工家屬',
      notesRaw: '',
      enrollments: [],
      sibling: false,
      internalStudent: false,
      specialDiscount: null,
      isStaffFamily: true,
    });
    expect(issues1.some((i) => i.code === 'STAFF_FAMILY_NO_DISCOUNT')).toBe(true);

    // 2. 員工家屬 + 特殊折扣 -> 不觸發
    const issues2 = detectStudentIssues({
      personCode: 'STU118',
      tagsRaw: '員工家屬, 特殊折扣8折',
      notesRaw: '',
      enrollments: [],
      sibling: false,
      internalStudent: false,
      specialDiscount: 0.8,
      isStaffFamily: true,
    });
    expect(issues2.some((i) => i.code === 'STAFF_FAMILY_NO_DISCOUNT')).toBe(false);

    // 3. 員工家屬 + 兄弟姊妹 -> 不觸發
    const issues3 = detectStudentIssues({
      personCode: 'STU119',
      tagsRaw: '員工家屬, 有兄弟姊妹折扣',
      notesRaw: '',
      enrollments: [],
      sibling: true,
      internalStudent: false,
      specialDiscount: null,
      isStaffFamily: true,
    });
    expect(issues3.some((i) => i.code === 'STAFF_FAMILY_NO_DISCOUNT')).toBe(false);

    // 4. 僅有搭車或需月繳 -> 絕不觸發 STAFF_FAMILY_NO_DISCOUNT
    const issues4 = detectStudentIssues({
      personCode: 'STU120',
      tagsRaw: '有搭車',
      notesRaw: '',
      enrollments: [],
      sibling: false,
      internalStudent: false,
      specialDiscount: null,
      isStaffFamily: false,
    });
    expect(issues4.some((i) => i.code === 'STAFF_FAMILY_NO_DISCOUNT')).toBe(false);
  });
});
