import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { StudentSnapshot } from '@/domain/students/types';
import type { ClassSettingLookup } from '@/domain/classification/class-category';

/**
 * D2d F：parity policy gate 的**可重複執行閘門**與其**鑑別力證明**。
 *
 * ── 為什麼要有這個檔 ──
 * PR #45 的兩位 reviewer 都指出（receipt -216／-244）同一件事：
 *  `d2c-parity-gate.test.ts` 的「表外差異偵測」抓不到表外差異——
 *   - `:382` 的 `added.filter(c => !白名單.includes(c))` 在 `added` 為空時恆為 `[]` 而通過；
 *     而該案例用的是 `none` 類的「交通車」，v3 依 D-04-b 不新增 issue，`added` 恆空。
 *   - 「逐欄」只覆蓋部分欄位：級距只有 `tierMismatch`（布林）與 `tierStatuses`（集合字串），
 *     **沒有逐列的 `tiers`（computedTier／status／needsReview）**。
 *
 * 實測（D2d 進行中，14 個合成情境）顯示：現有規則下 `tiers` 總與其它欄位同向變動，
 * 所以「缺 tiers」尚未產生**實際**的表外漏判；它是**未來規則變動時的盲區**。
 * 因此本檔的目標不是找一個現存漏判，而是：
 *   (1) 提供一個**可在 CI 重複執行**的閘門，比較面涵蓋 S §6.0 的全部業務欄位（含 tiers）；
 *   (2) **證明這個閘門會失敗**——以注入一個表外差異，讓閘門必須報出它。
 *       若閘門漏掉該欄位，測試本身就會失敗（這正是 reviewer 指出的無鑑別力症狀）。
 */

/** S manifest §6.0：比較的業務欄位（完整 12 項；不比較 runId／建立時間／ruleSetVersion／trace 識別）。 */
export const COMPARED_FIELDS = [
  'anqinDays',
  'tutoringDays',
  'subjectCount',
  'baseDiscountBps',
  'applicableAnqinBps',
  'applicableTutoringBps',
  'applicableMathBps',
  'applicableEnglishBps',
  'tierMismatch',
  'tierStatuses',
  'tiers',
  'issueCodes',
] as const;

export type ComparedField = (typeof COMPARED_FIELDS)[number];
export type BusinessFields = Record<ComparedField, unknown>;

/** S §6.1 差異表允許「新增的 issue code」（D-05 CLASS_NOT_MAPPED／D-07 SCHEDULE_NOT_FOUND）。 */
export const ALLOWED_NEW_ISSUE_CODES = ['CLASS_NOT_MAPPED', 'SCHEDULE_NOT_FOUND'] as const;

export function baseSnapshot() {
  return {
    aliasMap: new Map<string, string>(),
    scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>(),
    classSettings: new Map<string, ClassSettingLookup>(),
  };
}

