import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { buildSeedDraft, saveSettingsVersion } from '@/adapters/sqlite/settings-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { previewSettingsChange, SettingsPreviewError } from '@/application/settings-preview';
import { applySettingsPreview, SettingsApplyError } from '@/application/apply-settings';
import { detectClassLifecycle, detectMergeConflicts } from '@/domain/classification/class-attributes';
import type { SettingsDraft } from '@/contracts/settings';

/** 一位年級 4 的學生報名「國小輔導-四年級」與「國小數學-四A」。 */
function seedStudents(db: Database.Database, importId: string) {
  const now = new Date().toISOString();
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
      createdAt: now,
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
        enrollments: [
          {
            rawToken: '國小輔導-四年級',
            yearPrefix: null,
            baseName: '國小輔導-四年級',
            groupFlag: null,
            modifiers: [],
            withdrawalDate: null,
            erpBillingTierRaw: null,
            erpBillingTier: null,
            tierParseStatus: 'not_applicable',
            parseStatus: 'ok',
          },
          {
            rawToken: '國小數學-四A',
            yearPrefix: null,
            baseName: '國小數學-四A',
            groupFlag: null,
            modifiers: [],
            withdrawalDate: null,
            erpBillingTierRaw: null,
            erpBillingTier: null,
            tierParseStatus: 'not_applicable',
            parseStatus: 'ok',
          },
        ],
      },
    ]
  );
}

function activateV4(db: Database.Database, importId: string, runId: string) {
  const res = executeCalculationRun(db, importId, runId, { ruleSetVersion: 'erp-tag-v4' });
  saveCalculationRun(db, res.run, res.results, res.classCategories);
  db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ? WHERE id = 1').run(runId, importId);
  return res;
}

/** 固定合成歷史列：只驗證 saved-run reader/明確升級，不呼叫已退役的舊計算器。 */
function activateSyntheticHistoricalRun(db: Database.Database, importId: string, runId: string, version: string) {
  const now = '2026-10-23T00:00:00.000Z';
  saveCalculationRun(
    db,
    {
      id: runId,
      importId,
      scheduleVersionId: 'seed-v250922',
      ruleSetVersion: version,
      numericPolicy: 'integer-minute-rational-v1',
      asOfDate: '2026-10-23',
      status: 'completed',
      issueCounts: {},
      totalStudents: 1,
      createdAt: now,
    },
    [{
      id: `${runId}_S001`,
      runId,
      personCode: 'S001',
      name: '合成歷史學生',
      branch: '本部',
      grade: 4,
      gradeRaw: '4',
      subjectCount: 2,
      baseDiscountBps: 9500,
      anqinDays: 4,
      anqinDisplay: '4',
      tutoringDays: null,
      tutoringDisplay: null,
      englishDays: null,
      mathDays: null,
      chineseDays: null,
      homeworkDays: null,
      intensiveEnglishDays: null,
      saturdayTutoringDays: null,
      applicableAnqinBps: null,
      applicableTutoringBps: null,
      applicableEnglishBps: null,
      applicableMathBps: null,
      tierMismatch: false,
      tierComparisons: [],
      issues: [],
      hasIssues: false,
      trace: { syntheticHistoricalFixture: true },
      createdAt: now,
    }],
    version === 'erp-tag-v3' ? [] : undefined
  );
  db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ? WHERE id = 1').run(runId, importId);
}

