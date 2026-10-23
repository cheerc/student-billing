import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as billingCalculator from '@/domain/billing/billing-calculator';
import { executeCalculationRun } from '@/application/calculate-run';
import { getCalculationRun, saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { readRunDiagnostics } from '@/adapters/sqlite/run-diagnostics-repository';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { resolveClassAttributes } from '@/domain/classification/class-attributes';
import {
  effectiveCategoryOf,
  resolveClassEnrollment,
  type ClassSettingLookup,
} from '@/domain/classification/class-category';
import { calculateSubjectCountV3 } from '@/domain/billing/discount-rules';
import { parseSingleClassToken } from '@/domain/students/token-parser';
import type { StudentSnapshot } from '@/domain/students/types';

afterEach(() => vi.restoreAllMocks());

const RUN_ID = 'run_148_159_synthetic_baseline';
const IMPORT_ID = 'import_148_159_synthetic_baseline';

function enrollment(baseName: string) {
  return {
    rawToken: `${baseName}[團]`,
    yearPrefix: null,
    baseName,
    groupFlag: '團',
    modifiers: [],
    withdrawalDate: null,
    erpBillingTierRaw: null,
    erpBillingTier: null,
    tierParseStatus: 'not_applicable' as const,
    parseStatus: 'ok' as const,
  };
}

function student(
  personCode: string,
  grade: number,
  baseNames: string[],
  notesRaw = ''
): StudentSnapshot {
  return {
    personCode,
    name: `Synthetic student ${personCode}`,
    branch: 'Synthetic branch',
    gradeRaw: String(grade),
    grade,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw,
    enrollments: baseNames.map(enrollment),
    sourceRow: Number(personCode.slice(-1)) || 1,
  };
}

function settings(entries: Array<[string, ClassSettingLookup]>): Map<string, ClassSettingLookup> {
  return new Map(entries);
}

describe('Issues #148 + #159 PR-0: post-#157 synthetic v4 characterization', () => {
  it('keeps the seven class semantics separate and parses tier syntax without promoting category guesses', () => {
    const explicit = resolveClassAttributes('Synthetic study room', {
      classType: 'care',
      category: 'none',
      categorySource: 'manual',
      fixedFiveDays: true,
    });
    expect(explicit).toEqual({
      classType: 'care',
      category: 'none',
      categorySource: 'manual',
      fixedFiveDays: true,
    });

    expect(effectiveCategoryOf('國小數學-四A')).toEqual({ category: 'math', categorySource: 'seed' });
    expect(effectiveCategoryOf('國小數學-四A', { category: 'math', categorySource: 'unset' }))
      .toEqual({ category: 'unset', categorySource: 'unset' });
    expect(effectiveCategoryOf('國小數學-未設定班')).toEqual({ category: 'unset', categorySource: 'unset' });

    const aliasResolved = resolveClassEnrollment(
      { rawToken: '名冊原文班[團]', baseName: '名冊原文班' },
      new Map([['名冊原文班', '任意命名數學班']]),
      settings([['任意命名數學班', {
        classType: 'non_care', category: 'math', categorySource: 'manual', fixedFiveDays: false,
      }]])
    );
    expect(aliasResolved).toMatchObject({
      resolvedBaseName: '任意命名數學班', mapped: true, category: 'math', fixedFiveDays: false,
    });

    const unmappedByNameOnly = resolveClassEnrollment(
      { rawToken: '國小數學-新班[團]', baseName: '國小數學-新班' },
      undefined,
      new Map()
    );
    expect(unmappedByNameOnly).toMatchObject({
      mapped: false, category: 'unset', categorySource: 'unset', fixedFiveDays: false,
    });
    expect(calculateSubjectCountV3(['none', 'unset'])).toBe(0);

    const tier = parseSingleClassToken('115國小輔導-合成班[團][4_5] (2026-10-01離班)');
    expect(tier).toMatchObject({
      rawToken: '115國小輔導-合成班[團][4_5] (2026-10-01離班)',
      yearPrefix: '115',
      baseName: '國小輔導-合成班',
      groupFlag: '團',
      modifiers: ['4_5'],
      withdrawalDate: '2026-10-01',
      erpBillingTierRaw: '4_5',
      erpBillingTier: 4.5,
      tierParseStatus: 'parsed',
      parseStatus: 'ok',
    });
    expect(parseSingleClassToken('國小輔導-合成班[團][Starter]')).toMatchObject({
      erpBillingTier: null, tierParseStatus: 'unavailable', parseStatus: 'needs_review',
    });
    expect(parseSingleClassToken('任意數學班[團][4_5]')).toMatchObject({
      erpBillingTier: null, tierParseStatus: 'not_applicable', parseStatus: 'ok',
    });
  });

  it('freezes v4 outputs and all eight summary columns while new runs omit retired diagnostics', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);

      const summaryNames = [
        '國小輔導-合成甲',
        '國小數學-甲',
        '兒童美語-甲',
        '國語文-甲',
        '寫功課-甲',
        '加重美語-甲',
        '加強班-六甲',
      ];
      const fixedCareName = '國小輔導-固定合成乙';
      const fixedMathName = '合成數學乙';
      const policyName = '任意命名數學丙';
      const numericName = '國小數學-丁';

      const students = [
        student('SYNTH_01', 4, summaryNames),
        student('SYNTH_02', 4, [fixedCareName, fixedMathName]),
        student('SYNTH_03', 4, [policyName]),
        student('SYNTH_04', 4, [numericName]),
        student('SYNTH_05', 4, [], '園內生'),
      ];

      saveImportBatch(db, {
        id: IMPORT_ID,
        fileName: 'synthetic-roster.xlsx',
        fileHash: 'synthetic-file-hash',
        contentHash: 'synthetic-content-hash',
        sheetName: 'Synthetic',
        headerMap: {},
        parserVersion: 'synthetic-v1',
        scopeNote: '',
        rowCount: students.length,
        status: 'ready',
        createdAt: '2026-10-23T00:00:00.000Z',
      }, students);

      const classSettings = settings([
        [summaryNames[0], { classType: 'care', category: 'care', categorySource: 'manual', fixedFiveDays: false }],
        [summaryNames[1], { classType: 'non_care', category: 'math', categorySource: 'manual', fixedFiveDays: false }],
        [summaryNames[2], { classType: 'non_care', category: 'english', categorySource: 'manual', fixedFiveDays: false }],
        ...summaryNames.slice(3).map((name) => [name, {
          classType: 'non_care', category: 'none', categorySource: 'manual', fixedFiveDays: false,
        }] as [string, ClassSettingLookup]),
        [fixedCareName, { classType: 'care', category: 'care', categorySource: 'manual', fixedFiveDays: true }],
        [fixedMathName, { classType: 'non_care', category: 'math', categorySource: 'manual', fixedFiveDays: false }],
        [policyName, { classType: 'non_care', category: 'math', categorySource: 'manual', fixedFiveDays: false }],
        [numericName, { classType: 'non_care', category: 'math', categorySource: 'manual', fixedFiveDays: false }],
      ]);

      const scheduleOverride = new Map([
        [summaryNames[1], [{ start: 990, end: 1110, weekday: '三' }]],
        [summaryNames[2], [{ start: 990, end: 1110, weekday: '三', skipDeduction: true }]],
        [fixedMathName, [{ start: 900, end: 960, weekday: '一' }]],
        [policyName, [{ start: 990, end: 1110, weekday: '三' }]],
        [numericName, [{ start: 990, end: 1035, weekday: '三' }]],
      ]);

      const calculateSpy = vi.spyOn(billingCalculator, 'calculateStudentBilling');
      const { run, results, classCategories } = executeCalculationRun(db, IMPORT_ID, RUN_ID, {
        ruleSetVersion: 'erp-tag-v4',
        classSettings,
        scheduleOverride,
      });
      expect(calculateSpy).toHaveBeenCalledTimes(students.length);
      expect(calculateSpy.mock.calls.every(([_, options]) => options?.ruleSetVersion === 'erp-tag-v4')).toBe(true);
      const byCode = new Map(results.map((result) => [result.personCode, result]));

      // Hand-calculated from 02 §9A and D24: 120/180 day is a half-day deduction;
      // a skipped 120-minute English session contributes zero; 45/180 is below 0.3.
      expect(run.ruleSetVersion).toBe('erp-tag-v4');
      expect(byCode.get('SYNTH_01')).toMatchObject({
        subjectCount: 3,
        baseDiscountBps: 9000,
        anqinDays: null,
        tutoringDays: 4.5,
        englishDays: 2,
        mathDays: 2,
        chineseDays: 1,
        homeworkDays: 5,
        intensiveEnglishDays: 2,
        saturdayTutoringDays: 1,
        applicableTutoringBps: 9000,
      });
      expect(byCode.get('SYNTH_02')).toMatchObject({
        subjectCount: 2,
        baseDiscountBps: 9500,
        tutoringDays: 5,
        applicableTutoringBps: 9500,
      });
      expect(byCode.get('SYNTH_03')).toMatchObject({
        subjectCount: 1,
        baseDiscountBps: 10000,
        tutoringDays: 4.5,
        mathDays: null,
        issues: [],
      });
      expect(byCode.get('SYNTH_04')).toMatchObject({
        tutoringDays: 5,
        issues: [],
      });
      expect(byCode.get('SYNTH_05')?.issues.map((issue) => issue.code)).toContain('CONFLICTING_NOTE_SOURCE');
      expect(run.issueCounts).toEqual({ CONFLICTING_NOTE_SOURCE: 1 });

      expect(run.diagnosticAlgorithmVersion).toBeUndefined();
      expect(run.diagnostics).toBeUndefined();
      saveCalculationRun(db, run, results, classCategories);
      const persistedRun = getCalculationRun(db, RUN_ID);
      expect(persistedRun).not.toBeNull();
      expect(db.prepare('SELECT count(*) as n FROM run_diagnostics WHERE run_id = ?').get(RUN_ID)).toMatchObject({ n: 0 });
      expect(readRunDiagnostics(db, persistedRun!).status).not.toBe('supported');
    } finally {
      db.close();
    }
  });
});
