import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { detectAliasCategoryChanges } from '@/domain/classification/class-attributes';
import type { SettingsDraft } from '@/contracts/settings';

/**
 * D2b r2 R2-3：immutable RED（本檔為 r2 的 tests-only commit，src 未修時真實失敗）。
 *
 * 涵蓋兩項修正的新增斷言：
 *  - R2-1：`affectedStudents` 為三類 delta 的 personCode **聯集去重**計數；只有科數／折扣變化、天數不變時仍顯示正確人數。
 *    （r1 的案例把數學改成 english 而 before 已有 care，兩者皆 0，落在無法暴露任何一個方向錯誤的盲點。）
 *  - R2-2：Q13 跨類別 alias 在 preview payload 產出提示，且不阻擋儲存。
 */

/**
 * 兩位學生：報「國小輔導-四年級」＋「國小數學-三A」（年級 4）。
 * 選「三A」是因為它在 seed 有週一 990–1080 的時段（落在課輔窗口內，扣 0.5 天），
 * 因此「改時段」能真實造成天數變化，與「改類別」造成科數變化同時發生——
 * 這正是 r1 測試涵蓋不到、會重複其盲點的雙重變化情境。
 */
function seedTwoStudents(db: Database.Database, importId: string) {
  const now = new Date().toISOString();
  saveImportBatch(
    db,
    {
      id: importId,
      fileName: 'r2.xlsx',
      fileHash: 'h',
      contentHash: 'c',
      sheetName: 'Sheet1',
      headerMap: {},
      parserVersion: '1.0.0',
      scopeNote: '',
      rowCount: 2,
      status: 'ready',
      createdAt: now,
    },
    [0, 1].map((i) => ({
      personCode: `R2${String(i).padStart(3, '0')}`,
      name: `學生${i}`,
      grade: 4,
      gradeRaw: '4',
      gradeStatus: 'valid' as const,
      branch: '本部',
      contact: null,
      schoolInfo: null,
      tagsRaw: '',
      tags: [],
      notesRaw: '',
      sourceRow: i + 1,
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
          tierParseStatus: 'not_applicable' as const,
          parseStatus: 'ok' as const,
        },
        {
          rawToken: '國小數學-三A',
          yearPrefix: null,
          baseName: '國小數學-三A',
          groupFlag: null,
          modifiers: [],
          withdrawalDate: null,
          erpBillingTierRaw: null,
          erpBillingTier: null,
          tierParseStatus: 'not_applicable' as const,
          parseStatus: 'ok' as const,
        },
      ],
    }))
  );
}

function activate(db: Database.Database, importId: string, runId: string) {
  const res = executeCalculationRun(db, importId, runId, { ruleSetVersion: 'erp-tag-v3' as any });
  saveCalculationRun(db, res.run, res.results, res.classCategories);
  db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ? WHERE id = 1').run(runId, importId);
  return res;
}

function revision(db: Database.Database): number {
  return (db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as any).revision;
}