describe('D2b 6: 類別／固定 5 天變更進完整影響預覽（人數、天數、科數、折扣）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedStudents(db, 'imp_b');
    // 使用目前正式軌 v4 計算類別式科數。
    activateV4(db, 'imp_b', 'run_v4');
  });

  afterEach(() => db.close());

  it('把「國小數學-四A」手動設為不列入折扣後，預覽顯示該生科數改變（1 科）', () => {
    const revision = (db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as any).revision as number;
    const draft: SettingsDraft = buildSeedDraft();
    const target = draft.classes.find((c) => c.baseName === '國小數學-四A')!;
    target.category = 'none';
    target.categorySource = 'manual';

    const preview: any = previewSettingsChange(db, 'imp_b', {
      draft,
      expectedRevision: revision,
      targetRuleSetVersion: 'erp-tag-v4',
    });

    // 學生原本報兩類（care + math = 2 科 → 9500）；改成 none 後只剩 care = 1 科 → 10000
    expect(preview.subjectCountDeltas).toHaveLength(1);
    expect(preview.subjectCountDeltas[0]).toEqual({ personCode: 'S001', name: '測試生', before: 2, after: 1 });
    expect(preview.baseDiscountDeltas).toHaveLength(1);
    expect(preview.baseDiscountDeltas[0]).toEqual({ personCode: 'S001', name: '測試生', before: 9500, after: 10000 });
  });

  it('只改類別不改時段時，天數不變但科數／折扣仍進入影響預覽', () => {
    const revision = (db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as any).revision as number;
    const draft: SettingsDraft = buildSeedDraft();
    const target = draft.classes.find((c) => c.baseName === '國小數學-四A')!;
    target.category = 'english';
    target.categorySource = 'manual';

    const preview: any = previewSettingsChange(db, 'imp_b', {
      draft,
      expectedRevision: revision,
      targetRuleSetVersion: 'erp-tag-v4',
    }) as any;

    expect(preview.dayDeltas).toHaveLength(0);
    // care + english 仍為 2 科 → 折扣不變；科數不變
    expect(preview.subjectCountDeltas).toHaveLength(0);
  });

  it('選回「（未設定）」把 manual 改回未設定後，該科不再計入（科數與折扣都變）', () => {
    const revision = (db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as any).revision as number;
    const draft: SettingsDraft = buildSeedDraft();
    // 先手動設成 none，再在同一份草稿把該班改回未設定 → 有效值回到未設定（0 科）。
    // #157 Ruling 4：沒有「恢復自動」；撤回決定的路徑是選回「（未設定）」。
    // 撤回在草稿裡的形狀是**明確的** `category: 'unset'` + `categorySource: 'unset'`
    // （編輯器 `applyManualAttrsToClasses` 就是這樣寫的）——不是「刪掉這兩個欄位」：
    // 刪掉代表「從未被指定」，那會適用 seed 基準（math），撤回就失效了。
    // 手算：學生報 care + math。before 側是 seed 基準（兩科都計入 → 2 科），
    // after 側撤回 math 的指定 → 該科不計入（未設定）→ 1 科。
    // 因此本案例驗的是「撤回決定確實改變了計算結果」，而不是「回到原值」。
    const target = draft.classes.find((c) => c.baseName === '國小數學-四A')!;
    target.category = 'unset';
    target.categorySource = 'unset';

    const preview: any = previewSettingsChange(db, 'imp_b', {
      draft,
      expectedRevision: revision,
      targetRuleSetVersion: 'erp-tag-v4',
    }) as any;

    // 撤回決定 → 該科不再計入 → 科數 2 → 1、折扣 9500 → 10000（1 科無折扣）
    expect(preview.subjectCountDeltas).toHaveLength(1);
    expect(preview.subjectCountDeltas[0]).toMatchObject({ before: 2, after: 1 });
    expect(preview.baseDiscountDeltas).toHaveLength(1);
    expect(preview.baseDiscountDeltas[0]).toMatchObject({ before: 9500, after: 10000 });
  });
});

