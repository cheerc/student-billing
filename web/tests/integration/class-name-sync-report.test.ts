import { describe, it, expect } from 'vitest';
import {
  getClassNameMatchReport,
  summarizeClassNameReport,
  type ClassNameSyncReport,
} from '@/application/class-name-match-report';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import type { SettingsDraft } from '@/contracts/settings';
import {
  useGlobalTempDb,
  saveSyntheticBatch,
  activateBatch,
  makeStudent,
  saveSettings,
  saveRun,
} from '../helpers/d1-test-kit';

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe('ClassNameSyncReport read model（嚴格完全同名一致性，D62）', () => {
  const ctx = useGlobalTempDb('sb-sync-rep-');

  it('名冊 {甲, 乙, 丙}、課表 {甲, X, W}、別名 乙→X 判定正確', () => {
    const db = ctx.db();
    // 名冊：甲班 (s1), 乙班 (s2), 丙班 (s3)
    saveSyntheticBatch(db, 'imp_test', 'test.xlsx', '2026-09-01T08:00:00.000Z', [
      makeStudent('s1', ['甲班']),
      makeStudent('s2', ['乙班']),
      makeStudent('s3', ['丙班']),
    ]);
    activateBatch(db, 'imp_test', 'act-1');

    // 課表：甲班, X班, W班；別名：乙班 -> X班
    const seed = buildSeedDraft();
    const draft: SettingsDraft = {
      ...seed,
      classes: [
        { baseName: '甲班', teacher: null, active: true, sessions: [], classType: 'care', hasMultiSubjectDiscount: true },
        { baseName: 'X班', teacher: null, active: true, sessions: [], classType: 'english', hasMultiSubjectDiscount: true },
        { baseName: 'W班', teacher: null, active: false, sessions: [], classType: 'other', hasMultiSubjectDiscount: false },
      ],
      aliases: [
        { rawBaseName: '乙班', targetBaseName: 'X班' },
      ],
    };
    saveSettings(db, 'set_1', 1, draft);

    const report = getClassNameMatchReport(db, { importId: 'imp_test', scope: { kind: 'latest' } }) as unknown as ClassNameSyncReport;

    expect(report.snapshotStatus).toBe('ok');
    expect(report.rosterClassCount).toBe(3);
    expect(report.exactMatchCount).toBe(1); // 只有 甲班 是嚴格同名
    expect(report.unmappedStudents).toBe(1); // 只有 丙班 (s3) 沒有 legacyAliasTarget

    // mismatches: 乙班 (legacyAliasTarget = X班), 丙班 (legacyAliasTarget = null)
    // 排序：未對應優先 (丙班)，其次學生數，再依班名
    expect(report.mismatches).toEqual([
      { erpBaseName: '丙班', students: 1, tokens: 1, legacyAliasTarget: null },
      { erpBaseName: '乙班', students: 1, tokens: 1, legacyAliasTarget: 'X班' },
    ]);

    // systemOnly: X班, W班（本次名冊沒有直接報名）
    // X班 legacyAliasFrom: ['乙班']
    // W班 legacyAliasFrom: []
    expect(report.systemOnly).toEqual([
      { baseName: 'X班', active: true, classType: 'english', sessionCount: 0, legacyAliasFrom: ['乙班'] },
      { baseName: 'W班', active: false, classType: 'other', sessionCount: 0, legacyAliasFrom: [] },
    ]);

    // summarizeClassNameReport 摘要
    const summary = summarizeClassNameReport(report as any);
    expect(summary).toMatchObject({
      importId: 'imp_test',
      mismatchCount: 2,
      unmappedCount: 1,
      unmappedStudents: 1,
      reportPath: '/settings?tab=mapping&import=imp_test',
    });
  });

  it('別名目標不在課表設定中 → legacyAliasTarget 視為 null', () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_ghost', 'ghost.xlsx', '2026-09-01T08:00:00.000Z', [
      makeStudent('s1', ['丁班']),
    ]);
    activateBatch(db, 'imp_ghost', 'act-ghost');

    const seed = buildSeedDraft();
    const draft: SettingsDraft = {
      ...seed,
      classes: [
        { baseName: '正常班', teacher: null, active: true, sessions: [], classType: 'care' },
      ],
      aliases: [
        { rawBaseName: '丁班', targetBaseName: '不存在的幽靈班' },
      ],
    };
    saveSettings(db, 'set_ghost', 1, draft);

    const report = getClassNameMatchReport(db, { importId: 'imp_ghost', scope: { kind: 'latest' } }) as unknown as ClassNameSyncReport;
    expect(report.mismatches).toEqual([
      { erpBaseName: '丁班', students: 1, tokens: 1, legacyAliasTarget: null },
    ]);
    expect(report.unmappedStudents).toBe(1);
  });

  it('同一學生同時報名乙班（有舊對應）與丙班（未對應）→ unmappedStudents 跨班去重只算 1 人', () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_multi', 'multi.xlsx', '2026-09-01T08:00:00.000Z', [
      makeStudent('s1', ['乙班', '丙班']), // 同一學生 s1 在兩班
      makeStudent('s2', ['丙班']),
    ]);
    activateBatch(db, 'imp_multi', 'act-multi');

    const seed = buildSeedDraft();
    const draft: SettingsDraft = {
      ...seed,
      classes: [
        { baseName: 'X班', teacher: null, active: true, sessions: [], classType: 'care' },
      ],
      aliases: [
        { rawBaseName: '乙班', targetBaseName: 'X班' },
      ],
    };
    saveSettings(db, 'set_multi', 1, draft);

    const report = getClassNameMatchReport(db, { importId: 'imp_multi', scope: { kind: 'latest' } }) as unknown as ClassNameSyncReport;
    // 丙班為 legacyAliasTarget=null，涵蓋 s1 與 s2 -> unmappedStudents = 2
    expect(report.unmappedStudents).toBe(2);
  });

  it('快照缺失 → snapshotStatus: unavailable 且清單為 null', () => {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_snap', 'snap.xlsx', '2026-09-01T08:00:00.000Z', [
      makeStudent('s1', ['甲班']),
    ]);
    activateBatch(db, 'imp_snap', 'act-snap');
    saveRun(db, 'run_missing', 'imp_snap', 'non_existent_settings', '2026-09-02T00:00:00.000Z');

    const report = getClassNameMatchReport(db, { importId: 'imp_snap', scope: { kind: 'run', runId: 'run_missing' } }) as unknown as ClassNameSyncReport;
    expect(report).toEqual({
      importId: 'imp_snap',
      scope: { kind: 'run', runId: 'run_missing' },
      snapshotStatus: 'unavailable',
      rosterClassCount: null,
      exactMatchCount: null,
      mismatches: null,
      unmappedStudents: null,
      systemOnly: null,
      rosterOnly: null,
    });
  });
});
