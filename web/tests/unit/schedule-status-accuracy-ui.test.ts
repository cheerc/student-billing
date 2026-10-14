import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScheduleGrid } from '@/components/settings/schedule-grid';
import { ClassDeductionsPanel } from '@/components/results/class-deductions-panel';
import { buildSchedulePreview, type CalculatePreviewResponse, type CareStatus } from '@/application/schedule-preview';
import type { DeductionsResponse } from '@/application/schedule-deductions';
import { toCalculateDraft } from './helpers/calculate-draft';
import type { ScheduleGridRow } from '@/contracts/settings';

/**
 * 04 §8 UX07（修訂）、UX26；09 §3.1、§5.2（11 §3 A：F01、F02）的元件層測試。
 * 計算結果一律由真實的 buildSchedulePreview 產生（不手寫回應形狀），元件以 renderToStaticMarkup 呈現。
 *
 * 手算（v2 同星期；安親窗 13:00–16:00、課輔窗 16:30–19:30，週一至五；每日 180 分）：
 *   週一 15:20–16:50（920–1010）：安親重疊 40 分、課輔重疊 20 分。
 *   週一 17:00–18:00（1020–1080）：只與課輔窗重疊 60 分（安親 0）→ 班級課輔側有扣天、安親側「無重疊」。
 */

function row(over: Partial<ScheduleGridRow> & { rowId: string; className: string }): ScheduleGridRow {
  return {
    teacher: null,
    weekday: '一',
    startTime: '15:20',
    endTime: '16:50',
    startMinutes: 920,
    endMinutes: 1010,
    active: true,
    skipDeduction: false,
    ...over,
  };
}

function calc(rows: ScheduleGridRow[]): CalculatePreviewResponse {
  const core = buildSchedulePreview(toCalculateDraft(rows), 'erp-tag-v2');
  return { requestKey: 'k', draftHash: 'h', ...core };
}

function renderGrid(props: {
  rows: ScheduleGridRow[];
  calculateResult: CalculatePreviewResponse | null;
  calculateInputRows?: ScheduleGridRow[] | null;
  calculateError?: string | null;
}) {
  return renderToStaticMarkup(
    React.createElement(ScheduleGrid, {
      rows: props.rows,
      onUpdateRow: () => {},
      onDeleteRow: () => {},
      onAddRow: () => {},
      calculating: false,
      calculateResult: props.calculateResult,
      calculateInputRows: props.calculateInputRows ?? props.rows,
      calculateError: props.calculateError ?? null,
    })
  );
}

