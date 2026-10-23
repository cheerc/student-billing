import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { calculateSubjectCountByCategory } from '@/domain/billing/discount-rules';
import {
  resolveClassEnrollment,
  type ClassCategory,
  type ClassSettingLookup,
} from '@/domain/classification/class-category';
import {
  CATEGORY_LABELS,
  carryAttributesOnRename,
  resolveClassAttributes,
  type ClassAttributesView,
} from '@/domain/classification/class-attributes';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import type { ScheduleGridRow } from '@/contracts/settings';
import type { StudentSnapshot } from '@/domain/students';

/**
 * Issue #157 PR-1：班級類別「未設定」（`unset`）語意與計算核心。
 *
 * 授權：Issue #157 Expected Outcome 第 3 條（「兩個選項的預設值皆由使用者決定，班名不參與判定」）
 * ＋ Coordinator Rulings 1–5（comment 6311885500）＋ specs/06 D53。
 *
 * 本檔的 expected **一律由規格條文獨立手算**，不以被測函式輸出回填（CLAUDE.md §8）：
 *  - Ruling 2 的語意表：`care`/`math`/`english` 計入科數；`none` 與 `unset` 皆不計入，
 *    兩者計算結果相同、只有來源狀態不同。
 *  - Ruling 3：未對應班一律 `unset`、`mapped=false`，且**不論班名為何**一律產生 `CLASS_NOT_MAPPED`；
 *    該班對折扣與天數影響為零。
 *  - Ruling 4：`categorySource` 值域為 `'manual' | 'unset'`，`auto` 與其整條路徑拆除。
 *  - Ruling 5：`category` 存在但來源為 `auto` 者視為 `unset`（不把舊推導值升格為使用者決定）。
 *
 * 班名刻意選用**舊制會被自動偵測成 care／math／english／none 的四種寫法**，
 * 讓「不再依班名判定」這件事在斷言上可辨識（若仍殘留偵測，這裡會直接抓到）。
 */

