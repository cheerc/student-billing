import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import * as billingCalculator from '@/domain/billing/billing-calculator';
import { executeCalculationRun } from '@/application/calculate-run';
import { previewSettingsChange } from '@/application/settings-preview';
import { calculateSchedulePreview, SchedulePreviewError } from '@/application/schedule-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { activateImport, ActivateError } from '@/application/activate-import';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { saveCalculationRun, type CalculationRunRecord, type StudentCalculationRecord } from '@/adapters/sqlite/runs-repository';
import { buildSeedDraft, hashSettingsDraft, saveSettingsPreview, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { historicalRuleSetMetadata } from '@/domain/billing/rule-set';
import type { StudentSnapshot } from '@/domain/students/types';

afterEach(() => vi.restoreAllMocks());

function seedStudent(db: Database.Database, importId: string): void {
  const student: StudentSnapshot = {
    personCode: 'SYNTH_159_01',
    name: 'Synthetic student',
    branch: 'Synthetic branch',
    gradeRaw: '4',
    grade: 4,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: [{
      rawToken: '國小輔導-四年級[團]',
      yearPrefix: null,
      baseName: '國小輔導-四年級',
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    }],
  };
  saveImportBatch(db, {
    id: importId,
    fileName: 'synthetic.xlsx',
    fileHash: 'synthetic-file-hash',
    contentHash: 'synthetic-content-hash',
    sheetName: 'Synthetic',
    headerMap: {},
    parserVersion: 'synthetic-v1',
    scopeNote: '',
    rowCount: 1,
    status: 'ready',
    createdAt: '2026-10-23T00:00:00.000Z',
  }, [student]);
}

function persistV2Run(db: Database.Database, importId: string): void {
  const run: CalculationRunRecord = {
    id: 'run_legacy_v2',
    importId,
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
    id: 'run_legacy_v2_SYNTH_159_01',
    runId: run.id,
    personCode: 'SYNTH_159_01',
    name: 'Synthetic student',
    branch: 'Synthetic branch',
    grade: 4,
    gradeRaw: '4',
    subjectCount: 1,
    baseDiscountBps: 10000,
    anqinDays: null,
    anqinDisplay: null,
    tutoringDays: 4.5,
    tutoringDisplay: '4.5',
    englishDays: null,
    mathDays: null,
    chineseDays: null,
    homeworkDays: null,
    intensiveEnglishDays: null,
    saturdayTutoringDays: null,
    applicableAnqinBps: 10000,
    applicableTutoringBps: 10000,
    applicableEnglishBps: 10000,
    applicableMathBps: 10000,
    tierMismatch: false,
    tierComparisons: [],
    issues: [],
    hasIssues: false,
    trace: { sourceRow: 1, enrollments: [] },
    createdAt: '2026-10-23T00:00:00.000Z',
  };
  saveCalculationRun(db, run, [result]);
  db.prepare('UPDATE active_state SET active_import_id = ?, active_run_id = ?, revision = 1 WHERE id = 1')
    .run(importId, run.id);
}

function setupLegacyActiveDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  seedStudent(db, 'imp_synthetic_159');
  const draft = buildSeedDraft();
  saveSettingsVersion(db, {
    id: 'setv_synthetic_159',
    contentHash: 'synthetic-settings-hash',
    contentJson: JSON.stringify(draft),
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    createdFromPreviewId: null,
    revision: 1,
  });
  persistV2Run(db, 'imp_synthetic_159');
  return db;
}

