import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { GET as comparisonGET } from '@/app/api/v1/runs/[runId]/comparison/route';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import * as billingCalculator from '@/domain/billing/billing-calculator';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { formalProjectionHash, sha256, stableJson } from '@/contracts/run-diagnostics';
import type { SettingsDraft } from '@/contracts/settings';
import { activateBatch, getRequest, makeStudent, saveRun, saveSettings, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';

const callComparison = (runId: string) => comparisonGET(
  getRequest(`http://127.0.0.1:3000/api/v1/runs/${runId}/comparison?againstRuleSet=excel-v260922-compat`),
  { params: Promise.resolve({ runId }) }
);

describe('Issue #161: run comparison uses immutable diagnostic snapshots', () => {
  const ctx = useGlobalTempDb('sb-issue-161-');

  it('a newly created synthetic run captures the #157 unset result and serves that fixed projection', async () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_001', ['國小輔導-新開班', '國小數學-三A'], { grade: 1 }),
    ]);

    const created = activateBatch(db, 'imp_161', 'k-161-new');
    const run = getCalculationRun(db, created.runId);
    expect(run?.diagnosticAlgorithmVersion).toBe('comparison-snapshot-v1');
    const evidenceRow = db.prepare('SELECT effective_inputs_json FROM run_diagnostics WHERE run_id = ?').get(created.runId) as { effective_inputs_json: string };
    const evidence = JSON.parse(evidenceRow.effective_inputs_json);
    expect(evidence.calculationPolicies.compatNumericKernel).toMatchObject({
      sessionTimeConversion: 'minute-value-divided-by-1440',
      overlapMinutesOperationOrder: 'day-overlap-times-24-times-60',
      perSessionRawOrder: 'negative-overlap-divided-by-60-then-3',
      accumulationOrder: 'persisted-enrollment-and-session-order',
      comparisonPrecision: '15-significant-digits',
    });

    const response = await callComparison(created.runId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runId: created.runId,
      diagnosticAlgorithmVersion: 'comparison-snapshot-v1',
      totalDifferences: 1,
      differences: [{
        personCode: 'SYNTH_001',
        name: '學生SYNTH_001',
        sourceRow: 1,
        field: 'baseDiscountBps',
        formalValue: 10000,
        compatValue: 9500,
        category: 'DISCOUNT_DIFFERENCE',
      }],
    });
  });

  it('effective input evidence records seed fallback and legacy auto/manual/unset resolution actually used by billing', async () => {
    const db = ctx.db();
    const seedDraft = buildSeedDraft();
    const draft: SettingsDraft = {
      ...seedDraft,
      classes: seedDraft.classes.map((entry) => {
        if (entry.baseName === '國小輔導-四年級') {
          // Legacy auto values are ignored; the declared seed category remains effective.
          return { ...entry, category: 'math', categorySource: 'auto' };
        }
        if (entry.baseName === '國小數學-四A') {
          // A stale stored category is ignored when the operator explicitly marks it unset.
          return { ...entry, category: 'care', categorySource: 'unset' };
        }
        if (entry.baseName === '國小國語文-小五') {
          return { ...entry, category: 'care', categorySource: 'manual' };
        }
        return entry;
      }),
    };
    saveSyntheticBatch(db, 'imp_161_effective_categories', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_EFFECTIVE_CATEGORIES', [
        '兒童美語-Gino',
        '國小輔導-四年級',
        '國小數學-四A',
        '國小國語文-小五',
      ], { grade: 1 }),
    ]);
    saveSettings(db, 'setv_161_effective_categories', 1, draft);
    const created = activateBatch(db, 'imp_161_effective_categories', 'k-161-effective-categories');

    const evidenceRow = db.prepare('SELECT effective_inputs_json FROM run_diagnostics WHERE run_id = ?')
      .get(created.runId) as { effective_inputs_json: string };
    const evidence = JSON.parse(evidenceRow.effective_inputs_json);
    const expected = [
      { baseName: '兒童美語-Gino', category: 'english', categorySource: 'seed' },
      { baseName: '國小國語文-小五', category: 'care', categorySource: 'manual' },
      { baseName: '國小數學-四A', category: 'unset', categorySource: 'unset' },
      { baseName: '國小輔導-四年級', category: 'care', categorySource: 'seed' },
    ];
    expect(evidence.effectiveClassSettings.filter((entry: any) => expected.some((item) => item.baseName === entry.baseName)))
      .toEqual(expected.map((item) => {
        const setting = draft.classes.find((entry) => entry.baseName === item.baseName)!;
        return {
          ...item,
          classType: setting.classType ?? '',
          fixedFiveDays: setting.fixedFiveDays === true,
        };
      }));

    const savedCategories = db.prepare(`
      SELECT base_name, category, source FROM run_class_categories
      WHERE run_id = ? AND base_name IN (?, ?, ?, ?) ORDER BY base_name
    `).all(created.runId, ...expected.map((item) => item.baseName)) as Array<{ base_name: string; category: string; source: string }>;
    expect(savedCategories).toEqual(expected.map((item) => ({
      base_name: item.baseName,
      category: item.category,
      source: item.categorySource,
    })).sort((a, b) => a.base_name < b.base_name ? -1 : a.base_name > b.base_name ? 1 : 0));
  });

  it('an old run without a diagnostic version returns 409 and is not backfilled', async () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_old', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_OLD', ['國小數學-三A'], { grade: 3 }),
    ]);
    saveRun(db, 'run_161_old', 'imp_161_old', 'seed-v250922', '2026-10-20T08:00:00.000Z');

    const response = await callComparison('run_161_old');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'DIAGNOSTIC_VERSION_UNAVAILABLE' });
    expect((db.prepare('SELECT diagnostic_algorithm_version FROM calculation_runs WHERE id = ?').get('run_161_old') as any)
      .diagnostic_algorithm_version).toBeNull();
    expect(db.prepare('SELECT count(*) as n FROM run_diagnostics WHERE run_id = ?').get('run_161_old')).toMatchObject({ n: 0 });
  });

  it('records synthetic snapshot size and run creation / GET latency', async () => {
    const db = ctx.db();
    const students = Array.from({ length: 200 }, (_, index) => makeStudent(
      `SYNTH_MEASURE_${String(index + 1).padStart(4, '0')}`,
      [],
      { grade: index % 6 + 1, sourceRow: index + 1 },
    ));
    saveSyntheticBatch(db, 'imp_161_measure', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', students);

    const createStart = performance.now();
    const created = activateBatch(db, 'imp_161_measure', 'k-161-measure');
    const createMs = performance.now() - createStart;
    const diagnosticRow = db.prepare(`SELECT payload_json, effective_inputs_json FROM run_diagnostics WHERE run_id = ?`)
      .get(created.runId) as { payload_json: string; effective_inputs_json: string };
    const payloadBytes = Buffer.byteLength(diagnosticRow.payload_json, 'utf8');
    const evidenceBytes = Buffer.byteLength(diagnosticRow.effective_inputs_json, 'utf8');

    const getStart = performance.now();
    const response = await callComparison(created.runId);
    const getMs = performance.now() - getStart;
    expect(response.status).toBe(200);
    expect(payloadBytes + evidenceBytes).toBeGreaterThan(0);
    expect(createMs).toBeGreaterThan(0);
    expect(getMs).toBeGreaterThan(0);
    console.info(`ISSUE161_SYNTHETIC_MEASURE students=200 payload_bytes=${payloadBytes} effective_inputs_bytes=${evidenceBytes} diagnostic_json_bytes=${payloadBytes + evidenceBytes} create_run_ms=${createMs.toFixed(2)} comparison_get_ms=${getMs.toFixed(2)}`);
  });

  it('an independent cross-version golden keeps both a false positive and a false negative fixed; GET is read-only and calls no calculator', async () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_161_golden', 'synthetic.xlsx', '2026-10-20T08:00:00.000Z', [
      makeStudent('SYNTH_FP', ['國小輔導-新開班', '國小數學-三A'], { grade: 1, sourceRow: 1 }),
      makeStudent('SYNTH_FN', ['國小數學-三A'], { grade: 1, sourceRow: 2 }),
    ]);
    const seedDraft = buildSeedDraft();
    const draft: SettingsDraft = {
      ...seedDraft,
      classes: [
        ...seedDraft.classes.map((entry) => entry.baseName === '國小數學-三A' ? { ...entry, sessions: [] } : entry),
        {
          baseName: '國小輔導-新開班', subject: '國小輔導', teacher: null, active: true, sessions: [],
          classType: 'care', category: 'unset', categorySource: 'unset', fixedFiveDays: false,
        },
      ],
    };
    saveSettings(db, 'setv_161_golden', 1, draft);
    const created = activateBatch(db, 'imp_161_golden', 'k-161-golden');

    // Today’s synthetic result under #157 is different from the hand-authored stored history:
    // both students have 10000 bps formal today; the golden below records the historical values.
    const todaysFormal = db.prepare('SELECT person_code, base_discount_bps FROM student_calculations WHERE run_id = ? ORDER BY person_code')
      .all(created.runId);
    expect(todaysFormal).toEqual([
      { person_code: 'SYNTH_FN', base_discount_bps: 10000 },
      { person_code: 'SYNTH_FP', base_discount_bps: 10000 },
    ]);

    const fixturePath = path.resolve(__dirname, '../fixtures/issue-161/comparison-snapshot-v1/two-generation-golden.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const payload = { ...fixture.payload, runId: created.runId };
    for (const student of payload.students) {
      db.prepare(`UPDATE student_calculations
        SET base_discount_bps = ?, anqin_days = ?, tutoring_days = ?
        WHERE run_id = ? AND person_code = ?`)
        .run(student.formal.baseDiscountBps, student.formal.anqinDays, student.formal.tutoringDays, created.runId, student.personCode);
    }
    const payloadJson = JSON.stringify(payload);
    const previousDiagnostics = db.prepare('SELECT effective_inputs_json FROM run_diagnostics WHERE run_id = ?').get(created.runId) as { effective_inputs_json: string };
    const actualRows = payload.students.map((student: any) => {
      const result = db.prepare('SELECT name FROM student_calculations WHERE run_id = ? AND person_code = ?').get(created.runId, student.personCode) as { name: string };
      return {
        personCode: student.personCode,
        name: result.name,
        sourceRow: student.sourceRow,
        values: student.formal,
      };
    });
    db.exec('DROP TRIGGER run_diagnostics_immutable_update');
    db.prepare('UPDATE run_diagnostics SET payload_json = ?, payload_hash = ?, formal_result_hash = ? WHERE run_id = ?')
      .run(payloadJson, sha256(payloadJson), formalProjectionHash(actualRows), created.runId);
    // Keep the actual generation-time input evidence and its content hash untouched.
    expect(previousDiagnostics.effective_inputs_json).toContain('imp_161_golden');

    const dbStateHash = () => {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>);
      const snapshot = tables.map(({ name }) => {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const rows = db.prepare(`SELECT * FROM ${quoted}`).all();
        return [name, rows.sort((a, b) => stableJson(a).localeCompare(stableJson(b)))];
      });
      return sha256(stableJson(snapshot));
    };
    const before = dbStateHash();
    const calculatorSpy = vi.spyOn(billingCalculator, 'calculateStudentBilling').mockImplementation(() => {
      throw new Error('comparison GET called calculateStudentBilling');
    });
    try {
      const response = await callComparison(created.runId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        runId: created.runId,
        diagnosticAlgorithmVersion: 'comparison-snapshot-v1',
        totalDifferences: 3,
        differences: [
          {
            personCode: 'SYNTH_FN', name: '學生SYNTH_FN', sourceRow: 2,
            field: 'baseDiscountBps', formalValue: 9500, compatValue: 10000, category: 'DISCOUNT_DIFFERENCE',
          },
          {
            personCode: 'SYNTH_FN', name: '學生SYNTH_FN', sourceRow: 2,
            field: 'anqinDays', formalValue: 4.5, compatValue: 5, category: 'CARE_DAYS_DIFFERENCE',
          },
          {
            personCode: 'SYNTH_FN', name: '學生SYNTH_FN', sourceRow: 2,
            field: 'tutoringDays', formalValue: null, compatValue: 0, category: 'CARE_DAYS_DIFFERENCE',
          },
        ],
      });
      expect(calculatorSpy).not.toHaveBeenCalled();
      expect(dbStateHash()).toBe(before);

      // A newer saved setting changes the current category state, but cannot alter this run's response.
      const changedCurrentSettings: SettingsDraft = {
        ...buildSeedDraft(),
        classes: buildSeedDraft().classes.map((entry) => entry.baseName === '國小數學-三A'
          ? { ...entry, category: 'unset', categorySource: 'unset' }
          : entry),
      };
      saveSettings(db, 'setv_161_current_changed', 2, changedCurrentSettings);
      expect(db.prepare('SELECT id FROM settings_versions ORDER BY revision DESC LIMIT 1').get()).toMatchObject({ id: 'setv_161_current_changed' });
      const afterSettingsChange = dbStateHash();
      const unchanged = await callComparison(created.runId);
      expect(unchanged.status).toBe(200);
      expect(await unchanged.json()).toEqual({
        runId: created.runId,
        diagnosticAlgorithmVersion: 'comparison-snapshot-v1',
        totalDifferences: 3,
        differences: [
          { personCode: 'SYNTH_FN', name: '學生SYNTH_FN', sourceRow: 2, field: 'baseDiscountBps', formalValue: 9500, compatValue: 10000, category: 'DISCOUNT_DIFFERENCE' },
          { personCode: 'SYNTH_FN', name: '學生SYNTH_FN', sourceRow: 2, field: 'anqinDays', formalValue: 4.5, compatValue: 5, category: 'CARE_DAYS_DIFFERENCE' },
          { personCode: 'SYNTH_FN', name: '學生SYNTH_FN', sourceRow: 2, field: 'tutoringDays', formalValue: null, compatValue: 0, category: 'CARE_DAYS_DIFFERENCE' },
        ],
      });
      expect(calculatorSpy).not.toHaveBeenCalled();
      expect(dbStateHash()).toBe(afterSettingsChange);
    } finally {
      calculatorSpy.mockRestore();
    }
  });
});
