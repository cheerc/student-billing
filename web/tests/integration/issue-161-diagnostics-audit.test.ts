import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  RUN_DIAGNOSTIC_ALGORITHM_VERSION,
  formalProjectionHash,
  sha256,
  type RunDiagnosticEffectiveInputs,
  type RunDiagnosticPayload,
} from '@/contracts/run-diagnostics';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { auditIssue161Diagnostics } from '../../scripts/audit-issue-161-diagnostics';
import historicalGolden from '../fixtures/issue-161/comparison-snapshot-v1/two-generation-golden.json';
import { activateBatch, makeStudent, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';

function installSyntheticHistoricalSnapshot(db: Database.Database, runId: string): void {
  const run = getCalculationRun(db, runId);
  if (!run) throw new Error('synthetic run missing');
  const template = historicalGolden.payload as RunDiagnosticPayload;
  const rows = db.prepare(`
    SELECT person_code, name, base_discount_bps, anqin_days, tutoring_days, trace
    FROM student_calculations WHERE run_id = ? ORDER BY person_code
  `).all(runId) as Array<{
    person_code: string;
    name: string;
    base_discount_bps: number | null;
    anqin_days: number | null;
    tutoring_days: number | null;
    trace: string;
  }>;
  const students: RunDiagnosticPayload['students'] = rows.map((row) => {
    const trace = JSON.parse(row.trace) as { sourceRow: number };
    const historical = template.students.find((student) => student.personCode === row.person_code);
    if (!historical || historical.sourceRow !== trace.sourceRow) throw new Error('historical golden student mismatch');
    db.prepare(`
      UPDATE student_calculations SET base_discount_bps = ?, anqin_days = ?, tutoring_days = ?
      WHERE run_id = ? AND person_code = ?
    `).run(
      historical.formal.baseDiscountBps,
      historical.formal.anqinDays,
      historical.formal.tutoringDays,
      runId,
      row.person_code,
    );
    return {
      personCode: row.person_code,
      sourceRow: trace.sourceRow,
      formal: historical.formal,
      compat: historical.compat,
    };
  }).sort((left, right) => left.sourceRow - right.sourceRow || left.personCode.localeCompare(right.personCode));
  const payload: RunDiagnosticPayload = {
    ...template,
    runId,
    students,
    differences: template.differences.map((difference) => ({ ...difference })),
  };
  const effectiveInputs: RunDiagnosticEffectiveInputs = {
    evidenceSchemaVersion: 1,
    importId: run.importId,
    importSnapshotHash: 'a'.repeat(64),
    scheduleVersionId: run.scheduleVersionId,
    settingsSnapshotHash: null,
    seedScheduleHash: 'b'.repeat(64),
    calculationPolicies: {
      formalRuleSetVersion: run.ruleSetVersion,
      numericPolicy: run.numericPolicy,
      compatRuleSetVersion: 'excel-v260922-compat',
      overlapWindows: {
        anqin: { start: 780, end: 960, weekdays: ['一', '二', '三', '四', '五'] },
        tutoring: { start: 990, end: 1170, weekdays: ['一', '二', '三', '四', '五'] },
        minutesPerBillingDay: 180,
        tutoringSpecialRule: { minimumOverlapMinutes: 120, exclusiveEndAfter: 1110, exclusiveEndBefore: 1170 },
        comparisonPrecision: '15-significant-digits',
        formalRounding: { zeroBelow: 0.3, fullAtOrAbove: 0.8, epsilon: 0 },
      },
      compatNumericKernel: {
        sessionTimeConversion: 'minute-value-divided-by-1440',
        overlapOperationOrder: 'max-0-min-end-windowEnd-minus-max-start-windowStart',
        overlapMinutesOperationOrder: 'day-overlap-times-24-times-60',
        perSessionRawOrder: 'negative-overlap-divided-by-60-then-3',
        accumulationOrder: 'persisted-enrollment-and-session-order',
        specialTutoringThreshold: '15-significant-digit-overlap-at-least-120',
        negativeRounding: 'floor-total-then-fraction-thresholds-0.3-and-0.8',
        comparisonPrecision: '15-significant-digits',
      },
    },
    aliases: [],
    effectiveClassSettings: [],
    effectiveSessions: [],
    enrollmentOrder: students.map((student) => ({
      personCode: student.personCode,
      sourceRow: student.sourceRow,
      baseNames: ['國小輔導-新開班', '國小數學-三A'],
    })),
  };
  const payloadJson = JSON.stringify(payload);
  const inputsJson = JSON.stringify(effectiveInputs);
  const formalRows = students.map((student) => ({
    personCode: student.personCode,
    name: rows.find((row) => row.person_code === student.personCode)!.name,
    sourceRow: student.sourceRow,
    values: student.formal,
  }));

  db.prepare('UPDATE calculation_runs SET diagnostic_algorithm_version = ? WHERE id = ?')
    .run(RUN_DIAGNOSTIC_ALGORITHM_VERSION, runId);
  db.prepare(`
    INSERT INTO run_diagnostics (
      run_id, algorithm_version, payload_schema_version, payload_json, effective_inputs_json,
      payload_hash, effective_inputs_hash, formal_result_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    RUN_DIAGNOSTIC_ALGORITHM_VERSION,
    1,
    payloadJson,
    inputsJson,
    sha256(payloadJson),
    sha256(inputsJson),
    formalProjectionHash(formalRows),
    '2026-10-20T08:00:01.000Z',
  );
}

describe('Issue #161 legacy audit: historic snapshots stay auditable; PR-1 runs have none', () => {
  const ctx = useGlobalTempDb('sb-issue-161-audit-');

  it('reports a new run as unavailable and does not modify or expose its data', () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_audit_new', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_AUDIT_NEW', ['國小輔導-新開班'], { grade: 1 }),
    ]);
    const created = activateBatch(db, 'imp_161_audit_new', 'k-161-audit-new');
    const summary = auditIssue161Diagnostics(db);
    expect(summary).toMatchObject({
      totalRuns: 1,
      supportedRuns: 0,
      unavailableRuns: 1,
      corruptedRuns: 0,
      projectionCount: 0,
      storedDifferenceCount: 0,
      expectedDifferenceCount: 0,
      differenceSetFailures: 0,
      queryOnly: true,
    });
    expect(summary.dataVersionAfter).toBe(summary.dataVersionBefore);
    expect(Object.keys(summary)).not.toContain('runId');
    expect(JSON.stringify(summary)).not.toContain('SYNTH_AUDIT_NEW');
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_diagnostics WHERE run_id = ?').get(created.runId)).toMatchObject({ n: 0 });
  });

  it('audits a manually installed synthetic historical snapshot and detects an omitted valid difference', () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_audit_history', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_FP', ['國小輔導-新開班'], { grade: 1, sourceRow: 1 }),
      makeStudent('SYNTH_FN', ['國小輔導-新開班', '國小數學-三A'], { grade: 1, sourceRow: 2 }),
    ]);
    const created = activateBatch(db, 'imp_161_audit_history', 'k-161-audit-history');
    installSyntheticHistoricalSnapshot(db, created.runId);

    const completeSummary = auditIssue161Diagnostics(db);
    expect(completeSummary).toMatchObject({
      totalRuns: 1,
      supportedRuns: 1,
      unavailableRuns: 0,
      corruptedRuns: 0,
      projectionCount: 2,
      storedDifferenceCount: 3,
      expectedDifferenceCount: 3,
      differenceSetFailures: 0,
      queryOnly: true,
    });
    expect(completeSummary.dataVersionAfter).toBe(completeSummary.dataVersionBefore);
    expect(Object.keys(completeSummary)).not.toContain('runId');
    expect(JSON.stringify(completeSummary)).not.toContain('SYNTH_FN');

    const snapshotRow = db.prepare('SELECT payload_json FROM run_diagnostics WHERE run_id = ?').get(created.runId) as { payload_json: string };
    const payload = JSON.parse(snapshotRow.payload_json) as RunDiagnosticPayload;
    payload.differences = [];
    payload.totalDifferences = 0;
    const incompletePayloadJson = JSON.stringify(payload);
    db.pragma('query_only = OFF');
    db.exec('DROP TRIGGER run_diagnostics_immutable_update');
    db.prepare('UPDATE run_diagnostics SET payload_json = ?, payload_hash = ? WHERE run_id = ?')
      .run(incompletePayloadJson, sha256(incompletePayloadJson), created.runId);

    const incompleteSummary = auditIssue161Diagnostics(db);
    expect(incompleteSummary).toMatchObject({
      totalRuns: 1,
      supportedRuns: 1,
      unavailableRuns: 0,
      corruptedRuns: 0,
      storedDifferenceCount: 0,
      expectedDifferenceCount: 3,
      differenceSetFailures: 1,
      queryOnly: true,
    });
    expect(incompleteSummary.dataVersionAfter).toBe(incompleteSummary.dataVersionBefore);
    expect(JSON.stringify(incompleteSummary)).not.toContain('SYNTH_AUDIT_HISTORY');
  });
});
