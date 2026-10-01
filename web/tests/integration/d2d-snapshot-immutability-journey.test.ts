import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import {
  buildSeedDraft,
  getLatestSettingsVersion,
  readStoredDraft,
  saveSettingsVersion,
  hashSettingsDraft,
} from '@/adapters/sqlite/settings-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import type { SettingsDraft } from '@/contracts/settings';

/**
 * D2d H（04 §8 UX60）：舊 v3 run 的類別快照不被重新分類——**專項旅程**。
 *
 * decision d-20261001050915775646-5【二】：UX60 補 integration 專項旅程：
 * 舊 v3 run → 改設定 → 新 run，舊快照逐列不變。
 *
 * 為什麼既有 generic persistence 測試不夠（04 §8 原列已寫明）：
 * `d2a-run-class-categories-persistence.test.ts` 只驗「單次 v3 run 會寫快照、刪 run 會 cascade」，
 * 沒有驗「**改了設定之後**舊快照還在」。這個差別正是回溯改寫的入口——若實作把快照寫成
 * 「以當前設定 upsert」，單次測試照樣通過。
 *
 * 本檔的旅程：v3 run A（類別 Z）→ 改 Z 的設定 → preview→apply 產生 run B → 逐列比對 run A 的快照。
 * 負向保證：run B 的快照必須反映新設定（否則「舊的不變」是因為「都沒寫」而非因為快照語意）。
 */

const Z = '國小數學-四A';

function seedStudents(db: Database.Database, importId: string) {
  saveImportBatch(
    db,
    {
      id: importId,
      fileName: 'f.xlsx',
      fileHash: 'h',
      contentHash: 'c',
      sheetName: 'Sheet1',
      headerMap: {},
      parserVersion: '1.0.0',
      scopeNote: '',
      rowCount: 1,
      status: 'ready',
      createdAt: new Date().toISOString(),
    },
    [
      {
        personCode: 'S001',
        name: '測試生',
        grade: 4,
        gradeRaw: '4',
        gradeStatus: 'valid',
        branch: '本部',
        contact: null,
        schoolInfo: null,
        tagsRaw: '',
        tags: [],
        notesRaw: '',
        sourceRow: 1,
        enrollments: [Z].map((b) => ({
          rawToken: b,
          yearPrefix: null,
          baseName: b,
          groupFlag: null,
          modifiers: [],
          withdrawalDate: null,
          erpBillingTierRaw: null,
          erpBillingTier: null,
          tierParseStatus: 'not_applicable',
          parseStatus: 'ok',
        })),
      },
    ]
  );
}

function activate(db: Database.Database, importId: string, runId: string, version: string) {
  const res = executeCalculationRun(db, importId, runId, { ruleSetVersion: version as never });
  saveCalculationRun(db, res.run, res.results, res.classCategories);
  db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ? WHERE id = 1').run(runId, importId);
  return res;
}

/**
 * 讀回某 run 的整份類別快照，依 baseName 排序，供逐列 toEqual 比對。
 *
 * 直接查表而非走 `loadRunClassCategories`：該讀模型只 SELECT base_name／category／
 * fixed_five_days 三欄（讀折扣適用率只需這些），「逐列不變」要連 source／mapped 一起比，
 * 才不會漏掉「值沒變但來源被改寫」這種回溯改寫。
 */
function snapshotOf(db: Database.Database, runId: string) {
  return (
    db
      .prepare(
        'SELECT base_name, category, fixed_five_days, mapped, source FROM run_class_categories WHERE run_id = ?',
      )
      .all(runId) as Array<{
      base_name: string;
      category: string;
      fixed_five_days: number;
      mapped: number;
      source: string;
    }>
  ).sort((a, b) => a.base_name.localeCompare(b.base_name));
}

