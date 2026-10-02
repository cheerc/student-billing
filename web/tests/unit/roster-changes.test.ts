import { describe, it, expect } from 'vitest';
import { computeRosterChanges } from '@/application/roster-changes';
import { buildSeedDraft, draftToAliasMap, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { parseTagDiscounts, calculateSubjectCount, calculateBaseDiscountBps } from '@/domain/billing/discount-rules';
import { StudentSnapshot } from '@/domain/students';

/**
 * R4 operator 裁決 d-20260929111803466480-4 / d-20260929111814541876-5：
 * 「異動」必須以**真實 before/after 計算結果**判定，取代 R3 rosterDiff 的 person_code ＋ token 指紋代理。
 *
 * 異動兩類為主（operator 定義）：
 *   a. 折扣異動（例如原本 95 折 → 變 9 折）
 *   b. 安親／課輔扣除天數異動（例如原本 5 天 → 變 4.5 天）
 * 輔助原因以 before & after 對照呈現。
 *
 * 判準為「與收費計算直接相關的最終結果變化」，所以必須涵蓋：
 *   - 報名變動（courses 增減 → subjectCount → 折扣）
 *   - 年級變動（grade 決定安親／課輔分支；1–2 年級算安親、3–6 年級算課輔）
 *   - 標籤變動（tagsRaw → 兄弟姊妹／特殊折扣／園內生）
 * 三者都會在 before/after 計算結果上體現，不需各自推導欄位——這正是裁決要求的「不是擴充現有指紋」。
 *
 * expected 皆為獨立手算：
 *   - 基本折扣 R10：effectiveCount = subjectCount + sibling；>2 → 9000、=2 → 9500、其餘 10000
 *   - 安親 R11：max(3.5, 5 + rounded)，1–2 年級；課輔 R12：max(3, 5 + rounded)，3–6 年級
 *   - 園內生 R13：max(9000, basic − 500)
 */

function student(
  personCode: string,
  baseNames: string[],
  opts: { grade?: number; gradeRaw?: string; tagsRaw?: string; branch?: string } = {}
): StudentSnapshot {
  const grade = opts.grade ?? null;
  return {
    personCode,
    name: `學生${personCode}`,
    branch: opts.branch ?? '本校',
    gradeRaw: opts.gradeRaw ?? (grade !== null ? `${grade}年級` : ''),
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

describe('R4 operator 裁決：異動以 before/after 計算結果判定（非指紋代理）', () => {
  /** 以已儲存設定 before、seed 課表 after 建立可比對情境。 */
  const contexts = () => {
    const beforeDraft = buildSeedDraft();
    const afterDraft = buildSeedDraft();
    return {
      beforeCtx: { aliasMap: draftToAliasMap(beforeDraft), scheduleOverride: draftToScheduleOverride(beforeDraft) },
      afterCtx: { aliasMap: draftToAliasMap(afterDraft), scheduleOverride: draftToScheduleOverride(afterDraft) },
    };
  };

  describe('b. 天數異動：安親／課輔扣除天數 before & after', () => {
    it('報名不變、課表不變 → 非異動（計算結果相同）', () => {
      const { beforeCtx, afterCtx } = contexts();
      const s = student('S1', ['國小數學-一A'], { grade: 1 });

      const result = computeRosterChanges([s], [s], beforeCtx, afterCtx);

      expect(result.changes).toHaveLength(0);
      expect(result.stats.unchangedCount).toBe(1);
      expect(result.stats.dayChangedCount).toBe(0);
      expect(result.stats.discountChangedCount).toBe(0);
    });

    it('年級變動（1→3 年級）即使報名與課表皆不變，天數仍判定異動：安親→課輔分支切換', () => {
      // 指紋代理會漏判此 case：person_code 與報名 token 完全相同，只有 grade 變了
      const { beforeCtx, afterCtx } = contexts();
      // 報名國小輔導（安親/課輔收費分眾依年級帶：1–2 年級安親、3–6 年級課輔）
      const before = student('S1', ['國小輔導-一A'], { grade: 1 });
      const after = student('S1', ['國小輔導-一A'], { grade: 3 });

      // 前置（獨立手算：同報名同課表，僅年級帶不同 → 安親分支與課輔分支的天數各為 R11／R12 下限）
      const b = calculateStudentBilling(before, { ...beforeCtx, ruleSetVersion: 'erp-tag-v2' });
      const a = calculateStudentBilling(after, { ...afterCtx, ruleSetVersion: 'erp-tag-v2' });
      expect(b.careDays.anqin.isEnrolled).toBe(true);
      expect(b.careDays.tutoring.isEnrolled).toBe(false);
      expect(a.careDays.anqin.isEnrolled).toBe(false);
      expect(a.careDays.tutoring.isEnrolled).toBe(true);
      expect(b.careDays.anqin.days).not.toBeNull();
      expect(a.careDays.tutoring.days).not.toBeNull();
      // 兩分支的實扣天數可相同（皆觸底），但收費歸屬的照顧類別由安親改為課輔，
      // 屬「與收費計算直接相關的結果變化」，故仍判異動（不可用數值相等就當未異動）。
      expect(b.careDays.anqin.days).toBe(a.careDays.tutoring.days);

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);

      expect(result.changes).toHaveLength(1);
      const change = result.changes[0];
      expect(change.personCode).toBe('S1');
      expect(change.discountChange).toBeNull(); // 折扣未變（科數未變）
      expect(change.dayChange).not.toBeNull();
      expect(change.dayChange!.beforeAnqinDays).toBe(b.careDays.anqin.days);
      expect(change.dayChange!.afterTutoringDays).toBe(a.careDays.tutoring.days);
      expect(result.stats.dayChangedCount).toBe(1);
    });

    it('標籤變動（園內生 → 非園內生）使安親適用率與天數上限改變，判定異動', () => {
      const { beforeCtx, afterCtx } = contexts();
      // 園內生影響安親適用率 max(9000, basic−500) 與適用率本身
      // 園內生不影響天數下限（R13 只調適用率），故斷言「適用率異動」而非天數
      const before = student('S1', ['國小輔導-一A'], { grade: 1, tagsRaw: '園內生' });
      const after = student('S1', ['國小輔導-一A'], { grade: 1, tagsRaw: '' });

      const b = calculateStudentBilling(before, { ...beforeCtx, ruleSetVersion: 'erp-tag-v2' });
      const a = calculateStudentBilling(after, { ...afterCtx, ruleSetVersion: 'erp-tag-v2' });
      expect(b.applicableRates.anqin).not.toBe(a.applicableRates.anqin);
      expect(b.careDays.anqin.days).toBe(a.careDays.anqin.days); // 天數不變

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].reasons).toContain('適用率變動');
      expect(result.changes[0].dayChange).toBeNull();
    });
  });

  describe('a. 折扣異動：折扣 before & after（bps 對照）', () => {
    it('加一門課（effectiveCount 2→3）使基本折扣 9500 → 9000，判定折扣異動', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A', '兒童美語-一A'], { grade: 3 });
      const // 加一門不同科目（輔導）：subjectCount 數的是科目種類（輔導／數學／美語），不是 token 數
      after = student('S1', ['國小數學-一A', '兒童美語-一A', '國小輔導-一A'], { grade: 3 });

      // 前置（獨立手算 R10：科數 2 → 9500；科數 3 → 9000）
      expect(calculateSubjectCount(before.enrollments)).toBe(2);
      expect(calculateBaseDiscountBps(2, false, null)).toBe(9500);
      expect(calculateSubjectCount(after.enrollments)).toBe(3);
      expect(calculateBaseDiscountBps(3, false, null)).toBe(9000);

      const b = calculateStudentBilling(before, { ...beforeCtx, ruleSetVersion: 'erp-tag-v2' });
      const a = calculateStudentBilling(after, { ...afterCtx, ruleSetVersion: 'erp-tag-v2' });
      expect(b.baseDiscountBps).toBe(9500);
      expect(a.baseDiscountBps).toBe(9000);

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].discountChange).toEqual({
        beforeBps: 9500,
        afterBps: 9000,
        beforeLabel: '95折',
        afterLabel: '9折',
        reason: '已補科數變動',
      });
      expect(result.stats.discountChangedCount).toBe(1);
    });

    it('兄弟姊妹標籤使 effectiveCount +1（1 課+兄弟姊妹 → 9500），判定折扣異動', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A'], { grade: 3 });
      const after = student('S1', ['國小數學-一A'], { grade: 3, tagsRaw: '有兄弟姊妹折扣' });

      // 前置（獨立手算：tagDiscounts.sibling 由標籤決定，effectiveCount 1→2）
      expect(parseTagDiscounts('').sibling).toBe(false);
      expect(parseTagDiscounts('有兄弟姊妹折扣').sibling).toBe(true);
      expect(calculateBaseDiscountBps(1, false, null)).toBe(10000);
      expect(calculateBaseDiscountBps(1, true, null)).toBe(9500);

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].discountChange!.beforeBps).toBe(10000);
      expect(result.changes[0].discountChange!.afterBps).toBe(9500);
    });

    it('特殊折扣標籤直接覆蓋基本折扣（R10 優先序），判定折扣異動（8500＝收取 85%＝85折）', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A'], { grade: 3 });
      const after = student('S1', ['國小數學-一A'], { grade: 3, tagsRaw: '特殊折扣85折' });

      const d = parseTagDiscounts('特殊折扣85折');
      expect(d.specialDiscount).toBe(0.85);
      expect(calculateBaseDiscountBps(1, false, 0.85)).toBe(8500);

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);
      expect(result.changes[0].discountChange!.afterBps).toBe(8500);
      expect(result.changes[0].discountChange!.afterLabel).toBe('85折');
    });
  });

  describe('輔助原因：before & after 對照', () => {
    /**
     * Reviewer B2（PR #32）：逐班明細必須是 before 名單與 after 名單各自報名的**聯集**。
     * 只走 after 名單會讓「退掉的課」消失，保留的課又必定顯示無變化。
     *
     * 獨立手算（seed 課表，D24 取整、D30 同星期才計入；安親窗 13:00–16:00、課輔窗 16:30–19:30，週一至五）：
     *   國小數學-一A：週四 15:00–16:30、週六 10:30–12:00
     *     安親：週四 15:00–16:00 重疊 60 分（週六不在窗內星期）→ d=60/180=0.333，0.3≤frac<0.8 → 扣 0.5 天
     *     課輔：週四 15:00–16:30 與 16:30–19:30 只相接、重疊 0 → 扣 0 天
     *   國小數學-三A：週一 16:30–18:00、週三 18:00–19:30
     *     安親：不與 13:00–16:00 相交 → 扣 0 天
     *     課輔：週一 90 分＋週三 90 分＝180 分 → d=1.0、frac=0 → 扣 1.0 天
     * 學生層（小一，R11）：只算安親（課輔對 1–2 年級為 not_applicable → null）。
     *   換班前 max(3.5, 5−0.5)=4.5；換班後 max(3.5, 5−0)=5。三A 的課輔扣 1.0 天對小一計費無影響，
     *   但仍屬該班的逐班事實，明細照實列出。
     */
    it('明細含退掉的課與新報的課（聯集，數值逐項斷言）：一A→三A', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A'], { grade: 1 });
      const after = student('S1', ['國小數學-三A'], { grade: 1 });

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);
      const change = result.changes[0];

      // 學生層天數：小一只有安親；課輔不適用（null）
      expect(change.dayChange!.beforeAnqinDays).toBe(4.5);
      expect(change.dayChange!.afterAnqinDays).toBe(5);
      expect(change.dayChange!.beforeTutoringDays).toBeNull();
      expect(change.dayChange!.afterTutoringDays).toBeNull();

      // 逐班明細：兩門課都要出現，且各自標明是「退掉」或「新報」
      const rows = change.dayChange!.classBreakdown;
      expect(rows.map((r) => r.baseName).sort()).toEqual(['國小數學-一A', '國小數學-三A']);

      const dropped = rows.find((r) => r.baseName === '國小數學-一A')!;
      expect(dropped.presence).toBe('removed');
      expect(dropped.beforeAnqinDeduction).toBe(0.5);
      expect(dropped.beforeTutoringDeduction).toBe(0);
      expect(dropped.afterAnqinDeduction).toBeNull(); // 已不在 after 名單，不是「扣 0 天」
      expect(dropped.afterTutoringDeduction).toBeNull();

      const added = rows.find((r) => r.baseName === '國小數學-三A')!;
      expect(added.presence).toBe('added');
      expect(added.beforeAnqinDeduction).toBeNull(); // 原本沒報，不是「扣 0 天」
      expect(added.beforeTutoringDeduction).toBeNull();
      expect(added.afterAnqinDeduction).toBe(0);
      expect(added.afterTutoringDeduction).toBe(1);
    });

    /**
     * 兒童美語-KA：週二 15:30–16:30、週四 15:00–16:00
     *   安親（13:00–16:00）：週二 15:30–16:00＝30 分、週四 15:00–16:00＝60 分 → 90 分 → d=0.5 → 扣 0.5 天
     *   課輔（16:30–19:30）：週二 15:30–16:30 與 16:30 只相接、週四早於窗 → 0 → 扣 0 天
     * 小一：安親 before = max(3.5, 5−0.5(一A)−0.5(KA)) = 4；after 退掉 KA = max(3.5, 5−0.5) = 4.5。
     */
    it('保留的課兩側數值相同（presence=kept），退掉的美語課只有 before 側有值', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A', '兒童美語-KA'], { grade: 1 });
      const after = student('S1', ['國小數學-一A'], { grade: 1 }); // 退掉美語 KA、保留數學一A

      const change = computeRosterChanges([before], [after], beforeCtx, afterCtx).changes[0];
      expect(change.dayChange!.beforeAnqinDays).toBe(4);
      expect(change.dayChange!.afterAnqinDays).toBe(4.5);

      const rows = change.dayChange!.classBreakdown;
      expect(rows.map((r) => r.baseName).sort()).toEqual(['兒童美語-KA', '國小數學-一A']);

      const kept = rows.find((r) => r.baseName === '國小數學-一A')!;
      expect(kept.presence).toBe('kept');
      expect(kept.beforeAnqinDeduction).toBe(0.5);
      expect(kept.afterAnqinDeduction).toBe(0.5);
      expect(kept.beforeTutoringDeduction).toBe(0);
      expect(kept.afterTutoringDeduction).toBe(0);

      const dropped = rows.find((r) => r.baseName === '兒童美語-KA')!;
      expect(dropped.presence).toBe('removed');
      expect(dropped.beforeAnqinDeduction).toBe(0.5);
      expect(dropped.beforeTutoringDeduction).toBe(0);
      expect(dropped.afterAnqinDeduction).toBeNull();
      expect(dropped.statusAfter).toBe('no_enrollment');
    });

    /**
     * domain 只取每位學生「第一個國小數學」與「第一個兒童美語」計算扣天（billing-calculator.ts）。
     * 第二門數學不影響天數 → 退掉它不算異動；明細也不該把它當成造成變化的原因。
     */
    /**
     * Round3 PR-1 語意更新（decisions d-20261002173610753099-75）：**退出**一科要獨立列出，
     * 即使計費結果相同。原先此處斷言「不算異動」，是 d-…-4 的舊契約（那時只看計算結果），
     * 已被 -75 取代（spike §B1 RC04／§B3 CB 同源）。
     * 保留的保證：折扣／適用率／天數仍不變（無 dayChange、無 discountChange）。
     */
    it('第二門數學不計入扣天：小三 [一A,三A]→[一A] 計費結果相同 → 仍是異動，但只有報名異動（-75）', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A', '國小數學-三A'], { grade: 3 });
      const after = student('S1', ['國小數學-一A'], { grade: 3 });

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);

      expect(result.changes).toHaveLength(1);
      expect(result.stats.changedCount).toBe(1);
      expect(result.stats.unchangedCount).toBe(0);
      // 計費面完全不變：沒有天數、沒有折扣、沒有適用率變動
      expect(result.changes[0].dayChange).toBeNull();
      expect(result.changes[0].discountChange).toBeNull();
      expect(result.changes[0].rateChange).toBeNull();
      // 只有報名集合少了一班
      expect(result.changes[0].enrollmentChanges.map((e) => [e.baseName, e.presence])).toEqual([
        ['國小數學-一A', 'kept'],
        ['國小數學-三A', 'removed'],
      ]);
      expect(result.changes[0].classDiscountChanges).toEqual([]);
    });

    it('第一門數學被換掉時，原本排第二的三A變成計入：明細標為 kept，但 before 側為 not_counted（不是扣 0 天）', () => {
      const { beforeCtx, afterCtx } = contexts();
      // 小三課輔：before 計入的是一A（課輔扣 0）→ 5；after 只剩三A（課輔扣 1.0）→ max(3, 5−1)=4
      const before = student('S1', ['國小數學-一A', '國小數學-三A'], { grade: 3 });
      const after = student('S1', ['國小數學-三A'], { grade: 3 });

      const change = computeRosterChanges([before], [after], beforeCtx, afterCtx).changes[0];
      expect(change.dayChange!.beforeTutoringDays).toBe(5);
      expect(change.dayChange!.afterTutoringDays).toBe(4);

      const rows = change.dayChange!.classBreakdown;
      const first = rows.find((r) => r.baseName === '國小數學-一A')!;
      expect(first.presence).toBe('removed');
      expect(first.beforeTutoringDeduction).toBe(0);

      const second = rows.find((r) => r.baseName === '國小數學-三A')!;
      expect(second.presence).toBe('kept'); // 兩側都有報名
      expect(second.statusBefore).toBe('not_counted'); // 但 before 時排第二、不計入
      expect(second.beforeTutoringDeduction).toBeNull();
      expect(second.afterTutoringDeduction).toBe(1);
    });

    it('折扣異動附科數與標籤 before & after（可查原因）', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A'], { grade: 3 });
      const after = student('S1', ['國小數學-一A', '兒童美語-一A'], { grade: 3 });

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);
      const change = result.changes[0];
      expect(change.reasons).toContain('已補科數變動');
      expect(change.before).toHaveProperty('subjectCount');
      expect(change.after).toHaveProperty('subjectCount');
      expect(change.before!.subjectCount).toBe(1);
      expect(change.after!.subjectCount).toBe(2);
    });
  });

  /**
   * Reviewer B1（PR #32）：函式必須能吃**整批**名單。舊簽章 `afterStudents: StudentSnapshot | null`
   * 一次只能處理一位學生，退出名單只在 `afterStudents === null` 時才判斷，產品無法用整批呼叫。
   */
  describe('整批比對：新增／異動／退出三類同批出現', () => {
    it('一批名單同時含新增、異動、退出、未異動，各自歸類且計數正確', () => {
      const { beforeCtx, afterCtx } = contexts();
      const beforeList = [
        student('KEEP', ['國小數學-一A'], { grade: 3 }), // 未異動
        student('CHG', ['國小數學-一A', '兒童美語-KA'], { grade: 3 }), // 2 科 → 9500
        student('GONE', ['國小數學-三A'], { grade: 3 }), // 退出
      ];
      const afterList = [
        student('KEEP', ['國小數學-一A'], { grade: 3 }),
        student('CHG', ['國小數學-一A', '兒童美語-KA', '國小輔導-三年級'], { grade: 3 }), // 3 科 → 9000
        student('NEW1', ['國小數學-三A'], { grade: 3 }), // 新增
        student('NEW2', ['國小數學-三A'], { grade: 3 }), // 新增
      ];

      const result = computeRosterChanges(beforeList, afterList, beforeCtx, afterCtx);

      const byCode = new Map(result.changes.map((c) => [c.personCode, c]));
      expect([...byCode.keys()].sort()).toEqual(['CHG', 'GONE', 'NEW1', 'NEW2']); // KEEP 未異動不列入
      expect(byCode.get('CHG')!.discountChange).toMatchObject({ beforeBps: 9500, afterBps: 9000 });
      expect(byCode.get('GONE')!.isRemoved).toBe(true);
      expect(byCode.get('NEW1')!.isNew).toBe(true);
      expect(byCode.get('NEW2')!.isNew).toBe(true);

      expect(result.stats.newCount).toBe(2);
      expect(result.stats.removedCount).toBe(1);
      expect(result.stats.changedCount).toBe(1);
      expect(result.stats.unchangedCount).toBe(1);
      // totalStudents ＝ 本次名單（after）的人數
      expect(result.stats.totalStudents).toBe(4);
    });

    it('報名 token 改變但計費結果不變（二A→二B，兩班時段相同、皆不與照顧窗顯著重疊）→ 算報名異動、但計費面不變（-75）', () => {
      // 指紋代理會誤判為異動的案例（operator 裁決 d-…-4 明列的第一類誤判）。
      // 手算：二A、二B 皆為 週三 15:30–17:00、週六 09:00–10:30。
      //   安親窗（13:00–16:00）：週三重疊 15:30–16:00＝30 分；課輔窗（16:30–19:30）：週三重疊 16:30–17:00＝30 分
      //   30/180=0.167 < 0.3 → 皆扣 0；科目同為國小數學 → 折扣不變。
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-二A'], { grade: 1 });
      const after = student('S1', ['國小數學-二B'], { grade: 1 });

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);

      // -75：換班即使折扣與天數皆未變也要出現（spike §B3 CB）
      expect(result.changes).toHaveLength(1);
      expect(result.stats.changedCount).toBe(1);
      expect(result.stats.unchangedCount).toBe(0);
      // 計費面不變：這仍不是「折扣異動」或「天數異動」
      expect(result.changes[0].dayChange).toBeNull();
      expect(result.changes[0].discountChange).toBeNull();
      expect(result.changes[0].rateChange).toBeNull();
      expect(result.changes[0].classDiscountChanges).toEqual([]);
      expect(
        result.changes[0].enrollmentChanges.filter((e) => e.presence !== 'kept').map((e) => e.presence)
      ).toEqual(['switched', 'switched']);
    });

    it('同一位學生在 after 名單重複出現（同人員代碼）只算一人，取第一列', () => {
      const { beforeCtx, afterCtx } = contexts();
      const first = student('S1', ['國小數學-一A'], { grade: 3 });
      const dup = student('S1', ['國小數學-一A', '兒童美語-KA'], { grade: 3 }); // 後出現的列不採用

      const result = computeRosterChanges([], [first, dup], beforeCtx, afterCtx);

      expect(result.stats.newCount).toBe(1);
      expect(result.stats.totalStudents).toBe(1);
      expect(result.changes).toHaveLength(1);
    });
  });

  describe('首次匯入與邊界', () => {
    it('無舊名單（before 為空）→ 整批 after 全部視為新增，不顯示 before', () => {
      const { beforeCtx, afterCtx } = contexts();
      const students = [student('S1', ['國小數學-一A'], { grade: 1 }), student('S2', ['國小數學-三A'], { grade: 3 })];

      const result = computeRosterChanges([], students, beforeCtx, afterCtx);

      expect(result.changes).toHaveLength(2);
      expect(result.changes.map((c) => c.personCode)).toEqual(['S1', 'S2']);
      for (const c of result.changes) {
        expect(c.isNew).toBe(true);
        expect(c.before).toBeNull();
        expect(c.discountChange).toBeNull();
        expect(c.dayChange).toBeNull();
      }
      expect(result.stats.newCount).toBe(2);
      expect(result.stats.removedCount).toBe(0);
    });

    it('退出名單（before 有、after 無）→ removed，不計入折扣／天數異動', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A'], { grade: 1 });

      const result = computeRosterChanges([before], [], beforeCtx, afterCtx);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].isRemoved).toBe(true);
      expect(result.stats.removedCount).toBe(1);
    });

    it('bps 標籤化：10000/9500/9000/8500 與 null／未設定分開（不把未配置當 100%）', () => {
      const { beforeCtx, afterCtx } = contexts();
      // 2 科（數學＋美語）→ 9500「95折」；3 科（＋輔導）→ 9000「9折」
      const before = student('S1', ['國小數學-一A', '兒童美語-一A'], { grade: 3 });
      const after = student('S1', ['國小數學-一A', '兒童美語-一A', '國小輔導-一A'], { grade: 3 });

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);
      expect(result.changes[0].discountChange!.beforeLabel).toBe('95折');
      expect(result.changes[0].discountChange!.afterLabel).toBe('9折');
      expect(computeRosterChanges([], [], beforeCtx, afterCtx).changes).toEqual([]);
    });

    it('未報名課程（非適用）與 null 適用率不可被當成 100%', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-三A'], { grade: 1 });
      const after = student('S1', ['國小數學-三A'], { grade: 1 });

      const b = calculateStudentBilling(before, { ...beforeCtx, ruleSetVersion: 'erp-tag-v2' });
      // 小一未報名安親 → anqin 不適用；不可顯示為 100% 收取率
      expect(b.applicableRates.anqin).toBe(10000);
      expect(b.careDays.anqin.isEnrolled).toBe(false);

      const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);
      expect(result.changes).toHaveLength(0); // 非報名且未變動，非異動
    });
  });
});
