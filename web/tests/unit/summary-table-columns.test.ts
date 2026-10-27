import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SummaryTable, { formatBaseDiscount, STUDENT_TABLE_COLUMNS } from '@/components/summary-table';
import { formatDiscountBps } from '@/application/roster-changes';
import type { StudentCalculationItem } from '@/application/query-students';

/**
 * 09 §5.1 學生總表預設欄位（12 欄）與 UX14（八欄 null／false／0／特殊率／不適用、型別不混）：
 * 預設欄位為 姓名（凍結）、年級、所屬班級、安親天數、課輔天數、額外扣天、合計折扣、
 * 已補科數、兄弟姊妹折扣、特殊折扣、園內生、需確認。
 * 人員代碼、美語／數學／中文天數、寫功課等既有欄**移到欄位選擇／明細，不刪功能**。
 */

function item(over: Partial<StudentCalculationItem> = {}): StudentCalculationItem {
  return {
    id: 'r1',
    runId: 'run_1',
    personCode: 'STU0001',
    name: '王小明',
    branch: '本校',
    grade: 3,
    gradeRaw: '三年級',
    subjectCount: 2,
    baseDiscountBps: 9500,
    anqinDays: null,
    anqinDisplay: null,
    tutoringDays: 5,
    tutoringDisplay: '5',
    englishDays: 1,
    mathDays: 0.5,
    chineseDays: null,
    homeworkDays: null,
    intensiveEnglishDays: null,
    saturdayTutoringDays: null,
    applicableAnqinBps: 9500,
    applicableTutoringBps: 9500,
    applicableEnglishBps: 9500,
    applicableMathBps: 9500,
    tierMismatch: false,
    tierComparisons: [],
    issues: [],
    hasIssues: false,
    actionableIssues: [],
    actionableHasIssues: false,
    trace: {},
    createdAt: '2026-09-29T10:00:00.000Z',
    enrollments: [
      {
        rawToken: '國小數學-三A[團]',
        yearPrefix: null,
        baseName: '國小數學-三A',
        groupFlag: '團',
        modifiers: [],
        withdrawalDate: null,
        erpBillingTierRaw: '4.5',
        erpBillingTier: 4.5,
        tierParseStatus: 'parsed',
        parseStatus: 'ok',
      },
    ],
    classText: '國小數學-三A[團]',
    sourceRow: 2,
    ...over,
  } as StudentCalculationItem;
}

const defaultSnapshots = [
  { base_name: '國小輔導-一A', category: 'care', fixed_five_days: 0 },
  { base_name: '國小數學-三A', category: 'math', fixed_five_days: 0 },
  { base_name: '兒童美語-Gino', category: 'english', fixed_five_days: 0 },
  { base_name: '國語文-合成', category: 'none', fixed_five_days: 0 },
];

const render = (students: StudentCalculationItem[], props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(SummaryTable, {
      students,
      onSelectStudent: () => {},
      classCategorySnapshots: props.classCategorySnapshots !== undefined ? props.classCategorySnapshots as any : (props.ruleSetVersion ? defaultSnapshots : null),
      ...props,
    })
  );

describe('09 §5.1：學生總表預設欄位為 12 欄，既有欄位移不刪功能', () => {
  it('預設欄位順序為規格所列 12 欄（姓名／年級／所屬班級／安親／課輔／額外扣天／合計折扣／已補科數／兄弟姊妹／特殊折扣／園內生／需確認）', () => {
    expect(STUDENT_TABLE_COLUMNS).toEqual([
      '姓名',
      '年級',
      '所屬班級',
      '安親天數',
      '課輔天數',
      '額外扣天',
      '合計折扣',
      '已補科數',
      '兄弟姊妹折扣',
      '特殊折扣',
      '園內生',
      '需確認',
    ]);
  });

  it('表格標頭只呈現 12 個預設欄位；人員代碼與美語／數學／中文／寫功課不在預設欄（但功能未刪，於欄位選擇與明細）', () => {
    const html = render([item()]);
    const ths = html.match(/<th[^>]*>([\s\S]*?)<\/th>/g) ?? [];
    // ⓘ 為 tooltip 指示器（非欄位名稱的一部分），比對時去除
    const labels = ths
      .map((t) => t.replace(/<[^>]*>/g, '').replace(/\s*ⓘ/g, '').trim())
      .filter(Boolean);
    expect(labels).toEqual([...STUDENT_TABLE_COLUMNS]);
    // tooltip 指示器存在（合計折扣需說明基本率與指定課程的差別）
    expect(html).toContain('ⓘ');

    // 位移而非刪除：欄位選擇與明細仍可取得這些值
    expect(labels).not.toContain('人員代碼');
    expect(labels).not.toContain('美語天數');
  });

  it('姓名欄為凍結欄（sticky）', () => {
    const html = render([item()]);
    expect(html).toMatch(/class="[^"]*sticky-name[^"]*"/);
  });
});

