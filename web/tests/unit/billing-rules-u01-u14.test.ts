import { describe, it, expect } from 'vitest';
import {
  calculateOverlapMinutes,
  calculateSessionDeduction,
  calculateClassDeductionD24,
  calculateClassDeductionCompat,
  CARE_WINDOWS,
} from '@/domain/schedules/overlap-calculator';

describe('U01–U14: 時段重疊、單堂扣天與取整規則測試', () => {
  it('U01: 13:00–14:00 對安親 13:00–16:00 → 60 分鐘；raw -1/3', () => {
    // 13:00 = 780, 14:00 = 840
    const overlap = calculateOverlapMinutes(780, 840, CARE_WINDOWS.anqin.start, CARE_WINDOWS.anqin.end);
    expect(overlap).toBe(60);

    const deduction = calculateSessionDeduction(780, 840, 'anqin');
    expect(deduction.overlapMinutes).toBe(60);
    expect(deduction.rawDeduction).toBeCloseTo(-1 / 3, 6);
  });

  it('U02: 12:00–13:00、16:00–17:00 對安親 → 皆重疊 0', () => {
    const o1 = calculateOverlapMinutes(720, 780, CARE_WINDOWS.anqin.start, CARE_WINDOWS.anqin.end);
    const o2 = calculateOverlapMinutes(960, 1020, CARE_WINDOWS.anqin.start, CARE_WINDOWS.anqin.end);
    expect(o1).toBe(0);
    expect(o2).toBe(0);
  });

  it('U03: 12:00–17:00 對安親 → 180 分鐘而非 300', () => {
    const o = calculateOverlapMinutes(720, 1020, CARE_WINDOWS.anqin.start, CARE_WINDOWS.anqin.end);
    expect(o).toBe(180);
  });

  it('U04: 課輔 start=16:30, end=18:30 → 重疊 120，但不觸發嚴格大於 18:30，raw = -2/3', () => {
    // 16:30 = 990, 18:30 = 1110
    const ded = calculateSessionDeduction(990, 1110, 'tutoring');
    expect(ded.overlapMinutes).toBe(120);
    expect(ded.isSpecialTutoringRule).toBe(false);
    expect(ded.rawDeduction).toBeCloseTo(-120 / 180, 6); // -2/3
  });

  it('U05: 課輔 16:30–18:31 → 121 分鐘，特殊課輔 raw = -1', () => {
    // 18:31 = 1111 (大於 18:30 且小於 19:30 且 >= 120)
    const ded = calculateSessionDeduction(990, 1111, 'tutoring');
    expect(ded.overlapMinutes).toBe(121);
    expect(ded.isSpecialTutoringRule).toBe(true);
    expect(ded.rawDeduction).toBe(-1);
  });

  it('U06 (原生 Excel 錨點): 17:00–19:00 → 正式與 compat 皆為 -1，絕不產生 NUMERIC_POLICY_DIFFERENCE', () => {
    // 17:00 = 1020, 19:00 = 1140. 重疊 120，end 在 18:30 與 19:30 之間
    const dedD24 = calculateClassDeductionD24([{ start: 1020, end: 1140 }], 'tutoring');
    const dedCompat = calculateClassDeductionCompat([{ start: 1020, end: 1140 }], 'tutoring');

    expect(dedD24.raw).toBe(-1);
    expect(dedD24.rounded).toBe(-1);

    expect(dedCompat.raw).toBe(-1);
    expect(dedCompat.rounded).toBe(-1);

    // 兩者一致，不產生差異
    expect(dedD24.rounded).toBe(dedCompat.rounded);
  });

  it('U07: 17:31–19:30 → 119 分鐘，end 不小於 19:30，raw = -119/180', () => {
    // 17:31 = 1051, 19:30 = 1170. end = 19:30 不符合 end < 19:30 嚴格小於
    const ded = calculateSessionDeduction(1051, 1170, 'tutoring');
    expect(ded.overlapMinutes).toBe(119);
    expect(ded.isSpecialTutoringRule).toBe(false);
    expect(ded.rawDeduction).toBeCloseTo(-119 / 180, 6);
  });

  it('U08: start=17:00，end=19:29 / 19:30 / 19:31', () => {
    // 19:29 (1169): end < 19:30 且 >= 120 -> raw = -1
    const d1 = calculateSessionDeduction(1020, 1169, 'tutoring');
    expect(d1.rawDeduction).toBe(-1);

    // 19:30 (1170): end 未小於 19:30 -> raw = -150/180
    const d2 = calculateSessionDeduction(1020, 1170, 'tutoring');
    expect(d2.rawDeduction).toBeCloseTo(-150 / 180, 6);

    // 19:31 (1171): raw = -150/180
    const d3 = calculateSessionDeduction(1020, 1171, 'tutoring');
    expect(d3.rawDeduction).toBeCloseTo(-150 / 180, 6);
  });

  it('U09: R03 扣天量取整對照 (erp-tag-v1 vs compat)', () => {
    const testCases: [number, number, number][] = [
      // [d, expectedD24, expectedCompat]
      [0, 0, 0],
      [1 / 6, 0, 0],
      [1 / 3, -0.5, -0.5],
      [2 / 3, -0.5, -0.5],
      [0.75, -0.5, -1],
      [1, -1, -1],
      [1.25, -1, -1.5],
      [2 / 9, 0, -0.5],
    ];

    for (const [d, expD24, expCompat] of testCases) {
      let sessions: { start: number; end: number }[];
      if (d <= 1) {
        const minutes = Math.round(d * 180);
        sessions = [{ start: 780, end: 780 + minutes }];
      } else {
        // d > 1: 分成兩堂以避免單堂超過窗口
        sessions = [
          { start: 780, end: 960 }, // 180 分鐘 = 1 天
          { start: 780, end: 780 + Math.round((d - 1) * 180) },
        ];
      }

      const resD24 = calculateClassDeductionD24(sessions, 'anqin');
      const resCompat = calculateClassDeductionCompat(sessions, 'anqin');

      expect(resD24.rounded).toBe(expD24);
      expect(resCompat.rounded).toBe(expCompat);
    }
  });

  it('U10: erp-tag-v1 門檻小數 f=0.3, 0.5, 0.8 與前後一分鐘邊界', () => {
    // 0.3 天 = 54 分鐘
    // 53 分鐘: 53/180 ≈ 0.2944 < 0.3 -> 0
    const r53 = calculateClassDeductionD24([{ start: 780, end: 780 + 53 }], 'anqin');
    expect(r53.rounded).toBe(0);

    // 54 分鐘: 54/180 = 0.3000 -> -0.5
    const r54 = calculateClassDeductionD24([{ start: 780, end: 780 + 54 }], 'anqin');
    expect(r54.rounded).toBe(-0.5);

    // 0.5 天 = 90 分鐘 -> -0.5
    const r90 = calculateClassDeductionD24([{ start: 780, end: 780 + 90 }], 'anqin');
    expect(r90.rounded).toBe(-0.5);

    // 0.8 天 = 144 分鐘
    // 143 分鐘: 143/180 ≈ 0.7944 < 0.8 -> -0.5
    const r143 = calculateClassDeductionD24([{ start: 780, end: 780 + 143 }], 'anqin');
    expect(r143.rounded).toBe(-0.5);

    // 144 分鐘: 144/180 = 0.8000 -> -1
    const r144 = calculateClassDeductionD24([{ start: 780, end: 780 + 144 }], 'anqin');
    expect(r144.rounded).toBe(-1);
  });

  it('U11: Gino 實例: 安親 110 分鐘 → -0.5，課輔 70 分鐘 → -0.5', () => {
    // 一 15:20–16:50 (920–1010)
    // 三 15:30–17:00 (930–1020)
    // 五 15:20–16:50 (920–1010)
    const sessions = [
      { start: 920, end: 1010 },
      { start: 930, end: 1020 },
      { start: 920, end: 1010 },
    ];

    const anqin = calculateClassDeductionD24(sessions, 'anqin');
    expect(anqin.totalOverlapMinutes).toBe(110);
    expect(anqin.rounded).toBe(-0.5);

    const tutoring = calculateClassDeductionD24(sessions, 'tutoring');
    expect(tutoring.totalOverlapMinutes).toBe(70);
    expect(tutoring.rounded).toBe(-0.5);
  });

  it('U12: 同班兩筆各 30 分鐘 (-1/6) 先合計 -1/3 再取整為 -0.5，不能逐堂取整為 0', () => {
    const sessions = [
      { start: 780, end: 810 }, // 30 分鐘
      { start: 810, end: 840 }, // 30 分鐘
    ];
    const res = calculateClassDeductionD24(sessions, 'anqin');
    expect(res.totalOverlapMinutes).toBe(60);
    expect(res.raw).toBeCloseTo(-1 / 3, 6);
    expect(res.rounded).toBe(-0.5);
  });

  it('U13: 同日兩堂重疊／週六一堂 (erp-tag-v1 照每列相加不做星期排除；erp-tag-v2 週六重疊為 0)', () => {
    // 1. 同日兩堂時間重疊照每列相加，不做 union 去重 (週一 13:00–14:30 與 14:00–15:30 各 90 分鐘，共 180 分鐘)
    const sameDaySessions = [
      { start: 780, end: 870, weekday: '一' }, // 90 分鐘
      { start: 840, end: 930, weekday: '一' }, // 90 分鐘
    ];
    const resSameDay = calculateClassDeductionD24(sameDaySessions, 'anqin', { sameWeekdayOnly: true });
    expect(resSameDay.totalOverlapMinutes).toBe(180);
    expect(resSameDay.rounded).toBe(-1);

    // 2. 週六一堂 13:00–15:00 (120 分鐘)
    // 舊版 erp-tag-v1: sameWeekdayOnly=false，按時刻重疊算 120 分鐘 -> -0.5
    const resV1 = calculateClassDeductionD24([{ start: 780, end: 900, weekday: '六' }], 'anqin', { sameWeekdayOnly: false });
    expect(resV1.totalOverlapMinutes).toBe(120);
    expect(resV1.rounded).toBe(-0.5);

    // 新版 erp-tag-v2 (D30): sameWeekdayOnly=true，週六對一～五窗口重疊為 0 -> 0 天
    const resV2 = calculateClassDeductionD24([{ start: 780, end: 900, weekday: '六' }], 'anqin', { sameWeekdayOnly: true });
    expect(resV2.totalOverlapMinutes).toBe(0);
    expect(resV2.rounded).toBe(0);
  });

  it('DIFF-01 (原生 Excel 錨點): 同班兩堂各 18 分鐘加總 → 正式 0 天，Excel compat -0.5 天', () => {
    // 兩堂各 13:00–13:18 (780–798)
    const sessions = [
      { start: 780, end: 798 },
      { start: 780, end: 798 },
    ];

    const formal = calculateClassDeductionD24(sessions, 'anqin');
    const compat = calculateClassDeductionCompat(sessions, 'anqin');

    // 精確分鐘合計 36 分鐘，d = 0.2 < 0.3 -> 取整 0
    expect(formal.rounded).toBe(0);

    // 原生 Excel 浮點累積誤差 -> 取整 -0.5
    expect(compat.rounded).toBe(-0.5);

    // 兩者分歧，觸發 DIFF-01
    expect(formal.rounded).not.toBe(compat.rounded);
  });

  it('U14: 更改安親時間窗除數仍為 180 分鐘', () => {
    const res = calculateClassDeductionD24(
      [{ start: 780, end: 840 }],
      'anqin',
      { minutesPerBillingDay: 180, anqinWindow: { start: 720, end: 960 } } // 4 小時窗口
    );
    expect(res.raw).toBeCloseTo(-60 / 180, 6);
  });
});
