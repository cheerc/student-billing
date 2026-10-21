import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImpactDialog, type SettingsPreviewData } from '@/components/settings/impact-dialog';

describe('N02: ImpactDialog 科數與合計折扣變動明細（UX65／issue #54）', () => {
  it('1. 純類別異動（天數未變）：顯示「未改變收費天數」並呈現科數與折扣明細，0 必須呈現，折扣為格式化文字', () => {
    const preview: SettingsPreviewData = {
      mode: 'with_students',
      previewId: 'prev-cat-1',
      inputHash: 'hash1',
      expectedRevision: 1,
      settingsVersionId: 'v1',
      importId: 'imp_1',
      runId: 'run_1',
      totalStudents: 2,
      affectedStudents: 2,
      mismatchCount: 0,
      dayDeltas: [],
      subjectCountDeltas: [
        { personCode: 'R3_001', name: '學生甲', before: 0, after: 1 },
        { personCode: 'R3_002', name: '學生乙', before: 2, after: 3 },
      ],
      baseDiscountDeltas: [
        { personCode: 'R3_002', name: '學生乙', before: 9500, after: 9000 },
      ],
    } as any;

    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, {
        isOpen: true,
        mode: 'with_students',
        preview,
        splitWarnings: [],
        onClose: () => {},
        onApply: () => {},
        applying: false,
      })
    );

    // 天數未變文案必須保留
    expect(html).toContain('本次課表變更未改變現行學生的收費天數。');
    // 天數表格不得出現
    expect(html).not.toContain('天數變動明細');

    // 科數變動明細表格必須呈現，且 0 必須正確顯示
    expect(html).toContain('科數變動明細');
    expect(html).toContain('R3_001');
    expect(html).toContain('學生甲');
    expect(html).toContain('0');
    expect(html).toContain('1');
    expect(html).toContain('R3_002');
    expect(html).toContain('學生乙');
    expect(html).toContain('2');
    expect(html).toContain('3');

    // 合計折扣變動明細表格必須呈現，且數值為格式化文字（95折、9折）
    expect(html).toContain('合計折扣變動明細');
    expect(html).toContain('95折');
    expect(html).toContain('9折');
    // 學生甲未發生折扣變動（10000 -> 10000），不得出現在折扣表格
    const discountSection = html.slice(html.indexOf('合計折扣變動明細'));
    expect(discountSection).not.toContain('R3_001');
  });

  it('2. 僅天數異動（無科數與折扣異動）：呈現天數表格，不出現天數未變文案，亦不出現科數／折扣表格', () => {
    const preview: SettingsPreviewData = {
      mode: 'with_students',
      previewId: 'prev-day-1',
      inputHash: 'hash2',
      expectedRevision: 1,
      settingsVersionId: 'v1',
      importId: 'imp_1',
      runId: 'run_1',
      totalStudents: 1,
      affectedStudents: 1,
      mismatchCount: 0,
      dayDeltas: [{ personCode: 'R3_001', name: '學生甲', before: 5, after: 4.5 }],
      subjectCountDeltas: [],
      baseDiscountDeltas: [],
    } as any;

    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, {
        isOpen: true,
        mode: 'with_students',
        preview,
        splitWarnings: [],
        onClose: () => {},
        onApply: () => {},
        applying: false,
      })
    );

    expect(html).toContain('天數變動明細');
    expect(html).toContain('5');
    expect(html).toContain('4.5');
    expect(html).not.toContain('本次課表變更未改變現行學生的收費天數。');
    expect(html).not.toContain('科數變動明細');
    expect(html).not.toContain('合計折扣變動明細');
  });

  it('3. 三類同時異動：天數、科數、合計折扣三張表格皆完整呈現，不出現天數未變文案', () => {
    const preview: SettingsPreviewData = {
      mode: 'with_students',
      previewId: 'prev-mix-1',
      inputHash: 'hash3',
      expectedRevision: 1,
      settingsVersionId: 'v1',
      importId: 'imp_1',
      runId: 'run_1',
      totalStudents: 1,
      affectedStudents: 1,
      mismatchCount: 0,
      dayDeltas: [{ personCode: 'R3_001', name: '學生甲', before: 5, after: 4.5 }],
      subjectCountDeltas: [{ personCode: 'R3_001', name: '學生甲', before: 1, after: 2 }],
      baseDiscountDeltas: [{ personCode: 'R3_001', name: '學生甲', before: 10000, after: 9500 }],
    } as any;

    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, {
        isOpen: true,
        mode: 'with_students',
        preview,
        splitWarnings: [],
        onClose: () => {},
        onApply: () => {},
        applying: false,
      })
    );

    expect(html).toContain('天數變動明細');
    expect(html).toContain('科數變動明細');
    expect(html).toContain('合計折扣變動明細');
    expect(html).not.toContain('本次課表變更未改變現行學生的收費天數。');
    expect(html).toContain('無折扣');
    expect(html).toContain('95折');
  });

  it('4. 完全無異動（三類皆為空）：顯示天數未變文案，三張明細表皆不呈現', () => {
    const preview: SettingsPreviewData = {
      mode: 'with_students',
      previewId: 'prev-none-1',
      inputHash: 'hash4',
      expectedRevision: 1,
      settingsVersionId: 'v1',
      importId: 'imp_1',
      runId: 'run_1',
      totalStudents: 1,
      affectedStudents: 0,
      mismatchCount: 0,
      dayDeltas: [],
      subjectCountDeltas: [],
      baseDiscountDeltas: [],
    } as any;

    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, {
        isOpen: true,
        mode: 'with_students',
        preview,
        splitWarnings: [],
        onClose: () => {},
        onApply: () => {},
        applying: false,
      })
    );

    expect(html).toContain('本次課表變更未改變現行學生的收費天數。');
    expect(html).not.toContain('天數變動明細');
    expect(html).not.toContain('科數變動明細');
    expect(html).not.toContain('合計折扣變動明細');
  });

  it('5. Nullable 防禦：before 或 after 為 null 時優雅呈現，不崩潰', () => {
    const preview: SettingsPreviewData = {
      mode: 'with_students',
      previewId: 'prev-null-1',
      inputHash: 'hash5',
      expectedRevision: 1,
      settingsVersionId: 'v1',
      importId: 'imp_1',
      runId: 'run_1',
      totalStudents: 1,
      affectedStudents: 1,
      mismatchCount: 0,
      dayDeltas: [],
      subjectCountDeltas: [{ personCode: 'R3_999', name: '例外生', before: null, after: 1 }],
      baseDiscountDeltas: [{ personCode: 'R3_999', name: '例外生', before: 9500, after: null }],
    } as any;

    expect(() => {
      const html = renderToStaticMarkup(
        React.createElement(ImpactDialog, {
          isOpen: true,
          mode: 'with_students',
          preview,
          splitWarnings: [],
          onClose: () => {},
          onApply: () => {},
          applying: false,
        })
      );
      expect(html).toContain('科數變動明細');
      expect(html).toContain('合計折扣變動明細');
      expect(html).toContain('未設定');
    }).not.toThrow();
  });

  it('6. Ruling 2: 課程學費折扣變動（courseRateDeltas）呈現完整明細表格與格式化文字', () => {
    const preview: any = {
      mode: 'with_students',
      previewId: 'prev-course-rate-1',
      inputHash: 'hash6',
      expectedRevision: 1,
      settingsVersionId: 'v1',
      importId: 'imp_1',
      runId: 'run_1',
      totalStudents: 1,
      affectedStudents: 1,
      mismatchCount: 0,
      dayDeltas: [],
      subjectCountDeltas: [],
      baseDiscountDeltas: [],
      courseRateDeltas: [
        { personCode: 'R3_003', name: '學生丙', course: 'tutoring', courseLabel: '課輔', before: 10000, after: 9500 },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(ImpactDialog, {
        isOpen: true,
        mode: 'with_students',
        preview,
        splitWarnings: [],
        onClose: () => {},
        onApply: () => {},
        applying: false,
      })
    );

    expect(html).toContain('課程學費折扣變動明細');
    expect(html).toContain('R3_003');
    expect(html).toContain('學生丙');
    expect(html).toContain('課輔');
    expect(html).toContain('無折扣');
    expect(html).toContain('95折');
    expect(html).toContain('本次課表變更未改變現行學生的收費天數。');
  });
});
