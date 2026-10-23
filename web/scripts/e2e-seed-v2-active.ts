import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/adapters/sqlite/migrator';
import { saveImportBatch } from '../src/adapters/sqlite/import-repository';
import { saveCalculationRun, type CalculationRunRecord, type StudentCalculationRecord } from '../src/adapters/sqlite/runs-repository';

/**
 * D2d E：建立「既有 v2 DB」的前置狀態，供升級旅程的瀏覽器層 journey 使用。
 *
 * 背景：課表設定頁的升級確認只在使用者有 **舊版 active run** 時出現
 * （`settings/page.tsx:93` 取 `active.run?.ruleSetVersion`），而 activate 的規則版本
 * 由 server 固定為 v4；一般產品 API 不得建立 v2 active run，因此 E2E 必須 seed 固定歷史資料。
 *
 * 依 decision（Lead 裁定 (d)）：這是「升級前的舊資料」情境前置，不是案例間清理，
 * 故允許在 server 啟動前直接準備隔離 DB；不在 web/src 的產品路徑加測試專用分支。
 *
 * 寫入方式：
 *  - 名單以 `saveImportBatch` 儲存；v2 Run 與學生結果使用固定的合成歷史 fixture，
 *    經 `saveCalculationRun` 寫入，不呼叫已退役的舊版 calculator。
 *  - active 指標：`active_state` 沒有對應的 adapter 寫入函式（既有寫入點分散在
 *    `activate-import.ts`／`apply-settings.ts` 內部），故**只以 SQL 寫那一列**。
 *    這是本檔唯一的直接 SQL，已在 PR 與報告中揭露。
 *
 * 用法（由隔離執行器於 server 啟動前呼叫）：
 *   npx tsx scripts/e2e-seed-v2-active.ts <DATABASE_PATH>
 *
 * 邊界：不讀 `data/`、不讀合成 fixture、不動使用者 DB（呼叫端負責傳入臨時目錄下的
 * 隔離路徑）；只建立「一名年級 4、報名兩班數學」的最小 v2 現況。
 */

/**
 * 一名年級 4 學生，重複報名兩班數學。
 *
 * 選這兩班的原因（固定的 PR-0 post-#157 synthetic historical fixture）：
 *   國小數學-四A（報名順序在前）：2 堂，課輔窗口（990–1170）重疊 90 分 → raw −0.5
 *        → D24 rounded −0.5 → 課輔天數 max(3, 5−0.5) = 4.5
 *   國小數學-三A：2 堂週一 990–1080、週三 1080–1170，各 90 分且 end 1170 不滿足課輔特例
 *        （特例需 end<1170）→ raw −1 → rounded −1 → 課輔天數 max(3, 5−1) = 4
 * 因此 v2（首班）與 v4（扣天最多）在升級前後的天數必不相同，畫面上可觀察到差異。
 */
const GRADE = 4;
const ENROLLMENTS = ['國小數學-四A', '國小數學-三A'];
const IMPORT_ID = 'd2d_v2_fixture';
const RUN_ID = 'd2d_v2_run';

