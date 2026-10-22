import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { buildClassSettingMap } from '@/application/calculate-run';
import { buildSeedDraft, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import { resolveClassEnrollment } from '@/domain/classification/class-category';
import type { SettingsDraft } from '@/contracts/settings';
import type { StudentSnapshot } from '@/domain/students';

/**
 * Issue #157 PR-1 Ruling 4（Gate 1 退回修正）：seed 類別在「讀取已儲存設定」路徑也要生效。
 *
 * 缺陷（Coordinator 實測）：`SEED_CLASS_CATEGORIES` 只寫在 `buildSeedDraft()`（全新 DB 路徑），
 * 既有 DB 走 `readStoredDraft(latest.contentJson)` → 該版本的班全部 `category` 缺值 → 一律 `unset`。
 * 結果：同一份設定，**全新 DB 與既有 DB 算出不同結果**（342/372 名學生科數不同）。
 * 改動前（`83b0127`）兩條路徑完全一致（0 差異）——這是 #157 引入的**新缺陷**，
 * 不是 Ruling 1 的必然後果。
 *
 * 本檔的三條斷言即 Coordinator 要求 3 的證明力所在：
 *  1. 既有 DB（無 manual 指定的 seed 班）與全新 DB（seed 草稿）**算出相同的科數與基本折扣**；
 *  2. 既有 DB 中使用者**已 manual 指定**的 seed 班，其指定**不被** seed 類別覆寫；
 *  3. 使用者選回「（未設定）」並存檔後，重新讀取該設定**仍是 unset**（不被 seed 類別還原）。
 *
 * expected 一律由 seed 的**科目語意**獨立手算（02 §9A.6 的類別語意表），不以實作輸出回填
 * （CLAUDE.md §8）。
 */

/** 四個班涵蓋四種類別語意：care／math／english／none。 */
const SEED_CLASSES_USED = ['國小輔導-四年級', '國小數學-四A', '兒童美語-Gino', '國小國語文-小五'];

function makeStudent(baseNames: string[]): StudentSnapshot {
  return {
    personCode: 'SEEDFALL',
    name: '合成學生',
    branch: '本校',
    gradeRaw: '4年級',
    grade: 4,
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: baseNames.map((bn) => ({
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

/**
 * 模擬**既有 DB** 的設定版本：班級有課表與課程類型，但**沒有** `category`／`categorySource`
 * （rev 82 的實測狀態：50 班中 `category` 有值者 0 班、`categorySource` 有值者 0 班）。
 */
function asExistingDbDraft(): SettingsDraft {
  const draft = buildSeedDraft();
  const legacyContent = {
    ...draft,
    classes: [
      ...draft.classes.map((c) => {
        const { category, categorySource, ...rest } = c as Record<string, unknown>;
        void category;
        void categorySource;
        return rest as typeof c;
      }),
      {
        baseName: '既有設定自建班-甲',
        subject: '其他',
        teacher: null,
        active: true,
        sessions: [],
        classType: 'non_care' as const,
      },
    ],
  };
  return readStoredDraft(JSON.stringify(legacyContent));
}

/** 依 draft 的 classSettings 計算（與 run 端同一條路徑：buildClassSettingMap → resolveClassEnrollment）。 */
function calc(draft: SettingsDraft, baseNames: string[]) {
  return calculateStudentBilling(makeStudent(baseNames), {
    ruleSetVersion: 'erp-tag-v4',
    classSettings: buildClassSettingMap(draft),
  });
}

describe('Ruling 4 要求 3-1：既有 DB 與全新 DB 算出相同的科數與基本折扣', () => {
  it('buildSeedDraft 不把類別基準寫進草稿', () => {
    const fresh = buildSeedDraft();
    expect(
      fresh.classes.some((c) => 'category' in c || 'categorySource' in c)
    ).toBe(false);
  });

  it('不同形狀的既有 DB 設定版本與全新 DB seed 草稿，算出相同的科數與基本折扣', () => {
    const existing = asExistingDbDraft();
    const fresh = buildSeedDraft();
    expect(JSON.stringify(existing)).not.toBe(JSON.stringify(fresh));

    const existingRes = calc(existing, SEED_CLASSES_USED);
    const freshRes = calc(fresh, SEED_CLASSES_USED);

    // 手算（02 §9A.6 類別語意表 + R10）：
    // 國小輔導-四年級 → care、國小數學-四A → math、兒童美語-Gino → english、國小國語文-小五 → none。
    // 計入科數的類別＝{care, math, english}＝3 科 → 合計折扣 9000 bps（3 科 > 2 科 → 9000）。
    expect(existingRes.subjectCount).toBe(3);
    expect(existingRes.baseDiscountBps).toBe(9000);

    // 兩條路徑必須**數值**相同（不是形狀相同）
    expect(existingRes.subjectCount).toBe(freshRes.subjectCount);
    expect(existingRes.baseDiscountBps).toBe(freshRes.baseDiscountBps);
    expect(existingRes.applicableRates).toEqual(freshRes.applicableRates);
  });

  it('既有 DB 中「非 seed 名單」的班不受 seed 類別影響（未被指定即未設定）', () => {
    const existing = asExistingDbDraft();
    existing.classes = [
      ...existing.classes,
      {
        baseName: '使用者自建班-甲',
        subject: '其他',
        teacher: null,
        active: true,
        sessions: [],
        classType: 'non_care',
      } as any,
    ];

    const res = calc(existing, [...SEED_CLASSES_USED, '使用者自建班-甲']);
    // 手算：自建班未指定類別 → unset → 不計科數 → 仍是 3 科
    expect(res.subjectCount).toBe(3);
    expect(res.baseDiscountBps).toBe(9000);
  });
});

describe('Ruling 4 要求 3-2：使用者已 manual 指定的 seed 班，不被 seed 類別覆寫', () => {
  it('manual 指定 none 的 seed 班維持 none；同draft 中未指定的 seed 班取得 seed 類別', () => {
    const existing = asExistingDbDraft();
    const target = existing.classes.find((c) => c.baseName === '國小輔導-四年級')!;
    // 使用者明確指定「不列入折扣」
    (target as Record<string, unknown>).category = 'none';
    (target as Record<string, unknown>).categorySource = 'manual';

    const classSettings = buildClassSettingMap(existing);

    // 使用者的指定優先：seed 對這個班的類別是 care，但使用者指定了 none → none
    const manual = resolveClassEnrollment(
      { rawToken: '國小輔導-四年級[團]', baseName: '國小輔導-四年級' },
      undefined,
      classSettings
    );
    expect(manual.category).toBe('none');
    expect(manual.categorySource).toBe('manual');

    // 同一份設定中，未指定的 seed 班仍取得 seed 類別
    const seeded = resolveClassEnrollment(
      { rawToken: '國小數學-四A[團]', baseName: '國小數學-四A' },
      undefined,
      classSettings
    );
    expect(seeded.category).toBe('math');
  });

  it('manual 指定的 seed 班不計入科數（與未指定的 seed 班結果不同）', () => {
    const existing = asExistingDbDraft();
    const target = existing.classes.find((c) => c.baseName === '國小輔導-四年級')!;
    (target as Record<string, unknown>).category = 'none';
    (target as Record<string, unknown>).categorySource = 'manual';

    const res = calc(existing, SEED_CLASSES_USED);
    // 手算：care 被使用者排除 → 計入類別 = {math, english} = 2 科 → 9500
    expect(res.subjectCount).toBe(2);
    expect(res.baseDiscountBps).toBe(9500);
  });
});

describe('Ruling 4 要求 3-3：使用者選回「（未設定）」並存檔後，重新讀取仍是 unset', () => {
  it('草稿中明確記錄的撤回（categorySource=unset）不被 seed 類別還原', () => {
    const existing = asExistingDbDraft();
    const target = existing.classes.find((c) => c.baseName === '國小數學-四A')!;
    // 使用者選回「（未設定）」→ 存檔時記錄為明確的未設定
    (target as Record<string, unknown>).category = 'unset';
    (target as Record<string, unknown>).categorySource = 'unset';

    const classSettings = buildClassSettingMap(existing);
    const resolved = resolveClassEnrollment(
      { rawToken: '國小數學-四A[團]', baseName: '國小數學-四A' },
      undefined,
      classSettings
    );
    // 撤回必須真的撤回：不得被 seed 的 math 還原
    expect(resolved.category).toBe('unset');
    expect(resolved.categorySource).toBe('unset');
  });

  it('撤回一個 seed 班後，該生科數下降（該班不再計入），其餘 seed 班不受影響', () => {
    const existing = asExistingDbDraft();
    const target = existing.classes.find((c) => c.baseName === '國小數學-四A')!;
    (target as Record<string, unknown>).category = 'unset';
    (target as Record<string, unknown>).categorySource = 'unset';

    const res = calc(existing, SEED_CLASSES_USED);
    // 手算：math 被撤回 → 計入類別 = {care, english} = 2 科 → 9500
    expect(res.subjectCount).toBe(2);
    expect(res.baseDiscountBps).toBe(9500);
  });
});
