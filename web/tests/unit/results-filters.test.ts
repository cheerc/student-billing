import { describe, it, expect } from 'vitest';
import * as filters from '@/lib/results-filters';
import type { StudentFilters } from '@/lib/results-filters';

/** 已選0人仍是合法run值；只隱藏未選0人，不把facet count當作prune domain。 */
describe('Excel 式面板零人值', () => {
  it('prune 保留已選0人值與 ~none（既有保護性 GREEN）', () => {
    const selected: StudentFilters = { grade: ['3'], sibling: ['~none'] };
    const options = { grade: [{ value: '3', count: 0 }] };
    expect(filters.pruneStudentFilters(selected, options)).toEqual({ filters: selected, removed: [] });
  });
  it('面板隱藏未選0人、保留已選0人與沒有count的舊選項', () => {
    // 新helper由真panel使用；namespace cast讓RED在runtime而非typecheck import階段失敗。
    const visible = (filters as unknown as { visibleFilterOptions: <T extends { value: string; count?: number }>(options: T[], selected: string[]) => T[] }).visibleFilterOptions;
    const options = [{ value: '1', count: 2 }, { value: '2', count: 0 }, { value: '3', count: 0 }, { value: 'legacy' }];
    expect(visible(options, ['3'])).toEqual([options[0], options[2], options[3]]);
    expect(visible(options, ['~none'])).toEqual([options[0], options[3]]);
  });
});