describe('D2b r2 R2-1: affectedStudents 為三類 delta 的 personCode 聯集去重計數', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedTwoStudents(db, 'imp_r2');
    activate(db, 'imp_r2', 'run_r2_v3');
  });

  afterEach(() => db.close());

  it('(a) 同一人同時有天數與科數變化時只計一次（2 人同時改天數與類別 → 2 而非 4）', () => {
    // 國小數學-三A：週一 990–1080（重疊 90 分 → 扣 0.5）改成 990–1170（重疊 180 分 → 扣 1.0），
    // 同時把它手動設為「不列入折扣」（科數 {care, math} 2 科 → {care} 1 科）。
    // 兩位學生因此同時出現在 dayDeltas 與 subjectCountDeltas（相加會得到 4，應為 2）。
    const draft: SettingsDraft = buildSeedDraft();
    const math = draft.classes.find((c) => c.baseName === '國小數學-三A')!;
    math.sessions = [{ weekday: '一', startMinutes: 990, endMinutes: 1170 }];
    math.category = 'none';
    math.categorySource = 'manual';

    const preview: any = previewSettingsChange(db, 'imp_r2', {
      draft,
      expectedRevision: revision(db),
      targetRuleSetVersion: 'erp-tag-v3',
    });

    // 前置確認：必須同時產生多類 delta，否則本測試會重複 r1 的盲點
    expect(preview.dayDeltas.length).toBeGreaterThan(0);
    expect(preview.subjectCountDeltas.length).toBeGreaterThan(0);
    // 手算：2 位學生；相加寫法會得到 2 + 2 = 4
    const union = new Set([
      ...preview.dayDeltas.map((d: any) => d.personCode),
      ...preview.subjectCountDeltas.map((d: any) => d.personCode),
      ...preview.baseDiscountDeltas.map((d: any) => d.personCode),
    ]);
    expect(union.size).toBe(2);
    expect(preview.affectedStudents).toBe(2);
  });

  it('(b) 只有科數變化、天數不變時，受影響人數仍為正確人數（不得為 0）', () => {
    // 只把數學班手動設為「不列入折扣」：完全不動任何時段 → 天數不變
    const draft: SettingsDraft = buildSeedDraft();
    const math = draft.classes.find((c) => c.baseName === '國小數學-三A')!;
    math.category = 'none';
    math.categorySource = 'manual';

    const preview: any = previewSettingsChange(db, 'imp_r2', {
      draft,
      expectedRevision: revision(db),
      targetRuleSetVersion: 'erp-tag-v3',
    });

    // 關鍵：只有科數與折扣變化、天數不變
    expect(preview.dayDeltas).toHaveLength(0);
    expect(preview.subjectCountDeltas.length).toBe(2);
    // 受影響人數必須是 2
    expect(preview.affectedStudents).toBe(2);
  });

  it('(b2) 同一人同時出現在天數、科數與折扣三種 delta 時也只計一次', () => {
    // 同一位學生同時出現在三個陣列：相加寫法會算成 3 次
    const draft: SettingsDraft = buildSeedDraft();
    const math = draft.classes.find((c) => c.baseName === '國小數學-三A')!;
    math.sessions = [{ weekday: '一', startMinutes: 990, endMinutes: 1170 }];
    math.category = 'none';
    math.categorySource = 'manual';

    const preview: any = previewSettingsChange(db, 'imp_r2', {
      draft,
      expectedRevision: revision(db),
      targetRuleSetVersion: 'erp-tag-v3',
    });

    // 前置確認：三種 delta 都非空，且涵蓋同樣的 2 人
    expect(preview.dayDeltas.length).toBe(2);
    expect(preview.subjectCountDeltas.length).toBe(2);
    expect(preview.baseDiscountDeltas.length).toBe(2);
    const union = new Set([
      ...preview.dayDeltas.map((d: any) => d.personCode),
      ...preview.subjectCountDeltas.map((d: any) => d.personCode),
      ...preview.baseDiscountDeltas.map((d: any) => d.personCode),
    ]);
    expect(union.size).toBe(2);
    expect(preview.affectedStudents).toBe(2);
  });

  it('(c) 三種 delta 皆空時，受影響人數為 0', () => {
    const preview: any = previewSettingsChange(db, 'imp_r2', {
      draft: buildSeedDraft(),
      expectedRevision: revision(db),
      targetRuleSetVersion: 'erp-tag-v3',
    });
    expect(preview.dayDeltas).toHaveLength(0);
    expect(preview.subjectCountDeltas).toHaveLength(0);
    expect(preview.baseDiscountDeltas).toHaveLength(0);
    expect(preview.affectedStudents).toBe(0);
  });
});

