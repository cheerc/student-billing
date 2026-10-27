import { describe, expect, it } from 'vitest';
import { parseSingleClassToken, projectTierForApplicability } from '@/domain/students/token-parser';
import { compareTier } from '@/domain/billing/issues-detector';

describe('Issue #148 semantic consumers', () => {
  it('keeps ERP token parsing lexical and applies tier meaning only from class semantics', () => {
    const namedCare = parseSingleClassToken('115國小輔導-合成班[團][4_5]');
    const arbitraryName = parseSingleClassToken('115任意班[團][4_5]');

    expect(namedCare).toMatchObject({
      baseName: '國小輔導-合成班',
      modifiers: ['4_5'],
      erpBillingTier: null,
      tierParseStatus: 'unavailable',
      parseStatus: 'needs_review',
    });
    expect(arbitraryName).toMatchObject({
      baseName: '任意班',
      modifiers: ['4_5'],
      erpBillingTier: null,
      tierParseStatus: 'unavailable',
      parseStatus: 'needs_review',
    });

    expect(projectTierForApplicability(namedCare, 'applicable')).toMatchObject({
      erpBillingTier: 4.5,
      tierParseStatus: 'parsed',
      parseStatus: 'ok',
    });
    expect(projectTierForApplicability(arbitraryName, 'applicable')).toMatchObject({
      erpBillingTier: 4.5,
      tierParseStatus: 'parsed',
      parseStatus: 'ok',
    });
    expect(projectTierForApplicability(arbitraryName, 'not_applicable')).toMatchObject({
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    });
    expect(projectTierForApplicability(parseSingleClassToken('任意班[團]'), 'unset')).toMatchObject({
      erpBillingTier: null,
      tierParseStatus: 'unavailable',
      parseStatus: 'needs_review',
    });
  });

  it('marks an unset tier applicability as unavailable and needing review', () => {
    const token = projectTierForApplicability(parseSingleClassToken('任意班[團]'), 'unset');
    expect(compareTier({
      rawToken: token.rawToken,
      baseName: token.baseName,
      computedTier: 5,
      erpDeclaredTier: token.erpBillingTier,
      tierParseStatus: token.tierParseStatus,
      scheduleStatus: 'calculated',
    })).toMatchObject({ status: 'unavailable', needsReview: true, issues: ['TIER_PARSE_UNAVAILABLE'] });
  });
});
