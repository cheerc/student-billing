import { describe, it, expect } from 'vitest';
import { compare, routeRateField, LEGACY_PRE_ISSUE122_CONTEXT } from '../../scripts/compare-session-pricing-report.mjs';
import { compare as compareBilling } from '../../scripts/compare-billing-report.mjs';

/**
 * issue #122 消費端（按堂計價工具）：工具必須走 v3 run 的類別快照，
 * 不得再以「當前班名」重新推導（CLAUDE.md §9.0 複寫禁令、03 §5.3.4）。
 *
 * 這份測試的存在理由（reviewer 的實測）：改動前 `compare()` 只有
 * (reportStudents, webStudents, asOfDate, amountLookup) 四個參數，
 * **沒有任何參數路徑能把快照傳進去**，因此「把工具改回讀 applicable*Bps」
 * 不會讓任何一條測試轉紅。故本檔一律**真的把快照傳進 `compare()`**，
 * 不斷言 routeRateField 的空殼行為。
 *
 * 預期值依產品規格手算（02 §8 R13／R14），不以工具輸出反推。
 */

/** 一個學生層四個適用率互異的學生，否則「取到哪一側」無從判別。 */
const STUDENT = {
  personCode: 'S001',
  name: '測試生',
  grade: 4,
  gradeRaw: '4年級',
  baseDiscountBps: 10000,
  enrollments: [
    {
      rawToken: '兒童美語-Dommie[團]',
      baseName: '兒童美語-Dommie',
      erpBillingTier: null,
      withdrawalDate: null,
    },
  ],
  trace: { rawTags: '' },
  // 兒童美語側 8000（8 折）、數學側 8500、安親 9500、課輔 9000
  applicableEnglishBps: 8000,
  applicableMathBps: 8500,
  applicableAnqinBps: 9500,
  applicableTutoringBps: 9000,
};

/** 報表端：一筆兒童美語學費列，折扣寫成 8 折（＝快照/映射都應相符）。 */
function reportEntry({ rateDetail = '課程費 8折' } = {}) {
  return new Map([
    [
      '測試生',
      {
        name: '測試生',
        tuitionRows: ['兒童美語-Dommie[團] - 16 堂課'],
        discounts: [`兒童美語-Dommie[團] - ${rateDetail}`],
        otherDiscounts: [],
        other: [],
        billNo: 'B001',
        billDate: '2026-10-01',
        billStatus: '已開立',
      },
    ],
  ]);
}

const V3_CONTEXT = (snapshots: Array<{ base_name: string; category: string; fixed_five_days: number }>) => ({
  isV3Run: true,
  classCategories: snapshots,
});

