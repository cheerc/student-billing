import { ParsedToken } from '../students/types';

export type CalculationStatus = 'calculated' | 'not_applicable' | 'unavailable' | 'needs_review';

export interface TagDiscounts {
  extraDeduction: number | null;
  sibling: boolean;
  specialDiscount: number | null;
  internalStudent: boolean;
  isStaffFamily: boolean;
  hasMultipleSpecialDiscounts: boolean;
  hasMultipleExtraDeductions: boolean;
}

export interface CareDaysResultItem {
  days: number | null;
  displayDays: string | null;
  status: CalculationStatus;
  hasExtraFlag: boolean;
  isEnrolled: boolean;
}

export interface CareDaysResult {
  anqin: CareDaysResultItem;
  tutoring: CareDaysResultItem;
}

export interface StudentIssue {
  code: string;
  category?: string;
  message: string;
  enrollmentIds?: string[];
}

export interface TierComparison {
  enrollmentId: string;
  rawToken: string;
  baseName: string;
  computedTier: number | null;
  erpDeclaredTier: number | null;
  status: 'match' | 'mismatch' | 'not_applicable' | 'unavailable';
  needsReview: boolean;
  issues: string[];
}

/**
 * D2d B（04 §8 UX71；S manifest §7.5 第 6 點、§4.2／§7.5；D40 Q10-A）：
 * v3 選班（取適用側扣除正量最多，平手取報名順序在前者）的**選中結果**。
 *
 * 這是選班的唯一對外輸出：下游（八項總表的 englishDays／mathDays、匯入異動明細）
 * 必須讀「實際被選中的那一班」，不得各自再取一次首班——否則同一個學生會出現
 * 「天數按選中班算、摘要場次按首班算」的鏡像不一致。
 *
 * `selectedBaseName` 恆有值（即使全部候選不可計算，也記錄 fallback 依據的那一班），
 * 但那種情況 `isCalculable: false`，呼叫端必須自己決定要不要把它當成「有扣天」。
 */
export interface ClassSelection {
  /** 被選中的班級名（`rawToken` 的 baseName，alias 解析前）。 */
  selectedBaseName: string;
  /** 被選中的報名 token 原字串。 */
  selectedRawToken: string;
  /** 該候選的課表解析狀態（calculated／schedule_not_found／schedule_empty）。 */
  status: string;
  anqinDeduction: number;
  tutoringDeduction: number;
  /** 依適用側（安親／課輔／不適用）取正號後的扣除量，選班即取此值最大者。 */
  positiveDeduction: number;
  /** 選中的這一班是否真的可計算（全部不可計算時為 false）。 */
  isCalculable: boolean;
  /** 同類別候選總數／其中可計算的數量。 */
  candidateCount: number;
  calculableCount: number;
  /** 平手時依報名順序取前者；否則取正量最多。 */
  tieBreak: 'max_positive_deduction' | 'first_enrollment' | 'no_calculable_candidate';
}

/** 一名學生的選班結果（依折扣類別）。v1／v2／compat 無此輸出（維持首班語意）。 */
export interface StudentSelection {
  math?: ClassSelection;
  english?: ClassSelection;
}

export interface StudentBillingCalculation {
  personCode: string;
  subjectCount: number | null;
  baseDiscountBps: number | null; // 10000 = 100%, 9500 = 95%
  applicableRates: {
    anqin: number | null;
    tutoring: number | null;
    english: number | null;
    math: number | null;
    enrichment: number | null; // 加強班 (not_configured)
    chinese: number | null; // 國語文 (not_configured)
  };
  careDays: CareDaysResult;
  tierComparisons: TierComparison[];
  issues: StudentIssue[];
  hasIssues: boolean;
  /**
   * D2d B：v3 的選中班結果，下游共用同一份選班結果。
   * v1／v2／compat 不輸出（`undefined`）——它們沒有「選班」這件事，仍是首班語意。
   */
  selection?: StudentSelection;
}
