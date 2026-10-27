import { describe, it, expect } from 'vitest';
import { GET as runGET } from '@/app/api/v1/runs/[runId]/route';
import { GET as currentGET } from '@/app/api/v1/runs/current/route';
import { applicableRateForClass, loadRunClassCategories } from '@/application/applicable-rate';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { getCalculationRun, saveCalculationRun, type CalculationRunRecord } from '@/adapters/sqlite/runs-repository';
import { useGlobalTempDb, getRequest, saveSyntheticBatch, makeStudent } from '../helpers/d1-test-kit';

/**
 * issue #122：舊 v3 run 的類別快照必須經由讀模型（`getCalculationRun`）曝光，
 * 讓 `GET /api/v1/runs/{id}` 與 `/api/v1/runs/current` 兩條路徑都能取得。
 *
 * 規格錨點：03 §5.3.4（快照優先；v3 run 缺該班快照時嚴禁以當前班名猜測）。
 *
 * ## 歷史資料 fixture
 *
 * 這是本 repo 自己的判例（`d2a-run-class-categories-persistence.test.ts:11-16`，D2a N-6）：
 * 該案的「讀模型」測試只呼叫了 `executeCalculationRun`，沒有 run 列，
 * 於是 `applicableRateForClass` 的 v3 分支**從未真正被驗到**——實際驗到的是
 * v2 名稱映射，而 fixture 傳入 10000 讓斷言誤通過。
 *
 * PR-2 no longer creates old-version calculations. This suite persists synthetic historical
 * v3/v2 rows directly, then checks the same read-model/API contract. Student rate fields stay
 * deliberately distinct so a missing snapshot cannot silently pass through name mapping.
 */

const RATES = {
  Anqin: 9500,
  Tutoring: 8888, // 課輔側刻意非 10000：漏載快照退回名稱映射時會拿到這一側
  Math: 8500,
  English: 8000,
};

/** 學生層適用率欄位（`applicableRateForClass` 的輸入形狀）。四個值互異，才驗得出「取到哪一側」。 */
const STUDENT_RATE_FIELDS = {
  applicableAnqinBps: RATES.Anqin,
  applicableTutoringBps: RATES.Tutoring,
  applicableMathBps: RATES.Math,
  applicableEnglishBps: RATES.English,
};

const runUrl = (runId: string) => `http://127.0.0.1:3000/api/v1/runs/${runId}`;
const callRun = (runId: string) => runGET(getRequest(runUrl(runId)), { params: Promise.resolve({ runId }) });
const callCurrent = () => currentGET();

type Db = ReturnType<typeof import('@/adapters/sqlite').getDatabase>;

/** 名冊：兩個班，自動偵測結果與手動覆寫值刻意不同，否則覆寫與否無從區辨。 */
function seedRoster(db: Db, importId: string) {
  saveSyntheticBatch(db, importId, 'synthetic.xlsx', '2026-09-30T00:00:00.000Z', [
    makeStudent('S001', ['國小數學-三A'], { grade: 4, sourceRow: 1 }),
    makeStudent('S002', ['兒童美語-A'], { grade: 4, sourceRow: 2 }),
  ]);
}

/** Fixed synthetic pre-#159 row; history readers must not invoke a retired calculator. */
function saveHistoricalRun(db: Db, importId: string, runId: string, version: 'erp-tag-v2' | 'erp-tag-v3') {
  const run: CalculationRunRecord = {
    id: runId,
    importId,
    scheduleVersionId: 'seed-v250922',
    ruleSetVersion: version,
    numericPolicy: 'integer-minute-rational-v1',
    asOfDate: '2026-09-30',
    status: 'completed',
    issueCounts: {},
    totalStudents: 2,
    createdAt: '2026-09-30T00:00:00.000Z',
  };
  const categories = version === 'erp-tag-v3'
    ? [
        { baseName: '國小數學-三A', category: 'math', fixedFiveDays: 0, mapped: 1, source: 'auto' },
        { baseName: '兒童美語-A', category: 'english', fixedFiveDays: 0, mapped: 1, source: 'auto' },
      ]
    : undefined;
  saveCalculationRun(db, run, [], categories);
}

