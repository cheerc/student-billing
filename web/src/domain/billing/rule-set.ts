/**
 * The single current rule set. Every new run, preview and recalculation uses `erp-tag-v4`;
 * there is no version negotiation, upgrade ceremony or historical calculator.
 */

export type FormalRuleSetVersion = 'erp-tag-v4';

/** 可枚舉清單（API 契約用）。 */
export const FORMAL_RULE_SET_VERSION_LIST = ['erp-tag-v4'] as const;

export const TARGET_FORMAL_RULE_SET_VERSION: FormalRuleSetVersion = 'erp-tag-v4';
