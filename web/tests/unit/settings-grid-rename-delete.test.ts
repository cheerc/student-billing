import { describe, it, expect } from 'vitest';
import {
  ScheduleGridRow,
  gridRowsToClasses,
  detectSplitClasses,
  ClassSetting,
} from '@/contracts/settings';

describe('PR-1 追加: 逐列改名、單列刪除、改散警告與星期可編輯測試 (D28/D29)', () => {
  it('1. [RED] 逐列獨立改名後，gridRowsToClasses 應依新名稱自動重分組', () => {
    const rows: ScheduleGridRow[] = [
      {
        rowId: 'row-1',
        className: '兒童美語-Gino-Advanced', // 改名第 1 列
        teacher: 'Cathy',
        weekday: '一',
        startTime: '15:20',
        endTime: '16:50',
        startMinutes: 920,
        endMinutes: 1010,
        active: true,
      },
      {
        rowId: 'row-2',
        className: '兒童美語-Gino', // 維持原名
        teacher: 'Cathy',
        weekday: '三',
        startTime: '15:30',
        endTime: '17:00',
        startMinutes: 930,
        endMinutes: 1020,
        active: true,
      },
      {
        rowId: 'row-3',
        className: '兒童美語-Gino', // 維持原名
        teacher: 'Cathy',
        weekday: '五',
        startTime: '15:20',
        endTime: '16:50',
        startMinutes: 920,
        endMinutes: 1010,
        active: true,
      },
    ];

    const classes = gridRowsToClasses(rows);
    expect(classes.length).toBe(2);

    const ginoClass = classes.find((c) => c.baseName === '兒童美語-Gino');
    expect(ginoClass).toBeDefined();
    expect(ginoClass?.sessions.length).toBe(2);

    const advClass = classes.find((c) => c.baseName === '兒童美語-Gino-Advanced');
    expect(advClass).toBeDefined();
    expect(advClass?.sessions.length).toBe(1);
    expect(advClass?.sessions[0].weekday).toBe('一');
  });

  it('2. [RED] detectSplitClasses 應能偵測原同名多列被改散（拆成兩班）並產生警告', () => {
    const originalRows: ScheduleGridRow[] = [
      { rowId: 'r-1', className: '兒童美語-Gino', teacher: 'Cathy', weekday: '一', startTime: '15:20', endTime: '16:50', startMinutes: 920, endMinutes: 1010, active: true },
      { rowId: 'r-2', className: '兒童美語-Gino', teacher: 'Cathy', weekday: '三', startTime: '15:30', endTime: '17:00', startMinutes: 930, endMinutes: 1020, active: true },
      { rowId: 'r-3', className: '兒童美語-Gino', teacher: 'Cathy', weekday: '五', startTime: '15:20', endTime: '16:50', startMinutes: 920, endMinutes: 1010, active: true },
    ];

    // 模擬改散：其中一列被改名
    const splitRows: ScheduleGridRow[] = [
      { rowId: 'r-1', className: '兒童美語-Gino-A', teacher: 'Cathy', weekday: '一', startTime: '15:20', endTime: '16:50', startMinutes: 920, endMinutes: 1010, active: true },
      { rowId: 'r-2', className: '兒童美語-Gino', teacher: 'Cathy', weekday: '三', startTime: '15:30', endTime: '17:00', startMinutes: 930, endMinutes: 1020, active: true },
      { rowId: 'r-3', className: '兒童美語-Gino', teacher: 'Cathy', weekday: '五', startTime: '15:20', endTime: '16:50', startMinutes: 920, endMinutes: 1010, active: true },
    ];

    const warnings = detectSplitClasses(originalRows, splitRows);
    expect(warnings.length).toBe(1);
    expect(warnings[0].originalName).toBe('兒童美語-Gino');
    expect(warnings[0].splitNames).toContain('兒童美語-Gino-A');
    expect(warnings[0].splitNames).toContain('兒童美語-Gino');

    // 模擬全班統一更名（3 列全改為 兒童美語-Gino-New）不應觸發改散警告
    const unifiedRows: ScheduleGridRow[] = originalRows.map((r) => ({
      ...r,
      className: '兒童美語-Gino-New',
    }));
    const noSplit = detectSplitClasses(originalRows, unifiedRows);
    expect(noSplit.length).toBe(0);
  });

  it('3. 單列刪除：從多時段班中刪除 1 列，gridRowsToClasses 正確縮減時段數', () => {
    const rows: ScheduleGridRow[] = [
      { rowId: 'r-1', className: '兒童美語-Gino', teacher: 'Cathy', weekday: '一', startTime: '15:20', endTime: '16:50', startMinutes: 920, endMinutes: 1010, active: true },
      { rowId: 'r-3', className: '兒童美語-Gino', teacher: 'Cathy', weekday: '五', startTime: '15:20', endTime: '16:50', startMinutes: 920, endMinutes: 1010, active: true },
    ]; // 刪除了週三的 r-2

    const classes = gridRowsToClasses(rows);
    expect(classes.length).toBe(1);
    expect(classes[0].sessions.length).toBe(2);
    expect(classes[0].sessions.map((s) => s.weekday)).toEqual(['一', '五']);
  });

  it('4. 星期欄位編輯：修改星期文字後，gridRowsToClasses 正確保存新星期文字', () => {
    const rows: ScheduleGridRow[] = [
      { rowId: 'r-1', className: '小六加強班-數學', teacher: '丞鍹', weekday: '四', startTime: '19:00', endTime: '21:00', startMinutes: 1140, endMinutes: 1260, active: true },
    ]; // 將原本的「二」改為「四」

    const classes = gridRowsToClasses(rows);
    expect(classes[0].sessions[0].weekday).toBe('四');
  });

  it('5. [RED F1 rework] 空班級名稱列應被 gridRowsToClasses 丟棄，不產出 baseName 空字串班', () => {
    const rows: ScheduleGridRow[] = [
      { rowId: 'r-empty', className: '   ', teacher: null, weekday: '一', startTime: '13:00', endTime: '15:00', startMinutes: 780, endMinutes: 900, active: true },
      { rowId: 'r-1', className: '兒童美語-Gino', teacher: 'Cathy', weekday: '一', startTime: '15:20', endTime: '16:50', startMinutes: 920, endMinutes: 1010, active: true },
    ];

    const classes = gridRowsToClasses(rows);
    // F1: 空名列不可產出 baseName 為空字串的班污染版本快照
    expect(classes.length).toBe(1);
    expect(classes[0].baseName).toBe('兒童美語-Gino');
    expect(classes.every((c) => c.baseName.trim() !== '')).toBe(true);
  });
});