describe('D2b 5（Q9）: 同名合併且設定不同時阻擋儲存（課表 grid 的 rowId 追蹤）', () => {
  /** 課表 grid 的列（班名可改；rowId 為穩定識別）。 */
  function gridRow(rowId: string, className: string) {
    return {
      rowId,
      className,
      teacher: null,
      weekday: '三',
      startTime: '13:30',
      endTime: '15:00',
      startMinutes: 810,
      endMinutes: 900,
      active: true,
      skipDeduction: false,
    };
  }

  it('四A 與 四B 的列全部改成同一新名，且兩者設定不同 → 阻擋（要求選擇）', () => {
    const baselineRows = [gridRow('r1', '國小數學-四A'), gridRow('r2', '國小數學-四B')];
    const currentRows = [gridRow('r1', '國小數學-四'), gridRow('r2', '國小數學-四')];

    const lifecycle = detectClassLifecycle(baselineRows, currentRows);
    expect(lifecycle.merges).toEqual([{ mergedName: '國小數學-四', sources: ['國小數學-四A', '國小數學-四B'] }]);

    const sourceAttrs = new Map([
      ['國小數學-四A', { classType: 'non_care' as const, category: 'math' as const, categorySource: 'unset' as const, fixedFiveDays: false }],
      ['國小數學-四B', { classType: 'care' as const, category: 'care' as const, categorySource: 'manual' as const, fixedFiveDays: true }],
    ]);
    const conflicts = detectMergeConflicts(lifecycle.merges, sourceAttrs);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].mergedName).toBe('國小數學-四');
  });

  it('四A 與 四B 合併後兩者設定相同 → 不阻擋', () => {
    const baselineRows = [gridRow('r1', '國小數學-四A'), gridRow('r2', '國小數學-四B')];
    const currentRows = [gridRow('r1', '國小數學-四'), gridRow('r2', '國小數學-四')];
    const lifecycle = detectClassLifecycle(baselineRows, currentRows);

    const same = { classType: 'non_care' as const, category: 'math' as const, categorySource: 'unset' as const, fixedFiveDays: false };
    const sourceAttrs = new Map([
      ['國小數學-四A', { ...same }],
      ['國小數學-四B', { ...same }],
    ]);
    expect(detectMergeConflicts(lifecycle.merges, sourceAttrs)).toHaveLength(0);
  });

  it('整班改名（只改一個班的所有列）不算合併，不阻擋', () => {
    const baselineRows = [gridRow('r1', '國小數學-四A'), gridRow('r2', '國小數學-四B')];
    const currentRows = [gridRow('r1', '國小數學-四'), gridRow('r2', '國小數學-四B')];
    const lifecycle = detectClassLifecycle(baselineRows, currentRows);
    expect(lifecycle.merges).toHaveLength(0);
    expect(lifecycle.renames).toEqual([{ from: '國小數學-四A', to: '國小數學-四' }]);
  });

  it('拆班（一班的列改成兩個名）標為 split，來源名保留，不阻擋', () => {
    const baselineRows = [gridRow('r1', '國小輔導-四年級'), gridRow('r2', '國小輔導-四年級')];
    const currentRows = [gridRow('r1', '國小輔導-四年級'), gridRow('r2', '國小輔導-新班')];
    const lifecycle = detectClassLifecycle(baselineRows, currentRows);
    expect(lifecycle.splits).toEqual([{ originalName: '國小輔導-四年級', splitNames: ['國小輔導-四年級', '國小輔導-新班'] }]);
    expect(lifecycle.merges).toHaveLength(0);
  });

  it('新班（baseline 沒有的名稱）標為 new', () => {
    const baselineRows = [gridRow('r1', '國小數學-四A')];
    const currentRows = [gridRow('r1', '國小數學-四A'), gridRow('r2', '全新開的班')];
    const lifecycle = detectClassLifecycle(baselineRows, currentRows);
    expect(lifecycle.news.map((n) => n.baseName)).toEqual(['全新開的班']);
  });
});

describe('D2b 1: 設定草稿 hash 涵蓋類別與固定 5 天（取消修改可回到原值）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedStudents(db, 'imp_d');
    activateV4(db, 'imp_d', 'run_v4');
  });

  afterEach(() => db.close());

  it('相同類別值但來源不同（unset vs manual）會產生不同的 previewId（hash 涵蓋來源）', () => {
    const revision = (db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as any).revision as number;
    // 「未設定」＝草稿裡**沒有** category／categorySource 兩個欄位（03 §5.2 版本界線規則第 2 點）。
    const unsetDraft: SettingsDraft = buildSeedDraft();
    const unsetTarget = unsetDraft.classes.find((c) => c.baseName === '國小數學-四A')!;
    delete unsetTarget.category;
    delete unsetTarget.categorySource;
    const unset = previewSettingsChange(db, 'imp_d', { draft: unsetDraft, expectedRevision: revision, targetRuleSetVersion: 'erp-tag-v4' });

    const manualDraft: SettingsDraft = buildSeedDraft();
    const t = manualDraft.classes.find((c) => c.baseName === '國小數學-四A')!;
    t.category = 'math';
    t.categorySource = 'manual';
    const manual = previewSettingsChange(db, 'imp_d', { draft: manualDraft, expectedRevision: revision, targetRuleSetVersion: 'erp-tag-v4' });

    // 兩份草稿的有效值相同（都是 math），但來源狀態不同 → hash 必須不同，
    // 否則「未設定」與「使用者指定」在草稿層就分不出來。
    expect(manual.inputHash).not.toBe(unset.inputHash);
  });
});