function makeStudent(params: {
  personCode: string;
  grade: number;
  baseNames: string[];
  tagsRaw?: string;
}): StudentSnapshot {
  return {
    personCode: params.personCode,
    name: `學生${params.personCode}`,
    branch: '本校',
    gradeRaw: `${params.grade}年級`,
    grade: params.grade,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: params.tagsRaw ?? '',
    tags: params.tagsRaw ? params.tagsRaw.split(/[,;\s]+/).filter(Boolean) : [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: params.baseNames.map((bn) => ({
      rawToken: `${bn}[團]`,
      yearPrefix: null,
      baseName: bn,
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    })),
  };
}

/** 使用者明確指定的類別（`manual`）——Rule 2：只有這種才有折扣語意。 */
function manual(category: ClassCategory, fixedFiveDays = false): ClassSettingLookup {
  return { category, categorySource: 'manual', fixedFiveDays };
}

describe('Ruling 3：未對應課表的班一律 unset、mapped=false，且一律產生 CLASS_NOT_MAPPED', () => {
  // 四種班名分別對應舊制的 care／math／english／none。Ruling 3 明文要求「不論班名為何」。
  const CASES: Array<[string, string]> = [
    ['國小輔導-四年級', '舊制會偵測為 care'],
    ['國小數學-四A', '舊制會偵測為 math'],
    ['兒童美語-Gino', '舊制會偵測為 english'],
    ['交通車', '舊制會偵測為 none（且靜默不警告）'],
  ];

  for (const [baseName, why] of CASES) {
    it(`「${baseName}」未收錄於課表設定 → category=unset、categorySource=unset、mapped=false（${why}）`, () => {
      const r = resolveClassEnrollment({ rawToken: `${baseName}[團]`, baseName }, undefined, new Map());
      expect(r.category).toBe('unset');
      expect(r.categorySource).toBe('unset');
      expect(r.mapped).toBe(false);
      // Ruling 3：未對應班不觸發天數地板
      expect(r.fixedFiveDays).toBe(false);
    });

    it(`「${baseName}」未對應時一律產生 CLASS_NOT_MAPPED（${why}）`, () => {
      const res = calculateStudentBilling(makeStudent({ personCode: 'U1', grade: 4, baseNames: [baseName] }), {
        ruleSetVersion: 'erp-tag-v4',
        classSettings: new Map(),
      });
      expect(res.issues.some((i) => i.code === 'CLASS_NOT_MAPPED')).toBe(true);
    });
  }

  it('未對應班對有效科數與基本折扣的影響為零（與「該班不在名單報名」結果相同）', () => {
    const settings = new Map<string, ClassSettingLookup>([['國小輔導-四年級', manual('care')]]);
    // 對照組：只有一個使用者明確指定的 care 班
    const onlySpecified = calculateStudentBilling(
      makeStudent({ personCode: 'U2', grade: 4, baseNames: ['國小輔導-四年級'] }),
      { ruleSetVersion: 'erp-tag-v4', classSettings: settings }
    );
    // 實驗組：同一個 care 班，外加四個未對應的班（舊制分別會被偵測成 care/math/english/none）
    const plusUnmapped = calculateStudentBilling(
      makeStudent({
        personCode: 'U2',
        grade: 4,
        baseNames: ['國小輔導-四年級', '國小輔導-未收錄', '國小數學-未收錄', '兒童美語-未收錄', '交通車'],
      }),
      { ruleSetVersion: 'erp-tag-v4', classSettings: settings }
    );

    // 手算：兩側都只有 1 個折扣類別（care）→ 科數 1 → 基本率 10000（1 科無折扣）。
    // 若未對應班仍被班名推導出 math／english，科數會變成 3 → 9000，這裡就會抓到。
    expect(onlySpecified.subjectCount).toBe(1);
    expect(plusUnmapped.subjectCount).toBe(1);
    expect(onlySpecified.baseDiscountBps).toBe(10000);
    expect(plusUnmapped.baseDiscountBps).toBe(10000);
    expect(plusUnmapped.applicableRates).toEqual(onlySpecified.applicableRates);
  });

  it('未對應班不觸發天數地板：小四報名兩班未對應課表 → 課輔 5 天（無扣天、無固定 5 天）', () => {
    const res = calculateStudentBilling(
      makeStudent({ personCode: 'U3', grade: 4, baseNames: ['國小輔導-四年級', '國小數學-四A'] }),
      { ruleSetVersion: 'erp-tag-v4', classSettings: new Map() }
    );
    expect(res.careDays.tutoring.days).toBe(5);
  });
});

describe('Ruling 1 & 2：已對應但未指定類別 → unset，且不計入科數', () => {
  it('已收錄於課表設定、但沒有任何 category 欄位的**非 seed 班** → unset / unset', () => {
    // 用非 seed 的班名（「合成自建班-甲」不在 seed 49 班內），以驗「沒有使用者的指定就是未設定」。
    // seed 班的未指定情況另見 issue-157-seed-category-fallback.test.ts（seed 基準）。
    const r = resolveClassEnrollment(
      { rawToken: '合成自建班-甲[團]', baseName: '合成自建班-甲' },
      undefined,
      new Map<string, ClassSettingLookup>([['合成自建班-甲', {}]])
    );
    expect(r.mapped).toBe(true);
    expect(r.category).toBe('unset');
    expect(r.categorySource).toBe('unset');
  });

  it('已收錄但未指定類別的**非 seed 班**不計入科數（不得由班名推導）', () => {
    const res = calculateStudentBilling(
      makeStudent({ personCode: 'M1', grade: 4, baseNames: ['合成自建班-甲', '合成自建班-乙'] }),
      {
        ruleSetVersion: 'erp-tag-v4',
        classSettings: new Map<string, ClassSettingLookup>([
          ['合成自建班-甲', {}],
          ['合成自建班-乙', {}],
        ]),
      }
    );
    // 手算：兩班皆 unset → 0 科 → 基本率 10000
    expect(res.subjectCount).toBe(0);
    expect(res.baseDiscountBps).toBe(10000);
    // 已對應 → 不是 CLASS_NOT_MAPPED（該警告只針對「班名未對應課表」）
    expect(res.issues.some((i) => i.code === 'CLASS_NOT_MAPPED')).toBe(false);
  });

  it('seed 班未指定類別 → 套用 seed 基準（機構既有設定），來源標記為 seed 而非 manual', () => {
    const r = resolveClassEnrollment(
      { rawToken: '國小數學-四A[團]', baseName: '國小數學-四A' },
      undefined,
      new Map<string, ClassSettingLookup>([['國小數學-四A', {}]])
    );
    expect(r.mapped).toBe(true);
    expect(r.category).toBe('math');
    // seed 基準**不是**使用者的決定（#157 Ruling 4／Ruling 5）
    expect(r.categorySource).toBe('seed');
  });

  it('current category count excludes unset and none from the discount subject set', () => {
    // 手算：care + math + english = 3 科；再加 unset 與 none 不會增加
    expect(calculateSubjectCountByCategory(['care', 'math', 'english'])).toBe(3);
    expect(calculateSubjectCountByCategory(['care', 'math', 'english', 'unset'])).toBe(3);
    expect(calculateSubjectCountByCategory(['care', 'unset', 'none'])).toBe(1);
    expect(calculateSubjectCountByCategory(['unset'])).toBe(0);
    expect(calculateSubjectCountByCategory(['unset', 'none'])).toBe(0);
  });
});

describe('Ruling 2：使用者明確指定 none 與 unset「計算結果相同、來源不同」', () => {
  it('同一學生，某班 manual=none 與該班 unset：科數與基本折扣逐欄相同', () => {
    const student = makeStudent({ personCode: 'N1', grade: 4, baseNames: ['交通車', '國小輔導-四年級'] });

    const withManualNone = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4',
      classSettings: new Map<string, ClassSettingLookup>([
        ['交通車', manual('none')],
        ['國小輔導-四年級', manual('care')],
      ]),
    });
    const withUnset = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4',
      classSettings: new Map<string, ClassSettingLookup>([['國小輔導-四年級', manual('care')]]),
    });

    // 手算：care = 1 科 → 9500，兩者相同（none 與 unset 都不計科數）
    expect(withManualNone.subjectCount).toBe(1);
    expect(withUnset.subjectCount).toBe(1);
    expect(withManualNone.baseDiscountBps).toBe(withUnset.baseDiscountBps);
    expect(withManualNone.careDays.tutoring.days).toBe(withUnset.careDays.tutoring.days);
  });

  it('來源狀態不同：manual=none → categorySource=manual；未指定 → categorySource=unset', () => {
    const manualNone = resolveClassEnrollment(
      { rawToken: '交通車', baseName: '交通車' },
      undefined,
      new Map<string, ClassSettingLookup>([['交通車', manual('none')]])
    );
    const unspecified = resolveClassEnrollment(
      { rawToken: '交通車', baseName: '交通車' },
      undefined,
      new Map<string, ClassSettingLookup>([['交通車', {}]])
    );

    expect(manualNone.category).toBe('none');
    expect(manualNone.categorySource).toBe('manual');
    expect(unspecified.category).toBe('unset');
    expect(unspecified.categorySource).toBe('unset');
  });

  it('使用者明確指定 care 時才計入科數（單一班名相同、來源不同 → 結果不同）', () => {
    const student = makeStudent({ personCode: 'N2', grade: 4, baseNames: ['合成自建班-甲'] });
    const specified = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4',
      classSettings: new Map<string, ClassSettingLookup>([['合成自建班-甲', manual('care')]]),
    });
    const unspecified = calculateStudentBilling(student, {
      ruleSetVersion: 'erp-tag-v4',
      classSettings: new Map<string, ClassSettingLookup>([['合成自建班-甲', {}]]),
    });
    // 手算：care = 1 科 → 10000；unset = 0 科 → 10000（0 科也是基本率）；但種類數不同
    expect(specified.subjectCount).toBe(1);
    expect(unspecified.subjectCount).toBe(0);
  });
});

