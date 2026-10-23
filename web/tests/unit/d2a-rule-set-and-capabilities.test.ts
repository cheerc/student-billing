import { describe, it, expect } from 'vitest';
import {
  FORMAL_RULE_SET_VERSIONS,
  TARGET_FORMAL_RULE_SET_VERSION,
  isFormalRuleSetVersion,
  historicalRuleSetMetadata,
} from '@/domain/billing/rule-set';

describe('historical rule-set metadata is separate from the v4 calculation target', () => {
  it('retains persisted formal version identifiers while new calculation targets v4', () => {
    expect([...FORMAL_RULE_SET_VERSIONS].sort()).toEqual(['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'erp-tag-v4']);
    expect(isFormalRuleSetVersion('erp-tag-v3')).toBe(true);
    expect(isFormalRuleSetVersion('excel-v260922-compat')).toBe(false);
    expect(TARGET_FORMAL_RULE_SET_VERSION).toBe('erp-tag-v4');
  });

  it('uses explicit historical read metadata and leaves unknown versions fail-closed', () => {
    expect(historicalRuleSetMetadata('erp-tag-v1')).toEqual({
      known: true,
      hasClassCategorySnapshot: false,
      fixedFiveDaysAffectsRate: true,
      sameWeekdayOnly: false,
    });
    expect(historicalRuleSetMetadata('erp-tag-v2')).toEqual({
      known: true,
      hasClassCategorySnapshot: false,
      fixedFiveDaysAffectsRate: true,
      sameWeekdayOnly: true,
    });
    expect(historicalRuleSetMetadata('erp-tag-v3')).toEqual({
      known: true,
      hasClassCategorySnapshot: true,
      fixedFiveDaysAffectsRate: true,
      sameWeekdayOnly: true,
    });
    expect(historicalRuleSetMetadata('erp-tag-v4')).toEqual({
      known: true,
      hasClassCategorySnapshot: true,
      fixedFiveDaysAffectsRate: false,
      sameWeekdayOnly: true,
    });
    expect(historicalRuleSetMetadata('excel-v260922-compat').hasClassCategorySnapshot).toBe(false);
    expect(historicalRuleSetMetadata('unknown-version')).toEqual({
      known: false,
      hasClassCategorySnapshot: false,
      fixedFiveDaysAffectsRate: false,
      sameWeekdayOnly: false,
    });
  });
});
