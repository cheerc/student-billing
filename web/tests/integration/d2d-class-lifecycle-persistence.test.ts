import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import {
  buildSeedDraft,
  getLatestSettingsVersion,
  readStoredDraft,
  saveSettingsVersion,
  hashSettingsDraft,
} from '@/adapters/sqlite/settings-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { detectClassLifecycle } from '@/domain/classification/class-attributes';
import {
  classesToGridRows,
  detectSplitClasses,
  gridRowsToClasses,
  type ScheduleGridRow,
  type SettingsDraft,
} from '@/contracts/settings';

/**
 * D2d H（04 §8 UX54／UX55）：補上**完整儲存→讀回**的 integration 覆蓋。
 *
 * decision d-20261001050915775646-5【二】：UX54／UX55 不新增瀏覽器旅程
 * （operator 的「現在狀態」原則：班級生命週期不再擴充），改以真實呼叫鏈 integration 覆蓋——
 * `gridRowsToClasses`（client 真實存檔轉換）→ `previewSettingsChange` → `applySettingsPreview`
 * → `getLatestSettingsVersion` + `readStoredDraft`（重新讀回等價於 reload）。
 *
 * 為什麼走這條鏈才算數：既有 D2b 覆蓋只停在 `detectClassLifecycle`（純函式，回傳 merges/splits），
 * 沒有證明「判定之後真的存得下去、讀回來班級結構與時段分配正確」。本次補的正是這一段——
 * 特別是 D2a／D2b 的教訓：測試盲點出現在沒走真實鏈的地方。
 *
 * 層級註記：UX54／UX55 原本標「E2E 待補（D2d）」，本檔證明其 storage→reload 語意已閉合；
 * 畫面層的「拆班警告／合併衝突文案」由 UX56 與 D2b 既有 E2E 承載，本批不新增瀏覽器旅程。
 */

const WEEKDAY = '三';
const START = 810;
const END = 900;

/** 課表 grid 的列（rowId 為穩定識別，班名可改）。 */
function gridRow(rowId: string, className: string): ScheduleGridRow {
  return {
    rowId,
    className,
    teacher: null,
    weekday: WEEKDAY,
    startTime: '13:30',
    endTime: '15:00',
    startMinutes: START,
    endMinutes: END,
    active: true,
  };
}

