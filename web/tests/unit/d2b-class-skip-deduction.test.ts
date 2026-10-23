/**
 * #113 follow-up：「不計扣天」（skipDeduction）改為**逐時段／逐列**設定。
 *
 * 為什麼改：#113 初版把它放在班級層（classAttributes），勾一列會連動同班全部時段。
 * 但一個班常有 2~3 個時段，園方只想讓其中 1~2 堂不扣天（例：第一堂與安親重疊不扣、
 * 第二堂與課輔重疊照扣）。因此旗標移到 `ScheduleGridRow.skipDeduction` 與
 * `Session.skipDeduction`，每一列各自勾選。
 *
 * ── expected 全部獨立手算（不用被測函式輸出當黃金標準）──
 *  - 安親窗口 13:00–16:00 ＝ 780–960；課輔窗口 16:30–19:30 ＝ 990–1170；每日 180 分。
 *  - 週一 1080–1170（18:00–19:30）：與安親窗口無交集（1080 > 960）→ 安親重疊 0；
 *    與課輔窗口重疊 1170 − 1080 ＝ 90 分 → 課輔扣天 raw −90/180 ＝ −0.5。
 *  - 週三 1080–1170 同理：課輔重疊 90 分 → −0.5。
 *  - D24 取整：**同班先加總重疊分鐘**再取整（不是各堂分別取整）：
 *      d ＝ floor(totals) + f；f < 0.3 → 扣整數部分；0.3 ≤ f < 0.8 → 加 0.5；f ≥ 0.8 → 加 1。
 *      · 只勾週一 → 只剩週三 90 分 → d ＝ 0 + 0.5 → 扣 0.5 天 → 天數 4.5。
 *      · 兩堂都不勾 → 合計 180 分 → d ＝ 1 + 0.0 → 扣 1 天 → 天數 4。
 *      · 兩堂都勾 → 0 分 → 扣天 0 → 天數 5。
 *  - 年級 4 ＝ 課輔側。天數 ＝ max(3, 5 − 扣天量)。
 */

import { describe, it, expect } from 'vitest';
import {
  ClassSettingSchema,
  SessionSchema,
  ScheduleGridRowSchema,
  isSettingsDirty,
  classesToGridRows,
  gridRowsToClasses,
  gridRowsToCalculateClasses,
  type ScheduleGridRow,
  type ClassSetting,
} from '@/contracts/settings';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { buildSchedulePreview } from '@/application/schedule-preview';
import { combineCareStatuses } from '@/application/care-status';
import type { StudentSnapshot } from '@/domain/students/types';

const CARE = {
  anqin: { startMinutes: 780, endMinutes: 960 },
  tutoring: { startMinutes: 990, endMinutes: 1170 },
};

/** 週一 18:00–19:30（1080–1170）：與課輔窗重疊 90 分、與安親窗不重疊。 */
const MON_SESSION = { weekday: '一', startMinutes: 1080, endMinutes: 1170 };
/** 週三 18:00–19:30（1080–1170）：同樣與課輔窗重疊 90 分。 */
const WED_SESSION = { weekday: '三', startMinutes: 1080, endMinutes: 1170 };

function gridRow(over: Partial<ScheduleGridRow> & { rowId: string }): ScheduleGridRow {
  return {
    className: '國小數學-一A',
    teacher: null,
    weekday: '一',
    startTime: '18:00',
    endTime: '19:30',
    startMinutes: 1080,
    endMinutes: 1170,
    active: true,
    skipDeduction: false,
    ...over,
  };
}