describe('Issue #159 PR-2: single v4 runtime and explicit legacy upgrade', () => {
  it('keeps historical read metadata explicit and fails closed for unknown versions', () => {
    expect(historicalRuleSetMetadata('erp-tag-v1')).toEqual({
      known: true, hasClassCategorySnapshot: false, hasClassSemanticsSnapshot: false, fixedFiveDaysAffectsRate: true, sameWeekdayOnly: false,
    });
    expect(historicalRuleSetMetadata('erp-tag-v2')).toEqual({
      known: true, hasClassCategorySnapshot: false, hasClassSemanticsSnapshot: false, fixedFiveDaysAffectsRate: true, sameWeekdayOnly: true,
    });
    expect(historicalRuleSetMetadata('erp-tag-v3')).toEqual({
      known: true, hasClassCategorySnapshot: true, hasClassSemanticsSnapshot: false, fixedFiveDaysAffectsRate: true, sameWeekdayOnly: true,
    });
    expect(historicalRuleSetMetadata('erp-tag-v4')).toEqual({
      known: true, hasClassCategorySnapshot: true, hasClassSemanticsSnapshot: true, fixedFiveDaysAffectsRate: false, sameWeekdayOnly: true,
    });
    expect(historicalRuleSetMetadata('unknown-corrupt-version')).toEqual({
      known: false, hasClassCategorySnapshot: false, hasClassSemanticsSnapshot: false, fixedFiveDaysAffectsRate: false, sameWeekdayOnly: false,
    });
  });

  it('rejects a direct attempt to calculate a new v2 run', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      seedStudent(db, 'imp_direct_v2');

      expect(() => executeCalculationRun(db, 'imp_direct_v2', 'run_attempt_v2', {
        ruleSetVersion: 'erp-tag-v2',
      })).toThrow(/erp-tag-v4|upgrade/i);
    } finally {
      db.close();
    }
  });

  it('requires an explicit v4 upgrade for legacy-active settings previews and reads before values from the saved run', () => {
    const db = setupLegacyActiveDb();
    try {
      const draft = buildSeedDraft();
      expect(() => previewSettingsChange(db, 'imp_synthetic_159', {
        draft,
        expectedRevision: 1,
      })).toThrow(/erp-tag-v4|upgrade/i);

      const calcSpy = vi.spyOn(billingCalculator, 'calculateStudentBilling');
      const preview = previewSettingsChange(db, 'imp_synthetic_159', {
        draft,
        expectedRevision: 1,
        targetRuleSetVersion: 'erp-tag-v4',
      });

      expect(calcSpy).toHaveBeenCalledTimes(1);
      expect(calcSpy.mock.calls[0]?.[1]?.ruleSetVersion).toBe('erp-tag-v4');
      expect(preview.targetRuleSetVersion).toBe('erp-tag-v4');
      expect(preview.dayDeltas).toEqual([{
        personCode: 'SYNTH_159_01',
        name: 'Synthetic student',
        before: 4.5,
        after: 5,
      }]);
      expect(preview.courseRateDeltas).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('allows schedule calculation on an old active run only after explicit v4 selection', () => {
    const db = setupLegacyActiveDb();
    try {
      const draft = buildSeedDraft();
      expect(() => calculateSchedulePreview(db, { requestKey: 'legacy-default', draft }))
        .toThrowError(SchedulePreviewError);
      const preview = calculateSchedulePreview(db, {
        requestKey: 'legacy-upgrade',
        draft,
        targetRuleSetVersion: 'erp-tag-v4',
      });
      expect(preview.ruleSetVersion).toBe('erp-tag-v4');
    } finally {
      db.close();
    }
  });

  it('blocks ordinary activation and legacy settings previews without changing persisted history', () => {
    const db = setupLegacyActiveDb();
    try {
      expect(() => activateImport(db, {
        importId: 'imp_synthetic_159',
        expectedRevision: 1,
        idempotencyKey: 'activate-legacy-active',
      })).toThrowError(ActivateError);
      const activeBefore = db.prepare('SELECT active_run_id, revision FROM active_state WHERE id = 1').get();
      expect(activeBefore).toEqual({ active_run_id: 'run_legacy_v2', revision: 1 });
      expect(db.prepare('SELECT COUNT(*) AS total FROM calculation_runs').get()).toEqual({ total: 1 });

      const draft = buildSeedDraft();
      const now = new Date().toISOString();
      saveSettingsPreview(db, {
        previewId: 'setprev_legacy_target',
        inputHash: hashSettingsDraft(draft),
        draftJson: JSON.stringify(draft),
        expectedRevision: 1,
        settingsVersionId: 'setv_synthetic_159',
        importId: 'imp_synthetic_159',
        resultJson: '{}',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        targetRuleSetVersion: 'erp-tag-v2',
      });
      expect(() => applySettingsPreview(db, {
        previewId: 'setprev_legacy_target',
        expectedRevision: 1,
        idempotencyKey: 'apply-legacy-target',
      })).toThrow(/v4|upgrade/i);
      expect(db.prepare('SELECT active_run_id, revision FROM active_state WHERE id = 1').get())
        .toEqual(activeBefore);
      expect(db.prepare('SELECT COUNT(*) AS total FROM calculation_runs').get()).toEqual({ total: 1 });
      expect(db.prepare('SELECT COUNT(*) AS total FROM settings_versions').get()).toEqual({ total: 1 });
    } finally {
      db.close();
    }
  });

  it('replays a successful pre-v4 activation idempotency record before the legacy-active guard', () => {
    const db = setupLegacyActiveDb();
    try {
      const requestFields = { importId: 'imp_synthetic_159', expectedRevision: 1, asOfDate: '' };
      const legacyHash = crypto.createHash('sha256')
        .update(JSON.stringify({ ...requestFields, ruleSetVersion: 'erp-tag-v2' })).digest('hex');
      const response = {
        runId: 'run_preexisting_success', revision: 2, activeImportId: 'imp_synthetic_159',
        activeRunId: 'run_preexisting_success', status: 'completed', issueCounts: {}, totalStudents: 1,
      };
      db.prepare(`INSERT INTO idempotency_records
        (idempotency_key, request_body_hash, run_id, response_payload, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run('legacy-replay-key', legacyHash, response.runId, JSON.stringify(response), '2026-10-23T00:00:00.000Z');

      expect(activateImport(db, {
        importId: 'imp_synthetic_159', expectedRevision: 1, idempotencyKey: 'legacy-replay-key',
      })).toEqual(response);
      expect(db.prepare('SELECT active_run_id, revision FROM active_state WHERE id = 1').get())
        .toEqual({ active_run_id: 'run_legacy_v2', revision: 1 });
      expect(db.prepare('SELECT COUNT(*) AS total FROM calculation_runs').get()).toEqual({ total: 1 });
    } finally {
      db.close();
    }
  });

  it('does not infer enrichment/chinese before rates that student_calculations never persisted', () => {
    const db = setupLegacyActiveDb();
    try {
      const calculate = billingCalculator.calculateStudentBilling;
      vi.spyOn(billingCalculator, 'calculateStudentBilling').mockImplementation((student, options) => {
        const result = calculate(student, options);
        return {
          ...result,
          applicableRates: { ...result.applicableRates, enrichment: 9500, chinese: 9500 },
        };
      });
      const preview = previewSettingsChange(db, 'imp_synthetic_159', {
        draft: buildSeedDraft(), expectedRevision: 1, targetRuleSetVersion: 'erp-tag-v4',
      });
      expect(preview.courseRateDeltas?.filter((delta) => delta.course === 'enrichment' || delta.course === 'chinese'))
        .toEqual([]);
    } finally {
      db.close();
    }
  });
});
