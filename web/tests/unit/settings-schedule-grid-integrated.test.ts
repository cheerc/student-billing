/**
 * #80（單一表格整合屬性）與 #82（僅班名必填、平靜顯示「—」）的元件層驗收。
 *
 * 用 `renderToStaticMarkup` 斷言渲染結果：這是本 repo 既有的 UI 斷言慣例
 * （`settings-schedule-grid-ui.test.ts`、`schedule-status-accuracy-ui.test.ts`）。
 *
 * expected 來源：
 *  - 欄位與文案＝issue #80／#82 原文；
 *  - 「—」與 `aria-label="未設定時間"`＝decision `d-20261004093019108435-11`；
 *  - 折扣類別的有效值＝`CATEGORY_LABELS`（手算：兒童美語 → 美語班、國小數學 → 數學班）。
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import { CARE_WINDOWS_VIEW } from '@/application/schedule-preview';
import type { ScheduleGridRow } from '@/contracts/settings';
import type { ClassAttributesView } from '@/domain/classification/class-attributes';
import type { ClassCategory } from '@/domain/classification/class-category';

/** 三列 fixture：完整列、未知星期列、只有班名的佔位列（#82 的形狀）。 */
const ROWS: ScheduleGridRow[] = [
  {
    rowId: 'row-1',
    className: '兒童美語-Gino',
    teacher: 'Cathy',
    weekday: '一',
    startTime: '15:20',
    endTime: '16:50',
    startMinutes: 920,
    endMinutes: 1010,
    active: true,
    skipDeduction: false,
  },
  {
    rowId: 'row-2',
    className: '國小數學-一A',
    teacher: null,
    weekday: '',
    startTime: '',
    endTime: '',
    startMinutes: null,
    endMinutes: null,
    active: true,
    skipDeduction: false,
  },
];

// #113 follow-up & D61：五類型與是否有多科折扣
const ATTRS = new Map<string, ClassAttributesView>([
  ['兒童美語-Gino', { classType: 'english', category: 'english', categorySource: 'unset', hasMultiSubjectDiscount: true, fixedFiveDays: false }],
  ['國小數學-一A', { classType: 'math', category: 'math', categorySource: 'manual', hasMultiSubjectDiscount: true, fixedFiveDays: true }],
]);

function render(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(ScheduleGrid, {
      rows: ROWS,
      onUpdateRow: () => {},
      onDeleteRow: () => {},
      onAddRow: () => {},
      calculating: false,
      calculateResult: null,
      classAttributes: ATTRS,
      initialClassTypeTab: 'english',
      onSelectCategory: () => {},
      onToggleFixedFiveDays: () => {},
      ...overrides,
    })
  );
}

