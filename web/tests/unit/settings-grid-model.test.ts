import { describe, it, expect } from 'vitest';
import {
  ScheduleGridRowSchema,
  ScheduleGridRow,
  timeStringToMinutes,
  minutesToTimeString,
  gridRowsToClasses,
  classesToGridRows,
  buildSeedGridRows,
  ClassSetting,
} from '@/contracts/settings';

describe('D1: 平鋪排課時段列模型與驗證測試 (settings-grid-model)', () => {
  it('1. 合法平鋪時段列（如 15:20 ~ 16:50）驗證應成功通過', () => {
    const validRow = {
      rowId: 'row-1',
      className: '兒童美語-Gino',
      teacher: 'Cathy',
      weekday: '一',
      startTime: '15:20',
      endTime: '16:50',
      startMinutes: 920,
      endMinutes: 1010,
      active: true,
    };
    const parsed = ScheduleGridRowSchema.safeParse(validRow);
    expect(parsed.success).toBe(true);
  });

  it('2. 起迄倒置（如 17:00 ~ 15:00）應遭拒絕並拋出驗證錯誤 (RED)', () => {
    const invertedRow = {
      rowId: 'row-inv',
      className: '兒童美語-Gino',
      teacher: 'Cathy',
      weekday: '一',
      startTime: '17:00',
      endTime: '15:00',
      startMinutes: 1020,
      endMinutes: 900,
      active: true,
    };
    const parsed = ScheduleGridRowSchema.safeParse(invertedRow);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toMatch(/大於/);
    }
  });

  it('3. 起迄相同（如 15:00 ~ 15:00）應遭拒絕並拋出驗證錯誤', () => {
    const sameTimeRow = {
      rowId: 'row-same',
      className: '兒童美語-Gino',
      teacher: 'Cathy',
      weekday: '一',
      startTime: '15:00',
      endTime: '15:00',
      startMinutes: 900,
      endMinutes: 900,
      active: true,
    };
    const parsed = ScheduleGridRowSchema.safeParse(sameTimeRow);
    expect(parsed.success).toBe(false);
  });

  it('4. 空班級名稱應遭拒絕', () => {
    const emptyNameRow = {
      rowId: 'row-empty-name',
      className: '',
      teacher: null,
      weekday: '一',
      startTime: '15:00',
      endTime: '16:00',
      startMinutes: 900,
      endMinutes: 960,
      active: true,
    };
    const parsed = ScheduleGridRowSchema.safeParse(emptyNameRow);
    expect(parsed.success).toBe(false);
  });

  it('5. 時間格式非法（如 25:00 或 abc）應遭拒絕', () => {
    const badTimeRow = {
      rowId: 'row-bad-time',
      className: '兒童美語-Gino',
      teacher: null,
      weekday: '一',
      startTime: '25:00',
      endTime: '16:00',
      startMinutes: 1500,
      endMinutes: 960,
      active: true,
    };
    const parsed = ScheduleGridRowSchema.safeParse(badTimeRow);
    expect(parsed.success).toBe(false);
  });

  it('6. buildSeedGridRows() 應回傳剛好 89 筆平鋪時段列，涵蓋 49 個班級', () => {
    const rows = buildSeedGridRows();
    expect(rows.length).toBe(89);
    const uniqueClasses = new Set(rows.map((r) => r.className));
    expect(uniqueClasses.size).toBe(49);
  });

  it('7. buildSeedGridRows() 中 Gino 班應包含恰好 3 筆獨立時段列（週一、週三、週五）', () => {
    const rows = buildSeedGridRows();
    const ginoRows = rows.filter((r) => r.className === '兒童美語-Gino');
    expect(ginoRows.length).toBe(3);
    const weekdays = ginoRows.map((r) => r.weekday);
    expect(weekdays).toEqual(['一', '三', '五']);
    expect(ginoRows[0].teacher).toBe('Cathy');
  });

  it('8. gridRowsToClasses() 與 classesToGridRows() 雙向聚合轉換正確且保持資訊不失真', () => {
    const seedRows = buildSeedGridRows();
    const classes = gridRowsToClasses(seedRows);
    expect(classes.length).toBe(49);
    const ginoClass = classes.find((c) => c.baseName === '兒童美語-Gino');
    expect(ginoClass).toBeDefined();
    expect(ginoClass?.sessions.length).toBe(3);

    const roundTripRows = classesToGridRows(classes);
    expect(roundTripRows.length).toBe(89);
  });
});
