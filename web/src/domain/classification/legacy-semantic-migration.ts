import type { ClassSetting, SummaryDayRole, SummaryDayRoleCondition } from '@/contracts/settings';
import { legacyClassSemanticsOf, legacySaturdayRoleRequiresSix } from './legacy-class-semantics';
import { SEED_CLASS_SEMANTICS } from './class-semantics';

export interface LegacySemanticMigrationCandidate {
  baseName: string;
  migrateSummaryDayRoles: boolean;
  migrateErpTierApplicability: boolean;
}

export interface LegacySemanticMigrationResult {
  classes: ClassSetting[];
  migratedClassCount: number;
  migratedSummaryRoleClassCount: number;
  migratedTierApplicabilityClassCount: number;
}

export interface LegacySemanticMigrationPreviewRow {
  anonymousClassLabel: string;
  summaryDayRolesBefore: SummaryDayRole[] | null;
  summaryDayRolesAfter: SummaryDayRole[];
  summaryDayRoleConditionsAfter: SummaryDayRoleCondition[];
  erpTierApplicabilityBefore: 'applicable' | 'not_applicable' | 'unset' | null;
  erpTierApplicabilityAfter: 'applicable' | 'not_applicable' | 'unset';
}

export interface LegacySemanticMigrationPreview {
  rows: LegacySemanticMigrationPreviewRow[];
  summary: Pick<LegacySemanticMigrationResult,
    'migratedClassCount' | 'migratedSummaryRoleClassCount' | 'migratedTierApplicabilityClassCount'>;
}

/** Frozen pre-#148 interpretation, used only while an operator creates an explicit migration version. */
function legacySummaryRoles(baseName: string): {
  roles: SummaryDayRole[];
  conditions: SummaryDayRoleCondition[];
} {
  const semantic = legacyClassSemanticsOf(baseName);
  const conditions: SummaryDayRoleCondition[] = legacySaturdayRoleRequiresSix(baseName)
    ? [{ role: 'saturdayTutoringDays', condition: 'raw_token_contains_six' }]
    : [];
  return { roles: semantic.summaryDayRoles, conditions };
}

/**
 * Convert old name-derived outputs into explicit settings data. This function is intentionally
 * called only from the operator-triggered legacy migration flow; readers/calculators never call it.
 */
export function migrateLegacyClassSemantics(
  classes: ClassSetting[],
  candidates: ReadonlyMap<string, LegacySemanticMigrationCandidate>
): LegacySemanticMigrationResult {
  let migratedSummaryRoleClassCount = 0;
  let migratedTierApplicabilityClassCount = 0;
  let migratedClassCount = 0;

  const nextClasses = classes.map((item) => {
    const candidate = candidates.get(item.baseName);
    if (!candidate || SEED_CLASS_SEMANTICS.has(item.baseName)) return item;
    let next = item;
    let changed = false;

    if (candidate.migrateSummaryDayRoles && (item.summaryDayRolesSource ?? 'unset') === 'unset') {
      const semantic = legacySummaryRoles(item.baseName);
      next = {
        ...next,
        summaryDayRoles: semantic.roles,
        summaryDayRoleConditions: semantic.conditions,
        summaryDayRolesStatus: 'configured',
        summaryDayRolesSource: 'legacy_migration',
      };
      migratedSummaryRoleClassCount++;
      changed = true;
    }

    if (candidate.migrateErpTierApplicability && (item.erpTierApplicabilitySource ?? 'unset') === 'unset') {
      next = {
        ...next,
        erpTierApplicability: legacyClassSemanticsOf(item.baseName).erpTierApplicability,
        erpTierApplicabilitySource: 'legacy_migration',
      };
      migratedTierApplicabilityClassCount++;
      changed = true;
    }

    if (changed) migratedClassCount++;
    return next;
  });

  return {
    classes: nextClasses,
    migratedClassCount,
    migratedSummaryRoleClassCount,
    migratedTierApplicabilityClassCount,
  };
}

/** Read-only, PII-free recommendation table model; class names never leave this function. */
export function previewLegacyClassSemanticsMigration(
  classes: ClassSetting[],
  candidates: ReadonlyMap<string, LegacySemanticMigrationCandidate>
): LegacySemanticMigrationPreview {
  const migrated = migrateLegacyClassSemantics(classes, candidates);
  const migratedByName = new Map(migrated.classes.map((item) => [item.baseName, item]));
  const rows: LegacySemanticMigrationPreviewRow[] = [];

  for (const candidate of candidates.values()) {
    const before = classes.find((item) => item.baseName === candidate.baseName);
    const after = migratedByName.get(candidate.baseName);
    if (!before || !after) continue;
    rows.push({
      anonymousClassLabel: `舊班 ${rows.length + 1}`,
      summaryDayRolesBefore: candidate.migrateSummaryDayRoles ? null : before.summaryDayRoles ?? [],
      summaryDayRolesAfter: after.summaryDayRoles ?? [],
      summaryDayRoleConditionsAfter: after.summaryDayRoleConditions ?? [],
      erpTierApplicabilityBefore: candidate.migrateErpTierApplicability
        ? null
        : before.erpTierApplicability ?? 'unset',
      erpTierApplicabilityAfter: after.erpTierApplicability ?? 'unset',
    });
  }

  return {
    rows,
    summary: {
      migratedClassCount: migrated.migratedClassCount,
      migratedSummaryRoleClassCount: migrated.migratedSummaryRoleClassCount,
      migratedTierApplicabilityClassCount: migrated.migratedTierApplicabilityClassCount,
    },
  };
}