export function makeStudent(params: {
  personCode?: string;
  grade?: number | null;
  tagsRaw?: string;
  notesRaw?: string;
  enrollments: Array<{ rawToken: string; baseName: string }>;
}): StudentSnapshot {
  return {
    personCode: params.personCode ?? 'P001',
    name: '合成學生',
    branch: null,
    grade: params.grade ?? 4,
    gradeRaw: String(params.grade ?? 4),
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: params.tagsRaw ?? '',
    tags: [],
    notesRaw: params.notesRaw ?? '',
    sourceRow: 1,
    enrollments: params.enrollments.map((e) => ({
      rawToken: e.rawToken,
      baseName: e.baseName,
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

/** 抽取 S §6.0 的完整業務欄位；逐列級距以三元組保留，不塌縮成布林。 */
export function businessFields(
  result: ReturnType<typeof calculateStudentBilling>
): BusinessFields {
  return {
    anqinDays: result.careDays.anqin.days,
    tutoringDays: result.careDays.tutoring.days,
    subjectCount: result.subjectCount,
    baseDiscountBps: result.baseDiscountBps,
    applicableAnqinBps: result.applicableRates.anqin,
    applicableTutoringBps: result.applicableRates.tutoring,
    applicableMathBps: result.applicableRates.math,
    applicableEnglishBps: result.applicableRates.english,
    tierMismatch: result.tierComparisons.some((c) => c.status === 'mismatch'),
    tierStatuses: result.tierComparisons.map((c) => c.status).sort().join(','),
    tiers: result.tierComparisons.map((c) => [c.computedTier, c.status, c.needsReview]),
    issueCodes: [...new Set(result.issues.map((i) => i.code))].sort(),
  };
}

export function compareVersions(
  student: StudentSnapshot,
  opts: ReturnType<typeof baseSnapshot>
): { v2: BusinessFields; v3: BusinessFields } {
  return {
    v2: businessFields(calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v2' })),
    v3: businessFields(
      calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v3' as never })
    ),
  };
}

export interface OffTableDiff {
  field: ComparedField;
  v2: unknown;
  v3: unknown;
}

/**
 * 閘門本體：回傳所有「有差異且不在允許清單內」的欄位。
 * 允許清單為空時，任何差異都是表外 → 閘門必然回報（非空集合）。
 */
export function findOffTableDiffs(
  v2: BusinessFields,
  v3: BusinessFields,
  allowedFields: ReadonlySet<ComparedField>
): OffTableDiff[] {
  return COMPARED_FIELDS.filter(
    (f) => JSON.stringify(v2[f]) !== JSON.stringify(v3[f]) && !allowedFields.has(f)
  ).map((f) => ({ field: f, v2: v2[f], v3: v3[f] }));
}

/** issue code 層的表外判定：D-05／D-07 之外的新增 code 即表外。 */
export function findOffTableNewIssueCodes(v2: BusinessFields, v3: BusinessFields): string[] {
  const before = (v2.issueCodes as string[]) ?? [];
  return ((v3.issueCodes as string[]) ?? []).filter(
    (c) => !before.includes(c) && !ALLOWED_NEW_ISSUE_CODES.includes(c as never)
  );
}

describe('D2d F: parity gate 涵蓋 S §6.0 全部業務欄位', () => {
  it('比較面含 12 項業務欄位，且含逐列級距 tiers', () => {
    expect(COMPARED_FIELDS).toHaveLength(12);
    expect(COMPARED_FIELDS).toContain('tiers');
    expect(COMPARED_FIELDS).toContain('tierMismatch');
    expect(COMPARED_FIELDS).toContain('tierStatuses');
  });

  it('抽取器保留逐列級距三元組，不塌縮成布林', () => {
    const student = makeStudent({
      enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
    });
    const f = businessFields(
      calculateStudentBilling(student, {
        ...baseSnapshot(),
        ruleSetVersion: 'erp-tag-v2',
        scheduleOverride: new Map([
          ['國小數學-四A', [{ weekday: '一', start: 990, end: 1080 }]],
        ]),
      })
    );
    // 逐列三元組，而非單一布林
    expect(Array.isArray(f.tiers)).toBe(true);
    expect((f.tiers as unknown[])[0]).toHaveLength(3);
  });

  it('D-01 案例：逐列級距差異確實被比較面捕捉（不是靠 mismatch 布林）', () => {
    const student = makeStudent({
      enrollments: [
        { rawToken: '兒童美語-甲', baseName: '兒童美語-甲' },
        { rawToken: '兒童美語-乙', baseName: '兒童美語-乙' },
      ],
    });
    const opts = {
      ...baseSnapshot(),
      scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
        ['兒童美語-甲', [{ weekday: '一', start: 990, end: 1080 }]],
        ['兒童美語-乙', [{ weekday: '二', start: 990, end: 1140 }]],
      ]),
    };
    const { v2, v3 } = compareVersions(student, opts);
    // 手算（D24；課輔窗口 990–1170，每日 180 分；課輔特例重疊≥120 且 1110<end<1170）：
    //   甲 重疊 90 分 → raw −0.5 → rounded −0.5 → 課輔 5−0.5 = 4.5
    //   乙 重疊 150 分、end 1140 → 特例 −1 → 課輔 5−1 = 4
    expect(v2.tutoringDays).toBe(4.5);
    expect(v3.tutoringDays).toBe(4);
    // mismatch 布林兩版皆 false（級距為 not_applicable）→ 單靠布林抓不到，必須靠 tiers
    expect(v2.tierMismatch).toBe(false);
    expect(v3.tierMismatch).toBe(false);
    expect(JSON.stringify(v2.tiers)).not.toBe(JSON.stringify(v3.tiers));
  });
});

describe('D2d F: 閘門的鑑別力證明（注入表外差異必須被報出）', () => {
  /** 取得一組「v2／v3 確實有差異」的基準結果。 */
  function diffingPair() {
    const student = makeStudent({
      enrollments: [
        { rawToken: '兒童美語-甲', baseName: '兒童美語-甲' },
        { rawToken: '兒童美語-乙', baseName: '兒童美語-乙' },
      ],
    });
    return compareVersions(student, {
      ...baseSnapshot(),
      scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
        ['兒童美語-甲', [{ weekday: '一', start: 990, end: 1080 }]],
        ['兒童美語-乙', [{ weekday: '二', start: 990, end: 1140 }]],
      ]),
    });
  }

  it('允許清單為空時，閘門必須報出所有差異欄位（證明不是空集合恆過）', () => {
    const { v2, v3 } = diffingPair();
    const diffs = findOffTableDiffs(v2, v3, new Set());
    // D-01 至少造成 tutoringDays 與 tiers 差異
    expect(diffs.map((d) => d.field)).toContain('tutoringDays');
    expect(diffs.map((d) => d.field)).toContain('tiers');
    // 關鍵：閘門在有差異且未允許時必須回報非空
    expect(diffs.length).toBeGreaterThan(0);
  });

  it('注入：只在 tiers 有差異（其他欄位手動抹平）時，閘門仍必須抓到 tiers', () => {
    const { v2, v3 } = diffingPair();
    // 模擬現行 gate 的盲區：把其他欄位都設成與 v2 相同，只留 tiers 不同。
    // 若閘門的比較面沒有 tiers（像 d2c 的舊抽取器），此案例就抓不到 → 本條失敗。
    const injected: BusinessFields = {
      ...v3,
      anqinDays: v2.anqinDays,
      tutoringDays: v2.tutoringDays,
      subjectCount: v2.subjectCount,
      baseDiscountBps: v2.baseDiscountBps,
      applicableAnqinBps: v2.applicableAnqinBps,
      applicableTutoringBps: v2.applicableTutoringBps,
      applicableMathBps: v2.applicableMathBps,
      applicableEnglishBps: v2.applicableEnglishBps,
      tierMismatch: v2.tierMismatch,
      tierStatuses: v2.tierStatuses,
      issueCodes: v2.issueCodes,
    };
    const diffs = findOffTableDiffs(v2, injected, new Set());
    expect(diffs.map((d) => d.field)).toEqual(['tiers']);
  });

  it('注入：白名單外的 issue code 必須被報出（D-05／D-07 之外即表外）', () => {
    const base = diffingPair();
    const injected: BusinessFields = {
      ...base.v3,
      issueCodes: ['CLASS_NOT_MAPPED', 'OFF_TABLE_CODE'],
    };
    expect(findOffTableNewIssueCodes(base.v2, injected)).toEqual(['OFF_TABLE_CODE']);
  });

  it('注入：白名單內的 code 不算表外', () => {
    const base = diffingPair();
    const injected: BusinessFields = {
      ...base.v3,
      issueCodes: ['CLASS_NOT_MAPPED', 'SCHEDULE_NOT_FOUND'],
    };
    expect(findOffTableNewIssueCodes(base.v2, injected)).toEqual([]);
  });

  it('D24 實際斷言：兩種重疊必須得到不同扣天（不可丟棄變數）', () => {
    const mk = (start: number, end: number, personCode: string) =>
      businessFields(
        calculateStudentBilling(
          makeStudent({
            personCode,
            enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
          }),
          {
            ...baseSnapshot(),
            ruleSetVersion: 'erp-tag-v2',
            scheduleOverride: new Map([['國小數學-四A', [{ weekday: '一', start, end }]]]),
          }
        )
      );
    // 課輔窗口 990–1170：重疊 54 分 → f=0.3 → 0.5；重疊 36 分 → f=0.2 → 0
    const half = mk(990, 1044, 'D24-HALF');
    const zero = mk(990, 1026, 'D24-ZERO');
    // 兩種重疊的逐列級距必須不同 → 證明 D24 取整真的生效，而非兩版都回 0
    expect(half.tutoringDays).not.toBe(zero.tutoringDays);
    expect(JSON.stringify(half.tiers)).not.toBe(JSON.stringify(zero.tiers));
  });
});
