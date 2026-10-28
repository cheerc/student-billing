/**
 * D61 Phase 1（issue #184；specs/16 §3 Phase 1、§4.1）：五種課程類型、2×2 計費解耦、`其他班` 所見即所得扣天。
 *
 * ── expected 全部獨立手算（不用被測函式輸出當黃金標準；CLAUDE.md §8）──
 *  - 窗口：安親 13:00–16:00＝780–960；課輔 16:30–19:30＝990–1170；每日 180 分。年級 4 ＝ 課輔側。
 *  - 週三 17:00–19:00＝1020–1140：與課輔窗重疊 120 分，且 end 1140 ∈ (1110, 1170) → 課輔特例 raw = −1 → 扣 1 天
 *    （注意：plan §4.1 寫「150 分鐘」，實際 17:00–19:00 只有 120 分；同為 −1，結論不變）。
 *  - 週四 17:30–19:00 以外的對照：週四 17:30–18:30＝1050–1110：重疊 60 分、end 1110 不 > 1110 → 無特例，
 *    raw = −60/180 = −0.333；D24 frac 0.333 ∈ [0.3,0.8) → 扣 0.5 天。
 *  - 課輔天數 ＝ max(3, 5 + Σ各類扣天)。R10：effectiveCount＝科數；1 科→10000、2 科→9500、3 科→9000。
 *
 * ── baseline 特徵化（operator 決策 d-20260930131128030911-29 A 授權的狹義例外）──
 *  「seed 49 班零漂移」的 expected 取自**不可變 pre-change baseline `12206ac`** 在 seed 設定上對同一批合成學生的輸出，
 *  只用來鎖定「重構前後業務欄位未發生非預期改變」，**不是**算法正確性 oracle，且不得從新 HEAD 更新。
 *  其餘（2×2、其他班、契約）皆由規格獨立手算。
 */
