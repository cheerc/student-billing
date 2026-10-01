import { describe, it, expect } from 'vitest';
import {
  detectClassLifecycle,
  carryAttributesOnRename,
} from '@/domain/classification/class-attributes';
import type { ScheduleGridRow } from '@/contracts/settings';

/**
 * D2d C（RED）：併入**既有班**時的手動設定會被靜默取其一。
 *
 * 觀察對象：X（有手動設定）整班改名併入既有班 Z，Z 自己也有不同的手動設定。
 * 現行 `detectClassLifecycle` 對「目標名已在 baseline」直接 `continue`，
 * 因此不判為 merge；接著 `carryAttributesOnRename` 把它當**整班改名**處理，
 * 用 X 的 manual 值覆寫 Z 的 manual 值，畫面無任何衝突提示。
 *
 * S manifest §7.7：「合併不得靜默取其一」（Q9）。
 * 本檔斷言的是**期望契約**，用來證明現行實作不符；不改任何產品碼。
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
  };
}

describe('D2d C: 併入既有班的手動設定不得被靜默取其一', () => {
  it('X 併入既有班 Z，兩者手動設定不同 → 應判為需要使用者選擇的衝突', () => {
    const baseline = [
      row('r1', '國小數學-四A'), // X
      row('r2', '國小數學-四B'), // X 第二列
      row('r3', '國小數學-四C'), // Z 自己原本的列
    ];
    // X 的兩列全部改成 Z
    const current = [row('r1', '國小數學-四C'), row('r2', '國小數學-四C'), row('r3', '國小數學-四C')];
    const lc = detectClassLifecycle(baseline, current);

    // 預期：X → Z 應被視為同名合併的一部分（來源含 X 與 Z），而非單純改名
    expect(lc.merges.map((m) => m.mergedName)).toContain('國小數學-四C');
  });

  it('X 併入既有班 Z，Z 的手動設定不得被 X 靜默覆寫', () => {
    const currentAttrs = new Map([
      // Z 的既有 manual 設定
      ['國小數學-四C', { category: 'care' as const, categorySource: 'manual' as const, fixedFiveDays: true, fixedSource: 'manual' as const }],
      // X 的 manual 設定
      ['國小數學-四A', { category: 'none' as const, categorySource: 'manual' as const, fixedFiveDays: false, fixedSource: 'manual' as const }],
    ]);

    const out = carryAttributesOnRename(
      [{ from: '國小數學-四A', to: '國小數學-四C' }],
      new Map(),
      currentAttrs
    );

    // 預期（Q9「合併不得靜默取其一」）：不得無聲地以 X 覆蓋 Z
    expect(out.get('國小數學-四C')?.category).not.toBe('none');
    expect(out.get('國小數學-四C')?.categorySource).toBe('manual');
  });
});
