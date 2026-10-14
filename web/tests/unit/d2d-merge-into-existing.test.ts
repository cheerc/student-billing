import { describe, it, expect } from 'vitest';
import {
  detectClassLifecycle,
  carryAttributesOnRename,
} from '@/domain/classification/class-attributes';
import type { ScheduleGridRow } from '@/contracts/settings';

/**
 * D2d C：併入**既有班**時以既有班 Z 的現行設定為準（decision d-20261001043317183960-21）。
 *
 * operator 的產品原則：課程設定＝核對者認知的「現在」班級狀態，系統不記錄、不管理
 * 班級狀態轉換；有差異由使用者看比對結果自行修正。因此：
 *  - X 整班改名、與既有班 Z 同名 → **以 Z 現在的設定（手動或自動）為準**，
 *    X 的手動值不帶入、不覆寫 Z。
 *  - **不阻擋儲存、不新增合併判定**：類別面板所見即所得。
 *  - 保留：整班改成「新的、不存在的名字」時手動值跟著走（D37）。
 *  - 保留：已實作的 Q9 阻擋（≥2 個舊班合併成新名、設定不同時阻擋）不動。
 *
 * ── 對前一個 RED commit 8ffbf55 的取代說明 ──
 * 8ffbf55 第 1 條斷言「merges 應含 Z」（即視為合併並阻擋），**與本裁定相反**，
 * 該條已移除並由下方「不阻擋儲存」取代。8ffbf55 第 2 條（Z 的 manual 不得被
 * 靜默改成 X 的值）方向正確，予以保留並強化。8ffbf55 保留於歷史，不改寫。
 */

function row(rowId: string, className: string): ScheduleGridRow {
  return {
    rowId,
    className,
    weekday: '一',
    startTime: '17:00',
    endTime: '18:00',
    startMinutes: 1020,
    endMinutes: 1080,
    teacher: null,
    active: true,
    skipDeduction: false,
  };
}

/** Z＝既有班（baseline 有自己的 manual 值）；X＝另一個有不同 manual 值的班。 */
const BASE_ROWS = [
  row('r1', '國小數學-四A'), // X
  row('r2', '國小數學-四B'), // X 第二列
  row('r3', '國小數學-四C'), // Z：baseline 就有自己的列
];

describe('D2d C: 併入既有班 Z 時以 Z 的現行設定為準（最小修）', () => {
  it('併入既有班不視為合併、不阻擋儲存（所見即所得）', () => {
    const current = [row('r1', '國小數學-四C'), row('r2', '國小數學-四C'), row('r3', '國小數學-四C')];
    const lc = detectClassLifecycle(BASE_ROWS, current);
    // 裁定：不新增合併判定 → 既有班被併入不算 merge（8ffbf55 第 1 條的期望已作廢）
    expect(lc.merges).toEqual([]);
  });

  it('Z 的既有 manual 值不得被 X 靜默覆寫（8ffbf55 第 2 條保留並強化）', () => {
    const attrs = new Map([
      // Z 的既有 manual 設定（care + 固定 5 天）
      [
        '國小數學-四C',
        { category: 'care' as const, categorySource: 'manual' as const, fixedFiveDays: true, fixedSource: 'manual' as const, skipDeduction: false, skipDeductionSource: 'auto' as const },
      ],
      // X 的 manual 設定（不列入折扣、不固定）
      [
        '國小數學-四A',
        { category: 'none' as const, categorySource: 'manual' as const, fixedFiveDays: false, fixedSource: 'manual' as const, skipDeduction: false, skipDeductionSource: 'auto' as const },
      ],
    ]);

    const out = carryAttributesOnRename(
      [{ from: '國小數學-四A', to: '國小數學-四C' }],
      new Map(),
      attrs,
      new Set(['國小數學-四C']) // Z 在 baseline 已存在 → 併入既有班
    );

    // 以 Z 為準：X 的 manual 值不帶入、不覆寫
    expect(out.get('國小數學-四C')?.category).toBe('care');
    expect(out.get('國小數學-四C')?.fixedFiveDays).toBe(true);
    expect(out.get('國小數學-四C')?.categorySource).toBe('manual');
  });

  it('Z 為 auto 時，X 的 manual 值也不得覆寫 Z（Z 現在的值＝依 Z 班名自動偵測）', () => {
    const attrs = new Map([
      [
        '國小數學-四A',
        { category: 'none' as const, categorySource: 'manual' as const, fixedFiveDays: false, fixedSource: 'manual' as const, skipDeduction: false, skipDeductionSource: 'auto' as const },
      ],
    ]);

    const out = carryAttributesOnRename(
      [{ from: '國小數學-四A', to: '國小數學-四C' }],
      new Map(),
      attrs,
      new Set(['國小數學-四C']) // Z 在 baseline 已存在 → 併入既有班
    );

    // Z 未出現在 baselineManualAttrs → Z 為自動偵測（數學班 → math），X 的 manual 不得覆蓋
    expect(out.get('國小數學-四C')?.category).toBe('math');
    expect(out.get('國小數學-四C')?.categorySource).toBe('auto');
  });

  it('保留 D37：整班改成不存在的「新名」時，X 的 manual 值跟著走', () => {
    const attrs = new Map([
      [
        '國小數學-四A',
        { category: 'none' as const, categorySource: 'manual' as const, fixedFiveDays: true, fixedSource: 'manual' as const, skipDeduction: false, skipDeductionSource: 'auto' as const },
      ],
    ]);

    const out = carryAttributesOnRename([{ from: '國小數學-四A', to: '數學新班' }], new Map(), attrs);

    expect(out.get('數學新班')?.category).toBe('none');
    expect(out.get('數學新班')?.categorySource).toBe('manual');
    expect(out.get('數學新班')?.fixedFiveDays).toBe(true);
    expect(out.get('數學新班')?.fixedSource).toBe('manual');
  });
});