describe('issue #122：run 類別快照的 API 可見性（03 §5.3.4）', () => {
  const ctx = useGlobalTempDb('sb-issue122-');

  it('persisted v3 run：GET /api/v1/runs/{id} 回應含底線命名的 classCategories 快照', async () => {
    const db = ctx.db();
    runMigrations(db);
    seedRoster(db, 'imp_v3');
    saveHistoricalRun(db, 'imp_v3', 'run_v3', 'erp-tag-v3');

    const res = await callRun('run_v3');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { classCategories?: Array<Record<string, unknown>> };

    expect(body.classCategories, 'v3 run 必須回傳類別快照').toBeDefined();
    expect(Array.isArray(body.classCategories)).toBe(true);
    // 兩個班各一列；內容由名冊班名自動偵測而來（未覆寫），與 production 快照同源。
    const rows = body.classCategories!;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.base_name).sort()).toEqual(['兒童美語-A', '國小數學-三A']);

    // 底線命名＋數字旗標：產品讀模型以 `row.fixed_five_days === 1` 判定，
    // 回成駝峰或布林會讓「固定 5 天 → 100%」靜默失效，而只斷言「有快照」抓不到。
    expect(Object.keys(rows[0]).sort()).toEqual([
      'base_name',
      'category',
      'class_type',
      'fixed_five_days',
      'mapped',
      'resolved_base_name',
      'source',
    ]);
    expect(rows.every((r) => Number.isInteger(r.fixed_five_days))).toBe(true);
    expect(rows.find((r) => r.base_name === '國小數學-三A')!.category).toBe('math');
  });

  it('GET /api/v1/runs/current 走同一條載入路徑，run.classCategories 同樣帶到', async () => {
    const db = ctx.db();
    runMigrations(db);
    seedRoster(db, 'imp_v3');
    saveHistoricalRun(db, 'imp_v3', 'run_v3', 'erp-tag-v3');
    db.prepare('UPDATE active_state SET active_run_id = ?, revision = revision + 1 WHERE id = 1').run('run_v3');

    const res = await callCurrent();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run?: { classCategories?: unknown[] } };

    expect(body.run?.classCategories).toBeDefined();
    expect(body.run!.classCategories!.length).toBe(2);
  });

  it('兩條路徑的快照必須由載入層提供（route 層不得各補一次）', async () => {
    const db = ctx.db();
    runMigrations(db);
    seedRoster(db, 'imp_v3');
    saveHistoricalRun(db, 'imp_v3', 'run_v3', 'erp-tag-v3');

    // `/api/v1/classes` 等第三條路徑也是經由同一個 getCalculationRun，
    // 若改在 route 層補欄位，這些消費端就會各自漂移。
    const run = getCalculationRun(db, 'run_v3');
    expect(run).not.toBeNull();
    const rows = (run as unknown as { classCategories?: unknown[] }).classCategories;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows!.length).toBe(2);
  });

  it('v1／v2 run：快照欄位為 undefined（此 run 沒有快照概念，不是「查不到」）', async () => {
    const db = ctx.db();
    runMigrations(db);
    seedRoster(db, 'imp_v2');
    saveHistoricalRun(db, 'imp_v2', 'run_v2', 'erp-tag-v2');

    const body = (await (await callRun('run_v2')).json()) as { classCategories?: unknown };
    // undefined＝走名稱映射；[]＝v3 但查無此班。兩者語意不可混用。
    expect(body.classCategories).toBeUndefined();
  });

  it('手動覆寫 category 的班別：以 API 快照餵入讀模型，與畫面同源（不退回當前班名）', async () => {
    const db = ctx.db();
    runMigrations(db);
    seedRoster(db, 'imp_v3');
    saveHistoricalRun(db, 'imp_v3', 'run_v3', 'erp-tag-v3');

    // 模擬維護者把「國小數學-三A」手動覆寫成 english（自動偵測為 math）。
    db.prepare('UPDATE run_class_categories SET category = ?, source = ? WHERE run_id = ? AND base_name = ?')
      .run('english', 'manual', 'run_v3', '國小數學-三A');

    const body = (await (await callRun('run_v3')).json()) as { classCategories: Array<Record<string, unknown>> };
    expect(body.classCategories.find((r) => r.base_name === '國小數學-三A')!.category).toBe('english');

    const rate = applicableRateForClass('國小數學-三A', { grade: 4, ...STUDENT_RATE_FIELDS }, {
      
      findSnapshot: (name) => body.classCategories.find((r) => r.base_name === name) as never,
    });
    // 快照說 english → 取 English 側；退回當前班名會取 Math 側 8500。
    expect(rate).toEqual({ status: 'configured', bps: RATES.English });
    expect(rate).not.toEqual({ status: 'configured', bps: RATES.Math });
  });

  it('手動覆寫 fixed_five_days 的班別：讀模型回 10000；旗標為布林時本條會紅', async () => {
    const db = ctx.db();
    runMigrations(db);
    seedRoster(db, 'imp_v3');
    saveHistoricalRun(db, 'imp_v3', 'run_v3', 'erp-tag-v3');

    db.prepare('UPDATE run_class_categories SET fixed_five_days = ?, source = ? WHERE run_id = ? AND base_name = ?')
      .run(1, 'manual', 'run_v3', '兒童美語-A');

    const body = (await (await callRun('run_v3')).json()) as { classCategories: Array<Record<string, unknown>> };
    const row = body.classCategories.find((r) => r.base_name === '兒童美語-A')!;
    expect(typeof row.fixed_five_days).toBe('number');
    expect(row.fixed_five_days).toBe(1);

    const rate = applicableRateForClass('兒童美語-A', { grade: 4, ...STUDENT_RATE_FIELDS }, {
      
      findSnapshot: (name) => body.classCategories.find((r) => r.base_name === name) as never,
    });
    expect(rate).toEqual({ status: 'configured', bps: 8000 });
  });

  it('v3 run 缺該班快照：仍回 not_configured，嚴禁以當前班名（國小數學→math）猜測', async () => {
    const db = ctx.db();
    runMigrations(db);
    seedRoster(db, 'imp_v3');
    saveHistoricalRun(db, 'imp_v3', 'run_v3', 'erp-tag-v3');

    const body = (await (await callRun('run_v3')).json()) as { classCategories: Array<Record<string, unknown>> };

    // 「國小數學-三B」班名本身會映射到 math（→ 8500），但快照沒有這一班。
    const rate = applicableRateForClass('國小數學-三B', { grade: 4, ...STUDENT_RATE_FIELDS }, {
      
      findSnapshot: (name) => body.classCategories.find((r) => r.base_name === name) as never,
    });
    expect(rate).toEqual({ status: 'not_configured' });
    expect(rate).not.toEqual({ status: 'configured', bps: RATES.Math });
  });

  it('v3 run 但零快照列：回空陣列（不是 undefined），且讀模型回 not_configured', async () => {
    const db = ctx.db();
    runMigrations(db);
    seedRoster(db, 'imp_v3');
    saveHistoricalRun(db, 'imp_v3', 'run_v3', 'erp-tag-v3');
    db.prepare('DELETE FROM run_class_categories WHERE run_id = ?').run('run_v3');

    const body = (await (await callRun('run_v3')).json()) as { classCategories: unknown };
    expect(body.classCategories).toEqual([]);
    expect(loadRunClassCategories(db, 'run_v3')).toEqual([]);

    const rate = applicableRateForClass('國小數學-三A', { grade: 4, ...STUDENT_RATE_FIELDS }, {
      
      findSnapshot: () => undefined,
    });
    expect(rate).toEqual({ status: 'not_configured' });
  });

  it('快照不隨 run 之後的設定變動而改變（03 §5.3.4：之後不再重新偵測）', async () => {
    const db = ctx.db();
    runMigrations(db);
    seedRoster(db, 'imp_v3');
    saveHistoricalRun(db, 'imp_v3', 'run_v3', 'erp-tag-v3');

    const before = (await (await callRun('run_v3')).json()) as { classCategories: unknown[] };
    // 再算一次（新的 run）不應回頭改動既有 run 的快照列。
    saveHistoricalRun(db, 'imp_v3', 'run_v3b', 'erp-tag-v3');
    const after = (await (await callRun('run_v3')).json()) as { classCategories: unknown[] };

    expect(after.classCategories).toEqual(before.classCategories);
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_class_categories WHERE run_id = ?').get('run_v3')).toEqual({ n: 2 });
  });
});