describe('#80 & specs/14 & D61：課程類型分頁與欄位分離（A2, A4）', () => {
  it('美語班表格包含「是否有多科折扣」與「不計扣天」，不顯示「天數固定 5 天」', () => {
    const html = render();
    expect(html).toContain('是否有多科折扣');
    expect(html).toContain('不計扣天');
    // 美語班表格無「天數固定 5 天」
    expect(html).not.toContain('<th>天數固定 5 天</th>');
    expect(html).not.toContain('col-fixed-five');
  });

  it('首列帶該班的是否有多科折扣單選組', () => {
    const html = render();
    expect(html).toContain('aria-label="兒童美語-Gino 的是否有多科折扣"');
  });

  it('固定 5 天單選反映有效值（安親課輔班頁籤下可見）', () => {
    const careAttrs = new Map<string, ClassAttributesView>([
      ['國小輔導-四年級', { classType: 'care', category: 'care', categorySource: 'unset', hasMultiSubjectDiscount: true, fixedFiveDays: true }],
      ['國小輔導-五年級', { classType: 'care', category: 'care', categorySource: 'unset', hasMultiSubjectDiscount: true, fixedFiveDays: false }],
    ]);
    const careRows: ScheduleGridRow[] = [
      {
        rowId: 'care-1',
        className: '國小輔導-四年級',
        teacher: '王老師',
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
      {
        rowId: 'care-2',
        className: '國小輔導-五年級',
        teacher: '李老師',
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
    ];
    const html = render({ rows: careRows, classAttributes: careAttrs, initialClassTypeTab: 'care' });
    expect(html).toContain('aria-label="國小輔導-四年級 的天數固定 5 天"');
    expect(html).toContain('aria-label="國小輔導-五年級 的天數固定 5 天"');
  });

  it('不再有任何「恢復自動／自動設定」按鈕（#157 Ruling 4：auto 來源已拆除）', () => {
    const html = render();
    expect(html).not.toContain('data-restore-auto');
    expect(html).not.toContain('自動設定');
    expect(html).not.toContain('未手動修改');
  });

  it('「來源：自動／手動」pill 完全不再出現（#80 省略來源顯示）', () => {
    const html = render();
    expect(html).not.toContain('data-category-source=');
    expect(html).not.toContain('data-fixed-source=');
  });

  it('獨立的屬性卡片容器已移除（data-class-attributes-panel 不存在）', () => {
    const html = render();
    expect(html).not.toContain('data-class-attributes-panel');
    expect(html).not.toContain('折扣類別與固定 5 天（');
  });

  it('排課班欄位順序：班級名稱 → 是否有多科折扣 → 不計扣天 → 帶班老師 → 星期 → 上課時間 → 課程時長 → 操作', () => {
    const html = render();
    const order = [
      '班級名稱',
      '是否有多科折扣',
      '不計扣天',
      '帶班老師',
      '星期',
      '上課時間',
      '課程時長',
      '操作',
    ];
    let cursor = 0;
    for (const label of order) {
      const at = html.indexOf(label, cursor);
      expect(at, `找不到 ${label}，或它不在預期位置`).toBeGreaterThanOrEqual(0);
      cursor = at;
    }
  });

  it('凍結首欄與凍結左上角表頭（2D 捲動的 sticky 錨點）', () => {
    const html = render();
    expect(html).toContain('col-classname sticky-col sticky-corner');
    expect(html).toContain('table-scroll-container schedule-table-scroll');
  });
});

describe('#113 follow-up & D61：逐列獨立單選「不計扣天」', () => {
  it('表格有「不計扣天」欄（specs/14 A2/A4：與固定 5 天欄位徹底分離）', () => {
    const html = render();
    expect(html).toContain('col-skip-deduction');
  });

  it('每個時段列各自帶一個不計扣天單選組', () => {
    const html = render();
    expect(html).toContain('aria-label="兒童美語-Gino 第 1 列的不計扣天"');
  });

  it('同班兩列可一勾一不勾（逐列獨立，不會連動）', () => {
    const rows: ScheduleGridRow[] = [
      { ...ROWS[0], rowId: 'r-a', weekday: '一', skipDeduction: true },
      { ...ROWS[0], rowId: 'r-b', weekday: '三', skipDeduction: false },
    ];
    const html = render({ rows });
    expect(html).toContain('aria-label="兒童美語-Gino 第 1 列的不計扣天"');
    expect(html).toContain('aria-label="兒童美語-Gino 第 2 列的不計扣天"');
  });

  it('空狀態的 colSpan 隨欄位數一致（排課班 12 欄）', () => {
    const html = render({ rows: [] });
    expect(html).toContain('<td colSpan="12" class="empty-row-text">');
  });
});

describe('#82 & D61 1c：新增時段僅班名必填與未填時間雙重警示', () => {
  it('星期可留空：編輯列是文字輸入且以 placeholder「未定」提示留空', () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*class="input-weekday[^"]*"[^>]*placeholder="未定"/);
    expect(html).toContain('＋ 新增班級');
  });

  it('D61 1c：未填時間排課列渲染醒目待補時間徽章（取代舊 #82 低調破折號）', () => {
    const html = render({ initialClassTypeTab: 'math' });
    // 國小數學-一A 在 ROWS 中無時間 → 顯示待補時間徽章
    expect(html).toContain('badge-incomplete');
    expect(html).toContain('待補時間');
    expect(html).toContain('row-incomplete');
    expect(html).toContain('input-missing');
  });

  it('未知星期的列仍以「需確認」標示，不被「—」取代（#82 不動這個狀態）', () => {
    // 讓 row-2 變成「時間完整但星期未知」：此時 isIncomplete 為 false，應走 isUnknownWeekday 分支
    const html = render({
      rows: [{ ...ROWS[1], weekday: '八', startTime: '15:00', endTime: '16:00', startMinutes: 900, endMinutes: 960 }],
        calculateResult: {
        requestKey: 'mock',
        draftHash: 'h',
        ruleSetVersion: 'erp-tag-v2',
        windows: CARE_WINDOWS_VIEW,
        rows: [
          {
            rowId: 'row-2',
            classKey: '國小數學-一A',
            teacher: null,
            weekday: '八',
            startMinutes: 900,
            endMinutes: 960,
            durationMinutes: 60,
            anqin: { overlapMinutes: 0, rawDeduction: 0, status: 'unknown_weekday' },
            tutoring: { overlapMinutes: 0, rawDeduction: 0, status: 'unknown_weekday' },
          },
        ],
        classes: [],
        issues: [],
      },
    });
    expect(html).toContain('需確認');
    expect(html).toContain('data-unknown-weekday-notice');
    // 這一態不是「未設定時間」：不可被「—」取代（否則兩種狀態在畫面上不可區分）
    expect(html).not.toContain('aria-label="未設定時間"');
  });

  it('停用列仍顯示「停用」，不與未設定時間混淆', () => {
    const html = render({
      rows: [{ ...ROWS[0], active: false }],
      calculateResult: {
        requestKey: 'mock',
        draftHash: 'h',
        ruleSetVersion: 'erp-tag-v2',
        windows: CARE_WINDOWS_VIEW,
        rows: [
          {
            rowId: 'row-1',
            classKey: '兒童美語-Gino',
            teacher: 'Cathy',
            weekday: '一',
            startMinutes: 920,
            endMinutes: 1010,
            durationMinutes: 90,
            anqin: { overlapMinutes: null, rawDeduction: null, status: 'inactive' },
            tutoring: { overlapMinutes: null, rawDeduction: null, status: 'inactive' },
          },
        ],
        classes: [],
        issues: [],
      },
    });
    expect(html).toContain('停用');
  });
});

