import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RosterChangesDetails } from '@/components/imports/roster-changes-details';
import type {
  ClassBreakdown,
  ClassDiscountChange,
  ClassDiscountReason,
  EnrollmentChange,
  RosterChange,
} from '@/application/roster-changes';

/**
 * PR-2 呈現（-181；decisions -68／-75／-76／-79；specs/06 D43）。
 *
 * 文案正本：drafts/roster-changes-copy-final.txt（operator 授權 Lead 定稿）。
 * 畫面**只呈現** application 層已算好的 `enrollmentChanges`／`classDiscountChanges`，不自行推導。
 *
 * 對象是補習班行政人員：禁用詞＝合計折扣、適用率、科數、類別、token、bps；
 * 「原本／現在」兩欄沿用 formatDiscountBps 既有短標，原因欄不寫數字、不寫「因為」。
 */

type Change = RosterChange & {
  enrollmentChanges: EnrollmentChange[];
  classDiscountChanges: ClassDiscountChange[];
};

const ONE_BREAKDOWN: ClassBreakdown[] = [
  {
    baseName: '國小數學-三A',
    rawToken: 'a',
    presence: 'kept',
    beforeAnqinDeduction: 0,
    beforeTutoringDeduction: 0,
    afterAnqinDeduction: 0,
    afterTutoringDeduction: 1,
    statusBefore: 'calculated',
    statusAfter: 'calculated',
  },
];

function change(over: Partial<Change> = {}): Change {
  return {
    personCode: 'C1',
    name: '學生C1',
    isNew: false,
    isRemoved: false,
    before: {
      subjectCount: 1,
      baseDiscountBps: 10000,
      applicableAnqinBps: 10000,
      applicableTutoringBps: 10000,
      applicableMathBps: 10000,
      applicableEnglishBps: 10000,
      anqinDays: 5,
      tutoringDays: 5,
      isEnrolledAnqin: true,
      isEnrolledTutoring: true,
    },
    after: {
      subjectCount: 2,
      baseDiscountBps: 9500,
      applicableAnqinBps: 9500,
      applicableTutoringBps: 9500,
      applicableMathBps: 9500,
      applicableEnglishBps: 9500,
      anqinDays: 5,
      tutoringDays: 5,
      isEnrolledAnqin: true,
      isEnrolledTutoring: true,
    },
    discountChange: {
      beforeBps: 10000,
      afterBps: 9500,
      beforeLabel: '無折扣',
      afterLabel: '95折',
      reason: '已補科數變動',
    },
    dayChange: null,
    reasons: ['已補科數變動'],
    enrollmentChanges: [],
    classDiscountChanges: [],
    ...over,
  };
}

const render = (changes: Change[]) => renderToStaticMarkup(React.createElement(RosterChangesDetails, { changes }));

const rowOf = (html: string, code: string): string => {
  const rows = html.match(/<tr data-status[\s\S]*?<\/tr>/g) ?? [];
  const row = rows.find((r) => r.includes(`>${code}<`));
  if (!row) throw new Error(`找不到 ${code} 的明細列`);
  return row;
};

describe('PR-2 逐人明細：表頭與欄位契約', () => {
  it('表頭為 學生｜狀態｜報名異動｜折扣變動｜安親天數｜課輔天數（6 欄，展開列 colSpan=6）', () => {
    const html = render([
      change({ dayChange: { beforeAnqinDays: 5, afterAnqinDays: 4, beforeTutoringDays: 5, afterTutoringDays: 5, classBreakdown: ONE_BREAKDOWN } }),
    ]);
    const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual(['學生', '狀態', '報名異動', '折扣變動', '安親天數', '課輔天數']);
    expect(html).toMatch(/<td colSpan="6">/);
    expect(html).not.toMatch(/<td colSpan="7">/);
  });

  it('畫面全區不得出現禁用詞：合計折扣／適用率／科數／類別', () => {
    const html = render([
      change({
        reasons: ['已補科數變動'],
        enrollmentChanges: [
          { baseName: '兒童美語-EA', rawToken: 'a', presence: 'added' },
          { baseName: '國小數學-三A', rawToken: 'b', presence: 'removed' },
        ],
        classDiscountChanges: [
          {
            baseName: '國小數學-三A',
            rawToken: 'b',
            sideOf: 'math',
            beforeBps: 10000,
            afterBps: 9500,
            reasons: [{ kind: 'enrollment_added', className: '兒童美語-EA' }],
          },
        ],
      }),
    ]);
    for (const banned of ['合計折扣', '適用率', '科數', '類別']) {
      expect(html, `畫面不得出現「${banned}」`).not.toContain(banned);
    }
  });
});

