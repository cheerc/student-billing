import {
  DEFAULT_CLASS_TYPE_DEFINITIONS,
  type ClassSetting,
  type ClassTypeDefinition,
  type SettingsDraft,
  SettingsDraftReadSchema,
  type SummaryDayRole,
} from '@/contracts/settings';
import { SEED_CLASS_CATEGORIES, SEED_CLASSES } from '@/domain/schedules/seed-manifest';

export interface SeedClassSemantics {
  classTypeId: 'care' | 'non_care';
  summaryDayRoles: SummaryDayRole[];
  erpTierApplicability: 'applicable' | 'not_applicable';
}

/**
 * Explicit, synthetic semantics for the fixed seed manifest. This is characterization data only:
 * PR-3 stores it in settings and run snapshots but does not change billing/report consumers.
 */
const CARE_SEED_NAMES = [
  '國小輔導-一A', '國小輔導-一B', '國小輔導-二A', '國小輔導-二B',
  '國小輔導-三年級', '國小輔導-五年級', '國小輔導-六年級', '國小輔導-四年級',
] as const;
const MATH_SEED_NAMES = [
  '國小數學-一A', '國小數學-一B', '國小數學-二A', '國小數學-二B',
  '國小數學-三A', '國小數學-三B', '國小數學-五A', '國小數學-五B',
  '國小數學-六A', '國小數學-六B', '國小數學-四A', '國小數學-四B',
] as const;
const ENGLISH_SEED_NAMES = [
  '兒童美語-Gino', '兒童美語-Archy', '兒童美語-Chevady', '兒童美語-Cody',
  '兒童美語-Ali', '兒童美語-Dommie', '兒童美語-EC', '兒童美語-ED',
  '兒童美語-Pluto', '兒童美語-EF', '兒童美語-EG', '兒童美語-EK',
  '兒童美語-EL', '兒童美語-EM', '兒童美語-Kirra', '兒童美語-Norma',
  '兒童美語-Hopper', '兒童美語-Teffer', '兒童美語-Toker', '兒童美語-KA',
  '兒童美語-KB', '兒童美語-KC', '兒童美語-EA', '兒童美語-EB',
] as const;
const CHINESE_SEED_NAMES = ['國小國語文-小三小四', '國小國語文-小五'] as const;
const SATURDAY_SEED_NAMES = ['小六加強班-自然', '小六加強班-國文', '小六加強班-數學'] as const;

const seedRows: Array<[string, SeedClassSemantics]> = [
  ...CARE_SEED_NAMES.map((name) => [name, {
    classTypeId: 'care', summaryDayRoles: [], erpTierApplicability: 'applicable',
  }] as [string, SeedClassSemantics]),
  ...MATH_SEED_NAMES.map((name) => [name, {
    classTypeId: 'non_care', summaryDayRoles: ['mathDays'], erpTierApplicability: 'not_applicable',
  }] as [string, SeedClassSemantics]),
  ...ENGLISH_SEED_NAMES.map((name) => [name, {
    classTypeId: 'non_care', summaryDayRoles: ['englishDays'], erpTierApplicability: 'not_applicable',
  }] as [string, SeedClassSemantics]),
  ...CHINESE_SEED_NAMES.map((name) => [name, {
    classTypeId: 'non_care', summaryDayRoles: ['chineseDays'], erpTierApplicability: 'not_applicable',
  }] as [string, SeedClassSemantics]),
  ...SATURDAY_SEED_NAMES.map((name) => [name, {
    classTypeId: 'non_care', summaryDayRoles: ['saturdayTutoringDays'], erpTierApplicability: 'not_applicable',
  }] as [string, SeedClassSemantics]),
];

export const SEED_CLASS_SEMANTICS: ReadonlyMap<string, SeedClassSemantics & {
  category: string;
  subject: string;
}> = new Map(seedRows.map(([baseName, semantics]) => {
  const seed = SEED_CLASSES.find((item) => item.baseName === baseName);
  const category = SEED_CLASS_CATEGORIES.get(baseName);
  if (!seed || !category) throw new Error(`Seed semantic row is missing manifest data: ${baseName}`);
  return [baseName, { ...semantics, category, subject: seed.subject }];
}));

