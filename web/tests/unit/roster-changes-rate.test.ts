import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeRosterChanges } from '@/application/roster-changes';
import { RosterChangesDetails } from '@/components/imports/roster-changes-details';
import { buildSeedDraft, draftToAliasMap, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { StudentSnapshot } from '@/domain/students';

/**
 * 04 §8 UX78：異動明細的「適用率」欄（安親／課輔適用率 before → after）。
 *
 * 問題：只有適用率改變的異動（例：園內生標籤增減 → 安親適用率 max(9000, 基本率 − 500) 改變，
 * 但基本折扣與天數都不變），明細的折扣欄與天數欄都是「—」，只能從原因欄「適用率變動」看出有變，
 * 看不到數值；折扣同時變動時連原因欄的「適用率變動」都被遮蔽。
 *
 * 依「畫面不自行推導」原則，判定在 application 層（`RosterChange.rateChange`，additive），UI 只呈現。
 *
 * ── expected 皆為獨立手算（02 §8 R13／R14、R10），不由被測函式輸出回填 ──────────────
 *   基本折扣 R10：effectiveCount = 科數 + 兄弟姊妹；>2 → 9000、=2 → 9500、其餘 10000；0 報名（科數 null）→ null
 *   安親適用率 R13：寫功課／歷史美安 → 10000；否則園內生 → max(9000, 基本率 − 500)；其他 → 基本率
 *   課輔適用率 R14：寫功課 → 10000；否則基本率（園內生不扣）
 *   短標：10000 → 「無折扣」、9500 → 「95折」、9000 → 「9折」；null → 「—」
 *
 * 情境（學生皆為 v2 規則下的合成資料；本檔不依賴任何真實名冊）：
 *   (a) 只適用率變：國小輔導-一A，1 年級，有園內生 → 無園內生。
 *       前：基本 10000；安親 max(9000, 9500)=9500、課輔 10000。後：基本 10000；安親 10000、課輔 10000。
 *       → 折扣不變、天數不變；只列安親：9500 → 10000（95折 → 無折扣）；課輔未變不列。
 *   (b) 折扣與適用率同時變：國小輔導-一A，1 年級，園內生 → 加報國小數學-一A，仍園內生。
 *       前：科數 1、基本 10000；安親 9500、課輔 10000。
 *       後：科數 2、基本 9500；安親 max(9000, 9500−500=9000)=9000、課輔 9500。
 *       → 折扣 10000 → 9500；安親 95折 → 9折、課輔 無折扣 → 95折（兩項都變 → 兩項都列）。
 *   (c) 一側 null：國小輔導-一A，1 年級，無標籤 → 清空所有報名。
 *       前：科數 1、基本 10000；安親 10000、課輔 10000。後：科數 null → 基本 null；安親 null、課輔 null。
 *       → 安親 無折扣 → —、課輔 無折扣 → —（null 側顯示「—」，不是「未設定」）。
 *   (d) 新增／未出現：不是「異動」→ rateChange 為 null。
 *   (e) 完全不變：不在 changes 內。
 */

function student(
  personCode: string,
  baseNames: string[],
  opts: { grade?: number; tagsRaw?: string } = {}
): StudentSnapshot {
  const grade = opts.grade ?? null;
  return {
    personCode,
    name: `學生${personCode}`,
    branch: '本校',
    gradeRaw: grade !== null ? `${grade}年級` : '',
    grade,
    gradeStatus: grade !== null ? 'valid' : 'not_applicable',
    contact: null,
    schoolInfo: null,
    tagsRaw: opts.tagsRaw ?? '',
    tags: opts.tagsRaw ? opts.tagsRaw.split(/[,;\s]+/).filter(Boolean) : [],
    notesRaw: '',
    enrollments: baseNames.map((bn) => ({
      rawToken: `${bn}[團]`,
      yearPrefix: null,
      baseName: bn,
      groupFlag: '團',
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    })),
    sourceRow: 1,
  };
}

const contexts = () => {
  const beforeDraft = buildSeedDraft();
  const afterDraft = buildSeedDraft();
  return {
    beforeCtx: { aliasMap: draftToAliasMap(beforeDraft), scheduleOverride: draftToScheduleOverride(beforeDraft) },
    afterCtx: { aliasMap: draftToAliasMap(afterDraft), scheduleOverride: draftToScheduleOverride(afterDraft) },
  };
};

const only = (changes: ReturnType<typeof computeRosterChanges>['changes'], code: string) => {
  const found = changes.find((c) => c.personCode === code);
  if (!found) throw new Error(`changes 內找不到 ${code}`);
  return found;
};

describe('UX78 application 層：RosterChange.rateChange（additive）', () => {
  it('(a) 只適用率變（園內生 → 非園內生）：折扣與天數不變，只列有變的安親 9500 → 10000', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('A1', ['國小輔導-一A'], { grade: 1, tagsRaw: '園內生' });
    const after = student('A1', ['國小輔導-一A'], { grade: 1, tagsRaw: '' });

    const { changes } = computeRosterChanges([before], [after], beforeCtx, afterCtx);

    const c = only(changes, 'A1');
    expect(c.discountChange, '折扣不變').toBeNull();
    expect(c.dayChange, '天數不變').toBeNull();
    expect(c.reasons, '既有 reasons 判定不變').toEqual(['適用率變動']);
    expect(c.rateChange?.items.map((i) => ({ course: i.course, beforeBps: i.beforeBps, afterBps: i.afterBps, beforeLabel: i.beforeLabel, afterLabel: i.afterLabel }))).toEqual([
      { course: 'anqin', beforeBps: 9500, afterBps: 10000, beforeLabel: '95折', afterLabel: '無折扣' },
    ]);
  });

  it('(b) 折扣與適用率同時變：兩項適用率都列（安親 95折 → 9折、課輔 無折扣 → 95折），原因欄不因此多出「適用率變動」', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('B1', ['國小輔導-一A'], { grade: 1, tagsRaw: '園內生' });
    const after = student('B1', ['國小輔導-一A', '國小數學-一A'], { grade: 1, tagsRaw: '園內生' });

    const { changes, stats } = computeRosterChanges([before], [after], beforeCtx, afterCtx);

    const c = only(changes, 'B1');
    expect(c.discountChange?.beforeBps, '基本折扣前').toBe(10000);
    expect(c.discountChange?.afterBps, '基本折扣後').toBe(9500);
    expect(c.reasons, '既有 reasons 判定不變（折扣同時變動時不加「適用率變動」）').not.toContain('適用率變動');
    expect(c.rateChange?.items.map((i) => [i.course, i.beforeBps, i.afterBps, i.beforeLabel, i.afterLabel])).toEqual([
      ['anqin', 9500, 9000, '95折', '9折'],
      ['tutoring', 10000, 9500, '無折扣', '95折'],
    ]);
    expect(stats.discountChangedCount, '既有計數不變').toBe(1);
    expect(stats.changedCount).toBe(1);
  });

  it('(c) 一側 null（報名全部清空）：null 側標籤為「—」，不是「未設定」', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('C1', ['國小輔導-一A'], { grade: 1 });
    const after = student('C1', [], { grade: 1 });

    const { changes } = computeRosterChanges([before], [after], beforeCtx, afterCtx);

    const c = only(changes, 'C1');
    expect(c.rateChange?.items.map((i) => [i.course, i.beforeBps, i.afterBps, i.beforeLabel, i.afterLabel])).toEqual([
      ['anqin', 10000, null, '無折扣', '—'],
      ['tutoring', 10000, null, '無折扣', '—'],
    ]);
  });

  it('(d) 新增／未出現的學生不是「異動」：rateChange 為 null', () => {
    const { beforeCtx, afterCtx } = contexts();
    const gone = student('GONE', ['國小輔導-一A'], { grade: 1, tagsRaw: '園內生' });
    const fresh = student('NEW', ['國小輔導-一A'], { grade: 1, tagsRaw: '園內生' });

    const { changes } = computeRosterChanges([gone], [fresh], beforeCtx, afterCtx);

    expect(only(changes, 'NEW').rateChange).toBeNull();
    expect(only(changes, 'GONE').rateChange).toBeNull();
  });

  it('(e) 適用率沒有變（只有天數或折扣以外的變動）：rateChange 為 null；完全不變的學生不在 changes', () => {
    const { beforeCtx, afterCtx } = contexts();
    const same = student('SAME', ['國小輔導-一A'], { grade: 1, tagsRaw: '園內生' });
    // 年級 1→3：只有安親／課輔分支改變，基本折扣與兩項適用率都不變（見 roster-changes.test.ts 同型案例）
    const gradeBefore = student('G1', ['國小輔導-一A'], { grade: 1 });
    const gradeAfter = student('G1', ['國小輔導-一A'], { grade: 3 });

    const { changes } = computeRosterChanges([same, gradeBefore], [same, gradeAfter], beforeCtx, afterCtx);

    expect(changes.find((c) => c.personCode === 'SAME'), '完全不變不列入').toBeUndefined();
    const g = only(changes, 'G1');
    expect(g.dayChange).not.toBeNull();
    expect(g.rateChange, '適用率未變 → null').toBeNull();
  });
});

