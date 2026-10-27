import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { executeCalculationRun } from '@/application/calculate-run';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { getCalculationRun, saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { queryRunStudents } from '@/application/query-students';
import { useGlobalTempDb, saveSyntheticBatch, makeStudent } from '../helpers/d1-test-kit';
import { compare as compareBilling } from '../../scripts/compare-billing-report.mjs';

/**
 * issue #140 第 4 項：`not_configured` 的可達性必須由**正式測試**釘住，而不是靠一次性探針。
 *
 * ## 三種情形的可達性（reviewer 本輪更正過自己的宣稱）
 *
 * | 情形 | 可達性 |
 * |---|---|
 * | 無輔導班報名（`careClassName === ''`） | 正常流程可達 |
 * | 有輔導班報名、快照類別為 `none` | 正常流程可達 |
 * | **有輔導班報名、快照查無該班** | 需 DB 於 run 建立後變動；**正常流程不可達** |
 *
 * 第 1 種與第 3 種各由 `useSnapshot = !!rateContext && careClassName !== ''` 的
 * **不同側**決定，兩者都要在**真實 DB 輸出**上釘住：
 *
 * - 第 3 種（本檔 Test A）：`careClassName !== ''` 為真 → 進快照查詢 → 查無 → fail-closed。
 *   以 SQL 事後補列建構。這不是人造情境：`student_enrollments` 的 FK 只指向
 *   `import_batches`／`imported_students`（`migrations/0002_students_enrollments.sql`），
 *   **沒有任何約束阻止 run 建立後再插一筆報名**。
 * - 第 1 種（本檔 Test B）：`careClassName === ''` 為假 → 維持既有年級側讀數。
 *   這正是前一輪在真實資料上踩到的 37 列中 11 列的形狀（報表以科目取列，把只有
 *   美語／數學報名的學生帶進輔導報告）；若少了那道界線，這 11 列的適用率會整欄變成 `-`。
 *
 * 兩條都用**生產鏈**產生名冊與快照（`executeCalculationRun` → `saveCalculationRun`），
 * 再以 `queryRunStudents` 取出工具實際會收到的形狀，最後餵進真正的 `compare()`。
 */

const CARE_CLASS = '國小輔導-三年級';
const ENGLISH_CLASS = '兒童美語-A';

type Db = ReturnType<typeof import('@/adapters/sqlite').getDatabase>;

function runV4(db: Db, importId: string, runId: string) {
  const res = executeCalculationRun(db, importId, runId, { ruleSetVersion: 'erp-tag-v4' as never });
  const defJson = JSON.stringify({ id: 'care', label: '安親課輔班', scheduleMode: 'care_window' });
  const defHash = crypto.createHash('sha256').update(defJson).digest('hex');
  const semantics = [{
    baseName: CARE_CLASS,
    resolvedBaseName: CARE_CLASS,
    snapshotSchemaVersion: 2,
    classTypeId: 'care',
    classTypeDefinitionJson: defJson,
    classTypeDefinitionHash: defHash,
    subject: '國小輔導',
    subjectSource: 'seed',
    category: 'care',
    categorySource: 'seed',
    fixedFiveDays: 0,
    summaryDayRolesJson: '[]',
    summaryDayRoleConditionsJson: '[]',
    summaryDayRolesStatus: 'configured',
    summaryDayRolesSource: 'seed',
    erpTierApplicability: 'applicable',
    erpTierApplicabilitySource: 'seed',
  }];
  saveCalculationRun(db, res.run, res.results, res.classCategories);
  return res;
}

/** 報表端的輔導學費列（合成班名；`days` 由級距 `[3]` 解出，與名冊天數無關）。 */
function careReportEntries(name: string, className: string) {
  return new Map([
    [
      name,
      {
        name,
        tuition: `${className}[團][3] - 40 堂課`,
        discounts: [`${className}[團] - 課程費 9折`],
        otherDiscounts: [],
        other: [],
        billNo: 'B001',
        billDate: '2026-10-01',
        billStatus: '已開立',
      },
    ],
  ]);
}

/** 由 run 讀出工具端會拿到的 `rateContext`（形狀與 API 回應相同）。 */
function rateContextOf(db: Db, runId: string) {
  const run = getCalculationRun(db, runId);
  expect(run, 'run 必須存在').not.toBeNull();
  return {
    isV3Run: true,
    ruleSetVersion: 'erp-tag-v4',
    classCategories: (run as { classCategories?: unknown }).classCategories,
    classSemantics: (run as { classSemantics?: unknown }).classSemantics,
  };
}

describe('issue #140 第 4 項：not_configured 分支的可達性（正式測試）', () => {
  const ctx = useGlobalTempDb('sb-i140-reach-');

  it('Test A：run 建立後才補列輔導班報名 → 工具進 fail-closed 分支，標為 WEB_RATE_NOT_CONFIGURED', () => {
    const db = ctx.db();
    runMigrations(db);
    saveSyntheticBatch(db, 'imp', 'synthetic.xlsx', '2026-09-30T00:00:00.000Z', [
      makeStudent('S010', [ENGLISH_CLASS], { grade: 3, sourceRow: 1 }),
      makeStudent('S012', [CARE_CLASS], { grade: 3, sourceRow: 3 }),
    ]);
    runV4(db, 'imp', 'run_v4');

    // Keep report-side semantics while removing only the category projection. The v4 rate must
    // fail closed when its two snapshots disagree or are incomplete.
    db.prepare('DELETE FROM run_class_categories WHERE run_id = ? AND base_name = ?').run('run_v4', CARE_CLASS);

    // 前置狀態：該生名冊裡沒有輔導班；其 run 缺少這個班的 category projection
    const before = queryRunStudents(db, 'run_v4', { limit: 50 }).items[0]!;
    expect(before.enrollments.some((e) => e.baseName?.includes('國小輔導'))).toBe(false);
    const rows = (rateContextOf(db, 'run_v4').classCategories ?? []) as Array<{ base_name: string }>;
    expect(rows.some((r) => r.base_name === CARE_CLASS)).toBe(false);


    // 事後補列：run 已凍結，但名冊的報名表可以再長出一筆（0002 的 FK 不阻止）
    db.prepare(
      `INSERT INTO student_enrollments (
         id, import_id, person_code, token_index, raw_token, year_prefix,
         base_name, group_flag, modifiers, withdrawal_date, erp_billing_tier_raw,
         erp_billing_tier, tier_parse_status, parse_status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'imp_S010_extra', 'imp', 'S010', 1, `${CARE_CLASS}[團][3]`, null,
      CARE_CLASS, '團', '[]', null, null, 3, 'parsed', 'parsed', '2026-10-02T00:00:00.000Z'
    );

    const w = queryRunStudents(db, 'run_v4', { limit: 50 }).items[0]!;
    // 工具端的 `careClassNameOf` 以 `baseName.includes('國小輔導')` 取班 → 這下取到了
    expect(w.enrollments.some((e) => e.baseName?.includes('國小輔導'))).toBe(true);

    const { records } = compareBilling(
      careReportEntries(w.name, CARE_CLASS),
      [w],
      '2026-10-01',
      rateContextOf(db, 'run_v4') as never
    );

    expect(records[0]!.statusCategory).toBe('WEB_RATE_NOT_CONFIGURED');
    expect(records[0]!.web!.rateBps).toBeNull();
    // 不得退回名稱映射：該生 `applicableTutoringBps` 為年級側的值，
    // 若 fail-closed 分支沒走，這裡就會拿到一個看起來很正常的數字。
    expect(records[0]!.web!.rateBps).not.toBe(w.applicableTutoringBps);
  });

  it('Test B：v3 但該生名冊無輔導班（真實資料 11 列的形狀）→ 維持年級側讀數，不得變成無法判定', () => {
    const db = ctx.db();
    runMigrations(db);
    // 兩個學生：一個有輔導班（讓 run 有快照），一個只有美語（模擬被科目式取列帶進報告者）
    saveSyntheticBatch(db, 'imp', 'synthetic.xlsx', '2026-09-30T00:00:00.000Z', [
      makeStudent('S010', [CARE_CLASS], { grade: 3, sourceRow: 1 }),
      makeStudent('S011', [ENGLISH_CLASS], { grade: 3, sourceRow: 2 }),
    ]);
    runV4(db, 'imp', 'run_v4');

    const items = queryRunStudents(db, 'run_v4', { limit: 50 }).items;
    const noCare = items.find((s) => s.personCode === 'S011')!;
    expect(noCare.enrollments.some((e) => e.baseName?.includes('國小輔導'))).toBe(false);

    const { records } = compareBilling(
      careReportEntries(noCare.name, ENGLISH_CLASS),
      [noCare],
      '2026-10-01',
      rateContextOf(db, 'run_v4') as never
    );

    // `careClassName !== ''` 為假 → 這條界線讓它維持既有年級側讀數。
    // 少了這道界線，「一律走快照」會讓這一列的適用率整欄變成 `-`（前一輪實測回歸）。
    expect(records[0]!.statusCategory).not.toBe('WEB_RATE_NOT_CONFIGURED');
    expect(records[0]!.web!.rateBps).not.toBeNull();
  });
});
