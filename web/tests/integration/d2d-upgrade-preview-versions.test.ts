import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { getDatabase } from '@/adapters/sqlite';
import { saveCalculationRun, type CalculationRunRecord, type StudentCalculationRecord } from '@/adapters/sqlite/runs-repository';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { executeCalculationRun } from '@/application/calculate-run';
import { POST as previewPOST } from '@/app/api/v1/settings/preview/route';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { makeStudent, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';

/**
 * #159 PR-2 upgrade before/after boundary. The old run is a fixed synthetic persisted row;
 * this test never invokes an old calculator. Before values must come from that saved row,
 * while after values are calculated with v4 after an explicit upgrade choice.
 */
const IMPORT_ID = 'imp_upgrade_v2';
const RUN_ID = 'run_upgrade_v2';
const PERSON_CODE = 'SYNTH-UPGRADE-001';

function seedPersistedV2Run(db: ReturnType<typeof getDatabase>) {
  runMigrations(db);
  const student = makeStudent(PERSON_CODE, ['國小數學-四A', '國小數學-三A'], { grade: 4 });
  saveSyntheticBatch(db, IMPORT_ID, 'synthetic-upgrade.xlsx', '2026-10-23T00:00:00.000Z', [student]);

  const run: CalculationRunRecord = {
    id: RUN_ID,
    importId: IMPORT_ID,
    scheduleVersionId: 'seed-v250922',
    ruleSetVersion: 'erp-tag-v2',
    numericPolicy: 'integer-minute-rational-v1',
    asOfDate: '2026-10-23',
    status: 'completed',
    issueCounts: {},
    totalStudents: 1,
    createdAt: '2026-10-23T00:00:00.000Z',
  };
  const result: StudentCalculationRecord = {
    id: `${RUN_ID}_${PERSON_CODE}`,
    runId: RUN_ID,
    personCode: PERSON_CODE,
    name: '學生SYNTH-UPGRADE-001',
    branch: '本校',
    grade: 4,
    gradeRaw: '4年級',
    subjectCount: 1,
    baseDiscountBps: 10000,
    anqinDays: null,
    anqinDisplay: null,
    tutoringDays: 4.5,
    tutoringDisplay: '4.5',
    englishDays: null,
    mathDays: 2,
    chineseDays: null,
    homeworkDays: null,
    intensiveEnglishDays: null,
    saturdayTutoringDays: null,
    applicableAnqinBps: null,
    applicableTutoringBps: 10000,
    applicableEnglishBps: null,
    applicableMathBps: 10000,
    tierMismatch: false,
    tierComparisons: student.enrollments.map((enrollment) => ({
      enrollmentId: '',
      rawToken: enrollment.rawToken,
      baseName: enrollment.baseName,
      computedTier: null,
      erpDeclaredTier: null,
      status: 'not_applicable',
      needsReview: false,
      issues: [],
    })),
    issues: [],
    hasIssues: false,
    trace: {
      sourceRow: student.sourceRow,
      rawTags: student.tagsRaw,
      rawNotes: student.notesRaw,
      enrollments: student.enrollments,
      careDays: {
        anqin: { days: null, displayDays: null, isEnrolled: false },
        tutoring: { days: 4.5, displayDays: '4.5', isEnrolled: true },
      },
    },
    createdAt: '2026-10-23T00:00:00.000Z',
  };
  saveCalculationRun(db, run, [result]);
  db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ?, revision = 1 WHERE id = 1').run(RUN_ID, IMPORT_ID);
  return { student, oldRun: run, oldResult: result };
}

describe('PR-2: settings upgrade preview reads persisted v2 before values and calculates v4 after', () => {
  const ctx = useGlobalTempDb('sb-pr2-upgrade-preview-');

  it('explicit v4 upgrade uses the fixed persisted 4.5 before value and leaves the old row untouched', () => {
    const db = ctx.db();
    const { oldResult } = seedPersistedV2Run(db);
    const preview = previewSettingsChange(db, IMPORT_ID, {
      draft: buildSeedDraft(),
      expectedRevision: 1,
      targetRuleSetVersion: 'erp-tag-v4',
    });

    expect(preview.targetRuleSetVersion).toBe('erp-tag-v4');
    expect(preview.dayDeltas).toHaveLength(1);
    expect(preview.dayDeltas![0]).toEqual(expect.objectContaining({ personCode: PERSON_CODE, before: 4.5, after: 4 }));
    const persisted = db.prepare('SELECT tutoring_days, issues FROM student_calculations WHERE run_id = ? AND person_code = ?')
      .get(RUN_ID, PERSON_CODE) as { tutoring_days: number; issues: string };
    expect(persisted.tutoring_days).toBe(oldResult.tutoringDays);
    expect(persisted.issues).toBe(JSON.stringify(oldResult.issues));
    expect((db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(RUN_ID) as { rule_set_version: string }).rule_set_version)
      .toBe('erp-tag-v2');
  });

  it('ordinary preview on a v2 active run fails closed until v4 upgrade is explicitly selected', () => {
    const db = ctx.db();
    seedPersistedV2Run(db);
    let caught: any;
    try {
      previewSettingsChange(db, IMPORT_ID, { draft: buildSeedDraft(), expectedRevision: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught?.statusCode).toBe(409);
    expect(caught?.code).toBe('UPGRADE_REQUIRED');
  });

  it('direct v4 run execution cannot bypass the stored explicit-upgrade preview on a legacy active run', () => {
    const db = ctx.db();
    seedPersistedV2Run(db);

    expect(() => executeCalculationRun(db, IMPORT_ID, 'run_direct_v4', {
      ruleSetVersion: 'erp-tag-v4',
    })).toThrow(/明確升級預覽/);

    expect(db.prepare('SELECT COUNT(*) AS n FROM calculation_runs WHERE id = ?').get('run_direct_v4')).toEqual({ n: 0 });
  });

  it('missing or corrupt preview expiry cannot authorize the legacy-active direct-run bypass', () => {
    const db = ctx.db();
    seedPersistedV2Run(db);
    const preview = previewSettingsChange(db, IMPORT_ID, {
      draft: buildSeedDraft(),
      expectedRevision: 1,
      targetRuleSetVersion: 'erp-tag-v4',
    });

    for (const expiresAt of [null, 'not-a-date']) {
      db.prepare('UPDATE settings_previews SET expires_at = ? WHERE preview_id = ?').run(expiresAt, preview.previewId);
      expect(() => executeCalculationRun(db, IMPORT_ID, `run_bad_expiry_${String(expiresAt)}`, {
        ruleSetVersion: 'erp-tag-v4',
        upgradePreviewId: preview.previewId,
      })).toThrow(/明確升級預覽/);
    }
  });

  it('confirmed apply creates a v4 run and preserves both stored v2 rows', () => {
    const db = ctx.db();
    seedPersistedV2Run(db);
    const preview = previewSettingsChange(db, IMPORT_ID, {
      draft: buildSeedDraft(),
      expectedRevision: 1,
      targetRuleSetVersion: 'erp-tag-v4',
    });
    const applied = applySettingsPreview(db, {
      previewId: preview.previewId,
      expectedRevision: 1,
      idempotencyKey: 'synthetic-upgrade-apply',
    });

    expect((db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(applied.runId) as { rule_set_version: string }).rule_set_version)
      .toBe('erp-tag-v4');
    expect((db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(RUN_ID) as { rule_set_version: string }).rule_set_version)
      .toBe('erp-tag-v2');
    expect((db.prepare('SELECT tutoring_days FROM student_calculations WHERE run_id = ? AND person_code = ?').get(RUN_ID, PERSON_CODE) as { tutoring_days: number }).tutoring_days)
      .toBe(4.5);
    expect(db.prepare('SELECT COUNT(*) AS n FROM student_calculations WHERE run_id = ?').get(RUN_ID)).toEqual({ n: 1 });
  });

  it('preview route accepts explicit v4 upgrade and rejects a missing upgrade choice', async () => {
    const db = ctx.db();
    seedPersistedV2Run(db);
    void db;
    const req = (targetRuleSetVersion?: string) => new NextRequest('http://127.0.0.1:3000/api/v1/settings/preview', {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({
        importId: IMPORT_ID,
        draft: buildSeedDraft(),
        expectedRevision: 1,
        ...(targetRuleSetVersion ? { targetRuleSetVersion } : {}),
      }),
    });
    const accepted = await previewPOST(req('erp-tag-v4'));
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).targetRuleSetVersion).toBe('erp-tag-v4');

    const rejected = await previewPOST(req());
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).code).toBe('UPGRADE_REQUIRED');
  });
});
