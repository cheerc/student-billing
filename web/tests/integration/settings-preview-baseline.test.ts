import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { generateImportPreview } from '@/application/import-preview';
import { activateImport } from '@/application/activate-import';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { SettingsDraft } from '@/contracts/settings';

/**
 * 09 §3.2／§8.2.4：影響預覽的「前」是目前生效的設定（最新已儲存設定，尚無則 seed），不是永遠的 seed。
 * 否則已儲存過設定後，再預覽同一份 draft 會把「相對 seed 的差異」誤當成這次的影響，
 * 整班移除（不再退回 seed，B4）更會讓受影響人數失真。
 * expected 皆用 D18 已確認案例反推：seed 全量 draft＋一→一A 別名 → 13 位各 −0.5。
 */
const ALIAS = { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' };
const CLASS_1A = '國小數學-一A';

const draftWithAlias = (): SettingsDraft => ({ ...buildSeedDraft(), aliases: [ALIAS] });

describe('settings preview 的影響基準＝目前生效設定', () => {
  let tempDir: string;
  let db: any;
  let importA: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-base-test-'));
    db = createDatabase(path.join(tempDir, 'test.sqlite'));
    runMigrations(db);
    const buf = fs.readFileSync(path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx'));
    const p = await generateImportPreview(buf, 'fixture.xlsx');
    importA = 'imp_base_a';
    saveImportBatch(
      db,
      {
        id: importA,
        fileName: 'fixture.xlsx',
        fileHash: p.fileHash,
        contentHash: p.contentHash,
        sheetName: p.sheetName,
        headerMap: p.headerMapping,
        parserVersion: '1.0.0',
        scopeNote: p.scopeNote,
        rowCount: p.stats.totalStudents,
        status: 'ready',
        createdAt: new Date().toISOString(),
      },
      p.students
    );
    activateImport(db, { importId: importA, expectedRevision: 0, idempotencyKey: 'base-act' });
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function save(draft: SettingsDraft, expectedRevision: number, key: string) {
    const prev = previewSettingsChange(db, undefined, { draft, expectedRevision });
    return applySettingsPreview(db, { previewId: prev.previewId, expectedRevision, idempotencyKey: key });
  }

  it('尚無已儲存設定：基準是 seed（D18：13 位各 −0.5，既有行為不變）', () => {
    const prev = previewSettingsChange(db, undefined, { draft: draftWithAlias(), expectedRevision: 1 });
    expect(prev.affectedStudents).toBe(13);
    for (const d of prev.dayDeltas!) expect(d.after).toBe(d.before! - 0.5);
  });

  it('已儲存過同一份設定後再預覽同一份 draft：沒有任何變化（0 人受影響，mismatch 前後相同）', () => {
    save(draftWithAlias(), 1, 'base-save-1');
    const again = previewSettingsChange(db, undefined, { draft: draftWithAlias(), expectedRevision: 2 });
    expect(again.affectedStudents).toBe(0);
    expect(again.dayDeltas).toEqual([]);
    expect(again.mismatchAfter).toBe(again.mismatchBefore);
    expect(again.issueDelta!.after).toBe(again.issueDelta!.before);
  });

  it('v2 persisted-before issue delta 排除 retired-only warning，仍計 business issue 與 tier review', () => {
    const runId = (db.prepare('SELECT active_run_id FROM active_state WHERE id = 1').get() as { active_run_id: string }).active_run_id;
    db.prepare(`UPDATE student_calculations SET issues = '[]', tier_comparisons = '[]', has_issues = 0 WHERE run_id = ?`).run(runId);
    const people = db.prepare('SELECT person_code FROM student_calculations WHERE run_id = ? ORDER BY person_code LIMIT 3').all(runId) as Array<{ person_code: string }>;
    expect(people).toHaveLength(3);

    db.prepare('UPDATE student_calculations SET issues = ?, has_issues = 1 WHERE run_id = ? AND person_code = ?')
      .run(JSON.stringify([{ code: 'NUMERIC_POLICY_DIFFERENCE' }]), runId, people[0].person_code);
    db.prepare('UPDATE student_calculations SET issues = ?, has_issues = 1 WHERE run_id = ? AND person_code = ?')
      .run(JSON.stringify([{ code: 'NUMERIC_POLICY_DIFFERENCE' }, { code: 'CLASS_NOT_MAPPED' }]), runId, people[1].person_code);
    db.prepare('UPDATE student_calculations SET tier_comparisons = ?, has_issues = 1 WHERE run_id = ? AND person_code = ?')
      .run(JSON.stringify([{ needsReview: true }]), runId, people[2].person_code);
    db.prepare('UPDATE calculation_runs SET rule_set_version = ? WHERE id = ?').run('erp-tag-v2', runId);

    const preview = previewSettingsChange(db, undefined, {
      draft: buildSeedDraft(),
      expectedRevision: 1,
      targetRuleSetVersion: 'erp-tag-v4',
    });

    expect(preview.issueDelta).toMatchObject({ before: 2 });
    expect(db.prepare('SELECT has_issues FROM student_calculations WHERE run_id = ? AND person_code = ?').get(runId, people[0].person_code))
      .toEqual({ has_issues: 1 });
    expect(JSON.parse((db.prepare('SELECT issues FROM student_calculations WHERE run_id = ? AND person_code = ?').get(runId, people[0].person_code) as { issues: string }).issues))
      .toEqual([{ code: 'NUMERIC_POLICY_DIFFERENCE' }]);
  });

  it('已儲存有一→一A 對應後整班移除一A：13 位各 +0.5（由 −0.5 回到不扣天），不是相對 seed 的差異', () => {
    save(draftWithAlias(), 1, 'base-save-2');
    const removed: SettingsDraft = {
      ...draftWithAlias(),
      classes: draftWithAlias().classes.filter((c) => c.baseName !== CLASS_1A),
    };
    const prev = previewSettingsChange(db, undefined, { draft: removed, expectedRevision: 2 });
    expect(prev.affectedStudents).toBe(13);
    for (const d of prev.dayDeltas!) expect(d.after).toBe(d.before! + 0.5);
  });
});