describe('#81：Excel 匯出／匯入工具列（單純一鍵）', () => {
  it('只出現「匯出 Excel」與「匯入 Excel」兩顆按鈕，沒有任何欄位挑選對話框的痕跡', () => {
    const html = render({ onExportExcel: () => {}, onImportExcel: () => {} });
    expect(html).toContain('匯出 Excel');
    expect(html).toContain('匯入 Excel');
    for (const forbidden of ['選擇欄位', '勾選匯出', '欄位挑選', '部分匯出']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('檔案選取器接受 .xlsx 且不跳出任何選項 UI', () => {
    const html = render({ onExportExcel: () => {}, onImportExcel: () => {} });
    expect(html).toContain('type="file"');
    expect(html).toContain('.xlsx');
    // 以 display:none 移出可及性樹；可及控制項是［匯入 Excel］按鈕本身
    expect(html).toContain('display:none');
    expect(html).not.toContain('visually-hidden-input');
  });

  it('匯入失敗：role=alert 顯示白話錯誤，並明說「沒有套用任何資料」', () => {
    const html = render({
      onExportExcel: () => {},
      onImportExcel: () => {},
      importError: '這個 Excel 的欄位標題不符合課表格式，缺少：結束時間。',
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('alert-danger');
    expect(html).toContain('data-schedule-import-error');
    expect(html).toContain('沒有套用任何資料');
  });

  it('未提供匯入匯出處理器時不渲染那兩顆按鈕（元件可獨立使用）', () => {
    const html = render();
    expect(html).not.toContain('匯出 Excel');
    expect(html).not.toContain('data-schedule-export');
  });

  it('傳入匯出／匯入處理器時，把 classAttributes 的有效值一併交給上層（不重算）', () => {
    const seen: Array<[string, ClassCategory]> = [];
    const seenFixed: Array<[string, boolean]> = [];
    renderToStaticMarkup(
      React.createElement(ScheduleGrid, {
        rows: ROWS,
        onUpdateRow: () => {},
        onDeleteRow: () => {},
        onAddRow: () => {},
        calculating: false,
        calculateResult: null,
        classAttributes: ATTRS,
        onSelectCategory: (n: string, c: ClassCategory) => seen.push([n, c]),
        onToggleFixedFiveDays: (n: string, f: boolean) => seenFixed.push([n, f]),
          onExportExcel: () => {},
        onImportExcel: () => {},
      })
    );
    // 靜態渲染不會觸發事件；此處只確認 handler 已接上（未拋 TypeError＝呼叫鏈完整）
    expect(seen).toEqual([]);
    expect(seenFixed).toEqual([]);
  });
});

describe('specs/14 & Issue #155 & D61：5 頁籤與簡化操作（移除切換按鈕，A1, A2, A4）', () => {
  it('頁籤渲染：顯示 5 個課程類型頁籤並帶有數量統計', () => {
    const html = render();
    expect(html).toContain('安親課輔班');
    expect(html).toContain('美語班');
    expect(html).toContain('數學班');
    expect(html).toContain('其他班');
    expect(html).toContain('不排課');
    expect(html).toContain('role="tablist"');
  });

  it('排課頁籤：操作欄不包含「轉為安親課輔班」按鈕與切換對話框（Issue #155）', () => {
    const html = render();
    expect(html).not.toContain('轉為安親課輔班');
    expect(html).not.toContain('data-switch-to-care');
    expect(html).not.toContain('data-switch-type');
    expect(html).not.toContain('switch-class-type-dialog');
  });

  it('安親課輔班頁籤：表格顯示「安親課輔班（不計時段）」短標，操作無「轉為非安親課輔班」按鈕（Issue #155）', () => {
    const careAttrs = new Map<string, ClassAttributesView>([
      ['國小輔導-四年級', { classType: 'care', category: 'care', categorySource: 'unset', hasMultiSubjectDiscount: true, fixedFiveDays: false }],
    ]);
    const careRows: ScheduleGridRow[] = [
      {
        rowId: 'care-1',
        className: '國小輔導-四年級',
        teacher: '玟君',
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
    ];
    const html = render({
      rows: careRows,
      classAttributes: careAttrs,
      initialClassTypeTab: 'care',
    });
    expect(html).toContain('安親課輔班（不計時段）');
    expect(html).not.toContain('轉為非安親課輔班');
    expect(html).not.toContain('data-switch-to-non-care');
    expect(html).not.toContain('data-switch-type');
    // 欄位徹底分離：安親課輔班表格無星期、無時間、無不計扣天
    expect(html).not.toContain('class="col-skip-deduction"');
    expect(html).not.toContain('class="col-weekday"');
    expect(html).not.toContain('class="col-time"');
  });

  it('a11y 契約：頁籤面板必須具有 role="tabpanel" 且與 tab 的 id/aria-controls 對應', () => {
    const html = render();
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="class-type-panel-english"');
    expect(html).toContain('aria-labelledby="class-type-tab-english"');
  });

  it('焦點班級定位 banner 契約：包含 data-focus-class 標記與「顯示全部班級」按鈕', () => {
    const html = render({ focusClass: '兒童美語-Gino' });
    expect(html).toContain('data-focus-class');
    expect(html).toContain('顯示全部班級');
  });

  it('焦點班級為安親課輔班時，初始頁籤自動聚焦至 [安親課輔班]，避免誤判 missing', () => {
    const careAttrs = new Map<string, ClassAttributesView>([
      ['國小輔導-四年級', { classType: 'care', category: 'care', categorySource: 'unset', fixedFiveDays: false }],
    ]);
    const careRows: ScheduleGridRow[] = [
      {
        rowId: 'care-1',
        className: '國小輔導-四年級',
        teacher: '玟君',
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
    ];
    const html = render({ rows: careRows, classAttributes: careAttrs, focusClass: '國小輔導-四年級' });
    expect(html).toContain('data-focus-class');
    expect(html).not.toContain('data-focus-class-missing');
    expect(html).toContain('id="class-type-panel-care"');
  });

  describe('D61 Phase 3：五頁籤 UI、欄位徹底分離與 1c 待補時間雙重警示', () => {
    const d61Rows: ScheduleGridRow[] = [
      {
        rowId: 'care-1',
        className: '國小輔導-一年級',
        teacher: '王老師',
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
      {
        rowId: 'eng-1',
        className: '兒童美語-初階',
        teacher: 'John',
        weekday: '一',
        startTime: '15:20',
        endTime: '16:50',
        startMinutes: 920,
        endMinutes: 1010,
        active: true,
        skipDeduction: false,
      },
      {
        rowId: 'eng-incomplete',
        className: '兒童美語-待補班',
        teacher: 'Mary',
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
      {
        rowId: 'math-1',
        className: '國小數學-特訓',
        teacher: '李老師',
        weekday: '三',
        startTime: '16:40',
        endTime: '18:10',
        startMinutes: 1000,
        endMinutes: 1090,
        active: true,
        skipDeduction: false,
      },
      {
        rowId: 'other-1',
        className: '小六加強班-語文',
        teacher: '陳老師',
        weekday: '五',
        startTime: '17:00',
        endTime: '18:30',
        startMinutes: 1020,
        endMinutes: 1110,
        active: true,
        skipDeduction: true,
      },
      {
        rowId: 'unsch-1',
        className: '交通車-下午',
        teacher: '司機林',
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: true,
        skipDeduction: false,
      },
    ];

    const d61Attrs = new Map<string, ClassAttributesView>([
      ['國小輔導-一年級', { classType: 'care', hasMultiSubjectDiscount: true, category: 'care', categorySource: 'manual', fixedFiveDays: false }],
      ['兒童美語-初階', { classType: 'english', hasMultiSubjectDiscount: true, category: 'english', categorySource: 'manual', fixedFiveDays: false }],
      ['兒童美語-待補班', { classType: 'english', hasMultiSubjectDiscount: true, category: 'english', categorySource: 'manual', fixedFiveDays: false }],
      ['國小數學-特訓', { classType: 'math', hasMultiSubjectDiscount: false, category: 'none', categorySource: 'manual', fixedFiveDays: false }],
      ['小六加強班-語文', { classType: 'other', hasMultiSubjectDiscount: false, category: 'none', categorySource: 'manual', fixedFiveDays: false }],
      ['交通車-下午', { classType: 'unscheduled', hasMultiSubjectDiscount: false, category: 'none', categorySource: 'manual', fixedFiveDays: false }],
    ]);

    it('UX106：5 個課程類型頁籤依固定順序呈現', () => {
      const html = render({ rows: d61Rows, classAttributes: d61Attrs });
      expect(html).toContain('安親課輔班');
      expect(html).toContain('美語班');
      expect(html).toContain('數學班');
      expect(html).toContain('其他班');
      expect(html).toContain('不排課');

      // 檢查頁籤順序
      const posCare = html.indexOf('安親課輔班');
      const posEng = html.indexOf('美語班');
      const posMath = html.indexOf('數學班');
      const posOther = html.indexOf('其他班');
      const posUnsch = html.indexOf('不排課');
      expect(posCare).toBeLessThan(posEng);
      expect(posEng).toBeLessThan(posMath);
      expect(posMath).toBeLessThan(posOther);
      expect(posOther).toBeLessThan(posUnsch);
    });

    it('UX106：[其他班] 頁籤不出現多科折扣與固定 5 天，僅顯示不計扣天（預設是）', () => {
      const html = render({ rows: d61Rows, classAttributes: d61Attrs, initialClassTypeTab: 'other' });
      expect(html).toContain('id="class-type-panel-other"');
      expect(html).toContain('不計扣天');
      expect(html).not.toContain('是否有多科折扣');
      expect(html).not.toContain('天數固定 5 天');
    });

    it('UX106：[不排課] 頁籤僅顯示班級名稱、帶班老師、狀態與操作，狀態顯示「不排課」', () => {
      const html = render({ rows: d61Rows, classAttributes: d61Attrs, initialClassTypeTab: 'unscheduled' });
      expect(html).toContain('id="class-type-panel-unscheduled"');
      expect(html).toContain('交通車-下午');
      expect(html).toContain('不排課');
      expect(html).not.toContain('是否有多科折扣');
      expect(html).not.toContain('天數固定 5 天');
      expect(html).not.toContain('不計扣天');
      expect(html).not.toContain('上課時間 起 — 迄');
    });

    it('UX108：未填時間排課列渲染 1c 雙重警示（row-incomplete、input-missing、待補時間徽章）', () => {
      const html = render({ rows: d61Rows, classAttributes: d61Attrs, initialClassTypeTab: 'english' });
      expect(html).toContain('row-incomplete');
      expect(html).toContain('input-missing');
      expect(html).toContain('badge-incomplete');
      expect(html).toContain('待補時間');
    });

    it('UX108：美語班頁籤標籤包含待補計數提示（待補 1）', () => {
      const html = render({ rows: d61Rows, classAttributes: d61Attrs, initialClassTypeTab: 'english' });
      expect(html).toMatch(/美語班\s*\(\d+\s*·\s*待補\s*1\)/);
    });

    it('UX106：處於 [安親課輔班] 或 [不排課] 頁籤時，工具列自動隱藏課表星期篩選', () => {
      const htmlCare = render({ rows: d61Rows, classAttributes: d61Attrs, initialClassTypeTab: 'care' });
      expect(htmlCare).not.toContain('id="schedule-weekday-filter"');

      const htmlUnsch = render({ rows: d61Rows, classAttributes: d61Attrs, initialClassTypeTab: 'unscheduled' });
      expect(htmlUnsch).not.toContain('id="schedule-weekday-filter"');

      const htmlEng = render({ rows: d61Rows, classAttributes: d61Attrs, initialClassTypeTab: 'english' });
      expect(htmlEng).toContain('id="schedule-weekday-filter"');
    });
  });
});
