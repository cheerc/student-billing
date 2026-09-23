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
}
