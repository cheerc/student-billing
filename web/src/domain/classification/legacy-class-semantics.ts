import type { SummaryDayRole } from '@/contracts/settings';

export interface LegacyClassSemanticProjection {
  summaryDayRoles: SummaryDayRole[];
  erpTierApplicability: 'applicable' | 'not_applicable';
}

/** Frozen pre-#148 class-name interpretation for explicit migration and read-only legacy tools. */
export function legacyClassSemanticsOf(baseName: string): LegacyClassSemanticProjection {
  const summaryDayRoles: SummaryDayRole[] = [];
  if (baseName.includes('兒童美語')) summaryDayRoles.push('englishDays');
  if (baseName.includes('國小數學')) summaryDayRoles.push('mathDays');
  if (baseName.includes('國語文')) summaryDayRoles.push('chineseDays');
  if (baseName.includes('寫功課')) summaryDayRoles.push('homeworkDays');
  if (baseName.includes('加重美語') || baseName.includes('密集美語')) summaryDayRoles.push('intensiveEnglishDays');
  if (baseName.includes('週六課輔') || baseName.includes('加強班')) summaryDayRoles.push('saturdayTutoringDays');

  const regularCare =
    (baseName.includes('國小輔導') || baseName.includes('安親') || baseName.includes('課輔')) &&
    !baseName.includes('寫功課') &&
    !baseName.includes('美安');

  return {
    summaryDayRoles,
    erpTierApplicability: regularCare ? 'applicable' : 'not_applicable',
  };
}

/** The old report's Saturday column only counted an 加強班 token containing 六. */
export function legacySaturdayRoleRequiresSix(baseName: string): boolean {
  return !baseName.includes('週六課輔') && baseName.includes('加強班');
}
