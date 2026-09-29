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

      const result = computeRosterChanges([s], s, beforeCtx, afterCtx);

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

      const result = computeRosterChanges([before], after, beforeCtx, afterCtx);

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

      const result = computeRosterChanges([before], after, beforeCtx, afterCtx);
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

      const result = computeRosterChanges([before], after, beforeCtx, afterCtx);
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

      const result = computeRosterChanges([before], after, beforeCtx, afterCtx);
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

      const result = computeRosterChanges([before], after, beforeCtx, afterCtx);
      expect(result.changes[0].discountChange!.afterBps).toBe(8500);
      expect(result.changes[0].discountChange!.afterLabel).toBe('85折');
    });
  });

  describe('輔助原因：before & after 對照', () => {
    it('天數異動附逐班衝堂明細（哪些課程時段造成天數變化）', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A'], { grade: 1 });
      // 換一門課 → 該班的衝堂天數不同
      const after = student('S1', ['國小數學-三A'], { grade: 1 });

      const result = computeRosterChanges([before], after, beforeCtx, afterCtx);
      const change = result.changes[0];
      expect(change.dayChange).not.toBeNull();
      expect(change.dayChange!.classBreakdown.length).toBeGreaterThan(0);
      // 每一筆都帶 before & after 與班名，畫面才能呈現「因哪些課程時段衝堂」
      for (const b of change.dayChange!.classBreakdown) {
        expect(b).toHaveProperty('baseName');
        expect(b).toHaveProperty('beforeAnqinDays');
        expect(b).toHaveProperty('afterAnqinDays');
        expect(b).toHaveProperty('beforeTutoringDays');
        expect(b).toHaveProperty('afterTutoringDays');
        expect(b).toHaveProperty('statusBefore');
        expect(b).toHaveProperty('statusAfter');
      }
    });

    it('折扣異動附科數與標籤 before & after（可查原因）', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A'], { grade: 3 });
      const after = student('S1', ['國小數學-一A', '兒童美語-一A'], { grade: 3 });

      const result = computeRosterChanges([before], after, beforeCtx, afterCtx);
      const change = result.changes[0];
      expect(change.reasons).toContain('已補科數變動');
      expect(change.before).toHaveProperty('subjectCount');
      expect(change.after).toHaveProperty('subjectCount');
      expect(change.before!.subjectCount).toBe(1);
      expect(change.after!.subjectCount).toBe(2);
    });
  });

  describe('首次匯入與邊界', () => {
    it('首次匯入（無舊名單）全部視為新增，不顯示 before', () => {
      const { beforeCtx, afterCtx } = contexts();
      const students = [student('S1', ['國小數學-一A'], { grade: 1 }), student('S2', ['國小數學-三A'], { grade: 3 })];

      const result = computeRosterChanges([], students[0], beforeCtx, afterCtx, { isFirstImport: true });

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].personCode).toBe('S1');
      expect(result.changes[0].isNew).toBe(true);
      expect(result.changes[0].before).toBeNull();
      expect(result.changes[0].discountChange).toBeNull();
      expect(result.changes[0].dayChange).toBeNull();
      expect(result.stats.newCount).toBe(1);
    });

    it('退出名單（before 有、after 無）→ removed，不計入折扣／天數異動', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-一A'], { grade: 1 });

      const result = computeRosterChanges([before], null, beforeCtx, afterCtx);

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].isRemoved).toBe(true);
      expect(result.stats.removedCount).toBe(1);
    });

    it('bps 標籤化：10000/9500/9000/8500 與 null／未設定分開（不把未配置當 100%）', () => {
      const { beforeCtx, afterCtx } = contexts();
      // 2 科（數學＋美語）→ 9500「95折」；3 科（＋輔導）→ 9000「9折」
      const before = student('S1', ['國小數學-一A', '兒童美語-一A'], { grade: 3 });
      const after = student('S1', ['國小數學-一A', '兒童美語-一A', '國小輔導-一A'], { grade: 3 });

      const result = computeRosterChanges([before], after, beforeCtx, afterCtx);
      expect(result.changes[0].discountChange!.beforeLabel).toBe('95折');
      expect(result.changes[0].discountChange!.afterLabel).toBe('9折');
      expect(computeRosterChanges([], null, beforeCtx, afterCtx).changes).toEqual([]);
    });

    it('未報名課程（非適用）與 null 適用率不可被當成 100%', () => {
      const { beforeCtx, afterCtx } = contexts();
      const before = student('S1', ['國小數學-三A'], { grade: 1 });
      const after = student('S1', ['國小數學-三A'], { grade: 1 });

      const b = calculateStudentBilling(before, { ...beforeCtx, ruleSetVersion: 'erp-tag-v2' });
      // 小一未報名安親 → anqin 不適用；不可顯示為 100% 收取率
      expect(b.applicableRates.anqin).toBe(10000);
      expect(b.careDays.anqin.isEnrolled).toBe(false);

      const result = computeRosterChanges([before], after, beforeCtx, afterCtx);
      expect(result.changes).toHaveLength(0); // 非報名且未變動，非異動
    });
  });
});