describe('UX14：型別不混——0／null／非適用／未設定分開顯示', () => {
  it('安親天數為 null（非適用）與 0（適用但無扣天）分開', () => {
    const html = render([item()]);
    // 課輔 5 天顯示
    expect(html).toContain('>5<');
    // 安親 null 顯示「—」而非 0
    expect(html).toContain('—');
  });

  it('合計折扣對應基本率：顯示收取率短標；「指定課程可能另有調整」說明只在表頭 tooltip，不逐列重複（O01）', () => {
    const html = render([item({ baseDiscountBps: 9500 }), item({ personCode: 'STU0002', baseDiscountBps: 9000 })]);
    expect(html).toContain('95折');
    // 說明移到表頭：表頭有名稱明確的說明按鈕，資料列不重複同一句
    const thead = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
    const tbody = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
    expect(thead).toMatch(/aria-label="合計折扣說明"/);
    expect(tbody).not.toContain('指定課程可能另有調整');
  });

  it('未配置／null 折扣顯示「未設定」而非 100%（UX14：不可把未配置當 100%）', () => {
    const html = render([item({ baseDiscountBps: null, subjectCount: null })]);
    expect(html).toContain('未設定');
    expect(html).not.toContain('無折扣');
  });

  it('已補科數 0 與 null 分開：null 為「無法判定」', () => {
    const zero = render([item({ subjectCount: 0 })]);
    expect(zero).toContain('>0<');
    const none = render([item({ subjectCount: null })]);
    expect(none).toContain('—');
  });

  it('formatBaseDiscount：10000→無折扣、9500→95折、9000→9折、null→未設定', () => {
    expect(formatBaseDiscount(10000)).toBe('無折扣');
    expect(formatBaseDiscount(9500)).toBe('95折');
    expect(formatBaseDiscount(9000)).toBe('9折');
    expect(formatBaseDiscount(null)).toBe('未設定');
    // 與異動判準共用同一格式化（短標一致）
    expect(formatBaseDiscount(9500)).toBe(formatDiscountBps(9500));
  });
});