describe('issue #122：按堂計價工具走 v3 類別快照', () => {
  it('(a) category 被手動覆寫為 care：走快照的 care 分支，結果不等於 applicableEnglishBps', () => {
    // 名冊班名「兒童美語-Dommie」的當前名稱映射是 english（→ 8000）；
    // 快照說這班手動覆寫成 care，四年級 → 課輔側 9000。
    const snapshots = [{ base_name: '兒童美語-Dommie', category: 'care', fixed_five_days: 0 }];
    const { records } = compare(reportEntry(), [STUDENT], '2026-10-01', undefined, V3_CONTEXT(snapshots));

    const web = records[0].web;
    expect(web.rateCategory, '快照說 care，不可自作主張走美語分支').toBe('care');
    expect(web.rateBps).toBe(9000);
    expect(web.rateBps, '若退回當前班名會得到 applicableEnglishBps 8000').not.toBe(8000);
  });

  it('(b) fixed_five_days = 1 的班：讀到 10000（無折扣），且形狀為數字而非布林', () => {
    // 手動把一個美語班設為固定 5 天 → 03 §5.3.4 Q7-A：本班適用折扣 100% 而非「未設定」。
    // 報表這一班仍開了 8 折 → 系統（快照：100%）與報表（8 折）確實不一致，
    // 報告必須照實標為差異（D17），不可因為「快照說 100%」就把報表讀值吞掉。
    const snapshots = [{ base_name: '兒童美語-Dommie', category: 'english', fixed_five_days: 1 }];
    const { records } = compare(reportEntry(), [STUDENT], '2026-10-01', undefined, V3_CONTEXT(snapshots));

    // 兩項一起斷言：若 fixed_five_days 被寫成布林 true，`true === 1` 不成立，
    // 會落到 english 分支拿到 8000，於是這兩條會同時翻紅——單看其中一條都可能漏。
    expect(records[0].web.rateBps).toBe(10000);
    expect(records[0].statusCategory).toBe('DISCOUNT_DIFF');
  });

  it('(c) v3 但缺該班快照：標為無法判定（顯眼），不落回「無折扣」也不靜默略過', () => {
    // 快照存在但沒有這一班 → 03 §5.3.4：嚴禁以當前班名猜測。
    const snapshots = [{ base_name: '別的班', category: 'english', fixed_five_days: 0 }];
    const { records } = compare(reportEntry(), [STUDENT], '2026-10-01', undefined, V3_CONTEXT(snapshots));

    expect(records).toHaveLength(1); // 不得靜默略過該筆
    expect(records[0].statusCategory).not.toBe('MATCH');
    expect(records[0].statusCategory).toBe('WEB_RATE_NOT_CONFIGURED');
    expect(records[0].web.rateBps).toBeNull();
    expect(records[0].note.notes.join('')).toContain('快照');
  });

  it('(d) 未覆寫時與畫面既有行為一致：快照 english 且 fixed_five_days=0 → applicableEnglishBps', () => {
    const snapshots = [{ base_name: '兒童美語-Dommie', category: 'english', fixed_five_days: 0 }];
    const { records } = compare(reportEntry(), [STUDENT], '2026-10-01', undefined, V3_CONTEXT(snapshots));

    expect(records[0].web.rateBps).toBe(8000);
    expect(records[0].statusCategory).toBe('MATCH');
  });

  it('v1／v2 run（無快照概念）：維持當前班名映射，語意不變', () => {
    const { records } = compare(reportEntry(), [STUDENT], '2026-10-01');

    expect(records[0].web.rateBps).toBe(8000);
    expect(records[0].statusCategory).toBe('MATCH');
  });

  it('v3 但該 run 零快照列：同樣不得退回名稱映射', () => {
    const { records } = compare(reportEntry(), [STUDENT], '2026-10-01', undefined, V3_CONTEXT([]));

    expect(records[0].statusCategory).toBe('WEB_RATE_NOT_CONFIGURED');
    expect(records[0].web.rateBps).toBeNull();
  });

  it('routeRateField 保留為名稱映射的薄轉接（v1／v2 用），不作為 v3 的判定入口', () => {
    expect(routeRateField('兒童美語-Dommie', STUDENT)).toEqual({
      category: 'english',
      field: 'applicableEnglishBps',
      bps: 8000,
    });
  });

  it('LEGACY_PRE_ISSUE122_CONTEXT 顯式代表「未接快照」，讓未改的呼叫端看得見', () => {
    expect(LEGACY_PRE_ISSUE122_CONTEXT.isV3Run).toBe(false);
  });
});