import { describe, it, expect } from 'vitest';
import * as settingsContract from '@/contracts/settings';
import {
  ClassSettingSchema,
  SettingsDraftSchema,
  classesToGridRows,
  gridRowsToClasses,
  type ScheduleGridRow,
} from '@/contracts/settings';
import * as classCategory from '@/domain/classification/class-category';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { calculateCareDays } from '@/domain/billing/care-days';
import { buildSeedDraft, draftToAliasMap, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { buildClassSettingMap } from '@/application/calculate-run';
import type { StudentSnapshot } from '@/domain/students/types';

function stu(grade: number, names: string[]): StudentSnapshot {
  return {
    personCode: 'P001',
    name: '合成學生',
    branch: null,
    grade,
    gradeRaw: String(grade),
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: names.map((b) => ({
      baseName: b,
      rawToken: b,
      yearPrefix: null,
      groupFlag: null,
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable' as const,
      parseStatus: 'ok' as const,
    })),
  };
}

/** 五類型班級設定（刻意不帶舊 category 欄位：五類型＋布林就是全部事實）。 */
const lookup = (classType: string, hasMultiSubjectDiscount?: boolean) =>
  ({ classType, ...(hasMultiSubjectDiscount === undefined ? {} : { hasMultiSubjectDiscount }) }) as never;

const WED_17_19 = { weekday: '三', start: 1020, end: 1140 };
const THU_1730_1830 = { weekday: '四', start: 1050, end: 1110 };

function sess(base: { weekday: string; start: number; end: number }, skipDeduction: boolean) {
  return [{ ...base, skipDeduction }];
}

function calc(
  grade: number,
  settings: Array<[string, unknown]>,
  overrides: Array<[string, ReturnType<typeof sess>]>
) {
  return calculateStudentBilling(
    stu(
      grade,
      settings.map(([n]) => n)
    ),
    {
      classSettings: new Map(settings) as never,
      scheduleOverride: new Map(overrides),
    }
  );
}

// ---------------------------------------------------------------------------
// 1. 契約：五種類型與輔助函式
// ---------------------------------------------------------------------------

describe('D61 契約：ClassTypeSchema 與輔助常數', () => {
  it('ClassTypeSchema 收五種類型、拒絕其他值', () => {
    for (const t of ['care', 'english', 'math', 'other', 'unscheduled']) {
      expect(settingsContract.ClassTypeSchema.safeParse(t).success, t).toBe(true);
    }
    expect(settingsContract.ClassTypeSchema.safeParse('bogus').success).toBe(false);
  });

  it('CLASS_TYPE_ORDER 固定為 安親課輔班／美語班／數學班／其他班／不排課', () => {
    const c = settingsContract as unknown as Record<string, unknown>;
    expect(c.CLASS_TYPE_ORDER).toEqual(['care', 'english', 'math', 'other', 'unscheduled']);
    expect(c.CLASS_TYPE_LABELS).toEqual({
      care: '安親課輔班',
      english: '美語班',
      math: '數學班',
      other: '其他班',
      unscheduled: '不排課',
    });
  });

  it('isSchedulableClassType／supportsMultiSubjectDiscount／defaultSkipDeductionForClassType 的真值表', () => {
    const c = settingsContract as unknown as Record<string, (t: string) => boolean>;
    const types = ['care', 'english', 'math', 'other', 'unscheduled'];
    expect(types.map((t) => c.isSchedulableClassType?.(t))).toEqual([false, true, true, true, false]);
    expect(types.map((t) => c.supportsMultiSubjectDiscount?.(t))).toEqual([true, true, true, false, false]);
    expect(types.map((t) => c.defaultSkipDeductionForClassType?.(t))).toEqual([false, false, false, true, false]);
  });

  it('ClassSettingSchema 的類型邊界：other／unscheduled 不得多科折扣、非 care 不得固定 5 天、care／unscheduled 不得有時段', () => {
    const base = { baseName: '測試班', teacher: null, active: true, sessions: [] as unknown[] };
    const ok = (o: Record<string, unknown>) => ClassSettingSchema.safeParse({ ...base, ...o }).success;
    const mon = { weekday: '一', startMinutes: 1080, endMinutes: 1170, skipDeduction: false };

    expect(ok({ classType: 'english', hasMultiSubjectDiscount: false }), 'english 可關閉多科折扣').toBe(true);
    expect(ok({ classType: 'other', hasMultiSubjectDiscount: true }), 'other 不得有多科折扣').toBe(false);
    expect(ok({ classType: 'unscheduled', hasMultiSubjectDiscount: true }), 'unscheduled 不得有多科折扣').toBe(false);
    expect(ok({ classType: 'english', fixedFiveDays: true }), '非 care 不得固定 5 天').toBe(false);
    expect(ok({ classType: 'care', fixedFiveDays: true }), 'care 可固定 5 天').toBe(true);
    expect(ok({ classType: 'care', sessions: [mon] }), 'care 不得有時段').toBe(false);
    expect(ok({ classType: 'unscheduled', sessions: [mon] }), 'unscheduled 不得有時段').toBe(false);
    expect(ok({ classType: 'math', sessions: [mon] }), 'math 可有時段').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Seed 49 班：分流與基準零漂移
// ---------------------------------------------------------------------------

describe('D61 Seed 49 班分流與基準零漂移', () => {
  const draft = buildSeedDraft();

  it('buildSeedDraft 產出 8 care／24 english／12 math／5 other，共 49 班', () => {
    const count = (t: string) => draft.classes.filter((c) => c.classType === t).length;
    expect(draft.classes).toHaveLength(49);
    expect([count('care'), count('english'), count('math'), count('other'), count('unscheduled')]).toEqual([8, 24, 12, 5, 0]);
  });

  it('前 44 班 hasMultiSubjectDiscount===true、5 門 other 為 false；other 的時段 skipDeduction===true', () => {
    for (const c of draft.classes) {
      const multi = (c as { hasMultiSubjectDiscount?: boolean }).hasMultiSubjectDiscount;
      if (c.classType === 'other') {
        expect(multi, c.baseName).toBe(false);
        expect(c.sessions.length, c.baseName).toBeGreaterThan(0);
        expect(c.sessions.every((s) => s.skipDeduction === true), c.baseName).toBe(true);
      } else {
        expect(multi, c.baseName).toBe(true);
      }
    }
    const others = draft.classes.filter((c) => c.classType === 'other').map((c) => c.baseName).sort();
    expect(others).toEqual(
      ['國小國語文-小三小四', '國小國語文-小五', '小六加強班-國文', '小六加強班-數學', '小六加強班-自然'].sort()
    );
  });

  /**
   * pre-change baseline `12206ac` 在 seed 設定上的輸出（見檔頭 provenance）。
   * 欄位：[年級, 報名班, 科數, 基本折扣bps, 安親天數, 課輔天數, 問題碼]
   */
  const BASELINE: Array<[number, string[], number, number, number | null, number | null, string[]]> = [
    [1, ['國小輔導-一A', '國小數學-一A', '兒童美語-Gino'], 3, 9000, 4, null, []],
    [4, ['國小輔導-四年級', '國小數學-四A', '兒童美語-Chevady'], 3, 9000, null, 3, []],
    [4, ['國小輔導-四年級', '小六加強班-數學', '國小國語文-小五'], 1, 10000, null, 5, []],
    [5, ['國小輔導-五年級', '兒童美語-Gino', '兒童美語-Chevady', '小六加強班-自然'], 2, 9500, null, 3, ['DUPLICATE_SUBJECT_ENROLLMENT']],
    [6, ['國小輔導-六年級', '小六加強班-國文', '小六加強班-數學', '國小國語文-小三小四'], 1, 10000, null, 5, []],
    [2, ['國小輔導-二A', '國小數學-二B', '兒童美語-Kirra'], 3, 9000, 4.5, null, []],
  ];

  it.each(BASELINE)('seed 設定下 年級%i %j 與 pre-change baseline 一致', (grade, names, subjects, base, anqin, tutoring, issues) => {
    const r = calculateStudentBilling(stu(grade, names), {
      aliasMap: draftToAliasMap(draft),
      scheduleOverride: draftToScheduleOverride(draft),
      classSettings: buildClassSettingMap(draft),
    });
    expect(r.subjectCount).toBe(subjects);
    expect(r.baseDiscountBps).toBe(base);
    expect(r.careDays.anqin.days).toBe(anqin);
    expect(r.careDays.tutoring.days).toBe(tutoring);
    expect(r.issues.map((i) => i.code)).toEqual(issues);
  });
});

// ---------------------------------------------------------------------------
// 3. 美語／數學 2×2 解耦
// ---------------------------------------------------------------------------

describe('D61 2×2 解耦：是否有多科折扣 × 不計扣天', () => {
  const care = ['國小輔導-四年級', lookup('care', true)] as [string, unknown];

  it('數學班 多科折扣=否、不計扣天=否：科數 1（不計入）但衝堂扣天照扣 → 課輔 4 天', () => {
    const r = calc(4, [care, ['國小數學-特訓', lookup('math', false)]], [['國小數學-特訓', sess(WED_17_19, false)]]);
    expect(r.subjectCount).toBe(1);
    expect(r.baseDiscountBps).toBe(10000);
    expect(r.careDays.tutoring.days).toBe(4);
    expect(r.selection?.math?.positiveDeduction).toBe(1);
  });

  it('數學班 多科折扣=否、不計扣天=是：科數 1、不扣天 → 課輔 5 天', () => {
    const r = calc(4, [care, ['國小數學-特訓', lookup('math', false)]], [['國小數學-特訓', sess(WED_17_19, true)]]);
    expect(r.subjectCount).toBe(1);
    expect(r.careDays.tutoring.days).toBe(5);
  });

  it('數學班 多科折扣=是、不計扣天=否（對照）：科數 2 → 95 折，且扣 1 天 → 課輔 4 天', () => {
    const r = calc(4, [care, ['國小數學-特訓', lookup('math', true)]], [['國小數學-特訓', sess(WED_17_19, false)]]);
    expect(r.subjectCount).toBe(2);
    expect(r.baseDiscountBps).toBe(9500);
    expect(r.careDays.tutoring.days).toBe(4);
  });

  it('美語班 多科折扣=否、不計扣天=否：同樣不計科數但照扣天', () => {
    const r = calc(4, [care, ['兒童美語-特訓', lookup('english', false)]], [['兒童美語-特訓', sess(WED_17_19, false)]]);
    expect(r.subjectCount).toBe(1);
    expect(r.careDays.tutoring.days).toBe(4);
    expect(r.selection?.english?.positiveDeduction).toBe(1);
  });

  it('多科折扣=否的兩個美語班仍只取扣天最多的一班（週三 −1 勝過週四 −0.5）', () => {
    const r = calc(
      4,
      [care, ['兒童美語-甲', lookup('english', false)], ['兒童美語-乙', lookup('english', false)]],
      [
        ['兒童美語-甲', sess(THU_1730_1830, false)],
        ['兒童美語-乙', sess(WED_17_19, false)],
      ]
    );
    expect(r.careDays.tutoring.days).toBe(4);
    expect(r.selection?.english?.selectedRawToken).toBe('兒童美語-乙');
  });
});

// ---------------------------------------------------------------------------
// 4. 其他班：所見即所得扣天（Option A）
// ---------------------------------------------------------------------------

describe('D61 其他班 所見即所得扣天', () => {
  const care = ['國小輔導-四年級', lookup('care', true)] as [string, unknown];

  it('預設 skipDeduction=true：不扣天 → 課輔 5 天、科數 1，且不發缺課表警告', () => {
    const r = calc(4, [care, ['平日作文班', lookup('other')]], [['平日作文班', sess(WED_17_19, true)]]);
    expect(r.careDays.tutoring.days).toBe(5);
    expect(r.subjectCount).toBe(1);
    expect(r.issues.map((i) => i.code)).toEqual([]);
  });

  it('改為 skipDeduction=false：衝堂扣 1 天 → 課輔 4 天、科數仍 1（不計入多科折扣）', () => {
    const r = calc(4, [care, ['平日作文班', lookup('other')]], [['平日作文班', sess(WED_17_19, false)]]);
    expect(r.careDays.tutoring.days).toBe(4);
    expect(r.subjectCount).toBe(1);
    expect(r.baseDiscountBps).toBe(10000);
    expect(r.selection?.other?.selectedRawToken).toBe('平日作文班');
    expect(r.selection?.other?.positiveDeduction).toBe(1);
  });

  it('同生多門其他班：比照美語／數學取扣除量最多者（−1 勝過 −0.5）', () => {
    const r = calc(
      4,
      [care, ['作文甲', lookup('other')], ['作文乙', lookup('other')]],
      [
        ['作文甲', sess(THU_1730_1830, false)],
        ['作文乙', sess(WED_17_19, false)],
      ]
    );
    expect(r.careDays.tutoring.days).toBe(4);
    expect(r.selection?.other?.selectedRawToken).toBe('作文乙');
  });

  it('其他班與數學班扣天相加：數學 −1 ＋ 其他 −0.5 → 5 − 1.5 = 3.5', () => {
    const r = calc(
      4,
      [care, ['國小數學-特訓', lookup('math', true)], ['作文甲', lookup('other')]],
      [
        ['國小數學-特訓', sess(WED_17_19, false)],
        ['作文甲', sess(THU_1730_1830, false)],
      ]
    );
    expect(r.careDays.tutoring.days).toBe(3.5);
  });

  it('其他班空課表：發 SCHEDULE_EMPTY 警告（與美語／數學一致），扣天 0', () => {
    const r = calc(4, [care, ['平日作文班', lookup('other')]], [['平日作文班', []]]);
    expect(r.careDays.tutoring.days).toBe(5);
    expect(r.issues.map((i) => i.code)).toContain('SCHEDULE_EMPTY');
  });

  it('calculateCareDays 併入 otherDeduction：課輔 −1 → 4；安親 −0.5 → 4.5', () => {
    const input = {
      mathDeductionAnqin: 0,
      mathDeductionTutoring: 0,
      englishDeductionAnqin: 0,
      englishDeductionTutoring: 0,
      extraDeduction: null,
      hasHomeworkOrMeian: false,
    };
    expect(calculateCareDays({ ...input, grade: 4, otherDeductionTutoring: -1 } as never).tutoring.days).toBe(4);
    expect(calculateCareDays({ ...input, grade: 1, otherDeductionAnqin: -0.5 } as never).anqin.days).toBe(4.5);
  });
});

// ---------------------------------------------------------------------------
// 5. 重複報名提示（Ruling 4）與 deriveEffectiveCategory
// ---------------------------------------------------------------------------

describe('D61 Ruling 4：DUPLICATE_SUBJECT_ENROLLMENT 依 classType 判定', () => {
  it('兩個美語班即使多科折扣=否仍提示重複報名；兩個其他班不提示', () => {
    const eng = calc(
      4,
      [['兒童美語-甲', lookup('english', false)], ['兒童美語-乙', lookup('english', false)]],
      [['兒童美語-甲', sess(THU_1730_1830, false)], ['兒童美語-乙', sess(WED_17_19, false)]]
    );
    expect(eng.issues.filter((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT').map((i) => i.category)).toEqual(['兒童美語']);

    const oth = calc(
      4,
      [['作文甲', lookup('other')], ['作文乙', lookup('other')]],
      [['作文甲', sess(THU_1730_1830, true)], ['作文乙', sess(WED_17_19, true)]]
    );
    expect(oth.issues.map((i) => i.code)).not.toContain('DUPLICATE_SUBJECT_ENROLLMENT');
  });
});

describe('D61 deriveEffectiveCategory：(classType, hasMultiSubjectDiscount) → category 投影', () => {
  const derive = (classCategory as unknown as Record<string, (t: string, h: boolean) => string>).deriveEffectiveCategory;

  it('care／english／math 且 hasMulti=true → 同名；否則 none；other／unscheduled 恆為 none', () => {
    expect(derive?.('care', true)).toBe('care');
    expect(derive?.('english', true)).toBe('english');
    expect(derive?.('math', true)).toBe('math');
    expect(derive?.('care', false)).toBe('none');
    expect(derive?.('english', false)).toBe('none');
    expect(derive?.('math', false)).toBe('none');
    expect(derive?.('other', true)).toBe('none');
    expect(derive?.('unscheduled', false)).toBe('none');
  });

  it('resolveClassEnrollment 對已對應班輸出五類型、hasMultiSubjectDiscount 與投影後 category；未對應班維持 unset', () => {
    const map = new Map([
      ['國小數學-甲', lookup('math', false)],
      ['作文甲', lookup('other')],
    ]) as never;
    const m = classCategory.resolveClassEnrollment({ rawToken: '國小數學-甲', baseName: '國小數學-甲' }, undefined, map) as never as Record<string, unknown>;
    expect([m.classType, m.hasMultiSubjectDiscount, m.category]).toEqual(['math', false, 'none']);
    const o = classCategory.resolveClassEnrollment({ rawToken: '作文甲', baseName: '作文甲' }, undefined, map) as never as Record<string, unknown>;
    expect([o.classType, o.hasMultiSubjectDiscount, o.category]).toEqual(['other', false, 'none']);
    const u = classCategory.resolveClassEnrollment({ rawToken: '交通車', baseName: '交通車' }, undefined, map) as never as Record<string, unknown>;
    expect([u.classType, u.hasMultiSubjectDiscount, u.category, u.mapped]).toEqual([null, false, 'unset', false]);
  });
});

// ---------------------------------------------------------------------------
// 6. 待補時段存檔往返（Ruling 3）
// ---------------------------------------------------------------------------

function row(over: Partial<ScheduleGridRow> & { rowId: string }): ScheduleGridRow {
  return {
    className: '兒童美語-新班',
    teacher: null,
    weekday: '',
    startTime: '',
    endTime: '',
    startMinutes: null,
    endMinutes: null,
    active: true,
    skipDeduction: false,
    ...over,
  };
}

const EXISTING_ENGLISH = [
  { baseName: '兒童美語-新班', teacher: null, active: true, sessions: [], classType: 'english', hasMultiSubjectDiscount: true },
] as never;

describe('D61 待補時間存檔往返', () => {
  const careWindows = { anqin: { startMinutes: 780, endMinutes: 960 }, tutoring: { startMinutes: 990, endMinutes: 1170 } };

  it('只填星期、起迄留空：sessions 為 []、整份草稿通過存檔契約、還原後星期不蒸發', () => {
    const classes = gridRowsToClasses([row({ rowId: 'r1', weekday: '三' })], EXISTING_ENGLISH);
    expect(classes[0].classType).toBe('english');
    expect(classes[0].sessions).toEqual([]);
    expect((classes[0] as { incompleteSessions?: unknown[] }).incompleteSessions).toHaveLength(1);

    expect(SettingsDraftSchema.safeParse({ classes, aliases: [], careWindows }).success).toBe(true);

    const back = classesToGridRows(classes);
    expect(back).toHaveLength(1);
    expect([back[0].weekday, back[0].startMinutes, back[0].endMinutes]).toEqual(['三', null, null]);
  });

  it('同班一堂完整、一堂單邊時間：完整者進 sessions、不完整者進 incompleteSessions，往返保留 2 列', () => {
    const classes = gridRowsToClasses(
      [
        row({ rowId: 'r1', weekday: '一', startTime: '17:00', endTime: '19:00', startMinutes: 1020, endMinutes: 1140 }),
        row({ rowId: 'r2', weekday: '三', startTime: '17:00', startMinutes: 1020 }),
      ],
      EXISTING_ENGLISH
    );
    expect(classes[0].sessions).toHaveLength(1);
    expect((classes[0] as { incompleteSessions?: unknown[] }).incompleteSessions).toHaveLength(1);
    const back = classesToGridRows(classes);
    expect(back.map((r) => [r.weekday, r.startMinutes, r.endMinutes])).toEqual([
      ['一', 1020, 1140],
      ['三', 1020, null],
    ]);
  });

  it('單列全空佔位：省略 incompleteSessions，還原為 1 列空佔位', () => {
    const classes = gridRowsToClasses([row({ rowId: 'r1' })], EXISTING_ENGLISH);
    expect(classes[0].sessions).toEqual([]);
    expect('incompleteSessions' in classes[0]).toBe(false);
    expect(classesToGridRows(classes)).toHaveLength(1);
  });

  it('其他班空佔位列還原時 skipDeduction 依預設為 true', () => {
    const existing = [{ baseName: '作文甲', teacher: null, active: true, sessions: [], classType: 'other', hasMultiSubjectDiscount: false }] as never;
    const classes = gridRowsToClasses([row({ rowId: 'r1', className: '作文甲', skipDeduction: true })], existing);
    expect(classesToGridRows(classes)[0].skipDeduction).toBe(true);
  });

  it('buildSeedGridRows 對 5 門其他班的初始列設 skipDeduction=true，其餘為 false', () => {
    const rows = settingsContract.buildSeedGridRows();
    const others = new Set(['國小國語文-小三小四', '國小國語文-小五', '小六加強班-國文', '小六加強班-數學', '小六加強班-自然']);
    for (const r of rows) {
      expect(r.skipDeduction, r.className).toBe(others.has(r.className));
    }
  });
});
