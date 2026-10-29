import { describe, it, expect } from 'vitest';
import {
  resolveClassAttributes,
  toSavedClassAttributes,
  carryAttributesOnRename,
  detectMergeConflicts,
  attributesFromDraftClasses,
  attributesFromBaselineClasses,
  CATEGORY_LABELS,
} from '@/domain/classification/class-attributes';
import type { ClassSetting } from '@/contracts/settings';

/** 課表 draft 的班級（只需 baseName 與可選的四個類別欄位）。 */
function cls(baseName: string, extra: Partial<ClassSetting> = {}): ClassSetting {
  return {
    baseName,
    subject: 'x',
    teacher: null,
    active: true,
    sessions: [],
    ...extra,
  } as ClassSetting;
}

describe('D2b 1: 設定資料模型 — 有效類別與固定 5 天（#157：未設定＋使用者決定）', () => {
  it('未指定類別時有效值＝unset（非 seed 班；#157 Ruling 1：不再依班名自動偵測），固定 5 天預設 false', () => {
    // 用非 seed 的班名（「某自創班」不在 seed 49 班內）。seed 班的未指定情況另有 seed 基準，
    // 見 issue-157-seed-category-fallback.test.ts。
    const r = resolveClassAttributes('某自創班');
    expect(r.classType).toBe('other');
    expect(r.category).toBe('unset');
    expect(r.categorySource).toBe('unset');
    expect(r.fixedFiveDays).toBe(false);
  });

  it('seed 班未指定類別 → 套用 seed 基準（來源為 seed，非 manual）', () => {
    const r = resolveClassAttributes('國小數學-四A');
    expect(r.classType).toBe('math');
    expect(r.category).toBe('math');
    expect(r.categorySource).toBe('seed');
  });

  it('手動設定類別時有效值＝手動值，來源為 manual', () => {
    const r = resolveClassAttributes('某自創班', { category: 'care', categorySource: 'manual' });
    expect(r.classType).toBe('care');
    expect(r.category).toBe('care');
    expect(r.categorySource).toBe('manual');
  });

  it('手動設定的「固定 5 天」與類別各自獨立（Q7-A）', () => {
    const r = resolveClassAttributes('兒童美語-Gino', {
      category: 'english',
      categorySource: 'manual',
      fixedFiveDays: true,
    });
    expect(r.classType).toBe('care'); // fixedFiveDays: true 舊草稿/手動歸入 care
    expect(r.category).toBe('english');
    expect(r.fixedFiveDays).toBe(true);
  });

  it('類別缺值但固定 5 天有值時，各自判定（固定 5 天不推導類別）', () => {
    const r = resolveClassAttributes('某自創班', { fixedFiveDays: true });
    expect(r.classType).toBe('care'); // fixedFiveDays: true → 歸入 care 課程類型（specs/14 §3.9）
    expect(r.category).toBe('unset'); // #157：固定 5 天與類別互不推導
    expect(r.categorySource).toBe('unset');
    expect(r.fixedFiveDays).toBe(true);
  });

  it('手動值恰等於舊自動偵測值時仍為 manual（來源是使用者意圖，不因值相同而降級）', () => {
    const r = resolveClassAttributes('國小數學-四A', { category: 'math', categorySource: 'manual' });
    expect(r.category).toBe('math');
    expect(r.categorySource).toBe('manual');
  });

  it('五個類別都有合法顯示名稱，且「未設定」不與「不列入折扣」混用', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual(['care', 'english', 'math', 'none', 'unset']);
    expect(CATEGORY_LABELS.care).toBe('安親課輔班');
    expect(CATEGORY_LABELS.math).toBe('數學班');
    expect(CATEGORY_LABELS.english).toBe('美語班');
    expect(CATEGORY_LABELS.none).toBe('不列入折扣');
    // #157 Ruling 2：unset 是「使用者尚未指定」，不是「使用者指定不列入」
    expect(CATEGORY_LABELS.unset).toBe('（未設定）');
  });

  it('有效值輸出為 draft 的欄位（含 classType，且固定 5 天預設 false，無 fixedSource）', () => {
    const out = toSavedClassAttributes(resolveClassAttributes('國小輔導-寫功課'));
    expect(out).toEqual({
      classType: 'other',
      hasMultiSubjectDiscount: false,
      category: 'unset',
      categorySource: 'unset',
      fixedFiveDays: false,
    });
  });
});