/** Immutable synthetic v2 result captured before PR-2; never recompute it with current runtime code. */
function persistHistoricalV2Run(db: Database.Database, now: string): void {
  const enrollments = ENROLLMENTS.map((baseName) => ({
    rawToken: baseName,
    yearPrefix: null,
    baseName,
    groupFlag: null,
    modifiers: [],
    withdrawalDate: null,
    erpBillingTierRaw: null,
    erpBillingTier: null,
    tierParseStatus: 'not_applicable',
    parseStatus: 'ok',
  }));
  const run: CalculationRunRecord = {
    id: RUN_ID,
    importId: IMPORT_ID,
    scheduleVersionId: 'seed-v250922',
    ruleSetVersion: 'erp-tag-v2',
    numericPolicy: 'integer-minute-rational-v1',
    asOfDate: '2026-10-23',
    status: 'completed',
    issueCounts: { DUPLICATE_SUBJECT_ENROLLMENT: 1 },
    totalStudents: 1,
    createdAt: now,
  };
  const result: StudentCalculationRecord = {
    id: `${RUN_ID}_D2DV2001`,
    runId: RUN_ID,
    personCode: 'D2DV2001',
    name: '合成學生',
    branch: '本部',
    grade: GRADE,
    gradeRaw: '四年級',
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
    applicableAnqinBps: 10000,
    applicableTutoringBps: 10000,
    applicableEnglishBps: null,
    applicableMathBps: 10000,
    tierMismatch: false,
    tierComparisons: enrollments.map((enrollment) => ({
      enrollmentId: '',
      rawToken: enrollment.rawToken,
      baseName: enrollment.baseName,
      computedTier: null,
      erpDeclaredTier: null,
      status: 'not_applicable',
      needsReview: false,
      issues: [],
    })),
    issues: [{
      code: 'DUPLICATE_SUBJECT_ENROLLMENT',
      category: '國小數學',
      message: '學生重複報名同類別「國小數學」2 班，請檢查合成測試資料。',
    }],
    hasIssues: true,
    trace: {
      sourceRow: 1,
      rawTags: '',
      rawNotes: '',
      enrollments,
      careDays: {
        anqin: { days: null, displayDays: null, isEnrolled: false },
        tutoring: { days: 4.5, displayDays: '4.5', isEnrolled: true },
      },
    },
    createdAt: now,
  };
  saveCalculationRun(db, run, [result]);
}

function main(): void {
  const [databasePath] = process.argv.slice(2);
  if (!databasePath) {
    throw new Error('用法：tsx scripts/e2e-seed-v2-active.ts <DATABASE_PATH>');
  }
  if (!path.isAbsolute(databasePath)) {
    throw new Error(`DATABASE_PATH 必須是絕對路徑，收到 ${databasePath}`);
  }

  const db = new Database(databasePath);
  try {
    runMigrations(db);

    const now = new Date().toISOString();
    saveImportBatch(
      db,
      {
        id: IMPORT_ID,
        fileName: 'd2d-e2e-v2.xlsx',
        fileHash: 'd2d-e2e-v2',
        contentHash: 'd2d-e2e-v2',
        sheetName: 'Sheet1',
        headerMap: {},
        parserVersion: '1.0.0',
        scopeNote: '',
        rowCount: 1,
        status: 'ready',
        createdAt: now,
      },
      [
        {
          personCode: 'D2DV2001',
          name: '合成學生',
          grade: GRADE,
          gradeRaw: '四年級',
          gradeStatus: 'valid',
          branch: '本部',
          contact: null,
          schoolInfo: null,
          tagsRaw: '',
          tags: [],
          notesRaw: '',
          sourceRow: 1,
          enrollments: ENROLLMENTS.map((baseName) => ({
            rawToken: baseName,
            yearPrefix: null,
            baseName,
            groupFlag: null,
            modifiers: [],
            withdrawalDate: null,
            erpBillingTierRaw: null,
            erpBillingTier: null,
            tierParseStatus: 'not_applicable',
            parseStatus: 'ok',
          })),
        },
      ] as never
    );

    persistHistoricalV2Run(db, now);

    // active 指標：無 adapter 可寫，只以 SQL 寫這一列（已於 PR／報告揭露）
    db.prepare(
      'UPDATE active_state SET active_run_id = ?, active_import_id = ?, revision = revision + 1, updated_at = ? WHERE id = 1'
    ).run(RUN_ID, IMPORT_ID, now);

    const active = db.prepare('SELECT active_run_id FROM active_state WHERE id = 1').get() as {
      active_run_id: string;
    };
    const run = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(RUN_ID) as {
      rule_set_version: string;
    };
    const care = db
      .prepare('SELECT anqin_days, tutoring_days FROM student_calculations WHERE run_id = ? AND person_code = ?')
      .get(RUN_ID, 'D2DV2001') as { anqin_days: number | null; tutoring_days: number | null } | undefined;
    console.log(
      `E2E 前置完成：active_run_id=${active.active_run_id} rule_set_version=${run.rule_set_version}` +
        ` anqin=${care?.anqin_days ?? 'null'} tutoring=${care?.tutoring_days ?? 'null'}`
    );
  } finally {
    db.close();
  }
}

try {
  main();
} catch (e) {
  console.error('E2E v2 前置失敗：', e);
  process.exit(1);
}