describe('PR-2 狀態欄', () => {
  it('異動 → 「異動」；整位新學生 → 「新學生」；整位不在本次名單 → 「已不在名單」', () => {
    const html = render([
      change({ personCode: 'CH', name: '異動生' }),
      change({ personCode: 'NEW', name: '新生', isNew: true }),
      change({ personCode: 'GONE', name: '離開生', isRemoved: true }),
    ]);
    expect(rowOf(html, 'CH')).toContain('<td data-field="status">異動</td>');
    expect(rowOf(html, 'NEW')).toContain('<td data-field="status">新學生</td>');
    expect(rowOf(html, 'GONE')).toContain('<td data-field="status">已不在名單</td>');
  });

  it('新學生／已不在名單兩列的報名異動與折扣變動都顯示「—」', () => {
    const html = render([
      change({
        personCode: 'NEW',
        isNew: true,
        before: null,
        enrollmentChanges: [{ baseName: '兒童美語-EA', rawToken: 'a', presence: 'added' }],
        classDiscountChanges: [
          {
            baseName: '兒童美語-EA',
            rawToken: 'a',
            sideOf: 'english',
            beforeBps: null,
            afterBps: 10000,
            reasons: [],
          },
        ],
      }),
    ]);
    const row = rowOf(html, 'NEW');
    expect(row).toMatch(/data-field="enrollment"[^>]*>—</);
    expect(row).toMatch(/data-field="class-discount"[^>]*>—</);
  });
});

describe('PR-2 報名異動欄（-76 一：每列一件事）', () => {
  it('新增／退出／kept 不顯示；只有 kept → 「—」', () => {
    const html = render([
      change({
        personCode: 'K',
        enrollmentChanges: [
          { baseName: '國小數學-三A', rawToken: 'a', presence: 'kept' },
          { baseName: '兒童美語-EA', rawToken: 'b', presence: 'added' },
          { baseName: '兒童美語-EC', rawToken: 'c', presence: 'removed' },
        ],
      }),
    ]);
    const cell = rowOf(html, 'K').match(/<td data-field="enrollment">([\s\S]*?)<\/td>/)![1];
    expect(cell).toContain('新增 兒童美語-EA');
    expect(cell).toContain('退出 兒童美語-EC');
    expect(cell).not.toContain('國小數學-三A');
    expect(cell).not.toContain('保留');
  });

  it('只有 kept → 「—」', () => {
    const html = render([
      change({
        personCode: 'ONLYK',
        enrollmentChanges: [{ baseName: '國小數學-三A', rawToken: 'a', presence: 'kept' }],
      }),
    ]);
    expect(rowOf(html, 'ONLYK')).toMatch(/<td data-field="enrollment">—<\/td>/);
  });

  it('switched 成對只顯示一行「換班 舊 → 新」，不出現兩行', () => {
    // switchedWith 存的是**另一端的 rawToken**（roster-changes.ts 建構時對稱設定），
    // rawToken 形如「<baseName>[團]」，與其他測試的 student() helper 一致。
    const html = render([
      change({
        personCode: 'SW',
        enrollmentChanges: [
          { baseName: '國小數學-三A', rawToken: '國小數學-三A[團]', presence: 'switched', switchedWith: '國小數學-三B[團]' },
          { baseName: '國小數學-三B', rawToken: '國小數學-三B[團]', presence: 'switched', switchedWith: '國小數學-三A[團]' },
        ],
      }),
    ]);
    const cell = rowOf(html, 'SW').match(/<td data-field="enrollment">([\s\S]*?)<\/td>/)![1];
    expect(cell).toContain('換班 國小數學-三A → 國小數學-三B');
    expect(cell.match(/換班/g)?.length, '換班只一行').toBe(1);
  });

  it('班名用名冊原文，不縮寫', () => {
    const html = render([
      change({
        personCode: 'FULL',
        enrollmentChanges: [{ baseName: '115國小輔導-四年級A[團]', rawToken: 'a', presence: 'added' }],
      }),
    ]);
    expect(rowOf(html, 'FULL')).toContain('新增 115國小輔導-四年級A[團]');
  });
});

