import Database from 'better-sqlite3';
import {
  RUN_DIAGNOSTIC_ALGORITHM_VERSION,
  formalProjectionHash,
  runDiagnosticPayloadSchema,
  effectiveInputsSchema,
  sha256,
  sortDiagnosticDifferences,
  sortDiagnosticStudents,
  stableJson,
  type RunDiagnosticDifference,
  type RunDiagnosticStudentProjection,
} from '@/contracts/run-diagnostics';
import type { CalculationRunRecord } from './runs-repository';

export type RunDiagnosticsReadResult =
  | { status: 'version-unavailable' }
  | { status: 'content-missing' }
  | { status: 'corrupted' }
  | { status: 'supported'; diagnosticAlgorithmVersion: typeof RUN_DIAGNOSTIC_ALGORITHM_VERSION; differences: RunDiagnosticDifference[]; totalDifferences: number };

/** Read and validate the immutable content. This function issues SELECTs only. */
export function readRunDiagnostics(db: Database.Database, run: CalculationRunRecord): RunDiagnosticsReadResult {
  if (run.diagnosticAlgorithmVersion !== RUN_DIAGNOSTIC_ALGORITHM_VERSION) {
    return { status: 'version-unavailable' };
  }

  const row = db.prepare('SELECT * FROM run_diagnostics WHERE run_id = ?').get(run.id) as any;
  if (!row) return { status: 'content-missing' };

  try {
    if (row.algorithm_version !== run.diagnosticAlgorithmVersion ||
      row.payload_schema_version !== 1 ||
      sha256(row.payload_json) !== row.payload_hash ||
      sha256(row.effective_inputs_json) !== row.effective_inputs_hash) {
      return { status: 'corrupted' };
    }

    const rawPayload: unknown = JSON.parse(row.payload_json);
    const payloadResult = runDiagnosticPayloadSchema.safeParse(rawPayload);
    if (!payloadResult.success) return { status: 'corrupted' };
    const payload = payloadResult.data;

    const rawInputs: unknown = JSON.parse(row.effective_inputs_json);
    const inputsResult = effectiveInputsSchema.safeParse(rawInputs);
    if (!inputsResult.success) return { status: 'corrupted' };
    const effectiveInputs = inputsResult.data;

    if (payload.runId !== run.id || payload.diagnosticAlgorithmVersion !== run.diagnosticAlgorithmVersion ||
      payload.payloadSchemaVersion !== row.payload_schema_version ||
      payload.againstRuleSet !== 'excel-v260922-compat' ||
      payload.totalStudents !== run.totalStudents || payload.projectionCount !== payload.students.length ||
      payload.totalDifferences !== payload.differences.length ||
      effectiveInputs.importId !== run.importId || effectiveInputs.scheduleVersionId !== run.scheduleVersionId ||
      effectiveInputs.calculationPolicies.formalRuleSetVersion !== run.ruleSetVersion ||
      effectiveInputs.calculationPolicies.numericPolicy !== run.numericPolicy) {
      return { status: 'corrupted' };
    }

    const studentKeys = new Set(payload.students.map((student) => student.personCode));
    if (studentKeys.size !== payload.students.length) return { status: 'corrupted' };
    const sortedStudents = sortDiagnosticStudents(payload.students);
    if (stableJson(sortedStudents) !== stableJson(payload.students)) return { status: 'corrupted' };

    const resultRows = db.prepare(`
      SELECT person_code, name, base_discount_bps, anqin_days, tutoring_days, trace
      FROM student_calculations WHERE run_id = ? ORDER BY person_code ASC
    `).all(run.id) as any[];
    if (resultRows.length !== run.totalStudents) return { status: 'corrupted' };

    const savedResults = new Map<string, { personCode: string; name: string; sourceRow: number; values: { baseDiscountBps: number | null; anqinDays: number | null; tutoringDays: number | null } }>();
    try {
      for (const result of resultRows) {
        const trace = JSON.parse(result.trace);
        if (!Number.isInteger(trace.sourceRow) || trace.sourceRow <= 0 || savedResults.has(result.person_code)) {
          return { status: 'corrupted' };
        }
        savedResults.set(result.person_code, {
          personCode: result.person_code,
          name: result.name,
          sourceRow: trace.sourceRow,
          values: {
            baseDiscountBps: result.base_discount_bps,
            anqinDays: result.anqin_days,
            tutoringDays: result.tutoring_days,
          },
        });
      }
    } catch {
      return { status: 'corrupted' };
    }

    if (savedResults.size !== payload.students.length || payload.students.some((student) => !savedResults.has(student.personCode))) {
      return { status: 'corrupted' };
    }

    const formalRows: Array<{ personCode: string; name: string; sourceRow: number; values: { baseDiscountBps: number | null; anqinDays: number | null; tutoringDays: number | null } }> = [];
    for (const projection of payload.students) {
      const saved = savedResults.get(projection.personCode)!;
      if (saved.sourceRow !== projection.sourceRow ||
        saved.values.baseDiscountBps !== projection.formal.baseDiscountBps ||
        saved.values.anqinDays !== projection.formal.anqinDays ||
        saved.values.tutoringDays !== projection.formal.tutoringDays) {
        return { status: 'corrupted' };
      }
      formalRows.push({ ...saved, values: projection.formal });
    }

    const actualFormalHash = formalProjectionHash([...savedResults.values()]);
    const payloadFormalHash = formalProjectionHash(formalRows);
    if (actualFormalHash !== row.formal_result_hash || payloadFormalHash !== row.formal_result_hash) {
      return { status: 'corrupted' };
    }

    const differenceKeys = new Set<string>();
    for (const difference of payload.differences) {
      const key = JSON.stringify([difference.personCode, difference.field]);
      const projection = payload.students.find((student) => student.personCode === difference.personCode);
      const saved = savedResults.get(difference.personCode);
      if (differenceKeys.has(key) || !projection || !saved ||
        difference.name !== saved.name || difference.sourceRow !== projection.sourceRow ||
        difference.formalValue !== projection.formal[difference.field] ||
        difference.compatValue !== projection.compat[difference.field] ||
        difference.formalValue === difference.compatValue ||
        difference.category !== (difference.field === 'baseDiscountBps' ? 'DISCOUNT_DIFFERENCE' : 'CARE_DAYS_DIFFERENCE')) {
        return { status: 'corrupted' };
      }
      differenceKeys.add(key);
    }
    if (stableJson(sortDiagnosticDifferences(payload.differences)) !== stableJson(payload.differences)) {
      return { status: 'corrupted' };
    }

    return {
      status: 'supported',
      diagnosticAlgorithmVersion: RUN_DIAGNOSTIC_ALGORITHM_VERSION,
      differences: payload.differences,
      totalDifferences: payload.totalDifferences,
    };
  } catch {
    return { status: 'corrupted' };
  }
}
