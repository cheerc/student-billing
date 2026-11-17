import { describe, it, expect } from 'vitest';
import { useGlobalTempDb, saveSyntheticBatch, activateBatch, activeState, makeStudent } from '../helpers/d1-test-kit';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { getCalculationRun } from '@/adapters/sqlite/runs-repository';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { GET as classesGET } from '@/app/api/v1/classes/route';
import type { SettingsDraft } from '@/contracts/settings';

/**
 * #248 / PR #250 r1 F2、F4：同名優先走正式產品入口
 * （previewSettingsChange → applySettingsPreview → 正式 Run 快照 → GET /api/v1/classes）。
 *
 * 預期值依規格手算（不取實作輸出）：
 *  - 課表已有班 X 時，名冊班 X 同名優先 → 解析到 X 本身，mapped=1，類別為 X 設定的 english。
 *  - 課表沒有 raw 名 Z 時，別名 Z→X 仍有效（#189 歷史別名相容）→ 解析到 X。
 *  - 同名判斷必須與下游查找（buildClassSettingMap 的 key／aliasMap.get(raw)）相同的「完全字串相等」：
 *    課表班名為「 X 」（含空白）時並不遮蔽名冊 X，別名 X→Y 仍須生效 → 解析到 Y。
 * 全部為合成資料。
 */

const cls = (baseName: string, category: 'english' | 'math') => ({
  baseName,
  teacher: '合成老師',
  active: true,
  classType: category,
  hasMultiSubjectDiscount: true,
  category,
  categorySource: 'manual' as const,
  sessions: [
    { weekday: '1', startTime: '16:30', endTime: '18:00', startMinutes: 990, endMinutes: 1080, skipDeduction: false },
  ],
});

describe('同名優先：正式入口（設定 preview/apply → Run 快照 → /classes）', () => {
  const ctx = useGlobalTempDb('sb-alias-same-name-');

  /** 啟用名冊並經正式 preview/apply 套用 draft；回傳 apply 產生的 Run 快照列。 */
  const applyDraft = (rosterClasses: string[], draft: SettingsDraft) => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_a', 'a.xlsx', '2026-09-01T08:00:00.000Z', [makeStudent('s1', rosterClasses)]);
    activateBatch(db, 'imp_a', 'act-a');
    const expectedRevision = activeState(db).revision; // 啟用後的 active_state revision
    const preview = previewSettingsChange(db, 'imp_a', { draft, expectedRevision });
    const applied = applySettingsPreview(db, { previewId: preview.previewId, expectedRevision, idempotencyKey: 'apply-a' });
    expect(applied.runId).toBeTruthy();
    const run = getCalculationRun(db, applied.runId!)!;
    return new Map((run.classCategories ?? []).map((c) => [c.base_name, c]));
  };

  const baseDraft = (classes: ReturnType<typeof cls>[], aliases: SettingsDraft['aliases']): SettingsDraft => ({
    ...buildSeedDraft(),
    classes,
    aliases,
  });

  it('課表有 X、舊別名 X→Y（Y 不在課表）、名冊 X：快照 mapped=1、類別為 X 的 english，/classes 為 mapped', async () => {
    const snap = applyDraft(['X班'], baseDraft([cls('X班', 'english')], [{ rawBaseName: 'X班', targetBaseName: 'Y班' }]));
    const x = snap.get('X班')!;
    expect(x.mapped).toBe(1);
    expect(x.resolved_base_name).toBe('X班');
    expect(x.category).toBe('english');

    const body = await (await classesGET()).json();
    const item = body.items.find((i: any) => i.baseName === 'X班');
    expect(item.mappingStatus).toBe('mapped');
    expect(item.category).toBe('english');
    expect(item.isConfigured).toBe(true);
  });

  it('對照：raw Z 不在課表、別名 Z→X 仍有效 → 解析到 X、mapped=1、類別 english', async () => {
    const snap = applyDraft(['Z班'], baseDraft([cls('X班', 'english')], [{ rawBaseName: 'Z班', targetBaseName: 'X班' }]));
    const z = snap.get('Z班')!;
    expect(z.mapped).toBe(1);
    expect(z.resolved_base_name).toBe('X班');
    expect(z.category).toBe('english');

    const body = await (await classesGET()).json();
    const item = body.items.find((i: any) => i.baseName === 'Z班');
    expect(item.mappingStatus).toBe('aliased');
    expect(item.targetBaseName).toBe('X班');
  });

  it('F2：課表班名為「 X班 」（含空白）不遮蔽名冊 X班；別名 X班→Y班 仍生效 → 解析到 Y班、mapped=1、類別 math', () => {
    const snap = applyDraft(
      ['X班'],
      baseDraft([cls(' X班 ', 'english'), cls('Y班', 'math')], [{ rawBaseName: 'X班', targetBaseName: 'Y班' }]),
    );
    const x = snap.get('X班')!;
    expect(x.resolved_base_name).toBe('Y班');
    expect(x.mapped).toBe(1);
    expect(x.category).toBe('math');
  });
});