describe('Ruling 5：已儲存設定中 category 存在但來源為 auto → 視為 unset', () => {
  it('舊資料 categorySource="auto" 的 category 不得升格為使用者決定（非 seed 班）', () => {
    const r = resolveClassEnrollment(
      { rawToken: '合成自建班-甲[團]', baseName: '合成自建班-甲' },
      undefined,
      // 舊設定：有 category 值，但來源是系統推導的 auto
      new Map<string, ClassSettingLookup>([
        ['合成自建班-甲', { category: 'math', categorySource: 'auto' as never }],
      ])
    );
    expect(r.category).toBe('unset');
    expect(r.categorySource).toBe('unset');
  });

  it('resolveClassAttributes：舊 auto 來源的已存值同樣視為未設定（非 seed 班）', () => {
    const attrs = resolveClassAttributes('合成自建班-甲', {
      category: 'math',
      categorySource: 'auto' as never,
    });
    expect(attrs.category).toBe('unset');
    expect(attrs.categorySource).toBe('unset');
  });

  it('resolveClassAttributes：manual 的已存值原樣保留', () => {
    const attrs = resolveClassAttributes('國小數學-四A', { category: 'math', categorySource: 'manual' });
    expect(attrs.category).toBe('math');
    expect(attrs.categorySource).toBe('manual');
  });

  it('resolveClassAttributes：非 seed 班缺 category 時回 unset，且不依班名偵測', () => {
    for (const name of ['合成自建班-甲', '合成自建班-乙', '交通車-東區']) {
      const attrs = resolveClassAttributes(name);
      expect(attrs.category, name).toBe('unset');
      expect(attrs.categorySource, name).toBe('unset');
    }
  });

  it('seed 班的舊 auto 值同樣不採用——改用 seed 基準（來源為 seed，非 manual）', () => {
    const attrs = resolveClassAttributes('國小數學-四A', {
      category: 'math',
      categorySource: 'auto' as never,
    });
    // 舊 auto 推導值不得升格為使用者的決定；seed 基準是機構既有設定，兩者可採其一但來源必須如實
    expect(attrs.category).toBe('math');
    expect(attrs.categorySource).toBe('seed');
  });
});

