import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { buildSeedDraft, draftToAliasMap, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { generateImportPreview } from '@/application/import-preview';
import { buildClassSettingMap, executeCalculationRun } from '@/application/calculate-run';
import { buildSchedulePreview } from '@/application/schedule-preview';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
function projectActionableIssues<T extends { code: string }>(
  issues: readonly T[] | null | undefined,
  tierComparisons: Array<{ needsReview?: boolean | null }> | null | undefined
) {
  const actionableIssues = [...(issues ?? [])];
  return {
    actionableIssues,
    actionableHasIssues: actionableIssues.length > 0 || (tierComparisons ?? []).some((c) => c.needsReview === true),
  };
}

function projectActionableIssueCounts(issueCounts: Readonly<Record<string, number>>): Record<string, number> {
  return { ...issueCounts };
}
import type { CalculateDraft, SettingsDraft } from '@/contracts/settings';

/**
 * PR-2 v4 invariant: compare the current calculation output to an immutable synthetic golden
 * generated from the exact PR-1 base. The source SHA and issue normalization are recorded in
 * d1-v4-current-golden.json. The old v1/v2 direct-calculator goldens remain untouched as
 * historical evidence; this helper no longer invokes retired calculators.
 *
 * This is differential characterization, not an independent billing correctness oracle.
 * Per-student SHA-256 digests contain no names, person codes, or source workbook contents.
 */

export type Version = 'erp-tag-v4';
export const VERSIONS: Version[] = ['erp-tag-v4'];
export const CONTEXTS = ['seed', 'saved'] as const;
export type Context = (typeof CONTEXTS)[number];

const sha16 = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/**
 * 「已儲存設定」情境：在 seed 全量草稿上做會走到各種狀態的改動——
 *  - 一→一A、四年級A／B→四年級 的班名對應（alias）
 *  - 國小數學-三A 改成含週六與週一的課輔窗口時段
 *  - 國小數學-二B 整班移除（schedule_not_found）
 *  - 兒童美語-EA 星期改成「八」（未知星期，v2 fail-closed 並出警告）
 *  - 兒童美語-EB 停用（空覆寫 → schedule_empty）
 */
export function buildSavedContextDraft(): SettingsDraft {
  const seed = buildSeedDraft();
  const classes = seed.classes
    .filter((c) => c.baseName !== '國小數學-二B')
    .map((c) => {
      if (c.baseName === '國小數學-三A') {
        return {
          ...c,
          sessions: [
            { weekday: '六', startMinutes: 990, endMinutes: 1080, skipDeduction: false },
            { weekday: '一', startMinutes: 990, endMinutes: 1080, skipDeduction: false },
          ],
        };
      }
      if (c.baseName === '兒童美語-EA') {
        return { ...c, sessions: c.sessions.map((s) => ({ ...s, weekday: '八' })) };
      }
      if (c.baseName === '兒童美語-EB') return { ...c, active: false };
      return c;
    });
  return {
    ...seed,
    classes,
    aliases: [
      { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' },
      { rawBaseName: '國小輔導-四年級A', targetBaseName: '國小輔導-四年級' },
      { rawBaseName: '國小輔導-四年級B', targetBaseName: '國小輔導-四年級' },
    ],
  };
}

function contextOptions(ctx: Context): {
  aliasMap?: Map<string, string>;
  scheduleOverride?: ReturnType<typeof draftToScheduleOverride>;
} {
  if (ctx === 'seed') return {};
  const draft = buildSavedContextDraft();
  return { aliasMap: draftToAliasMap(draft), scheduleOverride: draftToScheduleOverride(draft) };
}

function runContextOptions(ctx: Context) {
  const contextDraft = ctx === 'seed' ? buildSeedDraft() : buildSavedContextDraft();
  const aliasMap = draftToAliasMap(contextDraft);
  return {
    classSettings: buildClassSettingMap(buildSeedDraft()),
    ...(ctx === 'saved' ? { aliasMap, scheduleOverride: draftToScheduleOverride(contextDraft) } : {}),
  };
}

function calcTuple(c: ReturnType<typeof calculateStudentBilling>) {
  const care = (x: ReturnType<typeof calculateStudentBilling>['careDays']['anqin']) => [
    x.days,
    x.displayDays,
    x.status,
    x.hasExtraFlag,
    x.isEnrolled,
  ];
  return [
    c.subjectCount,
    c.baseDiscountBps,
    care(c.careDays.anqin),
    care(c.careDays.tutoring),
    [
      c.applicableRates.anqin,
      c.applicableRates.tutoring,
      c.applicableRates.english,
      c.applicableRates.math,
      c.applicableRates.enrichment,
      c.applicableRates.chinese,
    ],
    c.tierComparisons.map((t) => [t.enrollmentId, t.computedTier, t.erpDeclaredTier, t.status, t.needsReview, t.issues]),
    c.issues.map((i) => [i.code, i.category ?? null, i.message]),
    c.hasIssues,
  ];
}

interface GroupSnapshot {
  count: number;
  digests: string[];
  rollup: string;
  issueCodeCounts: Record<string, number>;
  anqinDaysSum: number;
  tutoringDaysSum: number;
}

function rollup(digests: string[]) {
  return sha16(digests);
}

export interface InvarianceSnapshot {
  fixtureStudents: number;
  calculator: Record<string, GroupSnapshot>;
  run: Record<string, GroupSnapshot & { runIssueCounts: Record<string, number> }>;
  schedulePreview: Record<string, string>;
}

/** 計算目前程式碼的不變式快照（golden 由 8961c03 產生；D1 之後必須逐位元相同）。 */
export async function computeInvarianceSnapshot(): Promise<InvarianceSnapshot> {
  const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
  const preview = await generateImportPreview(buf, 'fixture.xlsx');
  const students = preview.students;

  const calculator: InvarianceSnapshot['calculator'] = {};
  const fixtureEnrollments = preview.students.flatMap((student) => student.enrollments);
  for (const ctx of CONTEXTS) {
    for (const version of VERSIONS) {
      const context = contextOptions(ctx);
      const digests: string[] = [];
      const issueCodeCounts: Record<string, number> = {};
      let anqinDaysSum = 0;
      let tutoringDaysSum = 0;
      for (const s of students) {
        const c = calculateStudentBilling(s, {
          ruleSetVersion: version,
          ...context,
          classSettings: buildClassSettingMap(buildSeedDraft()),
        });
        digests.push(sha16([s.sourceRow, ...calcTuple(c)]));
        for (const i of c.issues) issueCodeCounts[i.code] = (issueCodeCounts[i.code] ?? 0) + 1;
        anqinDaysSum += c.careDays.anqin.days ?? 0;
        tutoringDaysSum += c.careDays.tutoring.days ?? 0;
      }
      calculator[`${ctx}/${version}`] = {
        count: students.length,
        digests,
        rollup: rollup(digests),
        issueCodeCounts: Object.fromEntries(Object.entries(issueCodeCounts).sort()),
        anqinDaysSum,
        tutoringDaysSum,
      };
    }
  }

  // run 層：executeCalculationRun（PR-1 formal 結果、八項總表天數、trace 與歷史基準的正規化比較）
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-d1-inv-'));
  const db = createDatabase(path.join(tempDir, 'inv.sqlite'));
  const run: InvarianceSnapshot['run'] = {};
  try {
    runMigrations(db);
    saveImportBatch(
      db,
      {
        id: 'imp_inv',
        fileName: preview.fileName,
        fileHash: preview.fileHash,
        contentHash: preview.contentHash,
        sheetName: preview.sheetName,
        headerMap: preview.headerMapping,
        parserVersion: '1.0.0',
        scopeNote: preview.scopeNote,
        rowCount: preview.stats.totalStudents,
        status: 'ready',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      preview.students
    );
    for (const ctx of CONTEXTS) {
      for (const version of ['erp-tag-v4'] as const) {
        const out = executeCalculationRun(db, 'imp_inv', `run_${ctx}_${version}`, {
          ruleSetVersion: version,
          scheduleVersionId: ctx === 'seed' ? 'seed-v250922' : 'setv_inv',
          asOfDate: '2026-01-01',
          ...runContextOptions(ctx),
        });
        const digests = out.results.map((r) => {
          const actionable = projectActionableIssues(r.issues, r.tierComparisons);
          return sha16([
            r.personCode,
            r.subjectCount,
            r.baseDiscountBps,
            r.anqinDays,
            r.anqinDisplay,
            r.tutoringDays,
            r.tutoringDisplay,
            r.englishDays,
            r.mathDays,
            r.chineseDays,
            r.homeworkDays,
            r.intensiveEnglishDays,
            r.saturdayTutoringDays,
            r.applicableAnqinBps,
            r.applicableTutoringBps,
            r.applicableEnglishBps,
            r.applicableMathBps,
            r.tierMismatch,
            r.tierComparisons,
            actionable.actionableIssues,
            actionable.actionableHasIssues,
            r.trace,
          ]);
        });
        const actionableIssueCounts = projectActionableIssueCounts(out.run.issueCounts);
        run[`${ctx}/${version}`] = {
          count: out.results.length,
          digests,
          rollup: sha16([rollup(digests), out.run.ruleSetVersion, out.run.numericPolicy, out.run.scheduleVersionId, out.run.asOfDate, out.run.totalStudents]),
          issueCodeCounts: Object.fromEntries(Object.entries(actionableIssueCounts).sort()),
          runIssueCounts: Object.fromEntries(Object.entries(actionableIssueCounts).sort()),
          anqinDaysSum: out.results.reduce((a, r) => a + (r.anqinDays ?? 0), 0),
          tutoringDaysSum: out.results.reduce((a, r) => a + (r.tutoringDays ?? 0), 0),
        };
      }
    }
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // Current calculation previews use v4. Historical read behavior has separate metadata tests.
  const savedDraft = buildSavedContextDraft() as unknown as CalculateDraft;
  const schedulePreview: InvarianceSnapshot['schedulePreview'] = {};
  for (const version of ['erp-tag-v4'] as const) {
    schedulePreview[version] = sha16(buildSchedulePreview(savedDraft, version));
  }

  return { fixtureStudents: students.length, calculator, run, schedulePreview };
}
