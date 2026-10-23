import { describe, expect, it } from 'vitest';
import { auditIssue161Diagnostics } from '../../scripts/audit-issue-161-diagnostics';
import { sha256 } from '@/contracts/run-diagnostics';
import { activateBatch, makeStudent, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';

describe('Issue #161: local audit detects incomplete frozen difference projections without exposing records', () => {
  const ctx = useGlobalTempDb('sb-issue-161-audit-');

  it('reports aggregate integrity counts and detects an omitted saved difference', () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_audit', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_AUDIT', ['國小輔導-新開班', '國小數學-三A'], { grade: 1 }),
    ]);
    const created = activateBatch(db, 'imp_161_audit', 'k-161-audit');
    const row = db.prepare('SELECT payload_json FROM run_diagnostics WHERE run_id = ?').get(created.runId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json);
    expect(payload.totalDifferences).toBeGreaterThan(0);
    const completePayload = JSON.parse(row.payload_json);

    // Simulate a structurally valid but incomplete payload with a matching content hash.
    db.exec('DROP TRIGGER run_diagnostics_immutable_update');
    payload.differences = [];
    payload.totalDifferences = 0;
    const payloadJson = JSON.stringify(payload);
    db.prepare('UPDATE run_diagnostics SET payload_json = ?, payload_hash = ? WHERE run_id = ?')
      .run(payloadJson, sha256(payloadJson), created.runId);

    const summary = auditIssue161Diagnostics(db);
    expect(summary).toMatchObject({
      totalRuns: 1,
      supportedRuns: 1,
      unavailableRuns: 0,
      corruptedRuns: 0,
      projectionCount: 1,
      storedDifferenceCount: 0,
      differenceSetFailures: 1,
      queryOnly: true,
    });
    expect(summary.expectedDifferenceCount).toBeGreaterThan(0);
    expect(summary.dataVersionAfter).toBe(summary.dataVersionBefore);
    expect(Object.keys(summary)).not.toContain('runId');
    expect(JSON.stringify(summary)).not.toContain('SYNTH_AUDIT');

    // An extra difference key that is not backed by a formal/compat mismatch
    // is rejected as corrupted by the independent structural reader.
    db.pragma('query_only = OFF');
    completePayload.differences.push({
      personCode: completePayload.students[0].personCode,
      name: 'Synthetic audit student',
      sourceRow: completePayload.students[0].sourceRow,
      field: 'tutoringDays',
      formalValue: completePayload.students[0].formal.tutoringDays,
      compatValue: completePayload.students[0].formal.tutoringDays,
      category: 'CARE_DAYS_DIFFERENCE',
    });
    completePayload.totalDifferences = completePayload.differences.length;
    const extraKeyJson = JSON.stringify(completePayload);
    db.prepare('UPDATE run_diagnostics SET payload_json = ?, payload_hash = ? WHERE run_id = ?')
      .run(extraKeyJson, sha256(extraKeyJson), created.runId);
    const extraKeySummary = auditIssue161Diagnostics(db);
    expect(extraKeySummary).toMatchObject({
      totalRuns: 1,
      supportedRuns: 0,
      corruptedRuns: 1,
      differenceSetFailures: 0,
      queryOnly: true,
    });
    expect(extraKeySummary.dataVersionAfter).toBe(extraKeySummary.dataVersionBefore);
  });
});
