import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Immutable comparison content captured by the calculation invocation that created a run. */
export const RUN_DIAGNOSTIC_ALGORITHM_VERSION = 'comparison-snapshot-v1' as const;
export const RUN_DIAGNOSTIC_PAYLOAD_SCHEMA_VERSION = 1 as const;

export const DIAGNOSTIC_FIELDS = ['baseDiscountBps', 'anqinDays', 'tutoringDays'] as const;
export type DiagnosticField = (typeof DIAGNOSTIC_FIELDS)[number];
export type DiagnosticValues = Record<DiagnosticField, number | null>;

export interface RunDiagnosticStudentProjection {
  personCode: string;
  sourceRow: number;
  formal: DiagnosticValues;
  compat: DiagnosticValues;
}

export interface RunDiagnosticDifference {
  personCode: string;
  name: string;
  sourceRow: number;
  field: DiagnosticField;
  formalValue: number | null;
  compatValue: number | null;
  category: 'DISCOUNT_DIFFERENCE' | 'CARE_DAYS_DIFFERENCE';
}

export interface RunDiagnosticPayload {
  runId: string;
  diagnosticAlgorithmVersion: typeof RUN_DIAGNOSTIC_ALGORITHM_VERSION;
  payloadSchemaVersion: typeof RUN_DIAGNOSTIC_PAYLOAD_SCHEMA_VERSION;
  againstRuleSet: 'excel-v260922-compat';
  generatorRevision: string;
  totalStudents: number;
  projectionCount: number;
  totalDifferences: number;
  students: RunDiagnosticStudentProjection[];
  differences: RunDiagnosticDifference[];
}

export interface RunDiagnosticEffectiveInputs {
  evidenceSchemaVersion: 1;
  importId: string;
  importSnapshotHash: string;
  scheduleVersionId: string;
  settingsSnapshotHash: string | null;
  seedScheduleHash: string;
  calculationPolicies: {
    formalRuleSetVersion: string;
    numericPolicy: string;
    compatRuleSetVersion: 'excel-v260922-compat';
    overlapWindows: {
      anqin: { start: number; end: number; weekdays: string[] };
      tutoring: { start: number; end: number; weekdays: string[] };
      minutesPerBillingDay: number;
      tutoringSpecialRule: { minimumOverlapMinutes: number; exclusiveEndAfter: number; exclusiveEndBefore: number };
      comparisonPrecision: '15-significant-digits';
      formalRounding: { zeroBelow: number; fullAtOrAbove: number; epsilon: number };
    };
    compatNumericKernel: {
      sessionTimeConversion: 'minute-value-divided-by-1440';
      overlapOperationOrder: 'max-0-min-end-windowEnd-minus-max-start-windowStart';
      overlapMinutesOperationOrder: 'day-overlap-times-24-times-60';
      perSessionRawOrder: 'negative-overlap-divided-by-60-then-3';
      accumulationOrder: 'persisted-enrollment-and-session-order';
      specialTutoringThreshold: '15-significant-digit-overlap-at-least-120';
      negativeRounding: 'floor-total-then-fraction-thresholds-0.3-and-0.8';
      comparisonPrecision: '15-significant-digits';
    };
  };
  aliases: Array<{ rawBaseName: string; targetBaseName: string }>;
  effectiveClassSettings: Array<{
    baseName: string;
    classType: string;
    category: string;
    categorySource: string;
    fixedFiveDays: boolean;
  }>;
  effectiveSessions: Array<{
    baseName: string;
    source: 'saved-setting' | 'seed' | 'missing';
    sessions: Array<{ start: number | null; end: number | null; weekday: string | null; skipDeduction: boolean }>;
  }>;
  enrollmentOrder: Array<{ personCode: string; sourceRow: number; baseNames: string[] }>;
}

export interface RunDiagnosticsSnapshot {
  algorithmVersion: typeof RUN_DIAGNOSTIC_ALGORITHM_VERSION;
  payload: RunDiagnosticPayload;
  effectiveInputs: RunDiagnosticEffectiveInputs;
}

const finiteNullable = z.number().finite().nullable();
const valuesSchema = z.object({
  baseDiscountBps: finiteNullable,
  anqinDays: finiteNullable,
  tutoringDays: finiteNullable,
}).strict();
const studentSchema = z.object({
  personCode: z.string().min(1),
  sourceRow: z.number().int().positive(),
  formal: valuesSchema,
  compat: valuesSchema,
}).strict();
const differenceSchema = z.object({
  personCode: z.string().min(1),
  name: z.string(),
  sourceRow: z.number().int().positive(),
  field: z.enum(DIAGNOSTIC_FIELDS),
  formalValue: finiteNullable,
  compatValue: finiteNullable,
  category: z.enum(['DISCOUNT_DIFFERENCE', 'CARE_DAYS_DIFFERENCE']),
}).strict();

export const runDiagnosticPayloadSchema = z.object({
  runId: z.string().min(1),
  diagnosticAlgorithmVersion: z.literal(RUN_DIAGNOSTIC_ALGORITHM_VERSION),
  payloadSchemaVersion: z.literal(RUN_DIAGNOSTIC_PAYLOAD_SCHEMA_VERSION),
  againstRuleSet: z.literal('excel-v260922-compat'),
  generatorRevision: z.string().min(1),
  totalStudents: z.number().int().nonnegative(),
  projectionCount: z.number().int().nonnegative(),
  totalDifferences: z.number().int().nonnegative(),
  students: z.array(studentSchema),
  differences: z.array(differenceSchema),
}).strict();