function studentWith(tokens: string[], grade = 4): StudentSnapshot {
  return {
    personCode: 'S001',
    name: '測試學生',
    branch: '測試分部',
    grade,
    gradeRaw: String(grade),
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: tokens.map((b) => ({
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

/**
 * 一個班兩個時段：週一（可勾）與週三（可勾），各別帶自己的旗標。
 * 手算用 `overrideOf` 直接組出 draftToScheduleOverride 的輸出形狀。
 */
function overrideOf(sessions: Array<{ weekday: string; start: number; end: number; skipDeduction: boolean }>) {
  return new Map<string, Array<{ start: number; end: number; weekday: string; skipDeduction: boolean }>>([
    ['國小數學-一A', sessions],
  ]);
}

function calc(
  sessions: Array<{ weekday: string; start: number; end: number; skipDeduction: boolean }>,
  version: 'erp-tag-v2' | 'erp-tag-v3' = 'erp-tag-v3'
) {
  return calculateStudentBilling(studentWith(['國小數學-一A']), {
    ruleSetVersion: version,
    aliasMap: new Map(),
    scheduleOverride: overrideOf(sessions),
    // #157 Ruling 1：類別由使用者決定（本檔驗的是逐時段扣天，不是類別判定）。
    // v3 的選班演算法依類別挑選候選班，未宣告類別就沒有候選。
    classSettings: new Map([['國小數學-一A', { category: 'math' as const, categorySource: 'manual' as const }]]),
  });
}

// ---------------------------------------------------------------------------
// 1. 契約：旗標在「時段」與「平鋪列」上，不再是班級屬性
// ---------------------------------------------------------------------------

describe('#113 follow-up 契約：SessionSchema 的逐時段 skipDeduction', () => {
  it('缺欄位＝未勾選＝false（舊快照讀取時不回寫也能得到正確有效值）', () => {
    const parsed = SessionSchema.parse(MON_SESSION);
    expect(parsed.skipDeduction).toBe(false);
  });

  it('勾選的時段可通過存檔契約，旗標原樣保留', () => {
    const parsed = SessionSchema.parse({ ...MON_SESSION, skipDeduction: true });
    expect(parsed.skipDeduction).toBe(true);
  });

  it('非 boolean 的 skipDeduction 一律拒絕（不靜默當成 false）', () => {
    expect(SessionSchema.safeParse({ ...MON_SESSION, skipDeduction: 'maybe' }).success).toBe(false);
  });

  it('ScheduleGridRowSchema 同樣有逐列旗標，缺值為 false', () => {
    const base = {
      rowId: 'r1',
      className: '國小數學-一A',
      teacher: null,
      weekday: '一',
      startTime: '18:00',
      endTime: '19:30',
      startMinutes: 1080,
      endMinutes: 1170,
      active: true,
    };
    expect(ScheduleGridRowSchema.parse(base).skipDeduction).toBe(false);
    expect(ScheduleGridRowSchema.parse({ ...base, skipDeduction: true }).skipDeduction).toBe(true);
  });

  it('ClassSettingSchema 不再接受班級層的 skipDeduction 作為有效旗標（逐時段化）', () => {
    // 舊快照仍能解析（不被舊資料卡死），但旗標本身不再是班級層的有效來源。
    const parsed = ClassSettingSchema.parse({
      baseName: '國小數學-一A',
      subject: '國小數學',
      sessions: [{ ...MON_SESSION, skipDeduction: true }],
    });
    expect(parsed.sessions[0].skipDeduction).toBe(true);
    expect(parsed.skipDeduction).toBeUndefined();
  });
});

describe('#113 follow-up 契約：gridRows ↔ classes 逐列往返', () => {
  it('gridRowsToClasses 讓每一個 session 帶自己的旗標（不同時段可不同）', () => {
    const classes = gridRowsToClasses([
      gridRow({ rowId: 'r1', skipDeduction: true }),
      gridRow({ rowId: 'r2', weekday: '三', skipDeduction: false }),
    ]);
    expect(classes).toHaveLength(1);
    expect(classes[0].sessions.map((s) => s.skipDeduction)).toEqual([true, false]);
  });

  it('classesToGridRows 逐列還原旗標（往返一致）', () => {
    const classes = gridRowsToClasses([
      gridRow({ rowId: 'r1', skipDeduction: true }),
      gridRow({ rowId: 'r2', weekday: '三', skipDeduction: false }),
    ]);
    expect(classesToGridRows(classes).map((r) => r.skipDeduction)).toEqual([true, false]);
  });

  it('gridRowsToCalculateClasses（唯讀計算）同樣逐列帶旗標，且保留 rowId', () => {
    const calcClasses = gridRowsToCalculateClasses([
      gridRow({ rowId: 'r1', skipDeduction: true }),
      gridRow({ rowId: 'r2', weekday: '三', skipDeduction: false }),
    ]);
    expect(calcClasses[0].sessions).toEqual([
      { rowId: 'r1', weekday: '一', startMinutes: 1080, endMinutes: 1170, skipDeduction: true },
      { rowId: 'r2', weekday: '三', startMinutes: 1080, endMinutes: 1170, skipDeduction: false },
    ]);
  });

  it('舊快照的班級層 skipDeduction 不會被帶進新 session（不會與逐列旗標分岔）', () => {
    const legacy: ClassSetting[] = [
      {
        baseName: '國小數學-一A',
        subject: '國小數學',
        teacher: null,
        active: true,
        sessions: [],
        skipDeduction: true,
        skipDeductionSource: 'manual',
      } as ClassSetting,
    ];
    const out = gridRowsToClasses([gridRow({ rowId: 'r1' })], legacy)[0];
    expect(out.skipDeduction).toBeUndefined();
    expect(out.sessions[0].skipDeduction).toBe(false);
  });
});

describe('#113 follow-up 契約：isSettingsDirty 認得逐列旗標的變更', () => {
  const base = { rows: [gridRow({ rowId: 'r1' })], aliases: [] };

  it('只勾選某一列 → 視為有未儲存變更', () => {
    const current = [gridRow({ rowId: 'r1', skipDeduction: true })];
    expect(isSettingsDirty(base, current, [])).toBe(true);
  });

  it('只勾同班的另一列 → 同樣是變更（逐列獨立，不是整班旗標）', () => {
    const baseline = { rows: [gridRow({ rowId: 'r1' }), gridRow({ rowId: 'r2', weekday: '三' })], aliases: [] };
    const current = [gridRow({ rowId: 'r1' }), gridRow({ rowId: 'r2', weekday: '三', skipDeduction: true })];
    expect(isSettingsDirty(baseline, current, [])).toBe(true);
  });

  it('完全相同 → 不是變更', () => {
    expect(isSettingsDirty(base, [gridRow({ rowId: 'r1' })], [])).toBe(false);
  });
});

describe('#113 follow-up 契約：draftToScheduleOverride 逐時段帶旗標', () => {
  it('勾選與否原樣帶到 override（缺值視為 false）', () => {
    const override = draftToScheduleOverride({
      classes: [
        {
          baseName: '國小數學-一A',
          subject: '國小數學',
          teacher: null,
          active: true,
          sessions: [
            { ...MON_SESSION, skipDeduction: true },
            { ...WED_SESSION, skipDeduction: false },
          ],
        },
      ],
      aliases: [],
      careWindows: CARE,
      effectiveFrom: null,
      effectiveTo: null,
    });
    expect(override.get('國小數學-一A')).toEqual([
      { start: 1080, end: 1170, weekday: '一', skipDeduction: true },
      { start: 1080, end: 1170, weekday: '三', skipDeduction: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. 計算管線：只有未勾選的時段才納入扣天
// ---------------------------------------------------------------------------

describe('#113 follow-up 計算：逐時段扣天', () => {
  it('前置手算：兩堂都不勾 → 合計 180 分 → D24 扣 1 天 → 天數 4', () => {
    const r = calc([
      { weekday: '一', start: 1080, end: 1170, skipDeduction: false },
      { weekday: '三', start: 1080, end: 1170, skipDeduction: false },
    ]);
    expect(r.selection!.math!.tutoringDeduction).toBe(-1);
    expect(r.selection!.math!.positiveDeduction).toBe(1);
    expect(r.careDays.tutoring.days).toBe(4);
  });

  it('只勾週一 → 只剩週三 −0.5 → D24 取整 0.5 天 → 天數 4.5（不是 5，也不是 4）', () => {
    const r = calc([
      { weekday: '一', start: 1080, end: 1170, skipDeduction: true },
      { weekday: '三', start: 1080, end: 1170, skipDeduction: false },
    ]);
    expect(r.selection!.math!.tutoringDeduction).toBe(-0.5);
    expect(r.selection!.math!.positiveDeduction).toBe(0.5);
    expect(r.careDays.tutoring.days).toBe(4.5);
  });

  it('只勾週三 → 對稱：扣天同樣 0.5 天（勾哪一堂都一樣，方向無關）', () => {
    const r = calc([
      { weekday: '一', start: 1080, end: 1170, skipDeduction: false },
      { weekday: '三', start: 1080, end: 1170, skipDeduction: true },
    ]);
    expect(r.selection!.math!.tutoringDeduction).toBe(-0.5);
    expect(r.careDays.tutoring.days).toBe(4.5);
  });

  it('兩堂都勾 → 扣天 0、天數 5', () => {
    const r = calc([
      { weekday: '一', start: 1080, end: 1170, skipDeduction: true },
      { weekday: '三', start: 1080, end: 1170, skipDeduction: true },
    ]);
    expect(r.selection!.math!.tutoringDeduction).toBe(0);
    // 正值取「正值最大者」，−0 的負零在此正規化為 0
    expect(Object.is(r.selection!.math!.positiveDeduction, -0)).toBe(true);
    expect(r.careDays.tutoring.days).toBe(5);
  });

  it('整班都勾時仍是「已計算」（時段存在，不是缺課表）', () => {
    const r = calc([
      { weekday: '一', start: 1080, end: 1170, skipDeduction: true },
      { weekday: '三', start: 1080, end: 1170, skipDeduction: true },
    ]);
    expect(r.selection!.math!.status).toBe('calculated');
    expect(r.selection!.math!.isCalculable).toBe(true);
  });

  it('整班都勾時不產生 SCHEDULE_EMPTY／SCHEDULE_NOT_FOUND 警告', () => {
    const r = calc([
      { weekday: '一', start: 1080, end: 1170, skipDeduction: true },
      { weekday: '三', start: 1080, end: 1170, skipDeduction: true },
    ]);
    const codes = r.issues.map((i) => i.code);
    expect(codes).not.toContain('SCHEDULE_EMPTY');
    expect(codes).not.toContain('SCHEDULE_NOT_FOUND');
  });

  it('v2 路徑同樣逐時段生效（不是只有 v3）', () => {
    const r = calc(
      [
        { weekday: '一', start: 1080, end: 1170, skipDeduction: true },
        { weekday: '三', start: 1080, end: 1170, skipDeduction: false },
      ],
      'erp-tag-v2'
    );
    expect(r.careDays.tutoring.days).toBe(4.5);
  });

  it('勾選不會影響該時段的星期告警之外的判定：未勾的時段仍照常計未知星期', () => {
    // 手算：只有週三（未勾）可計，它的星期是「八」→ v2 同星期路徑 fail-closed 計 0 並出 1 筆告警。
    // 週一已勾、不列入扣天，因此不因它的星期而告警——這正是「只統計可扣天時段」的語意。
    const r = calculateStudentBilling(studentWith(['國小數學-一A']), {
      ruleSetVersion: 'erp-tag-v2',
      aliasMap: new Map(),
      scheduleOverride: new Map([
        [
          '國小數學-一A',
          [
            { weekday: '一', start: 1080, end: 1170, skipDeduction: true },
            { weekday: '八', start: 1080, end: 1170, skipDeduction: false },
          ],
        ],
      ]),
    });
    expect(r.issues.filter((i) => i.code === 'UNKNOWN_WEEKDAY')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. 唯讀預覽（schedule-preview）：逐堂與班級兩層
// ---------------------------------------------------------------------------

function previewDraft(
  sessions: Array<{ weekday: string; startMinutes: number; endMinutes: number; skipDeduction?: boolean }>
) {
  return {
    classes: [
      {
        baseName: '國小數學-一A',
        subject: '國小數學',
        teacher: '老師甲',
        active: true,
        sessions: sessions.map((s) => ({ skipDeduction: false, ...s })),
      },
    ],
    aliases: [],
    careWindows: CARE,
    effectiveFrom: null,
    effectiveTo: null,
  };
}

describe('#113 follow-up 預覽：逐堂與班級層', () => {
  it('前置手算：兩堂都不勾 → 班級課輔重疊 180 分、raw −1.0、rounded −1（D24）', () => {
    const core = buildSchedulePreview(
      previewDraft([MON_SESSION, { ...WED_SESSION }]) as never,
      'erp-tag-v2'
    );
    expect(core.classes[0].tutoring.totalOverlapMinutes).toBe(180);
    expect(core.classes[0].tutoring.raw).toBeCloseTo(-1.0, 12);
    expect(core.classes[0].tutoring.rounded).toBe(-1);
    expect(core.classes[0].tutoring.status).toBe('calculated');
  });

  it('只勾週一 → 班級層只算週三（重疊 90 分、rounded −0.5），週一該列標不計扣天', () => {
    const core = buildSchedulePreview(
      previewDraft([{ ...MON_SESSION, skipDeduction: true }, { ...WED_SESSION }]) as never,
      'erp-tag-v2'
    );
    expect(core.classes[0].tutoring.totalOverlapMinutes).toBe(90);
    expect(core.classes[0].tutoring.rounded).toBe(-0.5);
    expect(core.classes[0].tutoring.status).toBe('calculated');
    // 逐堂：週一標 no_deduction、扣天 0；週三照實顯示
    const [mon, wed] = core.rows;
    expect(mon.tutoring.status).toBe('no_deduction');
    expect(mon.tutoring.rawDeduction).toBe(0);
    expect(mon.tutoring.overlapMinutes).toBe(90); // D17：事實仍如實顯示
    expect(wed.tutoring.status).toBe('calculated');
    expect(wed.tutoring.overlapMinutes).toBe(90);
  });

  it('兩堂都勾 → 班級層重疊 0、raw 0、rounded 0、狀態 no_deduction，且不產生任何問題', () => {
    const core = buildSchedulePreview(
      previewDraft([{ ...MON_SESSION, skipDeduction: true }, { ...WED_SESSION, skipDeduction: true }]) as never,
      'erp-tag-v2'
    );
    for (const side of [core.classes[0].anqin, core.classes[0].tutoring]) {
      expect(side.totalOverlapMinutes).toBe(0);
      expect(side.raw).toBe(0);
      expect(side.rounded).toBe(0);
      expect(side.status).toBe('no_deduction');
    }
    expect(core.issues).toEqual([]);
    expect(core.classes[0].rowIds).toHaveLength(2);
  });

  it('勾選的時段仍保留（列與班級都不消失，起迄如實回傳）', () => {
    const core = buildSchedulePreview(
      previewDraft([{ ...MON_SESSION, skipDeduction: true }]) as never,
      'erp-tag-v2'
    );
    expect(core.classes).toHaveLength(1);
    expect(core.rows).toHaveLength(1);
    expect(core.rows[0].startMinutes).toBe(1080);
    expect(core.rows[0].endMinutes).toBe(1170);
    expect(core.rows[0].durationMinutes).toBe(90);
  });

  it('安親側（1080–1170 與安親窗 780–960 不重疊）勾選後仍標不計扣天、重疊 0', () => {
    const core = buildSchedulePreview(
      previewDraft([{ ...MON_SESSION, skipDeduction: true }]) as never,
      'erp-tag-v2'
    );
    expect(core.rows[0].anqin.overlapMinutes).toBe(0);
    expect(core.rows[0].anqin.status).toBe('no_deduction');
  });

  it('狀態合併：不計扣天優先於「無重疊」，但不被需確認／待補掩蓋', () => {
    expect(combineCareStatuses('no_deduction', 'no_deduction')).toBe('no_deduction');
    expect(combineCareStatuses('no_deduction', 'no_overlap')).toBe('no_deduction');
    expect(combineCareStatuses('no_overlap', 'no_deduction')).toBe('no_deduction');
    expect(combineCareStatuses('no_deduction', 'calculated')).toBe('no_deduction');
    expect(combineCareStatuses('calculated', 'no_deduction')).toBe('calculated');
    expect(combineCareStatuses('no_deduction', 'unknown_weekday')).toBe('unknown_weekday');
    expect(combineCareStatuses('unknown_weekday', 'no_deduction')).toBe('unknown_weekday');
    expect(combineCareStatuses('incomplete', 'no_deduction')).toBe('incomplete');
    expect(combineCareStatuses('inactive', 'no_deduction')).toBe('inactive');
  });
});