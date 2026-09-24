import { describe, it, expect } from 'vitest';
import {
  calculateOverlapMinutes,
  calculateSessionDeduction,
  calculateClassDeductionD24,
  CARE_WINDOWS,
  CARE_WINDOW_WEEKDAYS,
  normalizeWeekday,
} from '@/domain/schedules/overlap-calculator';
import {
  calculateStudentBilling,
  RuleSetVersion,
} from '@/domain/billing/billing-calculator';
import { StudentSnapshot } from '@/domain/students';
import seedData from '@/domain/schedules/schedule-seed.json';

describe('D30 / R01: 衝堂計算改為同星期才算（新 ruleSet 版本 erp-tag-v2）', () => {
  describe('1. calculateOverlapMinutes 星期比對邏輯 (RED)', () => {
    it('同星期照算重疊分鐘數 (週一 13:00–14:00 對 一~五 安親 13:00–16:00 → 60 分鐘)', () => {
      const overlap = calculateOverlapMinutes(
        780,
        840,
        CARE_WINDOWS.anqin.start,
        CARE_WINDOWS.anqin.end,
        '一',
        CARE_WINDOW_WEEKDAYS
      );
      expect(overlap).toBe(60);
    });

    it('跨星期重疊為 0 (週六 13:00–15:00 對 一~五 安親 13:00–16:00 → 0 分鐘)', () => {
      const overlap = calculateOverlapMinutes(
        780,
        900,
        CARE_WINDOWS.anqin.start,
        CARE_WINDOWS.anqin.end,
        '六',
        CARE_WINDOW_WEEKDAYS
      );
      expect(overlap).toBe(0);
    });

    it('星期日對 一~五 安親窗口 → 0 分鐘', () => {
      const overlap = calculateOverlapMinutes(
        780,
        900,
        CARE_WINDOWS.anqin.start,
        CARE_WINDOWS.anqin.end,
        '日',
        CARE_WINDOW_WEEKDAYS
      );
      expect(overlap).toBe(0);
    });

    it('首尾相接保持為 0 (週一 12:00–13:00 對 一~五 安親 13:00–16:00 → 0 分鐘)', () => {
      const overlap = calculateOverlapMinutes(
        720,
        780,
        CARE_WINDOWS.anqin.start,
        CARE_WINDOWS.anqin.end,
        '一',
        CARE_WINDOW_WEEKDAYS
      );
      expect(overlap).toBe(0);
    });

    it('單日指定窗口比對 (session 週二 vs window [二] → 照算; vs window [三] → 0)', () => {
      const match = calculateOverlapMinutes(780, 840, 780, 960, '二', ['二']);
      expect(match).toBe(60);

      const mismatch = calculateOverlapMinutes(780, 840, 780, 960, '一', ['二']);
      expect(mismatch).toBe(0);
    });

    it('未提供星期參數時保持舊行為 (純時刻比對，相容舊呼叫)', () => {
      const overlap = calculateOverlapMinutes(780, 900, 780, 960);
      expect(overlap).toBe(120);
    });

    it('normalizeWeekday 能正確識別各種合法星期格式', () => {
      expect(normalizeWeekday('一')).toBe('一');
      expect(normalizeWeekday('週一')).toBe('一');
      expect(normalizeWeekday('星期一')).toBe('一');
      expect(normalizeWeekday('1')).toBe('一');

      expect(normalizeWeekday('六')).toBe('六');
      expect(normalizeWeekday('週六')).toBe('六');
      expect(normalizeWeekday('星期六')).toBe('六');
      expect(normalizeWeekday('6')).toBe('六');

      expect(normalizeWeekday('日')).toBe('日');
      expect(normalizeWeekday('7')).toBe('日');

      expect(normalizeWeekday(null)).toBeNull();
      expect(normalizeWeekday('')).toBeNull();
      expect(normalizeWeekday('未知')).toBeNull();
    });
  });

  describe('2. calculateClassDeductionD24 扣天計算與版本差異 (RED)', () => {
    it('週六單堂 13:00–15:00: erp-tag-v1 扣 -0.5，erp-tag-v2 (sameWeekdayOnly: true) 為 0', () => {
      const sessions = [{ start: 780, end: 900, weekday: '六' }];

      // 舊版本 erp-tag-v1: sameWeekdayOnly = false
      const v1 = calculateClassDeductionD24(sessions, 'anqin', { sameWeekdayOnly: false });
      expect(v1.totalOverlapMinutes).toBe(120);
      expect(v1.raw).toBeCloseTo(-120 / 180, 6);
      expect(v1.rounded).toBe(-0.5);

      // 新版本 erp-tag-v2: sameWeekdayOnly = true
      const v2 = calculateClassDeductionD24(sessions, 'anqin', { sameWeekdayOnly: true });
      expect(v2.totalOverlapMinutes).toBe(0);
      expect(v2.raw).toBe(0);
      expect(v2.rounded).toBe(0);
    });

    it('同班混合時段 (週四 15:00–16:30 + 週六 13:00–15:00): v1 扣 -1，v2 僅計入週四扣 -0.5', () => {
      const sessions = [
        { start: 900, end: 990, weekday: '四' }, // 安親重疊 60 分鐘
        { start: 780, end: 900, weekday: '六' }, // 週六 120 分鐘
      ];

      // v1: 60 + 120 = 180 分鐘 (1 天) -> rounded = -1
      const v1 = calculateClassDeductionD24(sessions, 'anqin', { sameWeekdayOnly: false });
      expect(v1.totalOverlapMinutes).toBe(180);
      expect(v1.rounded).toBe(-1);

      // v2: 60 + 0 = 60 分鐘 (1/3 天) -> rounded = -0.5
      const v2 = calculateClassDeductionD24(sessions, 'anqin', { sameWeekdayOnly: true });
      expect(v2.totalOverlapMinutes).toBe(60);
      expect(v2.rounded).toBe(-0.5);
    });

    it('U11: Gino 三時段 (一/三/五 均為平日): v1 與 v2 計算結果位元相同', () => {
      const sessions = [
        { start: 920, end: 1010, weekday: '一' },
        { start: 930, end: 1020, weekday: '三' },
        { start: 920, end: 1010, weekday: '五' },
      ];

      const v1Anqin = calculateClassDeductionD24(sessions, 'anqin', { sameWeekdayOnly: false });
      const v2Anqin = calculateClassDeductionD24(sessions, 'anqin', { sameWeekdayOnly: true });
      expect(v1Anqin.totalOverlapMinutes).toBe(110);
      expect(v2Anqin.totalOverlapMinutes).toBe(110);
      expect(v1Anqin.rounded).toBe(-0.5);
      expect(v2Anqin.rounded).toBe(-0.5);

      const v1Tutoring = calculateClassDeductionD24(sessions, 'tutoring', { sameWeekdayOnly: false });
      const v2Tutoring = calculateClassDeductionD24(sessions, 'tutoring', { sameWeekdayOnly: true });
      expect(v1Tutoring.totalOverlapMinutes).toBe(70);
      expect(v2Tutoring.totalOverlapMinutes).toBe(70);
      expect(v1Tutoring.rounded).toBe(-0.5);
      expect(v2Tutoring.rounded).toBe(-0.5);
    });

    it('排課種子中的 4 個週六班級：在 v1 與 v2 下的安親衝堂對照', () => {
      const saturdayClasses = [
        '小六加強班-自然',
        '小六加強班-國文',
        '國小國語文-小三小四',
        '國小國語文-小五',
      ];

      for (const name of saturdayClasses) {
        const cls = seedData.classes.find((c) => c.baseName === name)!;
        expect(cls).toBeDefined();

        const sessions = cls.sessions
          .filter((s: any) => s.startMinutes !== null && s.endMinutes !== null)
          .map((s: any) => ({
            start: s.startMinutes,
            end: s.endMinutes,
            weekday: s.weekday,
          }));

        // v1: 舊規則照算時刻重疊 -> 皆為 -0.5
        const v1 = calculateClassDeductionD24(sessions, 'anqin', { sameWeekdayOnly: false });
        expect(v1.totalOverlapMinutes).toBeGreaterThan(0);
        expect(v1.rounded).toBe(-0.5);

        // v2: 新規則排除週六 -> 皆為 0
        const v2 = calculateClassDeductionD24(sessions, 'anqin', { sameWeekdayOnly: true });
        expect(v2.totalOverlapMinutes).toBe(0);
        expect(v2.rounded).toBe(0);
      }
    });
  });

  describe('3. calculateStudentBilling ruleSetVersion 契約與舊 run 不可變 (RED)', () => {
    const mockStudent: StudentSnapshot = {
      personCode: 'TEST001',
      name: '測試生',
      branch: '本校',
      gradeRaw: '小一',
      grade: 1,
      gradeStatus: 'valid',
      contact: '0900000000',
      schoolInfo: null,
      tagsRaw: '',
      tags: [],
      notesRaw: '',
      enrollments: [
        {
          rawToken: '國小輔導-一[團]',
          yearPrefix: null,
          baseName: '國小輔導-一',
          groupFlag: '團',
          modifiers: [],
          withdrawalDate: null,
          erpBillingTierRaw: null,
          erpBillingTier: 5,
          tierParseStatus: 'defaulted',
          parseStatus: 'ok',
        },
        {
          rawToken: '國小數學-特設班[團]',
          yearPrefix: null,
          baseName: '國小數學-特設班',
          groupFlag: '團',
          modifiers: [],
          withdrawalDate: null,
          erpBillingTierRaw: null,
          erpBillingTier: null,
          tierParseStatus: 'not_applicable',
          parseStatus: 'ok',
        },
      ],
      sourceRow: 10,
    };

    // 特設數學班排在週六下午 13:00–15:00 (120 分鐘)
    const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
      ['國小數學-特設班', [{ start: 780, end: 900, weekday: '六' }]],
    ]);

    it('舊版本 erp-tag-v1: 週六時段照算扣天 (安親自 5 天扣 0.5 天變為 4.5 天)', () => {
      const resV1 = calculateStudentBilling(mockStudent, {
        ruleSetVersion: 'erp-tag-v1',
        scheduleOverride: scheduleOverride as any,
      });

      // 120 分鐘 -> raw -2/3 -> rounded -0.5 -> 5 - 0.5 = 4.5
      expect(resV1.careDays.anqin.days).toBe(4.5);
    });

    it('新版本 erp-tag-v2: 同星期才算衝堂，週六時段不計入安親窗口 (安親維持 5 天)', () => {
      const resV2 = calculateStudentBilling(mockStudent, {
        ruleSetVersion: 'erp-tag-v2',
        scheduleOverride: scheduleOverride as any,
      });

      // 週六重疊為 0 -> 不扣天 -> 維持 5 天
      expect(resV2.careDays.anqin.days).toBe(5);
    });

    it('預設 ruleSetVersion 應為 erp-tag-v2 (未帶參數時套用新正式規則)', () => {
      const resDefault = calculateStudentBilling(mockStudent, {
        scheduleOverride: scheduleOverride as any,
      });

      expect(resDefault.careDays.anqin.days).toBe(5);
    });
  });
});
