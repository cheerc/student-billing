/**
 * #189 D62 Phase 2 rework r2（F2）— 存檔管線層的不變式。
 *
 * 這一檔證明的是「草稿轉換管線把 unset 屬性寫成 unset，且計算因此不計科數」。
 * **F2 的行為 RED 在 `settings-editor-sync-rework.test.tsx`**：那條測試掛載 `SettingsEditor`、
 * 按真正的「暫存新增」，再斷言送出的 preview 草稿；把 `handleStageNewClass` 的
 * `category/categorySource` 改回 `deriveEffectiveCategory(..., 'manual')` 時它會轉紅。
 * 本檔的屬性由測試自己組（見下方 `newClassAttrs`），所以它對元件的屬性投影沒有鑑別力——
 * 它的價值是把手算的計費差異（10000 vs 9500）固定下來，避免日後把 unset 誤解成「等效 none」。
 *
 * F2 規格依據（specs/17 §2.2「類別維持既有 initialCategory: 'unset' 行為（UX95）」）：
 * 「新增為課表班級」只問課程類型，**不得**替使用者決定折扣類別。使用者沒選類別就是 `unset`，
 * 因此在計算上不計入科數——同一名學生同時報名「新班＋既有美語班」時，基本折扣必須仍是
 * 10000（單科），不能變成 9500（系統替他套上多科折扣，D17 的反面）。
 *
 * 手算（R10；不用被測函式輸出當黃金標準）：
 *  - 新班類別 unset → 折扣類別集合 {} → 科數 0 → 基本折扣 10000。
 *  - 新班類別若被寫成 math → 折扣類別集合 {math, english} → 科數 2 → 基本折扣 9500。
 * 下面第二條測試就是拿後者當**對照**，說明差異不是憑空宣稱的。
 */
import { describe, it, expect } from 'vitest';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import {
  gridRowsToClasses,
  buildSeedGridRows,
  SettingsDraftSchema,
  supportsMultiSubjectDiscount,
  type ClassType,
} from '@/contracts/settings';
import { applyManualAttrsToClasses } from '@/domain/classification/persist-class-attributes';
import { stageNewClassFromRoster } from '@/domain/schedules/class-name-sync';
import { buildClassSettingMap } from '@/application/calculate-run';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import type { StudentSnapshot } from '@/domain/students/types';
import type { ClassAttributesView } from '@/domain/classification/class-attributes';

/**
 * 與 `settings-editor.tsx` 的 `handleStageNewClass` 相同的屬性投影：
 * 只問課程類型，類別維持 `unset`（`categorySource: 'unset'`），`classType` 記為使用者選擇。
 * 注意：本檔自行組這份屬性，因此它**不會**在元件改回 manual 時轉紅；
 * 那一條鑑別力在 `settings-editor-sync-rework.test.tsx` 的 F2 測試。
 */
function newClassAttrs(classType: ClassType): ClassAttributesView {
  const resolvedType: ClassType = classType === ('non_care' as ClassType) ? 'other' : classType;
  return {
    classType: resolvedType,
    category: 'unset',
    categorySource: 'unset',
    hasMultiSubjectDiscount: supportsMultiSubjectDiscount(resolvedType),
    fixedFiveDays: false,
  };
}

/** 走「暫存新增 → 存檔草稿」的正式轉換管線（gridRowsToClasses → applyManualAttrsToClasses）。 */
function buildNewClassDraft(erpBaseName: string, classType: ClassType, attrs = newClassAttrs(classType)) {
  const seed = buildSeedDraft();
  const staged = stageNewClassFromRoster(buildSeedGridRows(), { erpBaseName, classType });
  const classes = applyManualAttrsToClasses(
    gridRowsToClasses(staged.rows, seed.classes),
    new Map([[erpBaseName, attrs]])
  );
  return { draft: { ...seed, classes }, classes };
}

/** 合成學生：grade 4（課輔側），報名新班與既有美語班各一。 */
function twoEnrollmentStudent(classNames: string[]): StudentSnapshot {
  return {
    personCode: 'P001',
    name: '合成學生',
    branch: null,
    grade: 4,
    gradeRaw: '4',
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: classNames.map((b) => ({
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

describe('#189 D62 F2：新增名冊班級的類別維持 unset，不替使用者套折扣', () => {
  it('新增數學班後，存檔草稿的類別是 unset（classType 仍是使用者選的 math）', () => {
    const { draft, classes } = buildNewClassDraft('安親新生班', 'math');
    const cls = classes.find((c) => c.baseName === '安親新生班');

    expect(cls).toBeDefined();
    expect(cls!.classType).toBe('math');
    expect(cls!.category).toBe('unset');
    expect(cls!.categorySource).toBe('unset');
    expect(cls!.fixedFiveDays).toBe(false);

    const parsed = SettingsDraftSchema.safeParse(draft);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it('同一學生報「新增班＋兒童美語-Gino」時基本折扣維持 10000（未替他套多科折扣）', () => {
    const { classes } = buildNewClassDraft('安親新生班', 'math');
    const calc = calculateStudentBilling(twoEnrollmentStudent(['安親新生班', '兒童美語-Gino']), {
      classSettings: buildClassSettingMap({ ...buildSeedDraft(), classes }),
    });

    // 手算：unset 不計科數，只有 seed 的美語班計 1 科 → R10 effectiveCount 1 → 10000。
    expect(calc.subjectCount).toBe(1);
    expect(calc.baseDiscountBps).toBe(10000);
  });

  it('對照：若類別被寫成 manual math，同一學生會變成 2 科／9500（這就是 F2 的實際差異）', () => {
    const manualAttrs: ClassAttributesView = {
      classType: 'math',
      category: 'math',
      categorySource: 'manual',
      hasMultiSubjectDiscount: true,
      fixedFiveDays: false,
    };
    const { classes } = buildNewClassDraft('安親新生班', 'math', manualAttrs);
    const calc = calculateStudentBilling(twoEnrollmentStudent(['安親新生班', '兒童美語-Gino']), {
      classSettings: buildClassSettingMap({ ...buildSeedDraft(), classes }),
    });

    // 手算：{math, english} → 2 科 → R10 effectiveCount 2 → 9500。
    expect(calc.subjectCount).toBe(2);
    expect(calc.baseDiscountBps).toBe(9500);
  });
});
