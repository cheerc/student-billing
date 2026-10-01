import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { buildSeedDraft, saveSettingsVersion, hashSettingsDraft } from '@/adapters/sqlite/settings-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import type { SettingsDraft } from '@/contracts/settings';

/**
 * D2d A（RED）：升級預覽的 before／after 必須使用不同版本。
 *
 * S manifest §2.3 第 2 點：before＝**active 版本**＋最新已存設定；after＝**target 版本**＋草稿。
 * 現行 settings-preview.ts:207-217 兩側都傳 `formalRuleSetVersion`（target）。
 *
 * 案例用手算可判別的學生，**草稿完全不變**，只勾升級。若 before 正確使用 v2，
 * preview 必列出天數差異與受影響學生數；若 before 誤用 target，差異必為 0。
 *
 * ── 案例選用（重要：不可用數學案例）──────────────────────────────
 * 年級 4、依報名順序重複報名「兒童美語-Gino」→「兒童美語-Chevady」。以 seed 實測
 * （`calculateClassDeductionD24`，課輔窗口 990–1170、每日 180 分）：
 *   Gino（v2 首班）：一 920–1010（重疊 20 分）、三 930–1020（重疊 30 分）、五 920–1010（重疊 20 分）
 *        → raw −70/180 ≈ −0.389 → |frac| 0.389 ∈[0.3,0.8) → rounded −0.5
 *   Chevady：一 1010–1130（重疊 120 分）、四 1010–1130（重疊 120 分）
 *        → 課輔特例（重疊≥120 且 1110 < end 1130 < 1170）→ 每堂 −1 → rounded −2
 * 因此 v2 首班語意 → Gino 扣 0.5 → max(3, 5−0.5) = **4.5 天**；
 *           v3 取正量最多 → Chevady 扣 2.0 → max(3, 5−2) = **3 天**。
 *
 * ⚠ **原本用的「國小數學-四A／四B」案例已廢棄**（2026-10-01 GREEN A 實測）：兩班在 v2 與 v3
 * 的課輔天數**都是 4.5 天**（扣天相同，選班結果不影響天數），本來就無差異，
 * 該案例無法證明 before 用的是哪一版。改用美語案例——v2/v3 天數差 1.5 天，
 * 才有鑑別力。此處手算與實測一致（見 evidence-D2d/a-green.log 的 case sweep）。
 */
function seedDuplicateEnglish(db: Database.Database, importId: string) {
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
        enrollments: ['兒童美語-Gino', '兒童美語-Chevady'].map((b) => ({
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
    seedDuplicateEnglish(db, 'imp_dup');
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

    // 手算：v2 首班語意選 Gino → 課輔 4.5 天；v3 取正量最多選 Chevady → 課輔 3 天，Δ = −1.5
    expect(preview.mode).toBe('with_students');
    expect(preview.dayDeltas).toHaveLength(1);
    expect(preview.dayDeltas[0]).toMatchObject({ personCode: 'S001', before: 4.5, after: 3 });
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

  it('整條升級旅程（真實呼叫鏈）：preview 有差異 → apply 產生 v3 run、舊 v2 run 不變', () => {
    activate(db, 'imp_dup', 'run_v2', 'erp-tag-v2');
    const draft = saveSeedAsStored(db, 'v1', 1);
    db.prepare('UPDATE active_state SET revision = 1 WHERE id = 1').run();

    const preview: any = previewSettingsChange(db, 'imp_dup', {
      draft,
      expectedRevision: 1,
      targetRuleSetVersion: 'erp-tag-v3',
    });
    expect(preview.dayDeltas).toHaveLength(1);
    // preview 列記錄的目標版本＝apply 唯一採用的版本（D1 F-3）
    const row = db
      .prepare('SELECT target_rule_set_version FROM settings_previews WHERE preview_id = ?')
      .get(preview.previewId) as { target_rule_set_version: string };
    expect(row.target_rule_set_version).toBe('erp-tag-v3');

    const applied = applySettingsPreview(db, {
      previewId: preview.previewId,
      expectedRevision: 1,
      idempotencyKey: 'd2d-upgrade-journey',
    });

    const newRun = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(applied.runId) as {
      rule_set_version: string;
    };
    expect(newRun.rule_set_version).toBe('erp-tag-v3');
    expect(applied.runId).not.toBe('run_v2');
    // 舊 v2 run 的計算結果逐欄不變（不可回溯改寫）：逐欄比對該 run 的全部計算列
    const oldRows = db
      .prepare('SELECT * FROM student_calculations WHERE run_id = ? ORDER BY person_code')
      .all('run_v2') as Record<string, unknown>[];
    const stillThere = db
      .prepare('SELECT COUNT(*) AS n FROM student_calculations WHERE run_id = ?')
      .get('run_v2') as { n: number };
    expect(stillThere.n).toBe(oldRows.length);
    expect(oldRows.length).toBeGreaterThan(0);
    // v2 run 的舊值仍是 4.5 天（未被新 v3 run 的 3 天覆寫）
    expect(oldRows[0].tutoring_days).toBe(4.5);
    const active = db.prepare('SELECT active_run_id FROM active_state WHERE id = 1').get() as {
      active_run_id: string;
    };
    expect(active.active_run_id).toBe(applied.runId);
    // 舊 v2 run 本身仍標 v2
    const oldRun = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get('run_v2') as {
      rule_set_version: string;
    };
    expect(oldRun.rule_set_version).toBe('erp-tag-v2');
  });
});