describe('D2d H: UX60 舊 v3 run 的類別快照不被重新分類（專項旅程）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedStudents(db, 'imp_snap');
  });

  afterEach(() => db.close());

  /** 存一份設定版本作為 baseline（revision 遞增）。 */
  function storeDraft(draft: SettingsDraft, id: string, revision: number) {
    saveSettingsVersion(db, {
      id,
      contentHash: hashSettingsDraft(draft),
      contentJson: JSON.stringify(draft),
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: new Date().toISOString(),
      createdFromPreviewId: null,
      revision,
    });
    db.prepare('UPDATE active_state SET revision = ? WHERE id = 1').run(revision);
  }

  it('舊 v3 run → 改該班類別 → 新 run：舊快照逐列不變，新快照反映新類別', () => {
    // 1. 存 baseline 設定（Z 未手動 → 依班名自動偵測為 math）
    storeDraft(buildSeedDraft(), 'v1', 1);

    // 2. 產生舊的 v3 run A
    activate(db, 'imp_snap', 'run_A', 'erp-tag-v3');
    const snapA_before = snapshotOf(db, 'run_A');
    expect(snapA_before.find((r) => r.base_name === Z)).toMatchObject({
      category: 'math',
      source: 'auto',
    });

    // 3. 改設定：把 Z 手動設為不列入折扣（none）
    const draft2 = buildSeedDraft();
    const target = draft2.classes.find((c) => c.baseName === Z)!;
    target.category = 'none';
    target.categorySource = 'manual';
    storeDraft(draft2, 'v2', 2);

    // 3b. 走真實 preview→apply 產生新 run B（apply 才是寫入點）
    const revision = (
      db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as { revision: number }
    ).revision;
    const preview = previewSettingsChange(db, 'imp_snap', { draft: draft2, expectedRevision: revision });
    const applied = applySettingsPreview(db, {
      previewId: preview.previewId,
      expectedRevision: revision,
      idempotencyKey: 'd2d-h-ux60',
    });
    expect(applied.runId).not.toBe('run_A');

    // 4. 舊 run A 的快照逐列不變（核心斷言）
    const snapA_after = snapshotOf(db, 'run_A');
    expect(snapA_after).toEqual(snapA_before);

    // 5. 負向保證：新 run B 必須真的反映新類別（否則「舊的不變」只是因為都沒寫）
    const snapB = snapshotOf(db, applied.runId);
    expect(snapB.find((r) => r.base_name === Z)).toMatchObject({
      category: 'none',
      source: 'manual',
    });
    expect(snapB).not.toEqual(snapA_after);
  });

  it('改設定不影響舊 run 的計算列（student_calculations 不回溯改寫）', () => {
    storeDraft(buildSeedDraft(), 'v1', 1);
    activate(db, 'imp_snap', 'run_A', 'erp-tag-v3');

    const rowsBefore = db
      .prepare('SELECT * FROM student_calculations WHERE run_id = ?')
      .all('run_A') as unknown[];

    // 改設定：Z 改成不列入折扣（會改變科數與基本折扣）
    const draft2 = buildSeedDraft();
    const target = draft2.classes.find((c) => c.baseName === Z)!;
    target.category = 'none';
    target.categorySource = 'manual';
    storeDraft(draft2, 'v2', 2);

    const revision = (
      db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as { revision: number }
    ).revision;
    const preview = previewSettingsChange(db, 'imp_snap', { draft: draft2, expectedRevision: revision });
    applySettingsPreview(db, {
      previewId: preview.previewId,
      expectedRevision: revision,
      idempotencyKey: 'd2d-h-ux60-b',
    });

    const rowsAfter = db
      .prepare('SELECT * FROM student_calculations WHERE run_id = ?')
      .all('run_A') as unknown[];
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter.length).toBeGreaterThan(0);
  });

  it('已存設定的舊版本不被新設定覆寫（各自 contentJson 保持當時的值）', () => {
    storeDraft(buildSeedDraft(), 'v1', 1);

    const draft2 = buildSeedDraft();
    const target = draft2.classes.find((c) => c.baseName === Z)!;
    target.category = 'none';
    target.categorySource = 'manual';
    storeDraft(draft2, 'v2', 2);

    const v1 = db.prepare('SELECT content_json FROM settings_versions WHERE id = ?').get('v1') as {
      content_json: string;
    };
    const v2 = db.prepare('SELECT content_json FROM settings_versions WHERE id = ?').get('v2') as {
      content_json: string;
    };
    const readV1 = readStoredDraft(v1.content_json);
    const readV2 = readStoredDraft(v2.content_json);

    expect(readV1.classes.find((c) => c.baseName === Z)?.categorySource).toBeUndefined();
    expect(readV2.classes.find((c) => c.baseName === Z)).toMatchObject({
      category: 'none',
      categorySource: 'manual',
    });

    // 最新版本讀回仍為 v2（readStoredDraft 是唯一讀取入口，內容未被回寫）
    const latest = getLatestSettingsVersion(db)!;
    expect(readStoredDraft(latest.contentJson)).toEqual(readV2);
  });
});