/** 一位年級 4 的學生報名兩個班級，用於讓 preview 進入 with_students 模式。 */
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
        enrollments: ['國小數學-四A', '國小數學-四B'].map((b) => ({
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

describe('D2d H: UX54／UX55 班級生命週期的完整儲存→讀回（真實呼叫鏈）', () => {
  let db: Database.Database;
  let baseDraft: SettingsDraft;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedStudents(db, 'imp_lifecycle');
    activate(db, 'imp_lifecycle', 'run_v3', 'erp-tag-v3');

    baseDraft = buildSeedDraft();
    saveSettingsVersion(db, {
      id: 'v_base',
      contentHash: hashSettingsDraft(baseDraft),
      contentJson: JSON.stringify(baseDraft),
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: new Date().toISOString(),
      createdFromPreviewId: null,
      revision: 1,
    });
    db.prepare('UPDATE active_state SET revision = 1 WHERE id = 1').run();
  });

  afterEach(() => db.close());

  /** 把 baseline draft 换成只有指定兩列的精簡課表（讓斷言聚焦於班級結構，而非 seed 的 89 列）。 */
  function slimBaseline(rows: ScheduleGridRow[]): SettingsDraft {
    return { ...baseDraft, classes: gridRowsToClasses(rows) };
  }

  /**
   * 完整儲存→讀回：`currentRows` 經 client 真實轉換成 draft，preview→apply 後重新讀回。
   * 回傳讀回來的班級清單（依 baseName 索引）。
   */
  function saveAndReload(baseline: SettingsDraft, currentRows: ScheduleGridRow[]): SettingsDraft {
    const draft: SettingsDraft = { ...baseline, classes: gridRowsToClasses(currentRows) };
    const revision = (
      db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as { revision: number }
    ).revision;

    const preview = previewSettingsChange(db, 'imp_lifecycle', { draft, expectedRevision: revision });
    applySettingsPreview(db, {
      previewId: preview.previewId,
      expectedRevision: revision,
      idempotencyKey: `d2d-h-${preview.previewId}`,
    });

    const latest = getLatestSettingsVersion(db)!;
    return readStoredDraft(latest.contentJson);
  }

  describe('UX54: 拆班（把某班的部分時段列改名為新班名，原班仍存在）', () => {
    const baseRows = [gridRow('r1', '國小數學-四A'), gridRow('r2', '國小數學-四A')];

    it('判為 split 而非 rename／merge，且不阻擋儲存', () => {
      const current = [gridRow('r1', '國小數學-四A'), gridRow('r2', '國小數學-新班')];
      const lc = detectClassLifecycle(baseRows, current);

      expect(lc.splits).toEqual([
        { originalName: '國小數學-四A', splitNames: ['國小數學-四A', '國小數學-新班'] },
      ]);
      expect(lc.renames).toHaveLength(0);
      expect(lc.merges).toHaveLength(0);
      // D28 拆班警告（畫面層）：同一組列在 helper 與 contract 兩入口給出同一判定
      expect(detectSplitClasses(baseRows, current)).toEqual(lc.splits);
    });

    it('完整旅程：儲存後原班只保留原本以外的列、新班只含被改名的列，未改名的列不受影響', () => {
      const reloaded = saveAndReload(slimBaseline(baseRows), [
        gridRow('r1', '國小數學-四A'),
        gridRow('r2', '國小數學-新班'),
      ]);

      const byName = new Map(reloaded.classes.map((c) => [c.baseName, c]));
      // 原班仍在，且時段數從 2 減為 1（只留未改名的列）
      expect(byName.get('國小數學-四A')?.sessions).toHaveLength(1);
      expect(byName.get('國小數學-四A')?.sessions[0]).toMatchObject({
        weekday: WEEKDAY,
        startMinutes: START,
        endMinutes: END,
      });
      // 新班只含被改名的那一列，且時段內容不變（未被捏造）
      expect(byName.get('國小數學-新班')?.sessions).toHaveLength(1);
      expect(byName.get('國小數學-新班')?.sessions[0]).toMatchObject({
        weekday: WEEKDAY,
        startMinutes: START,
        endMinutes: END,
      });
      // 讀回後可再展平成 grid 列（無「空班佔位列」混入，班級結構可編輯）
      expect(classesToGridRows(reloaded.classes).filter((r) => r.className === '國小數學-新班')).toHaveLength(1);
    });
  });

  describe('UX55: 合班（兩班所有時段列改成同一個新班名，兩者設定相同）', () => {
    const baseRows = [gridRow('r1', '國小數學-四A'), gridRow('r2', '國小數學-四B')];

    it('判為同名合併（目標名不在 baseline）', () => {
      const current = [gridRow('r1', '國小數學-四'), gridRow('r2', '國小數學-四')];
      const lc = detectClassLifecycle(baseRows, current);

      expect(lc.merges).toEqual([{ mergedName: '國小數學-四', sources: ['國小數學-四A', '國小數學-四B'] }]);
      expect(lc.splits).toHaveLength(0);
      // 實測（characterization）：同一組列也會被記成兩個 rename（每個來源班各自整班改名到目標名），
      // 這是 detectClassLifecycle 的既有行為，合併判定與改名繼承是兩條並行的輸出。
      // 本列不主張應改為互斥，只固定現況：兩個來源班各自 rename 到同一目標名。
      expect(lc.renames).toEqual([
        { from: '國小數學-四A', to: '國小數學-四' },
        { from: '國小數學-四B', to: '國小數學-四' },
      ]);
    });

    it('完整旅程：儲存後合併為一班、兩班時段都在、不阻擋儲存', () => {
      const reloaded = saveAndReload(slimBaseline(baseRows), [
        gridRow('r1', '國小數學-四'),
        gridRow('r2', '國小數學-四'),
      ]);

      const byName = new Map(reloaded.classes.map((c) => [c.baseName, c]));
      // 合併後只剩一班，且兩班的時段都被保留下來（2 堂）
      expect(reloaded.classes.filter((c) => c.baseName === '國小數學-四')).toHaveLength(1);
      expect(byName.get('國小數學-四')?.sessions).toHaveLength(2);
      // 來源班名不再存在
      expect(byName.has('國小數學-四A')).toBe(false);
      expect(byName.has('國小數學-四B')).toBe(false);
    });

    it('合併後的類別依新名自動偵測（國小數學-四 → math），且不殘留來源班的 manual 欄位', () => {
      const reloaded = saveAndReload(slimBaseline(baseRows), [
        gridRow('r1', '國小數學-四'),
        gridRow('r2', '國小數學-四'),
      ]);
      const merged = reloaded.classes.find((c) => c.baseName === '國小數學-四')!;

      // 兩個來源班都未手動設定 → 讀回時不該有 manual 欄位（缺欄位＝自動偵測，03 §5.2）
      expect(merged.categorySource).toBeUndefined();
      expect(merged.category).toBeUndefined();
    });
  });
});