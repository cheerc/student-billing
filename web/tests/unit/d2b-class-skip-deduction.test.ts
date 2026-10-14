/**
 * #113：班級「不計扣天」（skipDeduction）——契約、領域屬性與計算管線。
 *
 * 目的：讓園方政策可以「逐班」宣告重疊不扣天，而不是刪空該班全部時段
 * （走 `schedule_empty` 會附帶待補＋SCHEDULE_EMPTY 警告，且時段資料全失）。
 *
 * ── 設計（與 category／fixedFiveDays 同一套三欄慣例）──
 *  1. `skipDeduction` 沒有班名自動偵測規則：auto 一律解析為 `false`；
 *     只有手動勾選（`skipDeductionSource === 'manual'`）才會存檔並生效。
 *  2. 缺欄位＝自動偵測＝不計扣天關閉（03 §5.2 版本界線規則第 2 點），
 *     因此舊快照讀取時不回寫即可得到正確有效值。
 *  3. 生效時：該班時段**保留**，扣天一律 0，不產生 SCHEDULE_EMPTY／SCHEDULE_NOT_FOUND 警告。
 *
 * ── expected 全部獨立手算（不用被測函式輸出當黃金標準）──
 *  - 安親窗口 13:00–16:00 ＝ 780–960；課輔窗口 16:30–19:30 ＝ 990–1170；每日 180 分。
 *  - 週一 1080–1170（18:00–19:30）：與安親窗口無交集（1080 > 960）→ 安親重疊 0；
 *    與課輔窗口重疊 1170 − 1080 ＝ 90 分 → 課輔扣天 raw −90/180 ＝ −0.5，
 *    D24 取整 |frac| 0.5 ∈ [0.3, 0.8) → 實際扣 −0.5 天。
 *  - 年級 4 ＝ 課輔側。數學班勾「不計扣天」後：扣天 0 → 天數 max(3, 5−0) ＝ 5 天。
 *  - 同一時段未勾選：扣天 0.5 → 天數 max(3, 5−0.5) ＝ 4.5 天。
 */

import { describe, it, expect } from 'vitest';
import { resolveClassEnrollment, type ClassSettingLookup } from '@/domain/classification/class-category';
import {
  resolveClassAttributes,
  toSavedClassAttributes,
  sameClassAttributes,
  carryAttributesOnRename,
  detectMergeConflicts,
  attributesFromDraftClasses,
  type ClassAttributesView,
} from '@/domain/classification/class-attributes';
import {
  ClassSettingSchema,
  isSettingsDirty,
  gridRowsToClasses,
  type ScheduleGridRow,
  type ClassSetting,
} from '@/contracts/settings';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { buildClassSettingMap } from '@/application/calculate-run';
import { buildSchedulePreview } from '@/application/schedule-preview';
import { combineCareStatuses } from '@/application/care-status';
import type { StudentSnapshot } from '@/domain/students/types';

const CARE = {
  anqin: { startMinutes: 780, endMinutes: 960 },
  tutoring: { startMinutes: 990, endMinutes: 1170 },
};

/** 週一 18:00–19:30 的時段（與課輔窗口重疊 90 分；與安親窗口無交集）。 */
const OVERLAP_SESSION = { weekday: '一', startMinutes: 1080, endMinutes: 1170 };

// ---------------------------------------------------------------------------
// 1. 存檔契約
// ---------------------------------------------------------------------------

