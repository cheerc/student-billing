import { describe, expect, it } from 'vitest';
import { parseSingleClassToken, projectTierForApplicability } from '@/domain/students/token-parser';
import { projectSummaryDayValues } from '@/application/summary-day-values';
import type { ClassSettingLookup } from '@/domain/classification/class-category';
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

  it('projects summary fields from aliased class roles and schedule data, independent of names', () => {
    const settings = new Map<string, ClassSettingLookup>([[
      '1234班',
      {
        classTypeId: 'study_room',
        subject: '數學',
        summaryDayRoles: ['mathDays', 'homeworkDays', 'saturdayTutoringDays'],
        summaryDayRolesStatus: 'configured',
        erpTierApplicability: 'not_applicable',
      },
    ]]);
    const values = projectSummaryDayValues(
      [parseSingleClassToken('任意課程[團]')],
      settings,
      new Map([['任意課程', '1234班']]),
      (name) => name === '1234班' ? 4 : undefined
    );

    expect(values).toEqual({
      englishDays: null,
      mathDays: 4,
      chineseDays: null,
      homeworkDays: 5,
      intensiveEnglishDays: null,
      saturdayTutoringDays: 1,
    });
  });

  it('does not infer the Saturday role from the token or class name', () => {
    const settings = new Map<string, ClassSettingLookup>([[
      '加強班-六年級',
      { classTypeId: 'study_room', summaryDayRoles: [], summaryDayRolesStatus: 'unset' },
    ]]);
    const values = projectSummaryDayValues(
      [parseSingleClassToken('加強班-六年級[六]')],
      settings,
      undefined,
      () => undefined
    );

    expect(values.saturdayTutoringDays).toBeNull();
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