if (
  SEED_CLASS_SEMANTICS.size !== SEED_CLASSES.length ||
  SEED_CLASSES.some((seed) => !SEED_CLASS_SEMANTICS.has(seed.baseName))
) {
  throw new Error('Seed semantic fixture must contain exactly one row for each of the 49 seed classes');
}

export type SemanticClassSetting = ClassSetting & {
  classTypeId: string;
  summaryDayRoles: SummaryDayRole[];
  summaryDayRolesStatus: 'configured' | 'unset' | 'unavailable';
  summaryDayRolesSource: 'manual' | 'seed' | 'legacy_migration' | 'unset';
  erpTierApplicability: 'applicable' | 'not_applicable' | 'unset';
  erpTierApplicabilitySource: 'manual' | 'seed' | 'legacy_migration' | 'unset';
  subjectSource: 'manual' | 'seed' | 'legacy_migration' | 'unset';
};

export interface SemanticRename { from: string; to: string }
export interface SemanticMerge { mergedName: string; sources: string[] }

/** Explicitly clear values that a selected class type does not support; never drop them implicitly. */
export function clearUnsupportedClassSemantics(
  item: ClassSetting,
  definition: ClassTypeDefinition
): ClassSetting {
  const supports = (key: ClassTypeDefinition['supportedAttributeKeys'][number]) =>
    definition.supportedAttributeKeys.includes(key);
  const existingRoles = item.summaryDayRoles ?? [];
  const allowedRoles = supports('summaryDayRoles')
    ? existingRoles.filter((role) => definition.summaryRoleOptions.includes(role))
    : [];
  const removedRoleOptions = allowedRoles.length !== existingRoles.length;
  return {
    ...item,
    ...(!supports('subject') ? { subject: '', subjectSource: 'unset' as const } : {}),
    ...(!supports('category') ? { category: 'unset' as const, categorySource: 'unset' as const } : {}),
    ...(!supports('fixedFiveDays') ? { fixedFiveDays: undefined } : {}),
    ...(!supports('skipDeduction') ? {
      sessions: item.sessions.map((session) => ({ ...session, skipDeduction: false })),
    } : {}),
    ...(!supports('summaryDayRoles') ? {
      summaryDayRoles: [],
      summaryDayRolesStatus: 'unset' as const,
      summaryDayRolesSource: 'unset' as const,
    } : {}),
    ...(supports('summaryDayRoles') && removedRoleOptions ? {
      summaryDayRoles: allowedRoles,
      ...(allowedRoles.length === 0 ? {
        summaryDayRolesStatus: 'unset' as const,
        summaryDayRolesSource: 'unset' as const,
      } : {}),
    } : {}),
    ...(!supports('erpTierApplicability') ? {
      erpTierApplicability: 'unset' as const,
      erpTierApplicabilitySource: 'unset' as const,
    } : {}),
  };
}

function semanticFields(item: ClassSetting): Partial<SemanticClassSetting> {
  return {
    classTypeId: item.classTypeId ?? item.classType,
    subject: item.subject,
    subjectSource: item.subjectSource,
    summaryDayRoles: item.summaryDayRoles ?? [],
    summaryDayRolesStatus: item.summaryDayRolesStatus ?? 'unset',
    summaryDayRolesSource: item.summaryDayRolesSource ?? 'unset',
    erpTierApplicability: item.erpTierApplicability ?? 'unset',
    erpTierApplicabilitySource: item.erpTierApplicabilitySource ?? 'unset',
  };
}

function comparableSemanticFields(item: ClassSetting): string {
  const fields = semanticFields(item);
  return JSON.stringify({
    classTypeId: fields.classTypeId,
    subject: fields.subject ?? '',
    subjectSource: fields.subjectSource,
    summaryDayRoles: fields.summaryDayRoles,
    summaryDayRolesStatus: fields.summaryDayRolesStatus,
    summaryDayRolesSource: fields.summaryDayRolesSource,
    erpTierApplicability: fields.erpTierApplicability,
    erpTierApplicabilitySource: fields.erpTierApplicabilitySource,
  });
}

