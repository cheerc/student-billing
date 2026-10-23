import { describe, expect, it } from 'vitest';
import { GET as comparisonGET } from '@/app/api/v1/runs/[runId]/comparison/route';
import { activateBatch, getRequest, makeStudent, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';
import { sha256, stableJson } from '@/contracts/run-diagnostics';

const callComparison = (runId: string) => comparisonGET(
  getRequest(`http://127.0.0.1:3000/api/v1/runs/${runId}/comparison?againstRuleSet=excel-v260922-compat`),
  { params: Promise.resolve({ runId }) }
);

function databaseHash(db: ReturnType<typeof import('@/adapters/sqlite').getDatabase>): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  const snapshot = tables.map(({ name }) => {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const rows = db.prepare(`SELECT * FROM ${quoted}`).all();
    return [name, rows.sort((a, b) => stableJson(a).localeCompare(stableJson(b)))];
  });
  return sha256(stableJson(snapshot));
}

describe('Issue #161: unavailable and corrupted diagnostics fail closed', () => {
  const ctx = useGlobalTempDb('sb-issue-161-integrity-');

  it('valid zero-difference payload is 200 and preserves null rather than substituting zero', async () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_zero', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_ZERO', [], { grade: 1 }),
    ]);
    const created = activateBatch(db, 'imp_161_zero', 'k-161-zero');

    const response = await callComparison(created.runId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: created.runId,
      diagnosticAlgorithmVersion: 'comparison-snapshot-v1',
      totalDifferences: 0,
      differences: [],
    });
    const payloadRow = db.prepare('SELECT payload_json FROM run_diagnostics WHERE run_id = ?').get(created.runId) as { payload_json: string };
    const payload = JSON.parse(payloadRow.payload_json);
    expect(payload.students[0].formal).toMatchObject({ baseDiscountBps: 10000, anqinDays: 5, tutoringDays: null });
    expect(payload.students[0].compat.tutoringDays).toBeNull();
    expect(db.prepare('SELECT count(*) as n FROM run_diagnostics WHERE run_id = ?').get(created.runId)).toMatchObject({ n: 1 });
  });

  it('supported run version without content returns 409 and does not modify any table', async () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_missing', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_MISSING', [], { grade: 1 }),
    ]);
    const created = activateBatch(db, 'imp_161_missing', 'k-161-missing');
    db.prepare('DELETE FROM run_diagnostics WHERE run_id = ?').run(created.runId);
    const before = databaseHash(db);

    const response = await callComparison(created.runId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'DIAGNOSTIC_VERSION_UNAVAILABLE' });
    expect(databaseHash(db)).toBe(before);
  });

  it('unknown algorithm version returns 409 without falling back to the current version', async () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_unknown', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_UNKNOWN', [], { grade: 1 }),
    ]);
    const created = activateBatch(db, 'imp_161_unknown', 'k-161-unknown');
    db.prepare('UPDATE calculation_runs SET diagnostic_algorithm_version = ? WHERE id = ?').run('unsupported-algorithm-v99', created.runId);
    const before = databaseHash(db);

    const response = await callComparison(created.runId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'DIAGNOSTIC_VERSION_UNAVAILABLE' });
    expect(databaseHash(db)).toBe(before);
  });

  it('corrupt JSON returns explicit 500 without leaking payload content or writing repairs', async () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_corrupt', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_CORRUPT', [], { grade: 1 }),
    ]);
    const created = activateBatch(db, 'imp_161_corrupt', 'k-161-corrupt');
    db.exec('DROP TRIGGER run_diagnostics_immutable_update');
    db.prepare('UPDATE run_diagnostics SET payload_json = ? WHERE run_id = ?').run('{"private":', created.runId);
    const before = databaseHash(db);

    const response = await callComparison(created.runId);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: '此 run 的診斷快照內容無效，無法安全提供。',
      code: 'DIAGNOSTIC_SNAPSHOT_CORRUPTED',
    });
    expect(databaseHash(db)).toBe(before);
  });

  it('formal result changed after snapshot creation is detected as corrupted', async () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_formal_mismatch', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_FORMAL', [], { grade: 1 }),
    ]);
    const created = activateBatch(db, 'imp_161_formal_mismatch', 'k-161-formal');
    db.prepare('UPDATE student_calculations SET base_discount_bps = 9500 WHERE run_id = ?').run(created.runId);
    const before = databaseHash(db);

    const response = await callComparison(created.runId);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'DIAGNOSTIC_SNAPSHOT_CORRUPTED' });
    expect(databaseHash(db)).toBe(before);
  });
});