/** 取出某列（依 aria-label 的星期輸入）在 tbody 內的 <tr> html。 */
function trOf(html: string, className: string): string {
  const trs = html.match(/<tr class="schedule-row[\s\S]*?<\/tr>/g) ?? [];
  const hit = trs.find((t) => t.includes(`value="${className}"`));
  if (!hit) throw new Error(`找不到班級列：${className}`);
  return hit;
}

describe('UX07（修訂）：ScheduleGrid 對未知／空白星期的呈現', () => {
  it('非空非法星期「八」：該列顯示可聚焦的「需確認」徽章（按鈕），四個計算欄不顯示 0 或舊值；頁面有不靠 hover 的說明', () => {
    const rows = [row({ rowId: 'r1', className: '測試班', weekday: '八' })];
    const html = renderGrid({ rows, calculateResult: calc(rows) });
    const tr = trOf(html, '測試班');

    expect(tr).toContain('row-unknown-weekday');
    // 可聚焦：徽章是 <button>，名稱「需確認原因」
    expect(tr).toMatch(/<button[^>]*aria-label="需確認原因"[^>]*>[\s\S]*?需確認[\s\S]*?<\/button>/);
    // 四個計算欄（課程時長以外）都不是 0：以徽章取代
    // 以 class 選欄，不以欄位索引 —— #80 在表格前方插了「列入多科折扣」「天數固定 5 天」兩欄，
    // 索引式的 slice 會在欄位增加時默默指到錯的欄位（這正是本檔先前兩個失敗的原因）。
    const calcCells = (
      tr.match(/<td class="(?:number )?(?:cblue|cteal)" data-calc="[a-z-]+">[\s\S]*?<\/td>/g) ?? []
    ); // 安親重疊、安親扣除、課輔重疊、課輔扣除
    expect(calcCells).toHaveLength(4);
    for (const cell of calcCells) {
      expect(cell).toContain('需確認');
      expect(cell).not.toMatch(/>0</);
    }
    // 不靠 hover 的可讀說明（09 §6：需確認後果不可只藏 hover）
    expect(html).toMatch(/role="status"[^>]*data-unknown-weekday-notice/);
    expect(html).toContain('星期無法識別');
    expect(html).toContain('不代表沒有衝堂');
  });

  it('空白星期：同樣顯示「需確認」徽章與說明（不是 0、不是待補）', () => {
    const rows = [row({ rowId: 'r1', className: '測試班', weekday: '' })];
    const html = renderGrid({ rows, calculateResult: calc(rows) });
    const tr = trOf(html, '測試班');
    expect(tr).toContain('row-unknown-weekday');
    expect(tr).toMatch(/aria-label="需確認原因"/);
    expect(tr).not.toContain('待補');
    expect(html).toContain('沒有填星期');
  });

  it('合法週六：顯示 0（已驗證無衝堂），沒有需確認徽章與說明', () => {
    const rows = [row({ rowId: 'r1', className: '測試班', weekday: '六' })];
    const html = renderGrid({ rows, calculateResult: calc(rows) });
    const tr = trOf(html, '測試班');
    expect(tr).not.toContain('row-unknown-weekday');
    expect(tr).not.toContain('需確認');
    expect(tr).toMatch(/<td class="number cblue" data-calc="anqin-overlap">0<\/td>/);
    expect(html).not.toContain('data-unknown-weekday-notice');
  });

  it('舊值立即失效：列的輸入已和計算結果所依據的輸入不同（改星期）→ 該列顯示「—」，不沿用舊的 40／20', () => {
    const before = [row({ rowId: 'r1', className: '測試班', weekday: '一' })];
    const oldResult = calc(before); // 週一 15:20–16:50：安親 40、課輔 20
    expect(oldResult.rows[0].anqin.overlapMinutes).toBe(40);

    const now = [row({ rowId: 'r1', className: '測試班', weekday: '八' })]; // 剛改成非法值，新結果尚未回來
    const html = renderGrid({ rows: now, calculateResult: oldResult, calculateInputRows: before });
    const tr = trOf(html, '測試班');
    // 同上：以 class 選欄而非索引（#80 新增了兩欄，索引 slice 會指錯欄）
    const calcCells = (
      tr.match(/<td class="(?:col-duration )?number"[^>]*data-calc="duration">[\s\S]*?<\/td>|<td class="number (?:cblue|cteal)"[^>]*data-calc="[a-z-]+">[\s\S]*?<\/td>/g) ?? []
    ); // 課程時長、安親×2、課輔×2
    expect(calcCells).toHaveLength(5);
    for (const cell of calcCells) {
      expect(cell).not.toMatch(/>40</);
      expect(cell).not.toMatch(/>20</);
      expect(cell).not.toMatch(/>0</);
      expect(cell).toContain('—');
    }
    // 尚未取得新結果前，也不冒充成「需確認」以外的確定狀態
    expect(tr).not.toContain('row-unknown-weekday');
  });

  it('舊值立即失效：改起始時間也一樣（輸入與結果依據不同即失效）；未改的列仍顯示原結果', () => {
    const before = [
      row({ rowId: 'r1', className: '甲班' }),
      row({ rowId: 'r2', className: '乙班', weekday: '二' }),
    ];
    const oldResult = calc(before);
    const now = [
      row({ rowId: 'r1', className: '甲班', startTime: '15:40', startMinutes: 940 }),
      before[1],
    ];
    const html = renderGrid({ rows: now, calculateResult: oldResult, calculateInputRows: before });
    expect(trOf(html, '甲班')).not.toMatch(/>40</);
    expect(trOf(html, '乙班')).toMatch(/>40</); // 乙班未改，結果仍有效
  });

  it('舊值立即失效：勾了「不計扣天」也算改到該列的計算輸入（09 §3.1：新結果未回來前不沿用舊值）', () => {
    // #113 follow-up：不計扣天是逐列欄位，一勾就改變扣天，因此必須和星期／時間一樣列入
    // rowCalcSignature；否則畫面會繼續顯示舊的 40／20，讓人以為勾選沒生效。
    const before = [row({ rowId: 'r1', className: '測試班', weekday: '一' })];
    const oldResult = calc(before);
    expect(oldResult.rows[0].anqin.overlapMinutes).toBe(40);

    const now = [row({ rowId: 'r1', className: '測試班', weekday: '一', skipDeduction: true })];
    const html = renderGrid({ rows: now, calculateResult: oldResult, calculateInputRows: before });
    const tr = trOf(html, '測試班');
    expect(tr).not.toMatch(/>40</);
    expect(tr).toContain('—');
  });

  it('calculate 失敗：顯示 role=alert 的說明，所有計算欄顯示「—」，不是 0、也不是舊值', () => {
    const rows = [row({ rowId: 'r1', className: '測試班' })];
    const html = renderGrid({
      rows,
      calculateResult: null,
      calculateError: '無法計算重疊與扣除天數，請稍後再試。',
    });
    expect(html).toMatch(/role="alert"[^>]*data-calculate-error/);
    expect(html).toContain('無法計算重疊與扣除天數');
    expect(html).toContain('不代表沒有衝堂');
    // #113：班級欄位由 8 欄增至 9 欄（多出「不計扣天」），計算欄因此要 slice(6, 10)
    // 而不是 slice(5, 9)——否則會把星期欄當成計算欄，測到的是錯的欄位。
    const calcCells = (trOf(html, '測試班').match(/<td[\s\S]*?<\/td>/g) ?? []).slice(6, 10);
    for (const cell of calcCells) {
      expect(cell).toContain('—');
      expect(cell).not.toMatch(/>0</);
    }
  });

  it('沒有失敗時不顯示失敗說明（不製造假警報）', () => {
    const rows = [row({ rowId: 'r1', className: '測試班' })];
    const html = renderGrid({ rows, calculateResult: calc(rows) });
    expect(html).not.toContain('data-calculate-error');
    expect(html).not.toContain('data-unknown-weekday-notice');
  });
});

describe('UX26：班級扣天的狀態同時考慮安親與課輔兩側', () => {
  function panelFor(rows: ScheduleGridRow[]) {
    const core = buildSchedulePreview(toCalculateDraft(rows), 'erp-tag-v2');
    const data: DeductionsResponse = {
      ...core,
      scope: 'seed',
      runId: null,
      scheduleVersionId: 'seed-v250922',
      settingsRevision: null,
      draftHash: 'h',
    };
    return renderToStaticMarkup(
      React.createElement(ClassDeductionsPanel, { data, onEditClass: () => {} })
    );
  }

  function statusOf(html: string, classKey: string): { text: string; dataStatus: string } {
    const trs = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
    const tr = trs.find((t) => t.includes(`${classKey} `));
    if (!tr) throw new Error(`找不到班級 ${classKey}`);
    const m = tr.match(/<span class="ded-status" data-status="([^"]+)">([^<]*)<\/span>/);
    if (!m) throw new Error('找不到狀態欄');
    return { text: m[2], dataStatus: m[1] };
  }

  it('只與課輔窗口重疊的班（週一 17:00–18:00）：課輔側有扣天，狀態是「已計算」而不是「無重疊」', () => {
    const html = panelFor([row({ rowId: 'r1', className: '只課輔班', startTime: '17:00', endTime: '18:00', startMinutes: 1020, endMinutes: 1080 })]);
    // 前置（手算）：安親側 0（無重疊），課輔側 60÷180＝0.333→實扣 0.5
    expect(html).toContain('0.333');
    const s = statusOf(html, '只課輔班');
    expect(s.text).toBe('已計算');
    expect(s.text).not.toBe('無重疊');
    expect(s.dataStatus).toBe('calculated');
  });

  it('只與安親窗口重疊的班（週一 13:30–14:30）：同樣是「已計算」', () => {
    const html = panelFor([row({ rowId: 'r1', className: '只安親班', startTime: '13:30', endTime: '14:30', startMinutes: 810, endMinutes: 870 })]);
    expect(statusOf(html, '只安親班').text).toBe('已計算');
  });

  it('兩側都沒有重疊（合法週六）：才是「無重疊」', () => {
    const html = panelFor([row({ rowId: 'r1', className: '週六班', weekday: '六' })]);
    expect(statusOf(html, '週六班').text).toBe('無重疊');
  });

  it('未知星期的班：狀態「需確認」，不被任一側掩蓋', () => {
    const html = panelFor([row({ rowId: 'r1', className: '未知班', weekday: '八' })]);
    expect(statusOf(html, '未知班').text).toBe('需確認');
  });

  it('展開逐堂列：未知星期的列在重疊／扣除欄顯示「需確認」，不是 0', () => {
    const rows = [row({ rowId: 'r1', className: '未知班', weekday: '八' })];
    const core = buildSchedulePreview(toCalculateDraft(rows), 'erp-tag-v2');
    const data: DeductionsResponse = { ...core, scope: 'seed', runId: null, scheduleVersionId: 's', settingsRevision: null, draftHash: 'h' };
    const html = renderToStaticMarkup(
      React.createElement(ClassDeductionsPanel, { data, onEditClass: () => {}, expandedClassKey: '未知班' })
    );
    const detail = html.match(/<table class="ded-session-table">[\s\S]*?<\/table>/)![0];
    expect(detail).toContain('需確認');
    expect(detail).not.toMatch(/>0\.000</);
  });
});