/** Carry class semantics on rename; merging into an existing baseline class keeps the target. */
export function carryClassSemanticsOnRename(
  currentClasses: ClassSetting[],
  sourceClasses: ClassSetting[],
  renames: SemanticRename[],
  baselineNames: ReadonlySet<string>
): ClassSetting[] {
  const sources = new Map(sourceClasses.map((item) => [item.baseName, item]));
  const output = new Map(currentClasses.map((item) => [item.baseName, item]));
  for (const { from, to } of renames) {
    if (baselineNames.has(to)) continue;
    const before = sources.get(from);
    const target = output.get(to);
    if (!before || !target) continue;
    const carried = semanticFields(before);
    output.set(to, {
      ...target,
      ...carried,
    });
  }
  return [...output.values()];
}

/** A merge of renamed classes with different semantic settings is blocked for explicit review. */
export function detectSemanticMergeConflicts(
  merges: SemanticMerge[],
  sourceClasses: ClassSetting[]
): SemanticMerge[] {
  const byName = new Map(sourceClasses.map((item) => [item.baseName, item]));
  return merges.filter((merge) => {
    const rows = merge.sources.map((name) => byName.get(name)).filter((row): row is ClassSetting => Boolean(row));
    return rows.length > 1 && rows.some((row) => comparableSemanticFields(row) !== comparableSemanticFields(rows[0]));
  });
}

/** Apply the semantic projection to the current row-generated settings without affecting billing fields. */
export function overlayClassSemantics<T extends { baseName: string }>(
  currentClasses: T[],
  semanticClasses: ClassSetting[]
): Array<T & Partial<ClassSetting>> {
  const byName = new Map(semanticClasses.map((item) => [item.baseName, item]));
  return currentClasses.map((item) => {
    const semantic = byName.get(item.baseName);
    return (semantic ? { ...item, ...semanticFields(semantic) } : item) as T & Partial<ClassSetting>;
  });
}

/** Read-only hydration of old settings JSON. It never writes back or infers non-seed semantics. */
export function normalizeSettingsDraftSemantics(input: SettingsDraft | unknown): SettingsDraft & {
  classTypeDefinitions: ClassTypeDefinition[];
  classes: SemanticClassSetting[];
} {
  const parsed = SettingsDraftReadSchema.parse(input);
  const definitions = parsed.classTypeDefinitions ?? DEFAULT_CLASS_TYPE_DEFINITIONS;
  const legacySettings = parsed.classTypeDefinitions === undefined;
  const normalized = parsed.classes.map((item) => {
    const seed = SEED_CLASS_SEMANTICS.get(item.baseName);
    const classTypeId = item.classTypeId ?? item.classType ?? seed?.classTypeId ??
      (legacySettings ? (item.fixedFiveDays === true ? 'care' : 'non_care') : undefined);
    if (!classTypeId) throw new Error(`新設定班級「${item.baseName}」必須明確選擇課程類型`);
    const summaryDayRoles = item.summaryDayRoles ?? seed?.summaryDayRoles ?? [];
    const rolesSource = item.summaryDayRolesSource ?? (item.summaryDayRolesStatus === 'unset'
      ? 'unset'
      : item.summaryDayRoles ? 'manual' : seed ? 'seed' : 'unset');
    const subject = item.subject ?? seed?.subject ?? '';
    const subjectSource = item.subjectSource ?? (seed && item.subject === undefined
      ? 'seed'
      : subject.trim() ? 'legacy_migration' : 'unset');
    const tierApplicability = item.erpTierApplicability ?? seed?.erpTierApplicability ?? 'unset';
    const tierSource = item.erpTierApplicabilitySource ?? (item.erpTierApplicability && item.erpTierApplicability !== 'unset'
      ? 'manual'
      : item.erpTierApplicability === 'unset' ? 'unset' : seed ? 'seed' : 'unset');
    const summaryDayRolesStatus = item.summaryDayRolesStatus ??
      (rolesSource === 'unset' ? 'unset' : 'configured');
    const definition = definitions.find((entry) => entry.id === classTypeId);
    if (!definition) throw new Error(`找不到課程類型 ${classTypeId}`);
    return {
      ...item,
      subject,
      subjectSource,
      classTypeId,
      summaryDayRoles,
      summaryDayRolesStatus,
      summaryDayRolesSource: rolesSource,
      erpTierApplicability: tierApplicability,
      erpTierApplicabilitySource: tierSource,
    } as SemanticClassSetting;
  });
  return {
    ...parsed,
    classTypeDefinitions: [...definitions],
    classes: normalized,
  };
}

