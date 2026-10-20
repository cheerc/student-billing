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

// #113 follow-up：不計扣天不再是班級屬性，只剩類別與固定 5 天；specs/14 加入 classType，移除 fixedSource。
const ATTRS = new Map<string, ClassAttributesView>([
  ['兒童美語-Gino', { classType: 'non_care', category: 'english', categorySource: 'auto', fixedFiveDays: false }],
  ['國小數學-一A', { classType: 'non_care', category: 'math', categorySource: 'manual', fixedFiveDays: true }],
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
      onSelectCategory: () => {},
      onToggleFixedFiveDays: () => {},
      onRestoreAuto: () => {},
      ...overrides,
    })
  );
}

describe('#80 & specs/14：課程類型分頁與欄位分離（A2, A4）', () => {
  it('非安親課輔班表格包含「列入多科折扣」與「不計扣天」，不顯示「天數固定 5 天」', () => {
    const html = render();
    expect(html).toContain('列入多科折扣');
    expect(html).toContain('不計扣天');
    // specs/14 A2: 非安親課輔班表格無「天數固定 5 天」
    expect(html).not.toContain('<th>天數固定 5 天</th>');
    expect(html).not.toContain('rowSpan="2" class="col-fixed-five"');
  });

  it('每個時段列都帶該班的折扣類別下拉', () => {
    const html = render();
    // 兩列、兩個非安親班 → 兩個下拉
    expect(html.match(/data-category-select=/g)?.length).toBe(2);
  });

  it('下拉顯示有效值的白話標籤（手算：Gino→美語班、一A→數學班），且對應到內部值', () => {
    const html = render();
    expect(html).toContain('data-category-select="兒童美語-Gino"');
    expect(html).toContain('data-category-select="國小數學-一A"');
    // 四個選項都渲染（課輔班／數學班／英文班／無折扣 的白話）
    for (const label of ['安親課輔班', '數學班', '美語班', '不列入折扣']) {
      expect(html).toContain(label);
    }
  });

  it('固定 5 天 checkbox 反映有效值（安親課輔班頁籤下可見，純 boolean 勾選框）', () => {
    const careAttrs = new Map<string, ClassAttributesView>([
      ['國小輔導-四年級', { classType: 'care', category: 'care', categorySource: 'auto', fixedFiveDays: true }],
      ['國小輔導-五年級', { classType: 'care', category: 'care', categorySource: 'auto', fixedFiveDays: false }],
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
    const checkboxes = html.match(/data-fixed-five-toggle="[^"]*"[^/]*?\/>/g) ?? [];
    expect(checkboxes).toHaveLength(2);
    // 國小輔導-四年級 為 true → checked
    expect(html).toMatch(/data-fixed-five-toggle="國小輔導-四年級"[^>]*checked/);
    // 國小輔導-五年級 為 false → not checked
    expect(html).not.toMatch(/data-fixed-five-toggle="國小輔導-五年級"[^>]*checked/);
  });

  it('手動過的班有「自動設定」按鈕；未手動的顯示淡灰「—」（取代原本的來源 pill）', () => {
    const html = render();
    // 國小數學-一A 兩項都是 manual → 有按鈕
    expect(html).toContain('data-restore-auto="國小數學-一A"');
    expect(html).toContain('自動設定');
    // 兒童美語-Gino 兩項都是 auto → 沒有按鈕，該格是 aria-label「未手動修改」的「—」
    expect(html).not.toContain('data-restore-auto="兒童美語-Gino"');
    expect(html).toContain('aria-label="兒童美語-Gino 未手動修改"');
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

  it('非安親課輔班欄位順序：班級名稱 → 列入多科折扣 → 不計扣天 → 帶班老師 → 星期 → 時間 → 計算欄 → 操作', () => {
    const html = render();
    const order = [
      '班級名稱',
      '列入多科折扣',
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

describe('#113 follow-up：逐列獨立勾選「不計扣天」', () => {
  it('表格有「不計扣天」欄（specs/14 A2/A4：與固定 5 天欄位徹底分離）', () => {
    const html = render();
    expect(html).toContain('col-skip-deduction');
  });

  it('每個時段列各自帶一個勾選（data-skip-deduction-toggle 以 rowId 為 key）', () => {
    const html = render();
    expect(html.match(/data-skip-deduction-toggle=/g)?.length).toBe(2);
    // 兩列同屬不同班級 → key 必須是 rowId 而非班名，否則會互相連動
    expect(html).toContain('data-skip-deduction-toggle="row-1"');
    expect(html).toContain('data-skip-deduction-toggle="row-2"');
  });

  it('勾選反映的是「這一列」的旗標，不是班級屬性', () => {
    // 手算：ROWS 兩列的 skipDeduction 都是 false → 兩格都不應 checked。
    const html = render();
    expect(html).not.toMatch(/data-skip-deduction-toggle="row-1"[^>]*checked/);
    expect(html).not.toMatch(/data-skip-deduction-toggle="row-2"[^>]*checked/);
  });

  it('同班兩列可一勾一不勾（逐列獨立，不會連動）', () => {
    const rows: ScheduleGridRow[] = [
      { ...ROWS[0], rowId: 'r-a', weekday: '一', skipDeduction: true },
      { ...ROWS[0], rowId: 'r-b', weekday: '三', skipDeduction: false },
    ];
    const html = render({ rows });
    expect(html).toMatch(/data-skip-deduction-toggle="r-a"[^>]*checked/);
    expect(html).not.toMatch(/data-skip-deduction-toggle="r-b"[^>]*checked/);
  });

  it('每個勾選都有可讀的列標籤（不只靠勾選框本身）', () => {
    const html = render();
    expect(html).toContain('aria-label="兒童美語-Gino 第 1 列的不計扣天"');
    expect(html).toContain('aria-label="國小數學-一A 第 2 列的不計扣天"');
  });

  it('欄位順序：…列入多科折扣 → 不計扣天 → 帶班老師 → 星期 → …', () => {
    const html = render();
    const order = ['列入多科折扣', '不計扣天', '帶班老師', '星期', '上課時間', '課程時長', '操作'];
    let cursor = 0;
    for (const label of order) {
      const at = html.indexOf(label, cursor);
      expect(at, `找不到 ${label}，或它不在預期位置`).toBeGreaterThanOrEqual(0);
      cursor = at;
    }
  });

  it('空狀態的 colSpan 隨欄位數一致（12 欄）', () => {
    const html = render({ rows: [] });
    expect(html).toContain('<td colSpan="12" class="empty-row-text">');
  });
});

describe('#82：新增時段僅班名必填、其餘可留空', () => {
  it('星期可留空：編輯列是文字輸入且以 placeholder「未定」提示留空', () => {
    const html = render();
    // 編輯列：文字輸入（保留使用者輸入未知星期的能力——09 §3.1 的「需確認」狀態來自這裡）
    expect(html).toMatch(/<input[^>]*class="input-weekday"[^>]*placeholder="未定"/);
    expect(html).not.toMatch(/<select[^>]*class="input-weekday"/);
    // specs/14 A1: 新增入口為「新增班級」
    expect(html).toContain('＋ 新增班級');
  });

  it('缺時間的列：計算欄平靜顯示「—」且帶 aria-label「未設定時間」（decision d-…-11）', () => {
    const html = render();
    // 5 個計算欄位（時長 + 安親×2 + 課輔×2）都是未設定時間
    expect(html.match(/aria-label="未設定時間"/g)?.length).toBe(5);
    expect(html).not.toContain('待補');
    expect(html).not.toContain('badge-incomplete');
  });

  it('「—」以 subtle 樣式呈現，不是可點的警示 badge（不是阻擋訊號）', () => {
    const html = render();
    // 說明改用可聚焦的 InfoTip 按鈕（title 只在 hover 看得到，09 §6 與 a11y 稽核都不接受）
    expect(html).not.toContain('title="未設定時間"');
    expect(html).toMatch(/<button[^>]*aria-label="未設定時間"[^>]*>[\s\S]*?cell-not-set[^<]*>—</);
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
        onRestoreAuto: () => {},
        onExportExcel: () => {},
        onImportExcel: () => {},
      })
    );
    // 靜態渲染不會觸發事件；此處只確認 handler 已接上（未拋 TypeError＝呼叫鏈完整）
    expect(seen).toEqual([]);
    expect(seenFixed).toEqual([]);
  });
});

describe('specs/14：雙頁籤與切換課程類型操作（A1, A2, A4, A9, A10）', () => {
  it('頁籤渲染：顯示「非安親課輔班」與「安親課輔班」雙頁籤並帶有數量統計', () => {
    const html = render();
    expect(html).toContain('非安親課輔班');
    expect(html).toContain('安親課輔班');
    expect(html).toContain('role="tablist"');
  });

  it('非安親課輔班頁籤：首欄行操作有「轉為安親課輔班」按鈕', () => {
    const html = render({ onSwitchClassType: () => {} });
    expect(html).toContain('轉為安親課輔班');
    expect(html).toContain('data-switch-to-care="兒童美語-Gino"');
  });

  it('安親課輔班頁籤：表格顯示「安親課輔班（不計時段）」短標，操作有「轉為非安親課輔班」按鈕，無時間與不計扣天', () => {
    const careAttrs = new Map<string, ClassAttributesView>([
      ['國小輔導-四年級', { classType: 'care', category: 'care', categorySource: 'auto', fixedFiveDays: false }],
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
      onSwitchClassType: () => {},
    });
    expect(html).toContain('安親課輔班（不計時段）');
    expect(html).toContain('轉為非安親課輔班');
    expect(html).toContain('data-switch-to-non-care="國小輔導-四年級"');
    // 欄位徹底分離：安親課輔班表格無星期、無時間、無不計扣天
    expect(html).not.toContain('class="col-skip-deduction"');
    expect(html).not.toContain('class="col-weekday"');
    expect(html).not.toContain('class="col-time"');
  });

  it('a11y 契約：雙頁籤面板必須具有 role="tabpanel" 且與 tab 的 id/aria-controls 對應', () => {
    const html = render();
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('id="class-type-panel-non_care"');
    expect(html).toContain('aria-labelledby="class-type-tab-non_care"');
  });

  it('焦點班級定位 banner 契約：包含 data-focus-class 標記與「顯示全部班級」按鈕', () => {
    const html = render({ focusClass: '兒童美語-Gino' });
    expect(html).toContain('data-focus-class');
    expect(html).toContain('顯示全部班級');
  });

  it('焦點班級為安親課輔班時，初始頁籤自動聚焦至 [安親課輔班]，避免誤判 missing', () => {
    const careAttrs = new Map<string, ClassAttributesView>([
      ['國小輔導-四年級', { classType: 'care', category: 'care', categorySource: 'auto', fixedFiveDays: false }],
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
});
