import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { calculateApplicableRate } from '@/domain/billing/discount-rules';
import type { StudentSnapshot } from '@/domain/students/types';

/**
 * #124：寫功課班的適用率覆蓋了特殊折扣。
 *
 * operator 裁示（權威，本 issue 範圍內）：寫功課班也可能帶「特殊折扣 NN折」，
 * 因此**特殊折扣優先於「寫功課固定 100%」**。
 *
 * 修正前：`calculateApplicableRate` 在 `hasHomeworkOrMeian` 為真時直接 `return 10000`，
 * 把 `calculateBaseDiscountBps` 已依 R10 算好的特殊折扣整個丟掉。
 *
 * expected 全部依規格獨立手算（02 §5 R07 標籤 → §6 R10 基本折扣 → §8 R13/R14 課程適用率，
 * 優先序依 operator 裁示：特殊折扣 > 寫功課固定 100%）。不使用待測函式輸出當黃金標準。
 */

const V4 = 'erp-tag-v4' as never;

/** 合成學生（僅虛構班名與虛構代碼，無真實個資；CLAUDE.md §3）。 */
function makeStudent(params: {
  personCode: string;
  grade: number;
  baseNames: string[];
  tagsRaw?: string;
  notesRaw?: string;
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
    notesRaw: params.notesRaw ?? '',
    sourceRow: 1,
    enrollments: params.baseNames.map((bn) => ({
      rawToken: `${bn}[團][五年級]`,
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

const HOMEWORK_CLASS = '115國小輔導-寫功課';
const CARE_CLASS = '115國小輔導';

describe('#124：特殊折扣優先於寫功課固定 100%（正式軌）', () => {
  it('A1 特殊折扣9折 ＋ 寫功課 → 安親／課輔適用率為 9000（非 10000）', () => {
    // 手算：v3 類別 {none} → 科數 0；R10 特殊折扣 0.9 直接覆蓋 → basic 9000；
    // 寫功課 fixedFiveDays=true → 修正前回 10000；裁示後維持 9000。
    const s = makeStudent({
      personCode: 'T124-A1',
      grade: 5,
      baseNames: [HOMEWORK_CLASS],
      tagsRaw: '特殊折扣9折',
    });
    const r = calculateStudentBilling(s, { ruleSetVersion: V4 });
    expect(r.baseDiscountBps).toBe(9000);
    expect(r.applicableRates.anqin).toBe(9000);
    expect(r.applicableRates.tutoring).toBe(9000);
  });

  it('A2 特殊折扣95折 ＋ 寫功課 → 安親／課輔適用率為 9500（證明非恰好對齊 9 折）', () => {
    // 手算：R10 特殊折扣 0.95 → basic 9500；非園內生故不套 -0.05；維持 9500。
    const s = makeStudent({
      personCode: 'T124-A2',
      grade: 5,
      baseNames: [HOMEWORK_CLASS],
      tagsRaw: '特殊折扣95折',
    });
    const r = calculateStudentBilling(s, { ruleSetVersion: V4 });
    expect(r.baseDiscountBps).toBe(9500);
    expect(r.applicableRates.anqin).toBe(9500);
    expect(r.applicableRates.tutoring).toBe(9500);
  });

  it('A3 無特殊折扣 ＋ 寫功課 → 安親／課輔適用率仍為 10000（規則未被掀掉）', () => {
    // 手算：無特殊折扣 → 科數 0、sibling false → effectiveCount 0 → basic 10000；
    // 寫功課 fixedFiveDays=true → 10000（與修正前相同）。
    const s = makeStudent({ personCode: 'T124-A3', grade: 5, baseNames: [HOMEWORK_CLASS] });
    const r = calculateStudentBilling(s, { ruleSetVersion: V4 });
    expect(r.baseDiscountBps).toBe(10000);
    expect(r.applicableRates.anqin).toBe(10000);
    expect(r.applicableRates.tutoring).toBe(10000);
  });

  it('A4 特殊折扣 ＋ 一般輔導班（無寫功課）→ 維持原行為', () => {
    // 手算：v3 類別 {care} → 科數 1；特殊折扣覆蓋 → basic 9000；無寫功課 → 直接採 basic。
    const s = makeStudent({
      personCode: 'T124-A4',
      grade: 5,
      baseNames: [CARE_CLASS],
      tagsRaw: '特殊折扣9折',
    });
    const r = calculateStudentBilling(s, { ruleSetVersion: V4 });
    expect(r.baseDiscountBps).toBe(9000);
    expect(r.applicableRates.anqin).toBe(9000);
    expect(r.applicableRates.tutoring).toBe(9000);
  });

  it('A5 特殊折扣 ＋ 寫功課，英文／數學／加強班／國語文分支不變', () => {
    // 手算：類別 {none, english, math} → 科數 2；特殊折扣覆蓋 → basic 9000。
    // R15：美語／數學直接採 basic = 9000；加強班／國語文 not_configured = null。
    const s = makeStudent({
      personCode: 'T124-A5',
      grade: 5,
      baseNames: [HOMEWORK_CLASS, '115兒童美語', '115國小數學'],
      tagsRaw: '特殊折扣9折',
    });
    const r = calculateStudentBilling(s, { ruleSetVersion: V4 });
    expect(r.baseDiscountBps).toBe(9000);
    expect(r.applicableRates.english).toBe(9000);
    expect(r.applicableRates.math).toBe(9000);
    expect(r.applicableRates.enrichment).toBeNull();
    expect(r.applicableRates.chinese).toBeNull();
  });

  it('A6 寫功課 ＋ 園內生 ＋ 特殊折扣：寫功課不再覆蓋，其餘安親規則照舊', () => {
    // 手算：特殊折扣 0.95 → basic 9500；園內生安親 max(9000, 9500-500)=9000；
    // 課輔無園內生額外優惠 → 9500。寫功課只移除 10000 覆蓋，其餘規則不動。
    const s = makeStudent({
      personCode: 'T124-A6',
      grade: 5,
      baseNames: [HOMEWORK_CLASS],
      tagsRaw: '園內生,特殊折扣95折',
    });
    const r = calculateStudentBilling(s, { ruleSetVersion: V4 });
    expect(r.baseDiscountBps).toBe(9500);
    expect(r.applicableRates.anqin).toBe(9000);
    expect(r.applicableRates.tutoring).toBe(9500);
  });

  it('A7 compatibility history cannot invoke a new calculation', () => {
    const s = makeStudent({
      personCode: 'T124-A7',
      grade: 5,
      baseNames: [HOMEWORK_CLASS],
      tagsRaw: '',
      notesRaw: '特殊折扣9折',
    });
    expect(() => calculateStudentBilling(s, { ruleSetVersion: 'excel-v260922-compat' })).toThrow(/請以 v4 明確升級/);
  });
});

describe('#124：calculateApplicableRate 單元層級', () => {
  it('v4 course helper does not carry old homework-specific switches', () => {
    expect(calculateApplicableRate('anqin', 9500, true)).toBe(9000);
    expect(calculateApplicableRate('tutoring', 9500, true)).toBe(9500);
  });

  it('explicit special discount is already represented by the base rate', () => {
    expect(calculateApplicableRate('anqin', 9000, false)).toBe(9000);
    expect(calculateApplicableRate('tutoring', 9500, false)).toBe(9500);
  });
});
