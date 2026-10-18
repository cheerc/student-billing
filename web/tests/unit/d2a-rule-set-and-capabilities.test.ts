import { describe, it, expect } from 'vitest';
import {
  FormalRuleSetVersion,
  FORMAL_RULE_SET_VERSIONS,
  CURRENT_FORMAL_RULE_SET_VERSION,
  isFormalRuleSetVersion,
  ruleSetCapabilities,
} from '@/domain/billing/rule-set';

describe('D2a: 規則版本與能力旗標 (RuleSet & Capabilities)', () => {
  it('FormalRuleSetVersion 包含 erp-tag-v3 且 FORMAL_RULE_SET_VERSIONS 集合註冊', () => {
    expect(FORMAL_RULE_SET_VERSIONS.has('erp-tag-v3')).toBe(true);
    expect(isFormalRuleSetVersion('erp-tag-v3')).toBe(true);
  });

  it('erp-tag-v3 的能力旗標完整明列且為預期狀態 (無字面比較退回風險)', () => {
    const caps = ruleSetCapabilities('erp-tag-v3');
    // 繼承 v2 特性
    expect(caps.sameWeekdayOnly).toBe(true);
    expect(caps.unknownWeekdayWarning).toBe(true);
    expect(caps.scheduleIncompleteOnUnknownWeekday).toBe(true);
    // D2a 新增特性旗標
    expect((caps as any).categoryBasedBilling).toBe(true);
    expect((caps as any).maxDeductionSelection).toBe(true);
    expect((caps as any).missingEnglishScheduleWarning).toBe(true);
    expect((caps as any).diagnosticsDecomposition).toBe(true);
    expect((caps as any).unmappedClassWarning).toBe(true);
    // #147: 固定 5 天在額外扣天前套用，額外扣天扣在固定 5 天之後
    expect((caps as any).extraDeductionAfterFloor).toBe(true);
  });

  it('erp-tag-v2, erp-tag-v1, excel-v260922-compat 之能力旗標維持原樣不變', () => {
    const v2Caps = ruleSetCapabilities('erp-tag-v2');
    expect(v2Caps.sameWeekdayOnly).toBe(true);
    expect(v2Caps.unknownWeekdayWarning).toBe(true);
    expect(v2Caps.scheduleIncompleteOnUnknownWeekday).toBe(true);
    expect((v2Caps as any).categoryBasedBilling).toBeFalsy();
    expect((v2Caps as any).maxDeductionSelection).toBeFalsy();
    expect((v2Caps as any).extraDeductionAfterFloor).toBeFalsy();

    const v1Caps = ruleSetCapabilities('erp-tag-v1');
    expect(v1Caps.sameWeekdayOnly).toBe(false);
    expect(v1Caps.unknownWeekdayWarning).toBe(false);
    expect(v1Caps.scheduleIncompleteOnUnknownWeekday).toBe(false);
    expect((v1Caps as any).extraDeductionAfterFloor).toBeFalsy();

    const compatCaps = ruleSetCapabilities('excel-v260922-compat');
    expect(compatCaps.sameWeekdayOnly).toBe(false);
    expect((compatCaps as any).extraDeductionAfterFloor).toBeFalsy();

    const unknownCaps = ruleSetCapabilities('unknown-version');
    expect(unknownCaps.sameWeekdayOnly).toBe(false);
    expect((unknownCaps as any).extraDeductionAfterFloor).toBeFalsy();
  });
});