describe('issue #122：國小輔導工具（billing:compare）的 v3 快照路徑', () => {
  /** 報表端：一筆國小輔導三年級學費列。 */
  const careReport = () =>
    new Map([
      [
        '測試生',
        {
          name: '測試生',
          tuition: '115國小輔導-三年級[團][4] - 40 堂課',
          discounts: ['115國小輔導-三年級[團] - 課程費 9折'],
          otherDiscounts: [],
          other: [],
          billNo: 'B003',
          billDate: '2026-10-01',
          billStatus: '已開立',
        },
      ],
    ]);

  /** 三年級（課輔側）、名冊有輔導班報名。 */
  const careStudent = {
    personCode: 'S010',
    name: '測試生',
    grade: 3,
    gradeRaw: '3年級',
    enrollments: [{ rawToken: '國小輔導-三年級[團][4]', baseName: '國小輔導-三年級', erpBillingTier: 4 }],
    tutoringDays: 4,
    tutoringDisplay: '4',
    anqinDays: 0,
    anqinDisplay: '0',
    applicableAnqinBps: 9500,
    applicableTutoringBps: 8888, // 刻意非 10000：漏走快照時會拿到這一側
    applicableMathBps: 8500,
    applicableEnglishBps: 8000,
    baseDiscountBps: 10000,
    subjectCount: 1,
    trace: { rawTags: '' },
    tierComparisons: [],
    issues: [],
  };

  it('快照 fixed_five_days = 1 的輔導班 → 10000，不退回課輔側 8888', () => {
    const snapshots = [{ base_name: '國小輔導-三年級', category: 'care', fixed_five_days: 1 }];
    const { records } = compareBilling(careReport(), [careStudent], '2026-10-01', { isV3Run: true, classCategories: snapshots });

    expect(records[0]!.web!.rateBps).toBe(10000);
    expect(records[0]!.web!.rateBps).not.toBe(8888);
  });

  it('快照 category 被覆寫為 none（且無固定 5 天）→ 無法判定，標為需人工判讀', () => {
    const snapshots = [{ base_name: '國小輔導-三年級', category: 'none', fixed_five_days: 0 }];
    const { records } = compareBilling(careReport(), [careStudent], '2026-10-01', { isV3Run: true, classCategories: snapshots });

    expect(records[0]!.statusCategory).toBe('WEB_RATE_NOT_CONFIGURED');
    expect(records[0]!.web!.rateBps).toBeNull();
    expect(records[0]!.note.notes.join('')).toContain('快照');
  });

  it('v3 但缺該班快照 → 同樣無法判定，嚴禁以年級猜測安親／課輔側', () => {
    const snapshots = [{ base_name: '別的班', category: 'care', fixed_five_days: 0 }];
    const { records } = compareBilling(careReport(), [careStudent], '2026-10-01', { isV3Run: true, classCategories: snapshots });

    expect(records[0]!.statusCategory).toBe('WEB_RATE_NOT_CONFIGURED');
    expect(records[0]!.web!.rateBps).not.toBe(8888);
  });

  it('快照 category = care 且無固定 5 天 → 三年級取課輔側 8888（與畫面同源）', () => {
    const snapshots = [{ base_name: '國小輔導-三年級', category: 'care', fixed_five_days: 0 }];
    const { records } = compareBilling(careReport(), [careStudent], '2026-10-01', { isV3Run: true, classCategories: snapshots });

    expect(records[0]!.web!.rateBps).toBe(8888);
  });

  it('v1／v2（不傳 context）：維持舊行為，且不因名冊無輔導班而變成無法判定', () => {
    const noCareEnrollment = { ...careStudent, enrollments: [] };
    const { records } = compareBilling(careReport(), [noCareEnrollment], '2026-10-01');

    // 舊行為在此仍顯示 8888；若改走 applicableRateForClass 的空班名會變成無法判定，
    // 那是未經裁決的行為變更，故 v1／v2 必須逐字維持原欄位選擇。
    expect(records[0]!.web!.rateBps).toBe(8888);
    expect(records[0]!.statusCategory).not.toBe('WEB_RATE_NOT_CONFIGURED');
  });
});

describe('issue #122：國小輔導工具既有簽章不變', () => {
  it('compare() 既有簽章（3 參數）仍可用', () => {
    const report = new Map([
      [
        '測試生',
        {
          name: '測試生',
          tuition: '115國小輔導-四年級[團][4] - 40 堂課',
          discounts: ['115國小輔導-四年級[團] - 課程費 9折'],
          otherDiscounts: [],
          other: [],
          billNo: 'B002',
          billDate: '2026-10-01',
          billStatus: '已開立',
        },
      ],
    ]);
    const student = {
      ...STUDENT,
      grade: 4,
      tutoringDays: 4,
      tutoringDisplay: '4',
      anqinDays: 0,
      anqinDisplay: '0',
    };
    const { records } = compareBilling(report, [student], '2026-10-01');
    // 四年級 → 課輔側 9000（9 折）
    expect(records[0]!.web!.rateBps).toBe(9000);
  });
});