export const effectiveInputsSchema = z.object({
  evidenceSchemaVersion: z.literal(1),
  importId: z.string().min(1),
  importSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  scheduleVersionId: z.string().min(1),
  settingsSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  seedScheduleHash: z.string().regex(/^[a-f0-9]{64}$/),
  calculationPolicies: z.object({
    formalRuleSetVersion: z.string().min(1),
    numericPolicy: z.string().min(1),
    compatRuleSetVersion: z.literal('excel-v260922-compat'),
    overlapWindows: z.object({
      anqin: z.object({ start: z.number().int(), end: z.number().int(), weekdays: z.array(z.string()) }).strict(),
      tutoring: z.object({ start: z.number().int(), end: z.number().int(), weekdays: z.array(z.string()) }).strict(),
      minutesPerBillingDay: z.number().positive(),
      tutoringSpecialRule: z.object({ minimumOverlapMinutes: z.number(), exclusiveEndAfter: z.number(), exclusiveEndBefore: z.number() }).strict(),
      comparisonPrecision: z.literal('15-significant-digits'),
      formalRounding: z.object({ zeroBelow: z.number(), fullAtOrAbove: z.number(), epsilon: z.number() }).strict(),
    }).strict(),
    compatNumericKernel: z.object({
      sessionTimeConversion: z.literal('minute-value-divided-by-1440'),
      overlapOperationOrder: z.literal('max-0-min-end-windowEnd-minus-max-start-windowStart'),
      overlapMinutesOperationOrder: z.literal('day-overlap-times-24-times-60'),
      perSessionRawOrder: z.literal('negative-overlap-divided-by-60-then-3'),
      accumulationOrder: z.literal('persisted-enrollment-and-session-order'),
      specialTutoringThreshold: z.literal('15-significant-digit-overlap-at-least-120'),
      negativeRounding: z.literal('floor-total-then-fraction-thresholds-0.3-and-0.8'),
      comparisonPrecision: z.literal('15-significant-digits'),
    }).strict(),
  }).strict(),
  aliases: z.array(z.object({ rawBaseName: z.string(), targetBaseName: z.string() }).strict()),
  effectiveClassSettings: z.array(z.object({
    baseName: z.string(), classType: z.string(), category: z.string(), categorySource: z.string(), fixedFiveDays: z.boolean(),
  }).strict()),
  effectiveSessions: z.array(z.object({
    baseName: z.string(), source: z.enum(['saved-setting', 'seed', 'missing']),
    sessions: z.array(z.object({ start: z.number().int().nullable(), end: z.number().int().nullable(), weekday: z.string().nullable(), skipDeduction: z.boolean() }).strict()),
  }).strict()),
  enrollmentOrder: z.array(z.object({ personCode: z.string().min(1), sourceRow: z.number().int().positive(), baseNames: z.array(z.string()) }).strict()),
}).strict();

export function stableJson(value: unknown): string {
  const normalize = (item: any): any => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function projectDiagnosticValues(values: Partial<DiagnosticValues>): DiagnosticValues {
  return {
    baseDiscountBps: values.baseDiscountBps ?? null,
    anqinDays: values.anqinDays ?? null,
    tutoringDays: values.tutoringDays ?? null,
  };
}

export function compareDiagnosticValues(
  projection: RunDiagnosticStudentProjection,
  name: string
): RunDiagnosticDifference[] {
  const differences: RunDiagnosticDifference[] = [];
  for (const field of DIAGNOSTIC_FIELDS) {
    const formalValue = projection.formal[field];
    const compatValue = projection.compat[field];
    if (formalValue !== compatValue) {
      differences.push({
        personCode: projection.personCode,
        name,
        sourceRow: projection.sourceRow,
        field,
        formalValue,
        compatValue,
        category: field === 'baseDiscountBps' ? 'DISCOUNT_DIFFERENCE' : 'CARE_DAYS_DIFFERENCE',
      });
    }
  }
  return differences;
}

export function sortDiagnosticStudents<T extends Pick<RunDiagnosticStudentProjection, 'sourceRow' | 'personCode'>>(students: T[]): T[] {
  return [...students].sort((a, b) => a.sourceRow - b.sourceRow || (a.personCode < b.personCode ? -1 : a.personCode > b.personCode ? 1 : 0));
}

export function sortDiagnosticDifferences(differences: RunDiagnosticDifference[]): RunDiagnosticDifference[] {
  const fieldRank = new Map<DiagnosticField, number>(DIAGNOSTIC_FIELDS.map((field, index) => [field, index]));
  return [...differences].sort((a, b) => a.sourceRow - b.sourceRow ||
    (a.personCode < b.personCode ? -1 : a.personCode > b.personCode ? 1 : 0) ||
    fieldRank.get(a.field)! - fieldRank.get(b.field)!);
}

export function formalProjectionHash(rows: Array<{ personCode: string; name: string; sourceRow: number; values: DiagnosticValues }>): string {
  const sorted = [...rows].sort((a, b) => a.sourceRow - b.sourceRow || (a.personCode < b.personCode ? -1 : a.personCode > b.personCode ? 1 : 0));
  return sha256(stableJson(sorted));
}
