import { describe, expect, it } from 'vitest';
import { activateImport } from '@/application/activate-import';
import { applySettingsPreview } from '@/application/apply-settings';
import { previewSettingsChange } from '@/application/settings-preview';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { activeState, activateBatch, makeStudent, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';

const FAIL_STUDENT_INSERT = `CREATE TRIGGER fail_student_calculations_insert
  BEFORE INSERT ON student_calculations BEGIN SELECT RAISE(ABORT, 'injected student calculation insert failure'); END`;

describe('Issue #159 PR-1: run transactions remain atomic without diagnostic writes', () => {
  const ctx = useGlobalTempDb('sb-issue-161-atomic-');

  it('activate student calculation write failure rolls back run, results, categories, active revision and idempotency', () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_activate_fail', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_ACT', ['國小數學-三A'], { grade: 3 }),
    ]);
    const beforeActive = activeState(db);
    db.exec(FAIL_STUDENT_INSERT);

    expect(() => activateBatch(db, 'imp_161_activate_fail', 'k-161-activate-fail'))
      .toThrow(/injected student calculation insert failure/);

    expect(db.prepare('SELECT count(*) as n FROM calculation_runs').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT count(*) as n FROM student_calculations').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT count(*) as n FROM run_class_categories').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT count(*) as n FROM run_diagnostics').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT count(*) as n FROM idempotency_records WHERE idempotency_key = ?').get('k-161-activate-fail')).toMatchObject({ n: 0 });
    expect(activeState(db)).toEqual(beforeActive);
  });

  it('apply with_students student write failure rolls back the new settings version and preview consumption state', () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_apply_fail', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_APPLY', ['國小數學-三A'], { grade: 3 }),
    ]);
    activateBatch(db, 'imp_161_apply_fail', 'k-161-activate-base');
    const before = {
      active: activeState(db),
      runs: db.prepare('SELECT * FROM calculation_runs ORDER BY id').all(),
      calculations: db.prepare('SELECT * FROM student_calculations ORDER BY id').all(),
      categories: db.prepare('SELECT * FROM run_class_categories ORDER BY run_id, base_name').all(),
      diagnostics: db.prepare('SELECT * FROM run_diagnostics ORDER BY run_id').all(),
      settings: db.prepare('SELECT * FROM settings_versions ORDER BY revision').all(),
      idempotency: db.prepare('SELECT * FROM idempotency_records ORDER BY idempotency_key').all(),
    };
    const preview = previewSettingsChange(db, undefined, {
      draft: buildSeedDraft(),
      expectedRevision: before.active.revision,
    });
    const previewBefore = db.prepare('SELECT * FROM settings_previews WHERE preview_id = ?').get(preview.previewId);
    db.exec(FAIL_STUDENT_INSERT);

    expect(() => applySettingsPreview(db, {
      previewId: preview.previewId,
      expectedRevision: before.active.revision,
      idempotencyKey: 'k-161-apply-fail',
    })).toThrow(/injected student calculation insert failure/);

    expect(activeState(db)).toEqual(before.active);
    expect(db.prepare('SELECT * FROM calculation_runs ORDER BY id').all()).toEqual(before.runs);
    expect(db.prepare('SELECT * FROM student_calculations ORDER BY id').all()).toEqual(before.calculations);
    expect(db.prepare('SELECT * FROM run_class_categories ORDER BY run_id, base_name').all()).toEqual(before.categories);
    expect(db.prepare('SELECT * FROM run_diagnostics ORDER BY run_id').all()).toEqual(before.diagnostics);
    expect(db.prepare('SELECT * FROM settings_versions ORDER BY revision').all()).toEqual(before.settings);
    expect(db.prepare('SELECT * FROM idempotency_records ORDER BY idempotency_key').all()).toEqual(before.idempotency);
    expect(db.prepare('SELECT * FROM settings_previews WHERE preview_id = ?').get(preview.previewId)).toEqual(previewBefore);
    expect(db.prepare('SELECT count(*) as n FROM idempotency_records WHERE idempotency_key = ?').get('k-161-apply-fail')).toMatchObject({ n: 0 });
  });

  it('a successful activation replay returns the original run and creates no diagnostic row', () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_replay', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_REPLAY', ['國小數學-三A'], { grade: 3 }),
    ]);
    const first = activateBatch(db, 'imp_161_replay', 'k-161-replay');
    const replay = activateImport(db, { importId: 'imp_161_replay', expectedRevision: 0, idempotencyKey: 'k-161-replay' });
    expect(replay).toEqual(first);
    expect(db.prepare('SELECT count(*) as n FROM run_diagnostics').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT diagnostic_algorithm_version FROM calculation_runs WHERE id = ?').get(first.runId))
      .toMatchObject({ diagnostic_algorithm_version: null });
  });
});