describe('D2b 5（Q9）: 整班改名帶走設定（含手動值與 classType）', () => {
  it('手動值隨班改名保留，來源仍為 manual', () => {
    const out = carryAttributesOnRename(
      [{ from: '新名字A', to: '新名字B' }],
      new Map([['新名字A', { classType: 'care', hasMultiSubjectDiscount: true, category: 'care', categorySource: 'manual', fixedFiveDays: true }]]),
      new Map([['新名字B', { classType: 'math', hasMultiSubjectDiscount: true, category: 'math', categorySource: 'manual', fixedFiveDays: false }]])
    );
    expect(out.get('新名字B')).toEqual({
      classType: 'care',
      hasMultiSubjectDiscount: true,
      category: 'care',
      categorySource: 'manual',
      fixedFiveDays: true,
    });
  });

  it('未指定類別的班改名後仍是 unset，classType 與 fixedFiveDays 隨班保留（#157：不得依新名重新判定）', () => {
    const out = carryAttributesOnRename(
      [{ from: '新名字A', to: '新名字B' }],
      new Map([['新名字A', { classType: 'other', hasMultiSubjectDiscount: false, category: 'unset', categorySource: 'unset', fixedFiveDays: true }]]),
      new Map()
    );
    expect(out.get('新名字B')).toEqual({
      classType: 'other',
      hasMultiSubjectDiscount: false,
      category: 'unset',
      categorySource: 'unset',
      fixedFiveDays: true,
    });

    // 改名成一個「看起來像數學班」的名字，也不得因此變成 math（這正是 Ruling 1 的重點）
    const out2 = carryAttributesOnRename(
      [{ from: '新名字A', to: '國小數學-新名' }],
      new Map([['新名字A', { classType: 'other', hasMultiSubjectDiscount: false, category: 'unset', categorySource: 'unset', fixedFiveDays: false }]]),
      new Map()
    );
    expect(out2.get('國小數學-新名')).toEqual({
      classType: 'other',
      hasMultiSubjectDiscount: false,
      category: 'unset',
      categorySource: 'unset',
      fixedFiveDays: false,
    });
  });

  it('可達性實驗：改名來源班不在 currentAttrs 與 baselineAttrs（如未手動修改的 seed 班），改名應解析來源屬性並保留，不遺失 classType', () => {
    const out = carryAttributesOnRename(
      [{ from: '兒童美語-Gino', to: '米豆奶美語一' }],
      new Map(),
      new Map()
    );
    expect(out.get('米豆奶美語一')).toEqual({
      classType: 'english',
      hasMultiSubjectDiscount: true,
      category: 'english',
      categorySource: 'manual',
      fixedFiveDays: false,
    });
  });

  it('改名後其他班之 skipDeduction 與屬性隨班保留且來源標記為 manual', () => {
    const out = carryAttributesOnRename(
      [{ from: '國小數學-四A', to: '米豆奶數學四A' }],
      new Map(),
      new Map()
    );
    expect(out.get('米豆奶數學四A')).toEqual({
      classType: 'math',
      hasMultiSubjectDiscount: true,
      category: 'math',
      categorySource: 'manual',
      fixedFiveDays: false,
    });
  });
});

describe('D2b 5（Q9）: 同名合併且設定不同時阻擋儲存', () => {
  it('兩來源設定不同 → 產生衝突，需使用者選擇', () => {
    const conflicts = detectMergeConflicts(
      [
        { mergedName: '國小數學-四', sources: ['國小數學-四A', '國小數學-四B'] },
      ],
      new Map([
        ['國小數學-四A', { classType: 'non_care', category: 'math', categorySource: 'unset', fixedFiveDays: false }],
        ['國小數學-四B', { classType: 'care', category: 'care', categorySource: 'manual', fixedFiveDays: true }],
      ])
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].mergedName).toBe('國小數學-四');
    expect(conflicts[0].sources).toEqual(['國小數學-四A', '國小數學-四B']);
  });

  it('兩來源設定相同 → 不阻擋', () => {
    const same = { classType: 'non_care' as const, category: 'math' as const, categorySource: 'unset' as const, fixedFiveDays: false };
    const conflicts = detectMergeConflicts(
      [{ mergedName: '國小數學-四', sources: ['國小數學-四A', '國小數學-四B'] }],
      new Map([
        ['國小數學-四A', { ...same }],
        ['國小數學-四B', { ...same }],
      ])
    );
    expect(conflicts).toHaveLength(0);
  });
});

describe('D2b 1: draft ↔ 班級屬性清單轉換（單一來源）', () => {
  it('從 draft 的 classes 取得屬性（無欄位＝未設定；有 manual 欄位＝使用者決定）', () => {
    const attrs = attributesFromDraftClasses([
      cls('某自創班'),
      cls('自創班', { category: 'care', categorySource: 'manual' }),
    ]);
    expect(attrs.get('某自創班')).toEqual({
      classType: 'other',
      hasMultiSubjectDiscount: false,
      category: 'unset',
      categorySource: 'unset',
      fixedFiveDays: false,
    });
    expect(attrs.get('自創班')).toEqual({
      classType: 'care',
      hasMultiSubjectDiscount: true,
      category: 'care',
      categorySource: 'manual',
      fixedFiveDays: false,
    });
  });

  it('baseline 版本讀出的是「當時已儲存」的屬性，與 draft 逐欄可比較', () => {
    const base = attributesFromBaselineClasses([cls('某自創班')]);
    expect(base.get('某自創班')).toEqual({
      classType: 'other',
      hasMultiSubjectDiscount: false,
      category: 'unset',
      categorySource: 'unset',
      fixedFiveDays: false,
    });
  });
});