describe('PR-2 折扣變動欄（-76 二：班級｜原本｜現在｜原因）', () => {
  const discountRow = (code: string, item: ClassDiscountChange) =>
    render([
      change({
        personCode: code,
        classDiscountChanges: [item],
        enrollmentChanges: [],
      }),
    ]);

  it('一行一班：「<班名>　原本 → 現在　原因」，欄位以 data-field 標記', () => {
    const html = discountRow(
      'D1',
      {
        baseName: '國小數學-三A',
        rawToken: 'a',
        sideOf: 'math',
        beforeBps: 10000,
        afterBps: 9500,
        reasons: [{ kind: 'enrollment_added', className: '兒童美語-EA' }],
      }
    );
    expect(html).toContain('<td data-field="class-discount"');
    expect(html).toContain('國小數學-三A');
    expect(html).toContain('無折扣 → 95折');
    expect(html).toContain('新增 兒童美語-EA');
  });

  it('原因文案：新增／退出／加上標籤「X」／移除標籤「X」', () => {
    const cases: Array<[ClassDiscountReason[], RegExp]> = [
      [[{ kind: 'enrollment_added', className: '兒童美語-EA' }], /新增 兒童美語-EA/],
      [[{ kind: 'enrollment_removed', className: '國小數學-三A' }], /退出 國小數學-三A/],
      [[{ kind: 'tag_added', tag: '有兄弟姊妹折扣' }], /加上標籤「有兄弟姊妹折扣」/],
      [[{ kind: 'tag_removed', tag: '特殊折扣85折' }], /移除標籤「特殊折扣85折」/],
    ];
    for (const [reasons, pattern] of cases) {
      const html = discountRow('R', {
        baseName: '國小輔導-一A',
        rawToken: 'a',
        sideOf: 'care',
        beforeBps: 10000,
        afterBps: 9500,
        reasons,
      });
      expect(html, reasons[0].kind).toMatch(pattern);
    }
  });

  it('多個原因以「、」並列，不加「同時」', () => {
    const html = discountRow('MULTI', {
      baseName: '國小輔導-一A',
      rawToken: 'a',
      sideOf: 'care',
      beforeBps: 10000,
      afterBps: 9500,
      reasons: [
        { kind: 'enrollment_removed', className: '國小數學-三A' },
        { kind: 'tag_added', tag: '有兄弟姊妹折扣' },
      ],
    });
    expect(html).toContain('退出 國小數學-三A、加上標籤「有兄弟姊妹折扣」');
    expect(html).not.toContain('同時');
  });

  it('reasons 空陣列 → 「名單資料變動」', () => {
    const html = discountRow('NOR', {
      baseName: '國小輔導-一A',
      rawToken: 'a',
      sideOf: 'care',
      beforeBps: 10000,
      afterBps: 9500,
      reasons: [],
    });
    expect(html).toContain('名單資料變動');
  });

  it('原因欄不寫數字、不寫「因為」', () => {
    const html = discountRow('PLAIN', {
      baseName: '國小輔導-一A',
      rawToken: 'a',
      sideOf: 'care',
      beforeBps: 10000,
      afterBps: 9500,
      reasons: [{ kind: 'enrollment_added', className: '兒童美語-EA' }],
    });
    const reasonsCell = html.match(/data-reason="[\s\S]*?<\/span>/)![0];
    expect(reasonsCell).not.toMatch(/因為/);
    expect(reasonsCell).not.toMatch(/\d{3,}/);
  });

  it('switched 不得被寫成折扣原因（只有 enrollment_added／removed／tag_*）', () => {
    const html = discountRow('SW', {
      baseName: '國小數學-三A',
      rawToken: 'a',
      sideOf: 'math',
      beforeBps: 10000,
      afterBps: 9500,
      reasons: [{ kind: 'enrollment_added', className: '兒童美語-EA' }],
    });
    expect(html).not.toContain('換班');
  });

  it('無折扣變動 → 「—」', () => {
    const html = render([change({ personCode: 'NONE', classDiscountChanges: [], enrollmentChanges: [] })]);
    expect(rowOf(html, 'NONE')).toMatch(/<td data-field="class-discount">—<\/td>/);
  });
});