describe('ClassDeductionsPanel：整班優先序（未知／不完整＞已計算＞無重疊；停用、共用窗口為班級層旗標）', () => {
  const cases: Array<[CareStatus, CareStatus, CareStatus]> = [
    ['no_overlap', 'no_overlap', 'no_overlap'],
    ['calculated', 'calculated', 'calculated'],
    ['no_overlap', 'calculated', 'calculated'],
    ['calculated', 'no_overlap', 'calculated'],
    ['no_overlap', 'unknown_weekday', 'unknown_weekday'],
    ['unknown_weekday', 'no_overlap', 'unknown_weekday'],
    ['calculated', 'unknown_weekday', 'unknown_weekday'],
    ['unknown_weekday', 'calculated', 'unknown_weekday'],
    ['calculated', 'incomplete', 'incomplete'],
    ['no_overlap', 'missing_time', 'missing_time'],
    ['missing_time', 'calculated', 'missing_time'],
    ['inactive', 'inactive', 'inactive'],
    ['shared_window', 'shared_window', 'shared_window'],
    ['inactive', 'no_overlap', 'inactive'],
    // #113：不計扣天與「已計算」同層級且優先於「無重疊」，但兩者同 rank 時保留安親側（第一引數）
    ['no_deduction', 'no_overlap', 'no_deduction'],
    ['no_overlap', 'no_deduction', 'no_deduction'],
    ['no_deduction', 'calculated', 'no_deduction'],
    ['calculated', 'no_deduction', 'calculated'],
    // 不可信狀態仍優先於「不計扣天」，不可被它掩蓋
    ['no_deduction', 'unknown_weekday', 'unknown_weekday'],
    ['no_deduction', 'incomplete', 'incomplete'],
  ];
  it.each(cases)('(%s, %s) → %s', (anqin, tutoring, expected) => {
    // 以真實 preview 為底，只覆寫兩側狀態以驗證 UI consumer 的獨立組合；不引用未存在的新 helper。
    const core = buildSchedulePreview(toCalculateDraft([row({ rowId: 'r1', className: '狀態組合班' })]), 'erp-tag-v2');
    const data: DeductionsResponse = {
      ...core,
      classes: core.classes.map((c) => ({
        ...c,
        anqin: { ...c.anqin, status: anqin },
        tutoring: { ...c.tutoring, status: tutoring },
      })),
      scope: 'seed',
      runId: null,
      scheduleVersionId: 'seed-v250922',
      settingsRevision: null,
      draftHash: 'h',
    };
    const html = renderToStaticMarkup(
      React.createElement(ClassDeductionsPanel, { data, onEditClass: () => {} })
    );
    const labels: Record<CareStatus, string> = {
      calculated: '已計算',
      no_overlap: '無重疊',
      no_deduction: '不計扣天',
      unknown_weekday: '需確認',
      missing_time: '待補',
      incomplete: '待補',
      shared_window: '共用窗口',
      inactive: '停用',
    };
    expect(html).toContain(`<span class="ded-status" data-status="${expected}">${labels[expected]}</span>`);
  });
});
