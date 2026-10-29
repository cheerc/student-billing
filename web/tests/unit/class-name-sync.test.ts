import { describe, it, expect } from 'vitest';
import { loadModule } from '../helpers/d1-test-kit';
import type { ScheduleGridRow, AliasMapping } from '@/contracts/settings';

const MODULE = '@/domain/schedules/class-name-sync';

interface ClassNameSyncMod {
  stageClassNameSync: (
    state: { rows: ScheduleGridRow[]; aliases: AliasMapping[] },
    op: { erpBaseName: string; systemBaseName: string }
  ) => { rows: ScheduleGridRow[]; aliases: AliasMapping[]; orphanedAliasRaws: string[] };
  stageNewClassFromRoster: (
    rows: ScheduleGridRow[],
    op: { erpBaseName: string; classType: 'care' | 'english' | 'math' | 'other' | 'unscheduled' }
  ) => { rows: ScheduleGridRow[]; newRow: ScheduleGridRow };
  ClassNameSyncError: new (message: string, code: string) => Error & { code: string };
}

describe('stageClassNameSync: 同步純函式', () => {
  it('模組存在並匯出 stageClassNameSync, stageNewClassFromRoster, ClassNameSyncError', async () => {
    const mod = await loadModule<ClassNameSyncMod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    expect(typeof mod?.stageClassNameSync).toBe('function');
    expect(typeof mod?.stageNewClassFromRoster).toBe('function');
    expect(typeof mod?.ClassNameSyncError).toBe('function');
  });

  it('多列整班改名，保留 rowId 與時段設定，觸發 lifecycle 改名辨識', async () => {
    const mod = await loadModule<ClassNameSyncMod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    if (!mod) return;
    const initialRows: ScheduleGridRow[] = [
      {
        rowId: 'row-1',
        className: '國小數學-一A',
        teacher: '張老師',
        weekday: '1',
        startTime: '16:30',
        endTime: '18:00',
        startMinutes: 990,
        endMinutes: 1080,
        active: true,
        skipDeduction: false,
      },
      {
        rowId: 'row-2',
        className: '國小數學-一A',
        teacher: '李老師',
        weekday: '3',
        startTime: '16:30',
        endTime: '18:00',
        startMinutes: 990,
        endMinutes: 1080,
        active: true,
        skipDeduction: false,
      },
      {
        rowId: 'row-3',
        className: '國小輔導-一年級',
        teacher: null,
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
    ];
    const initialAliases: AliasMapping[] = [
      { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' },
    ];

    const result = mod.stageClassNameSync(
      { rows: initialRows, aliases: initialAliases },
      { erpBaseName: '國小數學-一', systemBaseName: '國小數學-一A' }
    );

    // 兩列 row-1, row-2 改名為 國小數學-一，rowId 原樣保留
    expect(result.rows).toHaveLength(3);
    const renamedRows = result.rows.filter((r) => r.className === '國小數學-一');
    expect(renamedRows).toHaveLength(2);
    expect(renamedRows.map((r) => r.rowId)).toEqual(['row-1', 'row-2']);
    expect(renamedRows[0].teacher).toBe('張老師');
    expect(renamedRows[1].teacher).toBe('李老師');

    // row-3 未受影響
    expect(result.rows.find((r) => r.rowId === 'row-3')?.className).toBe('國小輔導-一年級');

    // 別名 rawBaseName === erpBaseName 已被清除
    expect(result.aliases).toHaveLength(0);
    expect(result.orphanedAliasRaws).toEqual([]);
  });

  it('清理 targetBaseName === systemBaseName 的別名，並將非 erpBaseName 者列入 orphanedAliasRaws', async () => {
    const mod = await loadModule<ClassNameSyncMod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    if (!mod) return;
    const rows: ScheduleGridRow[] = [
      {
        rowId: 'row-1',
        className: '系統班X',
        teacher: null,
        weekday: '1',
        startTime: '16:30',
        endTime: '18:00',
        startMinutes: 990,
        endMinutes: 1080,
        active: true,
        skipDeduction: false,
      },
      {
        rowId: 'row-2',
        className: '其他班W',
        teacher: null,
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
    ];
    const aliases: AliasMapping[] = [
      { rawBaseName: '米豆奶乙', targetBaseName: '系統班X' },
      { rawBaseName: '米豆奶丁', targetBaseName: '系統班X' },
      { rawBaseName: '米豆奶戊', targetBaseName: '其他班W' },
    ];

    const result = mod.stageClassNameSync(
      { rows, aliases },
      { erpBaseName: '米豆奶乙', systemBaseName: '系統班X' }
    );

    // 系統班X 改名為 米豆奶乙
    expect(result.rows.find((r) => r.rowId === 'row-1')?.className).toBe('米豆奶乙');

    // 移除 rawBaseName === 米豆奶乙
    // 移除 targetBaseName === 系統班X (丁 被孤立)
    // 剩下 戊 -> 其他班W
    expect(result.aliases).toEqual([{ rawBaseName: '米豆奶戊', targetBaseName: '其他班W' }]);
    expect(result.orphanedAliasRaws).toEqual(['米豆奶丁']);
  });

  it('三種前置拒絕：名稱相同、目標班不存在、來源班已存在', async () => {
    const mod = await loadModule<ClassNameSyncMod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    if (!mod) return;
    const rows: ScheduleGridRow[] = [
      {
        rowId: 'row-1',
        className: '系統班X',
        teacher: null,
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
      {
        rowId: 'row-2',
        className: '系統班Y',
        teacher: null,
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
    ];

    // 1. 兩者相同
    expect(() =>
      mod.stageClassNameSync({ rows, aliases: [] }, { erpBaseName: '系統班X', systemBaseName: '系統班X' })
    ).toThrowError();

    // 2. systemBaseName 不存在於 rows
    expect(() =>
      mod.stageClassNameSync({ rows, aliases: [] }, { erpBaseName: '新班名', systemBaseName: '不存在班' })
    ).toThrowError();

    // 3. erpBaseName 已存在於 rows
    expect(() =>
      mod.stageClassNameSync({ rows, aliases: [] }, { erpBaseName: '系統班Y', systemBaseName: '系統班X' })
    ).toThrowError();
  });
});

describe('stageNewClassFromRoster: 從名冊新增課表班級', () => {
  it('建立一列預設值，排課類型時段留空，其他班 skipDeduction 預設 true', async () => {
    const mod = await loadModule<ClassNameSyncMod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    if (!mod) return;
    const rows: ScheduleGridRow[] = [];

    // 美語班
    const result1 = mod.stageNewClassFromRoster(rows, { erpBaseName: '美語班甲', classType: 'english' });
    expect(result1.rows).toHaveLength(1);
    expect(result1.newRow).toMatchObject({
      className: '美語班甲',
      weekday: '',
      startTime: '',
      endTime: '',
      startMinutes: null,
      endMinutes: null,
      active: true,
      skipDeduction: false,
    });

    // 其他班
    const result2 = mod.stageNewClassFromRoster(result1.rows, { erpBaseName: '交通車', classType: 'other' });
    expect(result2.rows).toHaveLength(2);
    expect(result2.newRow).toMatchObject({
      className: '交通車',
      weekday: '',
      startTime: '',
      endTime: '',
      startMinutes: null,
      endMinutes: null,
      active: true,
      skipDeduction: true,
    });
  });

  it('若 erpBaseName 已存在於 rows 則拒絕', async () => {
    const mod = await loadModule<ClassNameSyncMod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    if (!mod) return;
    const rows: ScheduleGridRow[] = [
      {
        rowId: 'row-1',
        className: '已有班級',
        teacher: null,
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
    ];

    expect(() =>
      mod.stageNewClassFromRoster(rows, { erpBaseName: '已有班級', classType: 'math' })
    ).toThrowError();
  });
});