describe('D2b r2 R2-2: Q13 跨類別 alias 在影響預覽產出提示，且不阻擋儲存', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedTwoStudents(db, 'imp_q13');
    activate(db, 'imp_q13', 'run_q13_v3');
  });

  afterEach(() => db.close());

  it('跨類別 alias（米豆奶班名→不同類別的系統班）時 preview 產出 aliasCategoryNotices', () => {
    const draft: SettingsDraft = buildSeedDraft();
    draft.aliases = [
      { rawBaseName: '數學新班-2026春', targetBaseName: '國小數學-四A' },
      { rawBaseName: '美語新班-2026春', targetBaseName: '兒童美語-Gino' },
    ];

    const preview: any = previewSettingsChange(db, 'imp_q13', {
      draft,
      expectedRevision: revision(db),
      targetRuleSetVersion: 'erp-tag-v3',
    });

    expect(Array.isArray(preview.aliasCategoryNotices)).toBe(true);
    // 「數學新班-2026春」自動偵測為 none（不含關鍵字），「國小數學-四A」為 math → 跨類別
    const byRaw = new Map(
      preview.aliasCategoryNotices.map((n: any) => [n.rawBaseName, n])
    );
    expect(byRaw.get('數學新班-2026春')).toEqual({
      rawBaseName: '數學新班-2026春',
      targetBaseName: '國小數學-四A',
      rawDetected: 'none',
      targetDetected: 'math',
    });
    expect(byRaw.get('美語新班-2026春')).toEqual({
      rawBaseName: '美語新班-2026春',
      targetBaseName: '兒童美語-Gino',
      rawDetected: 'none',
      targetDetected: 'english',
    });
  });

  it('非跨類別 alias（兩側自動偵測結果相同）時不產出提示', () => {
    const draft: SettingsDraft = buildSeedDraft();
    // 兩側都含「國小數學」→ 同為 math，非跨類別
    draft.aliases = [
      { rawBaseName: '國小數學-新開班', targetBaseName: '國小數學-四A' },
    ];

    const preview: any = previewSettingsChange(db, 'imp_q13', {
      draft,
      expectedRevision: revision(db),
      targetRuleSetVersion: 'erp-tag-v3',
    });

    expect(preview.aliasCategoryNotices).toHaveLength(0);
  });

  it('有跨類別 alias 時 preview 仍成功（提示非阻擋，D37）', () => {
    const draft: SettingsDraft = buildSeedDraft();
    draft.aliases = [
      { rawBaseName: '數學新班-2026春', targetBaseName: '國小數學-四A' },
    ];

    // 不應拋錯：Q13 是提示不是阻擋（與 Q9 同名合併衝突阻擋不同）
    const preview: any = previewSettingsChange(db, 'imp_q13', {
      draft,
      expectedRevision: revision(db),
      targetRuleSetVersion: 'erp-tag-v3',
    });
    expect(preview.previewId).toBeTruthy();
    expect(preview.aliasCategoryNotices.length).toBeGreaterThan(0);
  });

  it('settings_only（無現行名單）時也產出提示（該路徑不建立 preview 計算，但提示仍須存在）', () => {
    const noActive = new Database(':memory:');
    runMigrations(noActive);
    const draft: SettingsDraft = buildSeedDraft();
    draft.aliases = [
      { rawBaseName: '數學新班-2026春', targetBaseName: '國小數學-四A' },
    ];
    const preview: any = previewSettingsChange(noActive, undefined, {
      draft,
      expectedRevision: 0,
      targetRuleSetVersion: 'erp-tag-v3',
    });
    expect(preview.mode).toBe('settings_only');
    expect(preview.aliasCategoryNotices.length).toBe(1);
    noActive.close();
  });
});

describe('D2b r2 R2-2: detectAliasCategoryChanges 純函式的既有行為不回退', () => {
  it('跨類別產出 notice、同類別不產出、空清單回空陣列', () => {
    expect(
      detectAliasCategoryChanges([{ rawBaseName: '數學新班', targetBaseName: '國小數學-四A' }])
    ).toHaveLength(1);
    expect(
      detectAliasCategoryChanges([{ rawBaseName: '國小數學-新開班', targetBaseName: '國小數學-四A' }])
    ).toHaveLength(0);
    expect(detectAliasCategoryChanges([])).toHaveLength(0);
  });
});
