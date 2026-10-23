import type { ClassSettingLookup } from '@/domain/classification/class-category';
import type { ParsedToken } from '@/domain/students/types';

export interface SummaryDayValues {
  englishDays: number | null;
  mathDays: number | null;
  chineseDays: number | null;
  homeworkDays: number | null;
  intensiveEnglishDays: number | null;
  saturdayTutoringDays: number | null;
}

const SUMMARY_CONSTANTS = {
  chineseDays: 1,
  homeworkDays: 5,
  intensiveEnglishDays: 2,
  saturdayTutoringDays: 1,
} as const;

/** Build report columns from the same alias and class metadata used by the run. */
export function projectSummaryDayValues(
  enrollments: Array<Pick<ParsedToken, 'rawToken' | 'baseName'>>,
  classSettings: Map<string, ClassSettingLookup> | undefined,
  aliasMap: Map<string, string> | undefined,
  sessionCountFor: (resolvedBaseName: string) => number | undefined,
  preferredSelection?: { english?: string; math?: string }
): SummaryDayValues {
  const rows = enrollments.map((enrollment) => {
    const resolvedBaseName = aliasMap?.get(enrollment.baseName) ?? enrollment.baseName;
    const setting = classSettings?.get(resolvedBaseName);
    const configuredRoles = setting?.summaryDayRolesStatus === 'configured'
      ? setting.summaryDayRoles ?? []
      : [];
    const conditions = setting?.summaryDayRoleConditions ?? [];
    const roles = configuredRoles.filter((role) => {
      const condition = conditions.find((item) => item.role === role);
      return condition === undefined ||
        (condition.condition === 'raw_token_contains_six' && enrollment.rawToken.includes('六'));
    });
    return { enrollment, resolvedBaseName, roles };
  });

  const selectedFor = (role: 'englishDays' | 'mathDays', selectedBaseName?: string) => {
    if (selectedBaseName) {
      const selectedResolved = aliasMap?.get(selectedBaseName) ?? selectedBaseName;
      const preferred = rows.find((row) =>
        row.roles.includes(role) &&
        (row.enrollment.baseName === selectedBaseName || row.resolvedBaseName === selectedResolved)
      );
      if (preferred) return preferred;
    }
    return rows.find((row) => row.roles.includes(role));
  };

  const english = selectedFor('englishDays', preferredSelection?.english);
  const math = selectedFor('mathDays', preferredSelection?.math);
  const hasRole = (role: keyof typeof SUMMARY_CONSTANTS) => rows.some((row) => row.roles.includes(role));

  return {
    englishDays: english ? sessionCountFor(english.resolvedBaseName) ?? 2 : null,
    mathDays: math ? sessionCountFor(math.resolvedBaseName) ?? 2 : null,
    chineseDays: hasRole('chineseDays') ? SUMMARY_CONSTANTS.chineseDays : null,
    homeworkDays: hasRole('homeworkDays') ? SUMMARY_CONSTANTS.homeworkDays : null,
    intensiveEnglishDays: hasRole('intensiveEnglishDays') ? SUMMARY_CONSTANTS.intensiveEnglishDays : null,
    saturdayTutoringDays: hasRole('saturdayTutoringDays') ? SUMMARY_CONSTANTS.saturdayTutoringDays : null,
  };
}
