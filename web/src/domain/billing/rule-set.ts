/**
 * Rule-set identifiers for persisted historical runs plus the current calculation target.
 * Historical version metadata is read-only; it never selects a calculator.
 */

/** 正式軌 ruleSetVersion（診斷軌 excel-v260922-compat 不作正式值，根 CLAUDE.md §2）。 */
export type FormalRuleSetVersion = 'erp-tag-v1' | 'erp-tag-v2' | 'erp-tag-v3' | 'erp-tag-v4';

export const FORMAL_RULE_SET_VERSIONS: ReadonlySet<string> = new Set<FormalRuleSetVersion>(['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'erp-tag-v4']);

/** 正式軌版本的可枚舉清單（API 契約用；與 FORMAL_RULE_SET_VERSIONS 同一份定義，不各寫一份）。 */
export const FORMAL_RULE_SET_VERSION_LIST = ['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'erp-tag-v4'] as const;

/** All newly calculated results use v4; old active runs require an explicit upgrade. */
export const TARGET_FORMAL_RULE_SET_VERSION: FormalRuleSetVersion = 'erp-tag-v4';

export function isFormalRuleSetVersion(v: unknown): v is FormalRuleSetVersion {
  return typeof v === 'string' && FORMAL_RULE_SET_VERSIONS.has(v);
}

/** Read-only metadata for persisted historical runs. These flags never authorize a new calculation. */
export interface HistoricalRuleSetMetadata {
  known: boolean;
  hasClassCategorySnapshot: boolean;
  hasClassSemanticsSnapshot: boolean;
  fixedFiveDaysAffectsRate: boolean;
  sameWeekdayOnly: boolean;
}

export function historicalRuleSetMetadata(version: string): HistoricalRuleSetMetadata {
  switch (version) {
    case 'erp-tag-v1':
    case 'excel-v260922-compat':
      return { known: true, hasClassCategorySnapshot: false, hasClassSemanticsSnapshot: false, fixedFiveDaysAffectsRate: true, sameWeekdayOnly: false };
    case 'erp-tag-v2':
      return { known: true, hasClassCategorySnapshot: false, hasClassSemanticsSnapshot: false, fixedFiveDaysAffectsRate: true, sameWeekdayOnly: true };
    case 'erp-tag-v3':
      return { known: true, hasClassCategorySnapshot: true, hasClassSemanticsSnapshot: false, fixedFiveDaysAffectsRate: true, sameWeekdayOnly: true };
    case 'erp-tag-v4':
      return { known: true, hasClassCategorySnapshot: true, hasClassSemanticsSnapshot: true, fixedFiveDaysAffectsRate: false, sameWeekdayOnly: true };
    default:
      // Unknown/corrupt historical version cannot authorize a snapshot or weekday-aware reconstruction.
      return { known: false, hasClassCategorySnapshot: false, hasClassSemanticsSnapshot: false, fixedFiveDaysAffectsRate: false, sameWeekdayOnly: false };
  }
}
