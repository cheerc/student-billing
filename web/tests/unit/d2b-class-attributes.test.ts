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

describe('D2b 1: 設定資料模型 — 有效類別與固定 5 天（自動偵測＋手動覆寫）', () => {
  it('無手動覆寫時有效值＝依班名自動偵測，來源為 auto', () => {
    const r = resolveClassAttributes('國小數學-四A');
    expect(r.category).toBe('math');
    expect(r.categorySource).toBe('auto');
    expect(r.fixedFiveDays).toBe(false);
    expect(r.fixedSource).toBe('auto');
  });

  it('手動設定類別時有效值＝手動值，來源為 manual', () => {
    const r = resolveClassAttributes('某自創班', { category: 'care', categorySource: 'manual' });
    expect(r.category).toBe('care');
    expect(r.categorySource).toBe('manual');
  });

  it('手動設定的「固定 5 天」與類別各自獨立（Q7-A）', () => {
    const r = resolveClassAttributes('兒童美語-Gino', {
      category: 'english',
      categorySource: 'manual',
      fixedFiveDays: true,
      fixedSource: 'manual',
    });
    expect(r.category).toBe('english');
    expect(r.fixedFiveDays).toBe(true);
    expect(r.fixedSource).toBe('manual');
  });

  it('類別缺值但固定 5 天有值時，兩者來源各自判定', () => {
    const r = resolveClassAttributes('國小輔導-四年級', { fixedFiveDays: true, fixedSource: 'manual' });
    expect(r.category).toBe('care');
    expect(r.categorySource).toBe('auto');
    expect(r.fixedFiveDays).toBe(true);
    expect(r.fixedSource).toBe('manual');
  });

  it('手動值恰等於自動偵測值時仍為 manual（來源是使用者意圖，不自動降回 auto）', () => {
    const r = resolveClassAttributes('國小數學-四A', { category: 'math', categorySource: 'manual' });
    expect(r.category).toBe('math');
    expect(r.categorySource).toBe('manual');
  });

  it('四個類別都有合法顯示名稱', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual(['care', 'english', 'math', 'none']);
    expect(CATEGORY_LABELS.care).toBe('安親課輔班');
    expect(CATEGORY_LABELS.math).toBe('數學班');
    expect(CATEGORY_LABELS.english).toBe('美語班');
    expect(CATEGORY_LABELS.none).toBe('不列入折扣');
  });

  it('有效值輸出為 draft 的四個欄位（來源與值一併寫出，供 hash 與快照使用）', () => {
    const out = toSavedClassAttributes(resolveClassAttributes('國小輔導-寫功課'));
    expect(out).toEqual({
      category: 'none',
      categorySource: 'auto',
      fixedFiveDays: true,
      fixedSource: 'auto',
    });
  });
});

describe('D2b 5（Q9）: 整班改名帶走設定（含手動值）', () => {
  it('手動值隨班改名保留，來源仍為 manual', () => {
    const out = carryAttributesOnRename(
      [{ from: '新名字A', to: '新名字B' }],
      new Map([['新名字A', { category: 'care', categorySource: 'manual', fixedFiveDays: true, fixedSource: 'manual' }]]),
      new Map([['新名字B', { category: 'math', categorySource: 'auto', fixedFiveDays: false, fixedSource: 'auto' }]])
    );
    expect(out.get('新名字B')).toEqual({
      category: 'care',
      categorySource: 'manual',
      fixedFiveDays: true,
      fixedSource: 'manual',
    });
  });

  it('沒有手動覆寫的班改名後依新名重新偵測', () => {
    const out = carryAttributesOnRename(
      [{ from: '新名字A', to: '新名字B' }],
      new Map([['新名字A', { category: 'none', categorySource: 'auto', fixedFiveDays: false, fixedSource: 'auto' }]]),
      new Map()
    );
    // 「新名字B」自動偵測為 none（非數學班名）：此處只驗「依新名重新偵測」這件事（值與原名不同）
    expect(out.get('新名字B')).toEqual({
      category: 'none',
      categorySource: 'auto',
      fixedFiveDays: false,
      fixedSource: 'auto',
    });

    const out2 = carryAttributesOnRename(
      [{ from: '新名字A', to: '國小數學-新名' }],
      new Map([['新名字A', { category: 'none', categorySource: 'auto', fixedFiveDays: false, fixedSource: 'auto' }]]),
      new Map()
    );
    expect(out2.get('國小數學-新名')).toEqual({
      category: 'math',
      categorySource: 'auto',
      fixedFiveDays: false,
      fixedSource: 'auto',
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
        ['國小數學-四A', { category: 'math', categorySource: 'auto', fixedFiveDays: false, fixedSource: 'auto' }],
        ['國小數學-四B', { category: 'care', categorySource: 'manual', fixedFiveDays: true, fixedSource: 'manual' }],
      ])
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].mergedName).toBe('國小數學-四');
    expect(conflicts[0].sources).toEqual(['國小數學-四A', '國小數學-四B']);
  });

  it('兩來源設定相同 → 不阻擋', () => {
    const same = { category: 'math' as const, categorySource: 'auto' as const, fixedFiveDays: false, fixedSource: 'auto' as const };
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
  it('從 draft 的 classes 取得已儲存的手動／自動屬性（無欄位＝未設定，讀取時自動偵測）', () => {
    const attrs = attributesFromDraftClasses([
      cls('國小數學-四A'),
      cls('自創班', { category: 'care', categorySource: 'manual' }),
    ]);
    expect(attrs.get('國小數學-四A')).toEqual({
      category: 'math',
      categorySource: 'auto',
      fixedFiveDays: false,
      fixedSource: 'auto',
    });
    expect(attrs.get('自創班')).toEqual({
      category: 'care',
      categorySource: 'manual',
      fixedFiveDays: false,
      fixedSource: 'auto',
    });
  });

  it('baseline 版本讀出的是「當時已儲存」的屬性，與 draft 逐欄可比較', () => {
    const base = attributesFromBaselineClasses([cls('國小數學-四A')]);
    expect(base.get('國小數學-四A')).toEqual({
      category: 'math',
      categorySource: 'auto',
      fixedFiveDays: false,
      fixedSource: 'auto',
    });
  });
});