describe('UX14／09 §5.1：徽章與合計折扣分離', () => {
  it('合計折扣是基本率；未選班時不出現任何適用率（不把適用率塞進別的欄位冒充）', () => {
    const html = render([item({ baseDiscountBps: 9500, applicableAnqinBps: 9000, applicableTutoringBps: 9000 })]);
    // 基本率 95折
    expect(html).toContain('95折');
    // 未恰選一班：沒有本班適用折扣欄，適用率 9折 不出現在表格任何一格
    expect(html).not.toContain('本班適用折扣');
    expect(html).not.toContain('9折');
  });

  it('特殊折扣欄顯示標籤的特殊折扣（例如 95折），沒有標籤為「—」，不是課程適用率', () => {
    const withTag = render([item({ baseDiscountBps: 9500, trace: { rawTags: '特殊折扣85折' } as never, applicableTutoringBps: 9000 })]);
    const cells = (withTag.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((c) => c.replace(/<[^>]*>/g, '').trim());
    expect(cells).toContain('85折');
    const without = render([item({ baseDiscountBps: 9500, applicableTutoringBps: 9000, applicableAnqinBps: 9000 })]);
    const cells2 = (without.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((c) => c.replace(/<[^>]*>/g, '').trim());
    expect(cells2).not.toContain('9折');
  });

  it('無警告時不堆綠色 badge、不宣告帳單已對帳正確（UX15／09 §5.1）', () => {
    const html = render([item({ hasIssues: false, tierMismatch: false })]);
    expect(html).not.toContain('已對帳');
    expect(html).not.toContain('正確');
  });

  it('級距差異徽章不得硬寫筆數（09 §7：預期N人只在 fixture）', () => {
    const html = render([item({ tierMismatch: true })]);
    expect(html).toContain('天數不同');
    // 舊實作的「級距差異 (5筆)」硬寫筆數，必須移除
    expect(html).not.toContain('級距差異 (5筆)');
    expect(html).not.toContain('(5筆)');
  });
});

describe('UX28／F05：恰選一班時的本班適用折扣欄（與基本率並列、不覆蓋）', () => {
  const cellsOf = (html: string) => (html.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((c) => c.replace(/<[^>]*>/g, '').trim());
  const headers = (html: string) =>
    (html.match(/<th[^>]*>([\s\S]*?)<\/th>/g) ?? []).map((t) => t.replace(/<[^>]*>/g, '').replace(/\s*ⓘ/g, '').trim()).filter(Boolean);

  it('恰選國小輔導班：欄位排在合計折扣右側；一二年級取安親側、三至六年級取課輔側；基本率不被覆蓋', () => {
    const html = render(
      [
        item({ personCode: 'S1', grade: 1, baseDiscountBps: 10000, applicableAnqinBps: 9500, applicableTutoringBps: 7000 }),
        item({ personCode: 'S2', grade: 3, baseDiscountBps: 9500, applicableAnqinBps: 7000, applicableTutoringBps: 9000 }),
      ],
      { singleClass: '國小輔導-一A', ruleSetVersion: 'erp-tag-v2' }
    );
    const h = headers(html);
    expect(h).toContain('本班適用折扣');
    expect(h.indexOf('本班適用折扣')).toBe(h.indexOf('合計折扣') + 1);
    const cells = cellsOf(html);
    // 兩列各 13 欄（12 欄＋本班適用折扣）；基本率仍在原欄
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g)!.filter((r) => r.includes('<td'));
    expect(rows).toHaveLength(2);
    const rowCells = rows.map((r) => (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((c) => c.replace(/<[^>]*>/g, '').trim()));
    const base = h.indexOf('合計折扣');
    const local = h.indexOf('本班適用折扣');
    expect(rowCells[0][base]).toBe('無折扣');
    expect(rowCells[0][local]).toBe('95折'); // 一年級 → 安親
    expect(rowCells[1][base]).toBe('95折');
    expect(rowCells[1][local]).toBe('9折'); // 三年級 → 課輔
    expect(cells.length).toBe(rowCells[0].length * 2);
  });

  it('國小數學取 math、兒童美語取 english；年級未知的輔導班為「—」（null）；未配置班為「未設定」，兩者分開且不是 100%', () => {
    const local = (singleClass: string, over: Partial<StudentCalculationItem>) => {
      const html = render([item(over)], { singleClass, ruleSetVersion: 'erp-tag-v2' });
      const h = headers(html);
      const row = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g)!.find((r) => r.includes('<td'))!;
      const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((c) => c.replace(/<[^>]*>/g, '').trim());
      return cells[h.indexOf('本班適用折扣')];
    };
    expect(local('國小數學-三A', { applicableMathBps: 9000, applicableEnglishBps: 7000 })).toBe('9折');
    expect(local('兒童美語-Gino', { applicableMathBps: 9000, applicableEnglishBps: 7000 })).toBe('7折');
    expect(local('國小輔導-一A', { grade: null, applicableAnqinBps: 9500, applicableTutoringBps: 9500 })).toBe('—');
    expect(local('國語文-合成', { applicableMathBps: 9000 })).toBe('未設定');
    expect(local('國語文-合成', { applicableMathBps: 9000 })).not.toBe('無折扣');
    const noRun = render([item({ applicableMathBps: 9000 })], { singleClass: '國小數學-三A' });
    const noRunRow = noRun.match(/<tr[^>]*>[\s\S]*?<\/tr>/g)!.find((r) => r.includes('<td'))!;
    const noRunCells = (noRunRow.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((c) => c.replace(/<[^>]*>/g, '').trim());
    expect(noRunCells[headers(noRun).indexOf('本班適用折扣')]).toBe('未設定');
  });

  it('沒有 singleClass（未選班或選多班）：沒有本班適用折扣欄', () => {
    expect(headers(render([item()]))).not.toContain('本班適用折扣');
    expect(headers(render([item()], { singleClass: null }))).not.toContain('本班適用折扣');
  });
});
