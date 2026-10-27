import { describe, it, expect } from 'vitest';
import {
  ScheduleGridRowSchema,
  ScheduleGridRow,
  SessionSchema,
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

  it('8. [F1] buildSeedGridRows() 空時段原樣攜帶 null，gridRowsToClasses 不產假 session，一B 保持空 sessions (RED)', () => {
    const rows = buildSeedGridRows();
    // 8 個 care_window 班級 + 一B 2 列，共 10 筆空時段列
    const math1BRows = rows.filter((r) => r.className === '國小數學-一B');
    expect(math1BRows.length).toBe(2);
    // F1: 不應被捏造 630-720，而應原樣攜帶 null
    expect(math1BRows[0].startMinutes).toBeNull();
    expect(math1BRows[0].endMinutes).toBeNull();

    const careRows = rows.filter((r) => r.className === '國小輔導-一A');
    expect(careRows.length).toBe(1);
    // F1: 不應被捏造 780-960，而應原樣攜帶 null
    expect(careRows[0].startMinutes).toBeNull();
    expect(careRows[0].endMinutes).toBeNull();

    // 聚合後：國小數學-一B 與 國小輔導-一A 不應含有實體 sessions
    const classes = gridRowsToClasses(rows);
    const math1BClass = classes.find((c) => c.baseName === '國小數學-一B');
    expect(math1BClass).toBeDefined();
    expect(math1BClass?.sessions.length).toBe(0); // 保持 schedule_empty 語義！

    const careClass = classes.find((c) => c.baseName === '國小輔導-一A');
    expect(careClass).toBeDefined();
    expect(careClass?.sessions.length).toBe(0); // 保持 care_window 共用時間窗語義！
  });

  it('9. [F2] classesToGridRows 不丟棄空時段班級，往返雙向保真 (RED)', () => {
    const emptyClass: ClassSetting = {
      baseName: '國小數學-一B',
      teacher: null,
      active: true,
      sessions: [], // 空 sessions 班
    };
    const flatRows = classesToGridRows([emptyClass]);
    // F2: 展平後應有 1 筆佔位列，不應丟棄該班
    expect(flatRows.length).toBe(1);
    expect(flatRows[0].className).toBe('國小數學-一B');
    expect(flatRows[0].startMinutes).toBeNull();
    expect(flatRows[0].endMinutes).toBeNull();

    // 往返轉換回 ClassSetting[] 仍應保留該班
    const roundTrip = gridRowsToClasses(flatRows);
    expect(roundTrip.length).toBe(1);
    expect(roundTrip[0].baseName).toBe('國小數學-一B');
    expect(roundTrip[0].sessions.length).toBe(0);
  });

  /**
   * #82：新增時段只有「班級名稱」必填，其餘（老師／星期／起迄）可留空。
   *
   * 這裡鎖的是**放寬的邊界**：平鋪列接受空星期並正規化為空字串，但存檔契約
   * （`SessionSchema`／`SavedWeekdaySchema`）必須仍然拒絕空白星期（09 §3.1）——
   * 兩者一起斷言，才不會有人日後「順手」把 SessionSchema 也放寬而悄悄改掉存檔語意。
   */
  describe('#82：平鋪列可留空、存檔契約不放寬', () => {
    const placeholderBase = {
      rowId: 'row-placeholder',
      className: '新開班-待排課',
      teacher: null,
      startTime: '',
      endTime: '',
      startMinutes: null,
      endMinutes: null,
      active: true,
    };

    it('10. 星期留空字串的佔位列可通過平鋪列契約，並保持為空字串', () => {
      const parsed = ScheduleGridRowSchema.safeParse({ ...placeholderBase, weekday: '' });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.weekday).toBe('');
    });

    it('11. 星期為 null 時正規化為空字串（row 型別維持 string，下游不必處理 null）', () => {
      const parsed = ScheduleGridRowSchema.safeParse({ ...placeholderBase, weekday: null });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.weekday).toBe('');
        expect(typeof parsed.data.weekday).toBe('string');
      }
    });

    it('12. 星期欄位缺漏時預設為空字串', () => {
      const { weekday, ...withoutWeekday } = { ...placeholderBase, weekday: '' };
      expect(weekday).toBe('');
      const parsed = ScheduleGridRowSchema.safeParse(withoutWeekday);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.weekday).toBe('');
    });

    it('13. 星期超過 8 字元仍被拒絕（長度上限不放寬，避免無意義 payload 進草稿）', () => {
      const parsed = ScheduleGridRowSchema.safeParse({ ...placeholderBase, weekday: '一二三四五六七八九' });
      expect(parsed.success).toBe(false);
    });

    it('14. 存檔契約 SessionSchema 仍拒絕空白星期（#82 不放寬存檔，09 §3.1）', () => {
      const blank = SessionSchema.safeParse({ weekday: '', startMinutes: 780, endMinutes: 900 });
      expect(blank.success).toBe(false);
      const ok = SessionSchema.safeParse({ weekday: '一', startMinutes: 780, endMinutes: 900 });
      expect(ok.success).toBe(true);
    });

    it('15. 只有班名的佔位列不產出 session，但班級本身保留（不因沒有時段就消失）', () => {
      const rows = buildSeedGridRows();
      rows.push(ScheduleGridRowSchema.parse({ ...placeholderBase, weekday: '' }));

      const classes = gridRowsToClasses(rows);
      const placeholder = classes.find((c) => c.baseName === '新開班-待排課');
      expect(placeholder).toBeDefined();
      expect(placeholder?.sessions).toEqual([]);
      expect(placeholder?.active).toBe(true);
      // 其餘 89 筆 seed 列不受影響（放寬沒有改變既有班的產出）。
      // 40 與 9 來自 probes/count-baseline.mts 實測（89 列 → 49 班，其中 40 班有 session、9 班為
      // 8 個 care_window 班 + 國小數學-一B），不是手算。
      const withSessions = classes.filter((c) => c.sessions.length > 0);
      expect(withSessions).toHaveLength(40);
      expect(classes.filter((c) => c.sessions.length === 0)).toHaveLength(10); // 9 個 seed 空時段班 + 新增的佔位班
      expect(withSessions.some((c) => c.baseName === '新開班-待排課')).toBe(false);
    });

    it('16. 往返保真：只有班名的列 classesToGridRows → gridRowsToClasses 仍回空 sessions', () => {
      const classes = gridRowsToClasses([ScheduleGridRowSchema.parse({ ...placeholderBase, weekday: '' })]);
      const flat = classesToGridRows(classes);
      expect(flat).toHaveLength(1);
      expect(flat[0].className).toBe('新開班-待排課');
      expect(flat[0].startMinutes).toBeNull();
      const roundTrip = gridRowsToClasses(flat);
      expect(roundTrip[0].sessions).toEqual([]);
    });
  });
});