describe('#113 契約：ClassSettingSchema 接受 skipDeduction 與其來源', () => {
  it('手動勾選的旗標可通過存檔契約', () => {
    const parsed = ClassSettingSchema.safeParse({
      baseName: '國小數學-一A',
      subject: '國小數學',
      skipDeduction: true,
      skipDeductionSource: 'manual',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skipDeduction).toBe(true);
      expect(parsed.data.skipDeductionSource).toBe('manual');
    }
  });

  it('未勾選（缺欄位）可通過契約，且解析後沒有任何旗標欄位（缺＝自動）', () => {
    const parsed = ClassSettingSchema.safeParse({ baseName: '國小數學-一A', subject: '國小數學' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skipDeduction).toBeUndefined();
      expect(parsed.data.skipDeductionSource).toBeUndefined();
    }
  });

  it('非法的 skipDeductionSource 一律拒絕（不靜默當 auto）', () => {
    const parsed = ClassSettingSchema.safeParse({
      baseName: '國小數學-一A',
      subject: '國小數學',
      skipDeductionSource: 'maybe',
    });
    expect(parsed.success).toBe(false);
  });

  it('gridRowsToClasses 只帶走 manual 的 skipDeduction（auto 不寫欄位，改班名會重新判定）', () => {
    const rows: ScheduleGridRow[] = [
      {
        rowId: 'r1',
        className: '新名字甲',
        teacher: null,
        weekday: '一',
        startTime: '18:00',
        endTime: '19:30',
        startMinutes: 1080,
        endMinutes: 1170,
        active: true,
      },
    ];
    const manualExisting: ClassSetting[] = [
      {
        baseName: '新名字甲',
        subject: '國小數學',
        teacher: null,
        active: true,
        sessions: [],
        skipDeduction: true,
        skipDeductionSource: 'manual',
      } as ClassSetting,
    ];
    const autoExisting: ClassSetting[] = [
      {
        baseName: '新名字甲',
        subject: '國小數學',
        teacher: null,
        active: true,
        sessions: [],
        skipDeduction: false,
        skipDeductionSource: 'auto',
      } as ClassSetting,
    ];

    const kept = gridRowsToClasses(rows, manualExisting)[0];
    expect(kept.skipDeduction).toBe(true);
    expect(kept.skipDeductionSource).toBe('manual');

    const notKept = gridRowsToClasses(rows, autoExisting)[0];
    expect(notKept.skipDeduction).toBeUndefined();
    expect(notKept.skipDeductionSource).toBeUndefined();
  });

  it('isSettingsDirty 認得 skipDeduction 的變更（勾選 → 視為有未儲存變更）', () => {
    const baseline = {
      rows: [],
      aliases: [],
      classAttrs: [
        { className: '國小數學-一A', category: 'math' as const, categorySource: 'auto' as const, fixedFiveDays: false, fixedSource: 'auto' as const, skipDeduction: false, skipDeductionSource: 'auto' as const },
      ],
    };
    const current = [
      { className: '國小數學-一A', category: 'math' as const, categorySource: 'auto' as const, fixedFiveDays: false, fixedSource: 'auto' as const, skipDeduction: true, skipDeductionSource: 'manual' as const },
    ];
    expect(isSettingsDirty(baseline, [], [], current)).toBe(true);
    // 反向：取消勾選回未勾選 → 仍是變更
    expect(isSettingsDirty({ ...baseline, classAttrs: current }, [], [], baseline.classAttrs!)).toBe(true);
    // 完全相同 → 不是變更
    expect(isSettingsDirty(baseline, [], [], baseline.classAttrs)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 領域屬性（class-attributes）
// ---------------------------------------------------------------------------

describe('#113 領域屬性：不計扣天與類別、固定 5 天各自獨立', () => {
  it('未手動時有效值為 false、來源 auto（無班名自動偵測規則）', () => {
    const r = resolveClassAttributes('國小數學-一A');
    expect(r.skipDeduction).toBe(false);
    expect(r.skipDeductionSource).toBe('auto');
  });

  it('手動勾選時有效值為 true、來源 manual；手動取消仍是 manual（來源是使用者意圖）', () => {
    const on = resolveClassAttributes('國小數學-一A', { skipDeduction: true, skipDeductionSource: 'manual' });
    expect(on.skipDeduction).toBe(true);
    expect(on.skipDeductionSource).toBe('manual');

    const off = resolveClassAttributes('國小數學-一A', { skipDeduction: false, skipDeductionSource: 'manual' });
    expect(off.skipDeduction).toBe(false);
    expect(off.skipDeductionSource).toBe('manual');
  });

  it('與類別／固定 5 天互不影響', () => {
    const r = resolveClassAttributes('兒童美語-Gino', {
      category: 'english',
      categorySource: 'manual',
      fixedFiveDays: true,
      fixedSource: 'manual',
      skipDeduction: true,
      skipDeductionSource: 'manual',
    });
    expect(r).toMatchObject({
      category: 'english',
      categorySource: 'manual',
      fixedFiveDays: true,
      fixedSource: 'manual',
      skipDeduction: true,
      skipDeductionSource: 'manual',
    });
  });

  it('有效值輸出為 draft 欄位（值與來源一併寫出，供 hash／快照涵蓋來源）', () => {
    const out = toSavedClassAttributes(resolveClassAttributes('國小數學-一A'));
    expect(out.skipDeduction).toBe(false);
    expect(out.skipDeductionSource).toBe('auto');
  });

  it('sameClassAttributes 逐欄比較：只差 skipDeduction 即視為不同（合併衝突須看見差異）', () => {
    const a: ClassAttributesView = { category: 'math', categorySource: 'auto', fixedFiveDays: false, fixedSource: 'auto', skipDeduction: true, skipDeductionSource: 'manual' };
    const b: ClassAttributesView = { category: 'math', categorySource: 'auto', fixedFiveDays: false, fixedSource: 'auto', skipDeduction: false, skipDeductionSource: 'auto' };
    expect(sameClassAttributes(a, b)).toBe(false);
    expect(sameClassAttributes(a, { ...a })).toBe(true);
  });

  it('draft → 屬性檢視：手動勾選被讀出來', () => {
    const attrs = attributesFromDraftClasses([
      { baseName: '國小數學-一A', skipDeduction: true, skipDeductionSource: 'manual' },
    ]);
    expect(attrs.get('國小數學-一A')?.skipDeduction).toBe(true);
    expect(attrs.get('國小數學-一A')?.skipDeductionSource).toBe('manual');
  });

  it('整班改名時手動勾選跟著走', () => {
    const out = carryAttributesOnRename(
      [{ from: '原班名甲', to: '新班名甲' }],
      new Map([['原班名甲', { category: 'math' as const, categorySource: 'auto' as const, fixedFiveDays: false, fixedSource: 'auto' as const, skipDeduction: true, skipDeductionSource: 'manual' as const }]]),
      new Map()
    );
    expect(out.get('新班名甲')?.skipDeduction).toBe(true);
    expect(out.get('新班名甲')?.skipDeductionSource).toBe('manual');
  });

  it('兩來源僅在「不計扣天」上不同 → 仍視為合併衝突（不得靜默取其一）', () => {
    const conflicts = detectMergeConflicts(
      [{ mergedName: '國小數學-一', sources: ['國小數學-一A', '國小數學-一B'] }],
      new Map([
        ['國小數學-一A', { category: 'math' as const, categorySource: 'auto' as const, fixedFiveDays: false, fixedSource: 'auto' as const, skipDeduction: true, skipDeductionSource: 'manual' as const }],
        ['國小數學-一B', { category: 'math' as const, categorySource: 'auto' as const, fixedFiveDays: false, fixedSource: 'auto' as const, skipDeduction: false, skipDeductionSource: 'auto' as const }],
      ])
    );
    expect(conflicts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. 報名解析（class-category）
// ---------------------------------------------------------------------------

describe('#113 報名解析：不計扣天隨班級設定帶入', () => {
  const lookup = (v: Partial<ClassSettingLookup>): Map<string, ClassSettingLookup> =>
    new Map([['國小數學-一A', { category: 'math', categorySource: 'auto', fixedFiveDays: false, fixedSource: 'auto', ...v }]]);

  it('已對應班級勾選時帶入 skipDeduction=true 與 manual 來源', () => {
    const r = resolveClassEnrollment(
      { rawToken: '國小數學-一A', baseName: '國小數學-一A' },
      undefined,
      lookup({ skipDeduction: true, skipDeductionSource: 'manual' })
    );
    expect(r.skipDeduction).toBe(true);
    expect(r.skipDeductionSource).toBe('manual');
  });

  it('缺欄位（未勾選）預設 false／auto', () => {
    const r = resolveClassEnrollment({ rawToken: '國小數學-一A', baseName: '國小數學-一A' }, undefined, lookup({}));
    expect(r.skipDeduction).toBe(false);
    expect(r.skipDeductionSource).toBe('auto');
  });

  it('未對應到系統班級時同樣預設 false／auto（不猜）', () => {
    const r = resolveClassEnrollment({ rawToken: '未知班', baseName: '未知班' }, undefined, new Map());
    expect(r.skipDeduction).toBe(false);
    expect(r.skipDeductionSource).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// 4. 計算管線（billing-calculator）
// ---------------------------------------------------------------------------

function studentWith(tokens: string[], grade = 4): StudentSnapshot {
  return {
    personCode: 'S-SKIP',
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

const SKIP_CLASS_SETTINGS = new Map<string, ClassSettingLookup>([
  ['國小數學-一A', { category: 'math', categorySource: 'manual', fixedFiveDays: false, fixedSource: 'auto', skipDeduction: true, skipDeductionSource: 'manual' }],
]);

/** 週一 18:00–19:30（課輔重疊 90 分；安親窗口 780–960 完全不重疊）。 */
const ONE_OVERRIDE = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
  ['國小數學-一A', [{ weekday: '一', start: 1080, end: 1170 }]],
]);

function calc(version: 'erp-tag-v2' | 'erp-tag-v3', skip: boolean, tokens = ['國小數學-一A']) {
  return calculateStudentBilling(studentWith(tokens), {
    ruleSetVersion: version,
    aliasMap: new Map(),
    classSettings: skip ? SKIP_CLASS_SETTINGS : new Map<string, ClassSettingLookup>(),
    scheduleOverride: new Map(ONE_OVERRIDE),
  });
}

describe('#113 計算：勾選「不計扣天」的班級扣天為 0', () => {
  it('前置手算：未勾選時，週一 18:00–19:30 與課輔窗口重疊 90 分 → 扣 0.5 天 → 天數 4.5', () => {
    const r = calc('erp-tag-v3', false);
    expect(r.selection!.math!.positiveDeduction).toBe(0.5);
    expect(r.careDays.tutoring.days).toBe(4.5);
  });

  it('v3：勾選後扣天為 0，天數回到 5 天（與手算一致）', () => {
    const r = calc('erp-tag-v3', true);
    expect(r.selection!.math!.anqinDeduction).toBe(0);
    expect(r.selection!.math!.tutoringDeduction).toBe(0);
    expect(r.selection!.math!.positiveDeduction).toBe(0);
    expect(r.careDays.tutoring.days).toBe(5);
  });

  it('v3：勾選後仍標為「已計算」（時段存在且有效，不是缺課表）', () => {
    const r = calc('erp-tag-v3', true);
    expect(r.selection!.math!.status).toBe('calculated');
    expect(r.selection!.math!.isCalculable).toBe(true);
  });

  it('v2：勾選後扣天為 0、天數回到 5 天', () => {
    const r = calc('erp-tag-v2', true);
    expect(r.careDays.tutoring.days).toBe(5);
  });

  it('勾選後不產生任何「缺時段」類警告', () => {
    const r = calc('erp-tag-v3', true);
    const codes = r.issues.map((i) => i.code);
    expect(codes).not.toContain('SCHEDULE_EMPTY');
    expect(codes).not.toContain('SCHEDULE_NOT_FOUND');
  });

  it('v3：勾選的候選與未勾選的候選同為可計算 → 選班結果可計算，不落 no_calculable_candidate', () => {
    // 未勾選者扣 0.5 天（正值較大）→ 依既有「取正量最多」規則應選出未勾選的班
    const r = calculateStudentBilling(studentWith(['國小數學-一A', '國小數學-一B']), {
      ruleSetVersion: 'erp-tag-v3',
      aliasMap: new Map(),
      classSettings: SKIP_CLASS_SETTINGS,
      scheduleOverride: new Map([
        ['國小數學-一A', [{ weekday: '一', start: 1080, end: 1170 }]],
        ['國小數學-一B', [{ weekday: '一', start: 1080, end: 1170 }]],
      ]),
    });
    expect(r.selection!.math!.tieBreak).toBe('max_positive_deduction');
    expect(r.selection!.math!.selectedBaseName).toBe('國小數學-一B');
    expect(r.careDays.tutoring.days).toBe(4.5);
  });

  it('關鍵反例：不計扣天不得靠「刪空時段」達成——有時段但不扣天，兩者結果相同、天數皆為 5', () => {
    const withSessions = calc('erp-tag-v3', true);
    // 反例組：完全相同的課表資料，只是不勾選 → 天數必須不同（4.5），證明旗標真的生效
    const withoutFlag = calc('erp-tag-v3', false);
    expect(withSessions.careDays.tutoring.days).toBe(5);
    expect(withoutFlag.careDays.tutoring.days).toBe(4.5);
    expect(withSessions.selection!.math!.anqinDeduction).toBe(0);
    expect(withoutFlag.selection!.math!.anqinDeduction).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. 唯讀預覽（schedule-preview）與狀態顯示
// ---------------------------------------------------------------------------

function previewDraft(skipDeduction?: boolean) {
  return {
    classes: [
      {
        baseName: '國小數學-一A',
        subject: '國小數學',
        teacher: '老師甲',
        active: true,
        sessions: [OVERLAP_SESSION],
        ...(skipDeduction === undefined ? {} : { skipDeduction, skipDeductionSource: 'manual' as const }),
      },
    ],
    aliases: [],
    careWindows: CARE,
    effectiveFrom: null,
    effectiveTo: null,
  };
}

describe('#113 預覽：勾選「不計扣天」的班級扣天為 0、狀態為不計扣天', () => {
  it('前置手算：未勾選時課輔重疊 90 分、raw −0.5、rounded −0.5', () => {
    const core = buildSchedulePreview(previewDraft() as never, 'erp-tag-v2');
    expect(core.classes[0].tutoring.totalOverlapMinutes).toBe(90);
    expect(core.classes[0].tutoring.raw).toBeCloseTo(-0.5, 12);
    expect(core.classes[0].tutoring.rounded).toBe(-0.5);
    expect(core.classes[0].tutoring.status).toBe('calculated');
  });

  it('勾選後：兩側重疊分鐘、raw、rounded 皆為 0，狀態為 no_deduction', () => {
    const core = buildSchedulePreview(previewDraft(true) as never, 'erp-tag-v2');
    for (const side of [core.classes[0].anqin, core.classes[0].tutoring]) {
      expect(side.totalOverlapMinutes).toBe(0);
      expect(side.raw).toBe(0);
      expect(side.rounded).toBe(0);
      expect(side.status).toBe('no_deduction');
    }
  });

  it('勾選後：時段保留（列與班級都不消失），逐堂仍有班名與起迄', () => {
    const core = buildSchedulePreview(previewDraft(true) as never, 'erp-tag-v2');
    expect(core.classes).toHaveLength(1);
    expect(core.rows).toHaveLength(1);
    expect(core.rows[0].classKey).toBe('國小數學-一A');
    expect(core.rows[0].startMinutes).toBe(1080);
    expect(core.rows[0].endMinutes).toBe(1170);
    expect(core.rows[0].durationMinutes).toBe(90);
  });

  it('勾選後：逐堂仍顯示實測重疊（重疊 90 分、raw −0.5）——政策與計算事實分開（D17）', () => {
    // 刻意與班級層不同：班級層是「真正影響天數的扣天」→ 歸零；
    // 逐堂層是「這堂確實重疊多少」→ 如實顯示。若逐堂也歸零，
    // 使用者會誤以為時段根本不衝突，那正是 D17「照實呈現」要避免的假象。
    const core = buildSchedulePreview(previewDraft(true) as never, 'erp-tag-v2');
    const row = core.rows[0];
    expect(row.tutoring.overlapMinutes).toBe(90);
    expect(row.tutoring.rawDeduction).toBeCloseTo(-0.5, 12);
    expect(row.tutoring.status).toBe('no_deduction');
    // 安親窗口（780–960）與 1080–1170 確實無交集
    expect(row.anqin.overlapMinutes).toBe(0);
    expect(row.anqin.status).toBe('no_deduction');
  });

  it('勾選後不產生任何問題清單項目', () => {
    const core = buildSchedulePreview(previewDraft(true) as never, 'erp-tag-v2');
    expect(core.issues).toEqual([]);
  });

  it('未勾選時預覽結果與旗標無關（負向保證：既有行為不變）', () => {
    const core = buildSchedulePreview(previewDraft(false) as never, 'erp-tag-v2');
    expect(core.classes[0].tutoring.totalOverlapMinutes).toBe(90);
    expect(core.classes[0].tutoring.rounded).toBe(-0.5);
    expect(core.classes[0].tutoring.status).toBe('calculated');
  });

  it('狀態合併：不計扣天優先於「無重疊」，但不被需確認／待補掩蓋（與「已計算」同層級）', () => {
    expect(combineCareStatuses('no_deduction', 'no_deduction')).toBe('no_deduction');
    expect(combineCareStatuses('no_deduction', 'no_overlap')).toBe('no_deduction');
    expect(combineCareStatuses('no_overlap', 'no_deduction')).toBe('no_deduction');
    // 同 rank（不計扣天 vs 已計算）保留第一引數＝安親側，與既有 unknown_weekday 的處理一致
    expect(combineCareStatuses('no_deduction', 'calculated')).toBe('no_deduction');
    expect(combineCareStatuses('calculated', 'no_deduction')).toBe('calculated');
    // 不可信狀態（需確認／待補）仍優先於「不計扣天」：那一列的資料本身就不可信
    expect(combineCareStatuses('no_deduction', 'unknown_weekday')).toBe('unknown_weekday');
    expect(combineCareStatuses('unknown_weekday', 'no_deduction')).toBe('unknown_weekday');
    expect(combineCareStatuses('incomplete', 'no_deduction')).toBe('incomplete');
    expect(combineCareStatuses('inactive', 'no_deduction')).toBe('inactive');
  });
});