describe('Ruling 4：類別顯示名稱與下拉必須能表達「未設定」', () => {
  it('CATEGORY_LABELS 涵蓋五個值，unset 的白話名稱是「未設定」語意（不得為「不列入折扣」）', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual(['care', 'english', 'math', 'none', 'unset']);
    expect(CATEGORY_LABELS.none).toBe('不列入折扣');
    expect(CATEGORY_LABELS.unset).not.toBe(CATEGORY_LABELS.none);
    expect(CATEGORY_LABELS.unset).toContain('未設定');
  });

  it('課表下拉：未指定的班顯示 unset（不是把未設定偽裝成「不列入折扣」）', () => {
    const rows: ScheduleGridRow[] = [
      {
        rowId: 'r1',
        className: '國小數學-四A',
        teacher: null,
        weekday: '一',
        startTime: '16:30',
        endTime: '18:00',
        startMinutes: 990,
        endMinutes: 1080,
        active: true,
        skipDeduction: false,
      },
    ];
    const attrs = new Map<string, ClassAttributesView>([
      ['國小數學-四A', { classType: 'non_care', category: 'unset', categorySource: 'unset', fixedFiveDays: false }],
    ]);

    const html = renderToStaticMarkup(
      React.createElement(ScheduleGrid, {
        rows,
        onUpdateRow: () => {},
        onDeleteRow: () => {},
        onAddRow: () => {},
        calculating: false,
        calculateResult: null,
        classAttributes: attrs,
        onSelectCategory: () => {},
        onToggleFixedFiveDays: () => {},
      })
    );

    // 這就是舊 `value={attr?.category ?? 'none'}` 的錯誤呈現：未設定被畫成「不列入折扣」
    expect(html).toContain('<option value="unset" selected=""');
    expect(html).not.toContain('<option value="none" selected=""');
    expect(html).toContain(CATEGORY_LABELS.unset);
  });
});

describe('Ruling 4：整班改名後 unset 仍是 unset，不得依新名重新偵測', () => {
  it('未指定的班改名為含「國小輔導」的新名 → 仍為 unset（不得變成 care）', () => {
    const before = new Map<string, ClassAttributesView>([
      ['交通車', { classType: 'non_care', category: 'unset', categorySource: 'unset', fixedFiveDays: false }],
    ]);
    const baseline = new Map(before);

    const out = carryAttributesOnRename(
      [{ from: '交通車', to: '國小輔導-新班' }],
      before,
      baseline
    );

    expect(out.get('國小輔導-新班')?.category).toBe('unset');
    expect(out.get('國小輔導-新班')?.categorySource).toBe('unset');
  });

  it('seed 班改名到非 seed 班名時，立刻變成明確 unset，與存檔後讀取值一致', () => {
    const before = new Map<string, ClassAttributesView>([
      ['國小數學-四A', resolveClassAttributes('國小數學-四A')],
    ]);
    const out = carryAttributesOnRename(
      [{ from: '國小數學-四A', to: '國小數學-四A新名' }],
      before,
      new Map(before)
    );

    expect(out.get('國小數學-四A')?.category).toBe('math');
    expect(out.get('國小數學-四A新名')?.category).toBe('unset');
    expect(out.get('國小數學-四A新名')?.categorySource).toBe('unset');
  });

  it('兩個相同 seed 類別合併至非 seed 班名時，新班即顯示明確 unset', () => {
    const before = new Map<string, ClassAttributesView>([
      ['國小數學-四A', resolveClassAttributes('國小數學-四A')],
      ['國小數學-四B', resolveClassAttributes('國小數學-四B')],
    ]);
    const out = carryAttributesOnRename(
      [
        { from: '國小數學-四A', to: '國小數學-四年級合班' },
        { from: '國小數學-四B', to: '國小數學-四年級合班' },
      ],
      before,
      new Map(before),
      new Set(before.keys())
    );

    expect(out.get('國小數學-四年級合班')?.category).toBe('unset');
    expect(out.get('國小數學-四年級合班')?.categorySource).toBe('unset');
  });

  it('手動指定的值隨班帶走（manual 不因改名而變）', () => {
    const before = new Map<string, ClassAttributesView>([
      ['國小數學-四A', { classType: 'non_care', category: 'math', categorySource: 'manual', fixedFiveDays: false }],
    ]);
    const out = carryAttributesOnRename(
      [{ from: '國小數學-四A', to: '國小數學-四A改名' }],
      before,
      new Map(before)
    );
    expect(out.get('國小數學-四A改名')?.category).toBe('math');
    expect(out.get('國小數學-四A改名')?.categorySource).toBe('manual');
  });
});
