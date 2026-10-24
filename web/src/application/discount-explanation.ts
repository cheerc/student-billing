import {
  calculateApplicableRate,
  calculateBaseDiscountBps,
  parseTagDiscountEvidence,
} from '@/domain/billing/discount-rules';

export type DiscountExplanationStatus =
  | 'verified_v4'
  | 'historical_limited'
  | 'source_unavailable'
  | 'snapshot_inconsistent';

export interface DiscountExplanationInput {
  ruleSetVersion: string | null | undefined;
  subjectCount: number | null | undefined;
  baseDiscountBps: number | null | undefined;
  applicable: {
    anqin: number | null | undefined;
    tutoring: number | null | undefined;
    english: number | null | undefined;
    math: number | null | undefined;
  };
  rawTags: string | null | undefined;
  /** True only when the saved trace has its own `rawTags` field. */
  hasRawTags: boolean;
}

export interface DiscountExplanationFactors {
  sibling: boolean;
  siblingToken: string | null;
  specialDiscountBps: number | null;
  specialDiscountTokens: string[];
  hasMultipleSpecialDiscounts: boolean;
  internalStudent: boolean;
  internalStudentToken: string | null;
  /** The current parser is substring based; this known negation needs human checking. */
  internalLabelNeedsReview: boolean;
  effectiveCount: number | null;
  effectiveCountExpression: string | null;
}

export interface DiscountExplanation {
  status: DiscountExplanationStatus;
  sourceAvailable: boolean;
  /** Present only when saved v4 rates match the read-only domain verification. */
  factors: DiscountExplanationFactors | null;
}

const isValidSubjectCount = (value: number | null | undefined): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

const isValidSavedRate = (value: number | null | undefined): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10000);

const sameRate = (saved: number | null | undefined, expected: number | null): boolean => saved === expected;

/**
 * Project a saved student's discount evidence for display. This never changes any persisted value.
 * Only current v4 runs with a complete trace and matching saved rates receive an explanation chain.
 */
export function buildDiscountExplanation(input: DiscountExplanationInput): DiscountExplanation {
  const sourceAvailable = input.hasRawTags && (input.rawTags === null || typeof input.rawTags === 'string');

  if (input.ruleSetVersion !== 'erp-tag-v4') {
    return { status: 'historical_limited', sourceAvailable, factors: null };
  }

  const savedRates = [
    input.baseDiscountBps,
    input.applicable.anqin,
    input.applicable.tutoring,
    input.applicable.english,
    input.applicable.math,
  ];
  if (
    !sourceAvailable ||
    !isValidSubjectCount(input.subjectCount) ||
    savedRates.some((rate) => !isValidSavedRate(rate))
  ) {
    return { status: 'source_unavailable', sourceAvailable, factors: null };
  }

  const evidence = parseTagDiscountEvidence(input.rawTags);
  const discounts = evidence.discounts;
  const expectedBase = calculateBaseDiscountBps(
    input.subjectCount,
    discounts.sibling,
    discounts.specialDiscount
  );
  if (expectedBase === null) {
    return { status: 'source_unavailable', sourceAvailable, factors: null };
  }

  // The calculator stores null for all course rates when there is no enrollment;
  // calling calculateApplicableRate directly would turn the saved 10000 base into rates.
  const expectedApplicable = input.subjectCount === null
    ? { anqin: null, tutoring: null, english: null, math: null }
    : {
        anqin: calculateApplicableRate('anqin', expectedBase, discounts.internalStudent),
        tutoring: calculateApplicableRate('tutoring', expectedBase, discounts.internalStudent),
        english: calculateApplicableRate('english', expectedBase, discounts.internalStudent),
        math: calculateApplicableRate('math', expectedBase, discounts.internalStudent),
      };
  if (
    !sameRate(input.baseDiscountBps, expectedBase) ||
    !sameRate(input.applicable.anqin, expectedApplicable.anqin) ||
    !sameRate(input.applicable.tutoring, expectedApplicable.tutoring) ||
    !sameRate(input.applicable.english, expectedApplicable.english) ||
    !sameRate(input.applicable.math, expectedApplicable.math)
  ) {
    return { status: 'snapshot_inconsistent', sourceAvailable, factors: null };
  }

  const effectiveCount = input.subjectCount === null
    ? null
    : input.subjectCount + (discounts.sibling ? 1 : 0);
  const effectiveCountExpression = input.subjectCount === null
    ? null
    : discounts.sibling
      ? `${input.subjectCount} + 1 = ${effectiveCount} 科`
      : `${input.subjectCount} 科`;

  return {
    status: 'verified_v4',
    sourceAvailable,
    factors: {
      sibling: discounts.sibling,
      siblingToken: evidence.siblingToken,
      specialDiscountBps: discounts.specialDiscount === null
        ? null
        : Math.round(discounts.specialDiscount * 10000),
      specialDiscountTokens: evidence.specialDiscountTokens,
      hasMultipleSpecialDiscounts: discounts.hasMultipleSpecialDiscounts,
      internalStudent: discounts.internalStudent,
      internalStudentToken: evidence.internalStudentToken,
      internalLabelNeedsReview: discounts.internalStudent && (input.rawTags as string).includes('非園內生'),
      effectiveCount,
      effectiveCountExpression,
    },
  };
}
