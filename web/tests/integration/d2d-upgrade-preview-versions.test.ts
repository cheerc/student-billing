import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { buildSeedDraft, saveSettingsVersion, hashSettingsDraft } from '@/adapters/sqlite/settings-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import type { SettingsDraft } from '@/contracts/settings';

/**
 * D2d A（RED）：升級預覽的 before／after 必須使用不同版本。
 *
 * S manifest §2.3 第 2 點：before＝**active 版本**＋最新已存設定；after＝**target 版本**＋草稿。
 * 現行 settings-preview.ts:207-217 兩側都傳 `formalRuleSetVersion`（target）。
 *
 * 案例用手算可判別的學生：年級 4 重複報名兩班數學（v2 取首班 0.5 扣 → 4.5 天；
 * v3 取扣天最多 → 1 扣 → 4 天）。**草稿完全不變**，只勾升級。
 * 若 before 正確使用 v2，preview 必列出天數差異與受影響學生數。
 */
function seedDuplicateMath(db: Database.Database, importId: string) {
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
          {
            rawToken: '國小數學-四B',
            yearPrefix: null,
            baseName: '國小數學-四B',
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

function activate(db: Database.Database, importId: string, runId: string, version: string) {
  const res = executeCalculationRun(db, importId, runId, { ruleSetVersion: version as never });
  saveCalculationRun(db, res.run, res.results, res.classCategories);
  db.prepare('UPDATE active_state SET active_run_id = ?, active_import_id = ? WHERE id = 1').run(runId, importId);
  return res;
}

function saveSeedAsStored(db: Database.Database, id: string, revision: number) {
  const draft: SettingsDraft = buildSeedDraft();
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
  return draft;
}

describe('D2d A: 升級預覽 before 用 active 版本、after 用 target 版本', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    seedDuplicateMath(db, 'imp_dup');
  });

  afterEach(() => db.close());

  it('v2 active、草稿不變、只勾升級 → 預覽必須呈現 v2→v3 的天數差異', () => {
    activate(db, 'imp_dup', 'run_v2', 'erp-tag-v2');
    // 已存一份設定作為「前」的基準（與草稿相同 → 唯一差異是規則版本）
    const draft = saveSeedAsStored(db, 'v1', 1);
    db.prepare('UPDATE active_state SET revision = 1 WHERE id = 1').run();

    const preview: any = previewSettingsChange(db, 'imp_dup', {
      draft,
      expectedRevision: 1,
      targetRuleSetVersion: 'erp-tag-v3',
    });

    // 手算：v2 課輔 4.5 天 → v3 課輔 4 天，Δ = −0.5
    expect(preview.mode).toBe('with_students');
    expect(preview.dayDeltas).toHaveLength(1);
    expect(preview.dayDeltas[0]).toMatchObject({ personCode: 'S001', before: 4.5, after: 4 });
    expect(preview.affectedStudents).toBe(1);
  });

  it('未勾升級（target 不指定）時 before／after 同版本 → 不應有天數差異', () => {
    activate(db, 'imp_dup', 'run_v2', 'erp-tag-v2');
    const draft = saveSeedAsStored(db, 'v1', 1);
    db.prepare('UPDATE active_state SET revision = 1 WHERE id = 1').run();

    const preview: any = previewSettingsChange(db, 'imp_dup', {
      draft,
      expectedRevision: 1,
    });

    expect(preview.dayDeltas).toHaveLength(0);
    expect(preview.affectedStudents).toBe(0);
  });

  it('空 DB（無 active run，settings_only）語意不變', () => {
    const draft: SettingsDraft = buildSeedDraft();
    const preview: any = previewSettingsChange(db, null, { draft, expectedRevision: 0 });
    expect(preview.mode).toBe('settings_only');
  });
});
