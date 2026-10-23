import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { buildSeedDraft, draftToAliasMap, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { generateImportPreview } from '@/application/import-preview';
import { executeCalculationRun } from '@/application/calculate-run';
import { buildSchedulePreview } from '@/application/schedule-preview';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { projectActionableIssues, projectActionableIssueCounts } from '@/domain/issues/actionable-issues';
import type { CalculateDraft, SettingsDraft } from '@/contracts/settings';

/**
 * D1 不變式（specs/11 §3 D1、04 §8 UX34）：v1／v2／compat 的計算輸出在 D1 前後逐欄相同。
 *
 * 這個 helper 只使用 8961c03 就已存在的公開函式（calculateStudentBilling、executeCalculationRun、
 * buildSchedulePreview），輸入是 repo 內合成 fixture（conforming-erp-fixture.xlsx，477 人）。
 * golden（tests/fixtures/d1-invariance-golden.json）由**未修改的 8961c03** 執行
 * `npx tsx tests/helpers/generate-d1-invariance-golden.ts` 產生。
 *
 * 政策邊界（operator 裁決 d-20260930131128030911-29 授權）：
 * 本工具屬於狹義之 pre-change baseline 差異特徵化（differential characterization），僅用於驗證重構
 * 前後未發生非預期漂移，不得作為獨立計費正確性 oracle。
 *
 * 每位學生只存業務欄位的 SHA-256 摘要（前 16 碼）：golden 不含任何學生資料，也不放大 repo。
 * 摘要涵蓋：天數（days／displayDays／status／額外扣天旗標／是否報名）、科數、基本折扣、六種課程適用率、
 * 級距比較（含 needsReview 與 issues）、issue code 與訊息、hasIssues；run 層另含八項總表天數、
 * tierMismatch、issueCounts、trace。識別／時間欄位（runId、createdAt、id）不進摘要。
 */

export type Version = 'erp-tag-v1' | 'erp-tag-v2' | 'excel-v260922-compat';
export const VERSIONS: Version[] = ['erp-tag-v1', 'erp-tag-v2', 'excel-v260922-compat'];
export const CONTEXTS = ['seed', 'saved'] as const;
export type Context = (typeof CONTEXTS)[number];

const sha16 = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/**
 * 「已儲存設定」情境：在 seed 全量草稿上做會走到各種狀態的改動——
 *  - 一→一A、四年級A／B→四年級 的班名對應（alias）
 *  - 國小數學-三A 改成含週六與週一的課輔窗口時段（v2 同星期只算週一；v1／compat 純時刻比對會把週六也算進去）
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
  for (const ctx of CONTEXTS) {
    for (const version of VERSIONS) {
      const digests: string[] = [];
      const issueCodeCounts: Record<string, number> = {};
      let anqinDaysSum = 0;
      let tutoringDaysSum = 0;
      for (const s of students) {
        const c = calculateStudentBilling(s, { ruleSetVersion: version, ...contextOptions(ctx) });
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
      for (const version of ['erp-tag-v1', 'erp-tag-v2'] as const) {
        const out = executeCalculationRun(db, 'imp_inv', `run_${ctx}_${version}`, {
          ruleSetVersion: version,
          scheduleVersionId: ctx === 'seed' ? 'seed-v250922' : 'setv_inv',
          asOfDate: '2026-01-01',
          ...contextOptions(ctx),
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

  // 讀模型（逐堂／班級扣天／問題）：v1 與 v2 的同星期語意、未知星期警告
  const savedDraft = buildSavedContextDraft() as unknown as CalculateDraft;
  const schedulePreview: InvarianceSnapshot['schedulePreview'] = {};
  for (const version of ['erp-tag-v1', 'erp-tag-v2'] as const) {
    schedulePreview[version] = sha16(buildSchedulePreview(savedDraft, version));
  }

  return { fixtureStudents: students.length, calculator, run, schedulePreview };
}
