import { describe, it, expect } from 'vitest';

import { compare, renderHtml } from '../../scripts/compare-session-pricing-report.mjs';
import { buildRunSnapshotContext } from '../../scripts/shared/rate-context';

/**
 * 加強班分流與附加費用依班歸屬（按堂計價工具）。全部為合成 fixture，無任何真實個資。
 *
 * ## 預期值依據（獨立手算，不取工具輸出）
 *
 *  - 同班附加費用常模：>= 50% 學生收取同一非零金額即為常模（heuristics 既有契約）。
 *    六B班 5 人各自的「國小部_教材費」皆為 200 → 常模 200，無人偏離。
 *  - 真實報表的版面事實（2026-11 報表實測）：「會計科目」欄對所有班都是「學雜費」，
 *    班別只寫在明細文字的前綴（`115小六數學加強班[團][小六][雜費] - 扣7/11颱風假停課`）。
 *    故同時修兩班的學生，加強班的 -340 與六B班的 +200 在舊行為下被加總成 -140。
 *  - 折扣 8.5 折 ＝ 8500 bps（沿用 report-xlsx 的「課程費 NN折」語意）。
 */

const MATH = '國小數學-六B';
const MATH_TOKEN = '115國小數學-六B[團]';
const ENH = '小六數學加強班';
const ENH_TOKEN = '115小六數學加強班[團][小六]';

const context = buildRunSnapshotContext({
  ruleSetVersion: 'erp-tag-v4',
  classCategories: [
    { base_name: MATH, category: 'math', fixed_five_days: 0, class_type: 'math' },
    { base_name: ENH, category: 'none', fixed_five_days: 0, class_type: 'other' },
  ],
})!;

