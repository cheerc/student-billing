import { describe, it, expect } from 'vitest';
import { useGlobalTempDb, saveSyntheticBatch, activateBatch, makeStudent, saveSettings } from '../helpers/d1-test-kit';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import {
  classesToGridRows,
  gridRowsToClasses,
  type ScheduleGridRow,
  type AliasMapping,
  type SettingsDraft,
} from '@/contracts/settings';
import {
  detectClassLifecycle,
  carryAttributesOnRename,
  resolveClassAttributes,
  type ClassAttributesView,
} from '@/domain/classification/class-attributes';
import { applyManualAttrsToClasses } from '@/domain/classification/persist-class-attributes';
import { executeCalculationRun, resolveLatestSavedSettings } from '@/application/calculate-run';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { loadModule } from '../helpers/d1-test-kit';

describe('班名同步計費不變式整合測試 (Billing Invariance)', () => {
  const ctx = useGlobalTempDb('sb-sync-inv-');

  it('課表 X + 別名 乙→X 之 Run A，與 stageClassNameSync(乙, X) 套用後之 Run B，計費結果完全不變 (A=B)', async () => {
    const db = ctx.db();
    const mod = await loadModule<{
      stageClassNameSync: (
        state: { rows: ScheduleGridRow[]; aliases: AliasMapping[] },
        op: { erpBaseName: string; systemBaseName: string }
      ) => { rows: ScheduleGridRow[]; aliases: AliasMapping[]; orphanedAliasRaws: string[] };
    }>('@/domain/schedules/class-name-sync');
    expect(mod, 'class-name-sync 模組需存在').not.toBeNull();
    if (!mod) return;

    // 名冊：
    // s1 報名 乙班（米豆奶班名）與 國小輔導-三年級
    // s2 報名 丁班（另一別名班）
    // s3 報名 國小輔導-三年級（基準照料班）
    saveSyntheticBatch(db, 'imp_inv', 'inv.xlsx', '2026-09-01T08:00:00.000Z', [
      makeStudent('s1', ['乙班', '國小輔導-三年級']),
      makeStudent('s2', ['丁班']),
      makeStudent('s3', ['國小輔導-三年級']),
    ]);
    activateBatch(db, 'imp_inv', 'act-inv');

    // 初始課表：
    // 包含 X班（兒童美語，週一 16:30-18:00），以及 國小輔導-三年級
    // 別名：乙班 -> X班，丁班 -> X班
    const seed = buildSeedDraft();
    const initialDraft = {
      ...seed,
      classes: [
        ...seed.classes.filter((c) => c.baseName === '國小輔導-三年級'),
        {
          baseName: 'X班',
          teacher: '陳老師',
          active: true,
          classType: 'english' as const,
          hasMultiSubjectDiscount: true,
          category: 'english' as const,
          categorySource: 'manual' as const,
          sessions: [
            {
              weekday: '1',
              startTime: '16:30',
              endTime: '18:00',
              startMinutes: 990,
              endMinutes: 1080,
              skipDeduction: false,
            },
          ],
        },
      ],
      aliases: [
        { rawBaseName: '乙班', targetBaseName: 'X班' },
        { rawBaseName: '丁班', targetBaseName: 'X班' },
      ],
    };
    saveSettings(db, 'set_initial', 1, initialDraft);

    // 執行 Run A（初始狀態：經別名連上）
    const settingsA = resolveLatestSavedSettings(db);
    const runA = executeCalculationRun(db, 'imp_inv', 'run_A', {
      ruleSetVersion: 'erp-tag-v4',
      ...settingsA,
    });

    const s1_A = runA.results.find((r) => r.personCode === 's1')!;
    const s2_A = runA.results.find((r) => r.personCode === 's2')!;
    const s3_A = runA.results.find((r) => r.personCode === 's3')!;

    // 驗證 Run A 中 s1 與 s2 沒有 CLASS_NOT_MAPPED
    expect(s1_A.issues.some((i: any) => i.code === 'CLASS_NOT_MAPPED')).toBe(false);
    expect(s2_A.issues.some((i: any) => i.code === 'CLASS_NOT_MAPPED')).toBe(false);

    // 執行同步草稿轉換：將 乙班 同步到 X班
    const initialRows = classesToGridRows(initialDraft.classes);
    const syncResult = mod.stageClassNameSync(
      { rows: initialRows, aliases: initialDraft.aliases },
      { erpBaseName: '乙班', systemBaseName: 'X班' }
    );

    expect(syncResult.orphanedAliasRaws).toEqual(['丁班']);

    // 走正式的生命週期與轉換管線從 syncResult.rows 產出 Run B 的 draft（非手寫寫死）
    const lifecycle = detectClassLifecycle(initialRows, syncResult.rows);
    expect(lifecycle.renames).toEqual([{ from: 'X班', to: '乙班' }]);

    const manualAttrs = new Map<string, ClassAttributesView>();
    for (const c of initialDraft.classes) {
      manualAttrs.set(c.baseName, resolveClassAttributes(c.baseName, c));
    }
    const carriedAttrs = carryAttributesOnRename(lifecycle.renames, manualAttrs, new Map());
    const convertedClasses = gridRowsToClasses(syncResult.rows, initialDraft.classes);
    const updatedClasses = applyManualAttrsToClasses(convertedClasses, carriedAttrs);

    const updatedDraft: SettingsDraft = {
      ...initialDraft,
      classes: updatedClasses,
      aliases: syncResult.aliases,
    };

    const preview = previewSettingsChange(db, 'imp_inv', { draft: updatedDraft, expectedRevision: 1 });
    const applied = applySettingsPreview(db, {
      previewId: preview.previewId,
      expectedRevision: 1,
      idempotencyKey: 'apply-sync-b',
    });

    // 取得 Run B
    const settingsB = resolveLatestSavedSettings(db);
    const runB = executeCalculationRun(db, 'imp_inv', applied.runId!, {
      ruleSetVersion: 'erp-tag-v4',
      ...settingsB,
    });

    const s1_B = runB.results.find((r) => r.personCode === 's1')!;
    const s2_B = runB.results.find((r) => r.personCode === 's2')!;
    const s3_B = runB.results.find((r) => r.personCode === 's3')!;

    // === 核心不變式斷言 ===
    // 1. 對於已同步的學生 s1：天數、折扣、級距比對完全相同
    expect(s1_B.anqinDays).toBe(s1_A.anqinDays);
    expect(s1_B.tutoringDays).toBe(s1_A.tutoringDays);
    expect(s1_B.baseDiscountBps).toBe(s1_A.baseDiscountBps);
    expect(s1_B.applicableEnglishBps).toBe(s1_A.applicableEnglishBps);
    expect(s1_B.applicableMathBps).toBe(s1_A.applicableMathBps);
    expect(s1_B.tierMismatch).toBe(s1_A.tierMismatch);
    expect(s1_B.issues.filter((i: any) => i.code !== 'DISCOUNT_DIFF')).toEqual(
      s1_A.issues.filter((i: any) => i.code !== 'DISCOUNT_DIFF')
    );

    // 2. 基準學生 s3 完全不受影響
    expect(s3_B.anqinDays).toBe(s3_A.anqinDays);
    expect(s3_B.tutoringDays).toBe(s3_A.tutoringDays);
    expect(s3_B.baseDiscountBps).toBe(s3_A.baseDiscountBps);
    expect(s3_B.issues).toEqual(s3_A.issues);

    // 3. 被孤立的學生 s2（丁班）：在 Run B 變成 CLASS_NOT_MAPPED
    expect(s2_B.issues.some((i: any) => i.code === 'CLASS_NOT_MAPPED')).toBe(true);
  });
});
