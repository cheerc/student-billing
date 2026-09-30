import { describe, it, expect } from 'vitest';
import {
  ClassSettingSchema,
  isSettingsDirty,
  SettingsBaseline,
  ScheduleGridRow,
} from '@/contracts/settings';

describe('D2a: 班級設定草稿資料模型擴充與衝突判定 (Settings Contract)', () => {
  it('ClassSettingSchema 支援 category, categorySource, fixedFiveDays, fixedSource 擴充欄位', () => {
    const rawClass = {
      baseName: '兒童美語-初級',
      subject: '兒童美語',
      teacher: '王老師',
      active: true,
      sessions: [
        { weekday: '一', startMinutes: 800, endMinutes: 900 },
      ],
      category: 'english',
      categorySource: 'manual',
      fixedFiveDays: false,
      fixedSource: 'auto',
    };

    const parsed = ClassSettingSchema.parse(rawClass);
    expect((parsed as any).category).toBe('english');
    expect((parsed as any).categorySource).toBe('manual');
    expect((parsed as any).fixedFiveDays).toBe(false);
    expect((parsed as any).fixedSource).toBe('auto');
  });

  it('F-13: isSettingsDirty 支援班級層 category / fixedFiveDays 變更之 dirty 判定', () => {
    const baseRows: ScheduleGridRow[] = [
      {
        rowId: 'row-1',
        className: '國小輔導-四年級',
        teacher: null,
        weekday: '一',
        startTime: '13:00',
        endTime: '16:00',
        startMinutes: 780,
        endMinutes: 960,
        active: true,
      },
    ];

    const baseline: SettingsBaseline = {
      rows: baseRows,
      aliases: [],
      // baseline 包含班級屬性
      classAttrs: [
        { className: '國小輔導-四年級', category: 'care', fixedFiveDays: false },
      ],
    } as any;

    // 時段列相同，但 classAttrs 改變
    const currentAttrs = [
      { className: '國小輔導-四年級', category: 'none', fixedFiveDays: true },
    ];

    expect((isSettingsDirty as any)(baseline, baseRows, [], currentAttrs)).toBe(true);

    // 完全相同 -> false
    expect((isSettingsDirty as any)(baseline, baseRows, [], [{ className: '國小輔導-四年級', category: 'care', fixedFiveDays: false }])).toBe(false);
  });
});