const web = (name: string, enrollments: string[], mathBps = 10000) => ({
  name,
  personCode: `P-${name}`,
  grade: 6,
  gradeRaw: '小六',
  baseDiscountBps: 10000,
  subjectCount: 1,
  applicableAnqinBps: null,
  applicableTutoringBps: null,
  applicableEnglishBps: null,
  applicableMathBps: mathBps,
  tierComparisons: [],
  issues: [],
  trace: { rawTags: '' },
  enrollments: enrollments.map((t) => ({ rawToken: t, baseName: t.replace(/^115/, '').replace(/\[.*$/, ''), withdrawalDate: null })),
});

const rep = (name: string, tuitionRows: string[], discounts: string[] = []) => ({
  name,
  tuitionRows,
  discounts,
  otherDiscounts: [],
  other: [],
  billNo: 'SYNTH',
  billDate: '2026-10-01',
  billStatus: '已繳',
});

const item = (detail: string, amount: number) => ({ subject: '學雜費', detail, amount });
const MATH_FEE = item(`${MATH_TOKEN}[雜費] - 國小部_教材費`, 200);

function fixture() {
  const names = ['乙', '丙', '丁', '戊'];
  const reports = new Map<string, any>();
  const fees = new Map<string, any[]>();
  const roster: any[] = [];

  // 甲：同時修六B（8.5折）與加強班（8.5折），加強班另有颱風扣款 -340
  reports.set('甲', rep('甲', [`${ENH_TOKEN} - 12 堂課`, `${MATH_TOKEN} - 18堂課`], [
    `${ENH_TOKEN}[8.5折] - 課程費85折`,
    `${MATH_TOKEN}[8.5折] - 課程費85折`,
  ]));
  fees.set('甲', [item(`${ENH_TOKEN}[雜費] - 扣7/11颱風假停課`, -340), MATH_FEE]);
  roster.push(web('甲', [`${MATH_TOKEN}`, `${ENH_TOKEN}`], 8500));

  for (const n of names) {
    reports.set(n, rep(n, [`${MATH_TOKEN} - 18堂課`]));
    fees.set(n, [MATH_FEE]);
    roster.push(web(n, [MATH_TOKEN]));
  }

  // 己：只修加強班、無折扣
  reports.set('己', rep('己', [`${ENH_TOKEN} - 12 堂課`]));
  fees.set('己', []);
  roster.push(web('己', [ENH_TOKEN]));

  // 庚：名單在席加強班，但報表無其學費列
  roster.push(web('庚', [ENH_TOKEN]));

  return { reports, fees, roster };
}

const run = () => {
  const { reports, fees, roster } = fixture();
  return compare(reports as never, roster as never[], '2026-10-14', undefined, context as never, fees as never) as any;
};

describe('加強班分流：不進入國小數學比對', () => {
  it('加強班學費列不產生比對紀錄，也不產生「系統無適用折扣值」或「在席未開單」', () => {
    const { records } = run();
    expect(records.some((r: any) => String(r.excel.className ?? '').includes('加強班'))).toBe(false);
    expect(records.filter((r: any) => r.statusCategory === 'WEB_RATE_NOT_CONFIGURED')).toHaveLength(0);
    expect(records.filter((r: any) => r.statusCategory === 'ROSTER_NOT_BILLED')).toHaveLength(0);
  });

  it('國小數學的紀錄仍完整：5 位學生各一筆、全部一致', () => {
    const { records } = run();
    expect(records).toHaveLength(5);
    expect(records.every((r: any) => r.statusCategory === 'MATCH')).toBe(true);
  });
});

describe('附加費用依班歸屬', () => {
  it('同時修兩班者：加強班的扣款不併入六B班學雜費，六B班不被判偏離常模', () => {
    const { records } = run();
    const jia = records.find((r: any) => r.name === '甲')!;
    expect(jia.statusCategory).toBe('MATCH');
    expect(jia.note.tags ?? []).not.toContain('學雜費偏離常模');
    expect(jia.deviation).toBeFalsy();
  });
});

describe('加強班折扣區塊（enhancement）', () => {
  it('每位學生一列：有折扣、無折扣、在席未開單都在同一份清單', () => {
    const { enhancement } = run();
    expect(enhancement.map((e: any) => e.name).sort()).toEqual(['己', '庚', '甲']);
  });

  it('甲：顯示加強班折扣 8500、颱風扣款 -340，並並列其國小數學折扣', () => {
    const jia = run().enhancement.find((e: any) => e.name === '甲');
    expect(jia.hasDiscount).toBe(true);
    const cls = jia.classes[0];
    expect(cls.className).toBe(ENH);
    expect(cls.billed).toBe(true);
    expect(cls.rateBps).toBe(8500);
    expect(cls.ancillaryFees).toEqual([{ detail: expect.stringContaining('颱風'), amount: -340 }]);
    expect(jia.otherClassRates).toEqual([expect.objectContaining({ className: MATH, rateBps: 8500 })]);
  });

  it('己：無折扣仍列出，hasDiscount 為 false', () => {
    const ji = run().enhancement.find((e: any) => e.name === '己');
    expect(ji.hasDiscount).toBe(false);
    expect(ji.classes[0].rateBps).toBe(10000);
  });

  it('庚：名單在席但報表無學費列 → billed=false，保留在席未開單線索', () => {
    const geng = run().enhancement.find((e: any) => e.name === '庚');
    expect(geng.classes[0]).toMatchObject({ className: ENH, billed: false });
  });
});

describe('加強班折扣區塊的 HTML', () => {
  const META = {
    runId: 'run-synth', asOfDate: '2026-10-14', xlsxPath: '/synthetic/report.xlsx',
    ruleSetVersion: 'erp-tag-v4', numericPolicy: 'synthetic', rateSource: 'synthetic',
    billAnchorDate: '2026-10-01', duplicateNames: [] as string[], amountColumns: '（合成）',
  };

  it('輸出獨立區塊，含學生、加強班折扣、扣款與在席未開單，並註明不判定對錯', () => {
    const { records, enhancement } = run();
    const html = renderHtml(records, { ...META, fareItems: [], enhancement });
    expect(html).toContain('id="enhancement-detail"');
    const section = html.slice(html.indexOf('id="enhancement-detail"'));
    expect(section).toContain('甲');
    expect(section).toContain('8.5折');
    expect(section).toContain('-340');
    expect(section).toContain('庚');
    expect(section).toContain('在席未開單');
    expect(section).toContain('不判定對錯');
  });

  it('區塊不計入主表紀錄數（紀錄數維持 5）', () => {
    const { records, enhancement } = run();
    const html = renderHtml(records, { ...META, fareItems: [], enhancement });
    expect(html.match(/data-cat="/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(records).toHaveLength(5);
  });

  it('沒有加強班資料時輸出明確的空白說明，而非整區消失', () => {
    const html = renderHtml([], { ...META, fareItems: [], enhancement: [] });
    expect(html).toContain('id="enhancement-detail"');
    expect(html).toContain('本次報表無加強班項目');
  });
});
