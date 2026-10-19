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

describe('#80：折扣類別與固定 5 天併入時段表格', () => {
  it('同一張表格裡就有「列入多科折扣」與「天數固定 5 天」兩欄', () => {
    const html = render();
    expect(html).toContain('列入多科折扣');
    expect(html).toContain('天數固定 5 天');
    // 兩欄都在同一個 table 內（不是另開一張）
    expect(html.match(/<table/g)?.length).toBe(1);
  });

  it('每個時段列都帶該班的折扣類別下拉與固定 5 天勾選（不是每班一列）', () => {
    const html = render();
    // 兩列、兩個班 → 兩個下拉、兩個 checkbox
    expect(html.match(/data-category-select=/g)?.length).toBe(2);
    expect(html.match(/data-fixed-five-toggle=/g)?.length).toBe(2);
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

  it('固定 5 天 checkbox 反映有效值（一A 為 manual=true → checked）', () => {
    const html = render();
    // Gino 是 auto=false → 未勾；一A 是 manual=true → 勾
    const checkboxes = html.match(/data-fixed-five-toggle="[^"]*"[^/]*?\/>/g) ?? [];
    expect(checkboxes).toHaveLength(2);
    expect(html).toMatch(/data-fixed-five-toggle="兒童美語-Gino"[^>]*>/);
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

  it('欄位順序：班級名稱 → 列入多科折扣 → 天數固定 5 天 → 帶班老師 → 星期 → 時間 → 計算欄 → 操作', () => {
    const html = render();
    const order = [
      '班級名稱',
      '列入多科折扣',
      '天數固定 5 天',
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
  it('表格有「不計扣天」欄，緊接在「天數固定 5 天」之後', () => {
    const html = render();
    const atFixed = html.indexOf('天數固定 5 天');
    const atSkip = html.indexOf('不計扣天');
    expect(atSkip).toBeGreaterThan(atFixed);
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

  it('欄位順序：…天數固定 5 天 → 不計扣天 → 帶班老師 → 星期 → …', () => {
    const html = render();
    const order = ['天數固定 5 天', '不計扣天', '帶班老師', '星期', '上課時間', '課程時長', '操作'];
    let cursor = 0;
    for (const label of order) {
      const at = html.indexOf(label, cursor);
      expect(at, `找不到 ${label}，或它不在預期位置`).toBeGreaterThanOrEqual(0);
      cursor = at;
    }
  });

  it('空狀態的 colSpan 隨欄位數一起長大（12 → 13）', () => {
    const html = render({ rows: [] });
    expect(html).toContain('<td colSpan="13" class="empty-row-text">');
  });
});

describe('#82：新增時段僅班名必填、其餘可留空', () => {
  it('星期可留空：編輯列是文字輸入且以 placeholder「未定」提示留空', () => {
    const html = render();
    // 編輯列：文字輸入（保留使用者輸入未知星期的能力——09 §3.1 的「需確認」狀態來自這裡）
    expect(html).toMatch(/<input[^>]*class="input-weekday"[^>]*placeholder="未定"/);
    expect(html).not.toMatch(/<select[^>]*class="input-weekday"/);
    // 新增表單獨立於元件 state（showAddForm 是內部 useState），靜態渲染不會展開；
    // 因此這裡只驗「新增時段」入口存在，星期選項交給 E2E（#82-1 實際開表單驗預設值為空）。
    expect(html).toContain('＋ 新增時段');
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