describe('UX78 UI：明細表「適用率」欄只呈現 application 層的 rateChange', () => {
  const render = (changes: ReturnType<typeof computeRosterChanges>['changes']) =>
    renderToStaticMarkup(React.createElement(RosterChangesDetails, { changes }));

  const build = () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = [
      student('A1', ['國小輔導-一A'], { grade: 1, tagsRaw: '園內生' }),
      student('B1', ['國小輔導-一A'], { grade: 1, tagsRaw: '園內生' }),
      student('C1', ['國小輔導-一A'], { grade: 1 }),
      student('GONE', ['國小輔導-一A'], { grade: 1 }),
    ];
    const after = [
      student('A1', ['國小輔導-一A'], { grade: 1, tagsRaw: '' }),
      student('B1', ['國小輔導-一A', '國小數學-一A'], { grade: 1, tagsRaw: '園內生' }),
      student('C1', [], { grade: 1 }),
      student('NEW', ['國小輔導-一A'], { grade: 1 }),
    ];
    return computeRosterChanges(before, after, beforeCtx, afterCtx).changes;
  };

  /** 取出某位學生那一列 `<tr>` 的 HTML。 */
  const rowOf = (html: string, code: string): string => {
    const rows = html.match(/<tr data-category[\s\S]*?<\/tr>/g) ?? [];
    const row = rows.find((r) => r.includes(`>${code}<`));
    if (!row) throw new Error(`找不到 ${code} 的明細列`);
    return row;
  };

  it('表頭新增「適用率」，逐班明細列 colSpan 同步為 7', () => {
    const html = render(build());
    expect(html).toContain('<th>適用率</th>');
    // 折扣、適用率、安親天數、課輔天數、原因 + 學生、類別 ＝ 7 欄
    expect(html.match(/<th>/g)?.length, '表頭欄數').toBe(7);
    expect(html).toMatch(/<td colSpan="7">/);
    expect(html).not.toMatch(/<td colSpan="6">/);
  });

  it('(a) 只適用率變：折扣欄「—」、適用率欄只有安親一行「安親 95折 → 無折扣」', () => {
    const row = rowOf(render(build()), 'A1');
    expect(row).toMatch(/data-field="discount"[^>]*>—</);
    expect(row).toMatch(/data-field="rate"/);
    expect(row).toMatch(/data-rate="anqin"[^>]*>安親 95折 → 無折扣</);
    expect(row, '課輔未變不列').not.toMatch(/data-rate="tutoring"/);
  });

  it('(b) 折扣與適用率同時變：適用率欄兩行（安親 95折 → 9折／課輔 無折扣 → 95折）', () => {
    const row = rowOf(render(build()), 'B1');
    expect(row).toMatch(/data-field="discount"[^>]*>無折扣 → 95折</);
    expect(row).toMatch(/data-rate="anqin"[^>]*>安親 95折 → 9折</);
    expect(row).toMatch(/data-rate="tutoring"[^>]*>課輔 無折扣 → 95折</);
  });

  it('(c) 一側 null：顯示「—」，不顯示「未設定」', () => {
    const row = rowOf(render(build()), 'C1');
    expect(row).toMatch(/data-rate="anqin"[^>]*>安親 無折扣 → —</);
    expect(row).toMatch(/data-rate="tutoring"[^>]*>課輔 無折扣 → —</);
    // 只斷言適用率格：既有「折扣」欄對 null 仍是「無折扣 → 未設定」（D-4 不改既有欄位），不在本案範圍。
    const rateCell = /<td data-field="rate">[\s\S]*?<\/td>/.exec(row)?.[0] ?? '';
    expect(rateCell).not.toBe('');
    expect(rateCell, '適用率格的 null 側是「—」，不是「未設定」').not.toContain('未設定');
  });

  it('(d) 新增／未出現的學生：適用率欄「—」', () => {
    const html = render(build());
    expect(rowOf(html, 'NEW')).toMatch(/data-field="rate"[^>]*>—</);
    expect(rowOf(html, 'GONE')).toMatch(/data-field="rate"[^>]*>—</);
  });
});
