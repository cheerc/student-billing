import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { StudentSnapshot } from '@/domain/students/types';
import { SEED_BASE_NAMES } from '@/domain/schedules/seed-manifest';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';
import type { ClassSettingLookup } from '@/domain/classification/class-category';
import { manualCategories } from '../helpers/manual-categories';

describe('D2a: erp-tag-v4 班級類別計費核心與選班演算法', () => {
  /**
   * 本檔所有虛構班級的**明確**類別宣告（#157 Ruling 1：班名不再參與判定）。
   *
   * 每一項都是「這個測試要驗的業務事實」，不是由產品依班名猜出來的：
   *   - 國小輔導-四年級 → care；國小輔導-寫功課 → 使用者明確指定不列入 → none
   *   - 國小數學-*／兒童美語-* → 各自科目
   *   - 交通車／正音班 → 使用者明確指定不列入 → none
   * 未列在此表的班名（例如「國小數學-全新未開班」）刻意保持未設定，用來驗 Ruling 3。
   */
  const MANUAL = manualCategories({
    care: ['國小輔導-四年級', '國小輔導-五子', '國小輔導-美安'],
    math: [
      '國小數學-四A', '國小數學-甲', '國小數學-乙', '國小數學-丙',
      '國小數學-X', '國小數學-Y',
    ],
    english: ['兒童美語-甲', '兒童美語-乙', '兒童美語-X', '兒童美語-Y', '兒童美語-EA', '兒童美語-EB', '兒童美語-未排課'],
    none: ['國小輔導-寫功課', '交通車[中區]', '交通車-A', '交通車-B', '正音A班'],
  });

  /** 以本檔的明確宣告補齊 classSettings（保留呼叫端已給的項目）。 */
  function withManual(extra?: Map<string, ClassSettingLookup>): Map<string, ClassSettingLookup> {
    const map = new Map(MANUAL);
    for (const [k, v] of extra ?? []) map.set(k, v);
    return map;
  }

  // 基礎 helper: 構造最小 StudentSnapshot
  function makeStudent(params: {
    personCode?: string;
    grade?: number | null;
    tagsRaw?: string;
    notesRaw?: string;
    enrollments: Array<{ rawToken: string; baseName: string; tokenIndex?: number; erpBillingTier?: number | null }>;
  }): StudentSnapshot {
    return {
      personCode: params.personCode ?? 'S001',
      name: '測試學生',
      branch: null,
      grade: params.grade ?? 4,
      gradeRaw: String(params.grade ?? 4),
      gradeStatus: 'valid',
      contact: null,
      schoolInfo: null,
      tagsRaw: params.tagsRaw ?? '',
      tags: [],
      notesRaw: params.notesRaw ?? '',
      sourceRow: 1,
      enrollments: params.enrollments.map((e, idx) => ({
        rawToken: e.rawToken,
        baseName: e.baseName,
        yearPrefix: null,
        groupFlag: null,
        modifiers: [],
        withdrawalDate: null,
        erpBillingTierRaw: null,
        erpBillingTier: e.erpBillingTier ?? null,
        tierParseStatus: 'not_applicable',
        parseStatus: 'ok',
      })),
    };
  }

  describe('1. R03 類別式科數與基本折扣 (取代 R09 與寫功課減1)', () => {
    it('手算案例 D-02: 一般輔導 + 寫功課 + 數學 (年級 4, Q1 寫功課優先->不列入)', () => {
      // 班級：
      // 「國小輔導-四年級」-> care
      // 「國小輔導-寫功課」-> none (Q1)
      // 「國小數學-四A」    -> math
      // 類別種數 = {care, math} = 2 科 (同類只算1科，不再受寫功課減1扣減)
      // 歷史規則與 current v4 differ; this test asserts the current category result
      // v4: {care, math} = 2 科 -> 基本率 9500 bps
      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' },
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
          { rawToken: '國小數學-四A[團]', baseName: '國小數學-四A' },
        ],
      });


      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, classSettings: MANUAL });
      expect(resV4.subjectCount).toBe(2); // v4: {care, math} = 2
      expect(resV4.baseDiscountBps).toBe(9500);
    });

    it('手算案例 D-02 + 兄弟姊妹折扣標籤', () => {
      // 在 D-02 基礎上加標籤「有兄弟姊妹折扣」
      // Historical calculator output is not used by new runs.
      // v4: effectiveCount = 2 + 1 = 3 -> 9000 bps
      const student = makeStudent({
        grade: 4,
        tagsRaw: '有兄弟姊妹折扣',
        enrollments: [
          { rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' },
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
          { rawToken: '國小數學-四A[團]', baseName: '國小數學-四A' },
        ],
      });


      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, classSettings: MANUAL });
      expect(resV4.baseDiscountBps).toBe(9000);
    });

    it('手算案例 D-02b: 一般輔導 + 寫功課 (無其他科) + 兄弟姊妹 (年級 4)', () => {
      // 班級：國小輔導-四年級 + 國小輔導-寫功課
      // Historical calculator output is not used by new runs.
      // v4: {care} = 1 科, effectiveCount = 1 + 1 = 2 -> 基本率 9500 bps
      const student = makeStudent({
        grade: 4,
        tagsRaw: '有兄弟姊妹折扣',
        enrollments: [
          { rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' },
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
        ],
      });


      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, classSettings: MANUAL });
      expect(resV4.subjectCount).toBe(1);
      expect(resV4.baseDiscountBps).toBe(9500);
    });

    it('同一類別重複報名多班，同類只算 1 科 (例如報兩班兒童美語)', () => {
      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '兒童美語-EA', baseName: '兒童美語-EA' },
          { rawToken: '兒童美語-EB', baseName: '兒童美語-EB' },
        ],
      });

      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, classSettings: MANUAL });
      expect(resV4.subjectCount).toBe(1); // {english} = 1
      expect(resV4.baseDiscountBps).toBe(10000);
    });

    it('只有不列入班 (寫功課、交通車、正音班): 科數為 0，基本率為 10000', () => {
      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
          { rawToken: '交通車[中區]', baseName: '交通車[中區]' },
        ],
      });

      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, classSettings: MANUAL });
      expect(resV4.subjectCount).toBe(0);
      expect(resV4.baseDiscountBps).toBe(10000);
    });
  });

  describe('2. R03 / D37 ② 衝堂扣天選班演算法 (取正量最多扣天)', () => {
    it('手算案例 D-01a: 重複美語，課輔側 (年級 4) 取正量最多', () => {
      // 學生年級 4 (課輔側窗口: 週一至五 16:30-19:30 = 990-1170)
      // 甲: 週一 16:30-18:00 (重疊 90 分鐘 -> raw -0.5 -> rounded -0.5，正量 0.5)
      // 乙: 週二 16:30-19:00 (重疊 150 分鐘且下課 19:00 在 (18:30, 19:30) 觸發特例 -> raw -1.0 -> rounded -1.0，正量 1.0)
      // Current v4 selects the calculable class with greatest applicable deduction.
      // v4: 取正量最多乙 -> 扣 1.0 -> 課輔天數 = max(3.0, 5 - 1.0) = 4.0
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
        ['兒童美語-甲', [{ start: 990, end: 1080, weekday: '一' }]],
        ['兒童美語-乙', [{ start: 990, end: 1140, weekday: '二' }]],
      ]);

      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '兒童美語-甲', baseName: '兒童美語-甲', tokenIndex: 0 },
          { rawToken: '兒童美語-乙', baseName: '兒童美語-乙', tokenIndex: 1 },
        ],
      });


      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL });
      expect(resV4.careDays.tutoring.days).toBe(4.0);
    });

    it('手算案例 D-01b: 重複美語，安親側 (年級 2) 取正量最多', () => {
      // 學生年級 2 (安親側窗口: 週一至五 13:00-16:00 = 780-960)
      // 甲: 週一 13:00-14:30 (重疊 90 分鐘 -> rounded -0.5，正量 0.5)
      // 乙: 週三 13:00-16:00 (重疊 180 分鐘 -> rounded -1.0，正量 1.0)
      // Current v4 selects the calculable class with greatest applicable deduction.
      // v4: 取最多乙 -> max(3.5, 5 - 1.0) = 4.0
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
        ['兒童美語-甲', [{ start: 780, end: 870, weekday: '一' }]],
        ['兒童美語-乙', [{ start: 780, end: 960, weekday: '三' }]],
      ]);

      const student = makeStudent({
        grade: 2,
        enrollments: [
          { rawToken: '兒童美語-甲', baseName: '兒童美語-甲', tokenIndex: 0 },
          { rawToken: '兒童美語-乙', baseName: '兒童美語-乙', tokenIndex: 1 },
        ],
      });


      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL });
      expect(resV4.careDays.anqin.days).toBe(4.0);
    });

    it('手算案例 D-01c: 適用側決定選班', () => {
      // X: 週一 17:00-18:00 (課輔重疊 60 分鐘 -> 扣 0.5；安親重疊 0)
      // Y: 週一 13:30-14:30 (安親重疊 60 分鐘 -> 扣 0.5；課輔重疊 0)
      // 報名順序: X, Y
      // 年級 2 (安親側): X 安親扣 0、Y 安親扣 0.5 -> v4 選 Y -> 天數 = max(3.5, 5 - 0.5) = 4.5
      // (historical first-class behavior is not used by current calculations)
      // 年級 4 (課輔側): X 課輔扣 0.5、Y 課輔扣 0 -> v4 選 X -> 天數 = max(3.0, 5 - 0.5) = 4.5
      // (historical first-class behavior is not used by current calculations)
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
        ['兒童美語-X', [{ start: 1020, end: 1080, weekday: '一' }]],
        ['兒童美語-Y', [{ start: 810, end: 870, weekday: '一' }]],
      ]);

      const studentG2 = makeStudent({
        grade: 2,
        enrollments: [
          { rawToken: '兒童美語-X', baseName: '兒童美語-X', tokenIndex: 0 },
          { rawToken: '兒童美語-Y', baseName: '兒童美語-Y', tokenIndex: 1 },
        ],
      });
      expect(calculateStudentBilling(studentG2, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL }).careDays.anqin.days).toBe(4.5);

      const studentG4 = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '兒童美語-X', baseName: '兒童美語-X', tokenIndex: 0 },
          { rawToken: '兒童美語-Y', baseName: '兒童美語-Y', tokenIndex: 1 },
        ],
      });
      expect(calculateStudentBilling(studentG4, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL }).careDays.tutoring.days).toBe(4.5);
    });

    it('平手取報名順序在前者 (token_index 較小)', () => {
      // 兩班皆在週一 16:30-18:00 (皆扣 0.5 天)
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
        ['兒童美語-甲', [{ start: 990, end: 1080, weekday: '一' }]],
        ['兒童美語-乙', [{ start: 990, end: 1080, weekday: '一' }]],
      ]);

      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '兒童美語-甲', baseName: '兒童美語-甲', tokenIndex: 0 },
          { rawToken: '兒童美語-乙', baseName: '兒童美語-乙', tokenIndex: 1 },
        ],
      });

      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL });
      expect(resV4.careDays.tutoring.days).toBe(4.5);
    });

    it('案例 D-01d: 首班未對應課表 (schedule_not_found)，第二班可計算時選第二班且保留首班警告', () => {
      // 學生報 丙 (課表中找不到) 與 乙 (週一 16:30-17:30，扣 0.5 天)
      // Current v4 records missing candidates and uses the best calculable candidate.
      // v4 只在可計算候選中選乙 -> 扣 0.5 -> 天數 4.5，且保留丙的 SCHEDULE_NOT_FOUND 警告
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
        ['國小數學-乙', [{ start: 990, end: 1050, weekday: '一' }]],
      ]);

      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '國小數學-丙', baseName: '國小數學-丙', tokenIndex: 0 },
          { rawToken: '國小數學-乙', baseName: '國小數學-乙', tokenIndex: 1 },
        ],
      });


      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL });
      expect(resV4.careDays.tutoring.days).toBe(4.5);
      expect(resV4.issues.some((i) => i.code === 'SCHEDULE_NOT_FOUND')).toBe(true);
    });

    it('Q5-B: 含未知星期候選以 fail-closed 值參與比較且保留 UNKNOWN_WEEKDAY 警告', () => {
      // 甲: 週一 16:30-19:00 (扣 1.0) + 星期「八」16:30-17:30 (未知 -> 0) -> 合計扣 1.0
      // 乙: 週一 16:30-17:30 (扣 0.5)
      // 甲的正量扣除 1.0 >= 乙的 0.5 -> v4 選甲 -> 課輔天數 = 5 - 1.0 = 4.0，並帶 UNKNOWN_WEEKDAY 警告
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
        [
          '國小數學-甲',
          [
            { start: 990, end: 1140, weekday: '一' },
            { start: 990, end: 1050, weekday: '八' },
          ],
        ],
        ['國小數學-乙', [{ start: 990, end: 1050, weekday: '一' }]],
      ]);

      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '國小數學-甲', baseName: '國小數學-甲', tokenIndex: 0 },
          { rawToken: '國小數學-乙', baseName: '國小數學-乙', tokenIndex: 1 },
        ],
      });

      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL });
      expect(resV4.careDays.tutoring.days).toBe(4.0);
      expect(resV4.issues.some((i) => i.code === 'UNKNOWN_WEEKDAY')).toBe(true);
    });
  });

  describe('3. R11 / R12 / Q7-A 固定 5 天 (天數下限 5 與適用率 100%)', () => {
    it('U58: 額外扣天在固定 5 天之後扣除 (5 - 2 = 3)，但受年級下限保底 (案例 D-12)', () => {
      // 學生年級 4，報「國小輔導-寫功課」，標籤「安課額外扣2天」
      // 固定 5 天 baseVal = 5; 額外扣 2 天 -> Math.max(3.0, 5 - 2) = 3
      const student = makeStudent({
        grade: 4,
        tagsRaw: '安課額外扣2天',
        enrollments: [{ rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' }],
      });

      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, classSettings: MANUAL });
      expect(resV4.careDays.tutoring.days).toBe(3);
      expect(resV4.careDays.tutoring.displayDays).toBe('3*額');
      expect(resV4.applicableRates.tutoring).toBe(10000); // base course rate remains 100% for no-discount enrollment
    });

  });

  describe('4. R17 / Q3 isEnrolled 判定', () => {
    it('案例 D-04: 只有「國小輔導-寫功課」的年級 5 學生，v4 isEnrolled 為 false (v2 為 true)', () => {
      const student = makeStudent({
        grade: 5,
        enrollments: [{ rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' }],
      });


      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, classSettings: MANUAL });
      expect(resV4.careDays.tutoring.isEnrolled).toBe(false);
    });
  });

  describe('5. R17 / Q8 重複報名提示', () => {
    it('Q8: 報名兩班寫功課 (固定 5 天且 none)，v4 仍出 DUPLICATE_SUBJECT_ENROLLMENT 提示', () => {
      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '國小輔導-寫功課A', baseName: '國小輔導-寫功課' },
          { rawToken: '國小輔導-寫功課B', baseName: '國小輔導-寫功課' },
        ],
      });

      const classSettings = new Map([
        // #157：明確指定才有折扣語意；Q8 的條件是 fixedFiveDays && category === 'none'
        ['國小輔導-寫功課', { category: 'none' as const, categorySource: 'manual' as const, fixedFiveDays: true }],
      ]);
      const resV4 = calculateStudentBilling(student, {
        ruleSetVersion: 'erp-tag-v4' as any,
        classSettings: withManual(classSettings),
      });
      const dup = resV4.issues.find((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT');
      expect(dup).toBeDefined();
    });

    it('若為兩班交通車 (none 且非固定 5 天)，不出重複報名提示', () => {
      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '交通車-A', baseName: '交通車-A' },
          { rawToken: '交通車-B', baseName: '交通車-B' },
        ],
      });

      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, classSettings: MANUAL });
      expect(resV4.issues.some((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT')).toBe(false);
    });
  });

  describe('6. F-8 美語缺課表警告與 Q4 未對應班 CLASS_NOT_MAPPED', () => {
    it('F-8: 美語班在課表中找不到時，v4 reports a missing English schedule for review', () => {
      // 學生報「兒童美語-未排課」，在 scheduleOverride 或 seed 中找不到
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([]);

      const student = makeStudent({
        grade: 4,
        enrollments: [{ rawToken: '兒童美語-未排課', baseName: '兒童美語-未排課' }],
      });


      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL });
      expect(resV4.issues.some((i) => i.code === 'SCHEDULE_NOT_FOUND')).toBe(true);
    });

    it('Q4-b: 未對應班（不限類別）一律出 CLASS_NOT_MAPPED 需確認警告', () => {
      // 學生報「國小數學-新開未對應班」，在課表設定中未找到。
      // #157 Ruling 3：範圍由「care/math/english」改為「所有未對應班」。
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([]);

      const student = makeStudent({
        grade: 4,
        enrollments: [{ rawToken: '國小數學-新開未對應班', baseName: '國小數學-新開未對應班' }],
      });

      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL });
      const unmapped = resV4.issues.find((i) => i.code === 'CLASS_NOT_MAPPED');
      expect(unmapped).toBeDefined();
      expect(unmapped?.message).toContain('班名未對應課表，請確認米豆奶班名或系統班級名稱');
    });

    it('Q4-b（#157 改寫）: 未對應的交通車同樣出 CLASS_NOT_MAPPED——不再靜默', () => {
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([]);

      const student = makeStudent({
        grade: 4,
        enrollments: [{ rawToken: '交通車-東區', baseName: '交通車-東區' }],
      });

      // 舊制：交通車的班名被自動偵測成 none，因此靜默不警告（119 位學生因此無任何提示）。
      // #157 Ruling 3：未對應就是未對應，一律警告——否則使用者無法從結果反推「這班沒被收錄」。
      const resV4 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4' as any, scheduleOverride, classSettings: MANUAL });
      expect(resV4.issues.some((i) => i.code === 'CLASS_NOT_MAPPED')).toBe(true);
    });
  });

  describe('R2-3: current v4 discount and warning inputs use tags only', () => {
    it('tag 「有兄弟姊妹」 without the required suffix does not apply the sibling discount', () => {
      const student = makeStudent({
        grade: 4,
        tagsRaw: '有兄弟姊妹',
        enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
      });
      const result = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4', classSettings: MANUAL });
      expect(result.baseDiscountBps).toBe(10000);
    });

    it('tag 「有兄弟姊妹折扣」 applies the sibling discount', () => {
      const student = makeStudent({
        grade: 4,
        tagsRaw: '有兄弟姊妹折扣',
        enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
      });
      const result = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4', classSettings: MANUAL });
      expect(result.baseDiscountBps).toBe(9500);
    });

    it('notes do not provide a fallback sibling discount and do not suppress the staff-family warning', () => {
      const student = makeStudent({
        grade: 4,
        notesRaw: '有兄弟姊妹折扣',
        tagsRaw: '員工家屬, 有兄弟姊妹',
        enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
      });
      const result = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v4', classSettings: MANUAL });
      expect(result.baseDiscountBps).toBe(10000);
      expect(result.issues.some((issue) => issue.code === 'STAFF_FAMILY_NO_DISCOUNT')).toBe(true);
    });
  });

  describe('R2-2: 49 個種子班級生產形狀計算 0 誤發與未對應班判定', () => {
    it('掃描全部 49 個 seed 班級，以生產形狀計算 v4，已存在班級 0 個 CLASS_NOT_MAPPED', () => {
      const db = new Database(':memory:');
      runMigrations(db);

      const now = new Date().toISOString();
      const students = SEED_BASE_NAMES.map((name, idx) => ({
        personCode: `SEED_${String(idx).padStart(3, '0')}`,
        name: `種子生_${idx}`,
        grade: 4,
        gradeRaw: '4',
        gradeStatus: 'valid' as const,
        branch: '本部',
        contact: null,
        schoolInfo: null,
        tagsRaw: '',
        tags: [],
        notesRaw: '',
        sourceRow: idx + 1,
        enrollments: [
          {
            rawToken: name,
            yearPrefix: null,
            baseName: name,
            groupFlag: null,
            modifiers: [],
            withdrawalDate: null,
            erpBillingTierRaw: null,
            erpBillingTier: null,
            tierParseStatus: 'not_applicable' as const,
            parseStatus: 'ok' as const,
          },
        ],
      }));

      saveImportBatch(
        db,
        {
          id: 'imp_seed_all',
          fileName: 'seed_classes.xlsx',
          fileHash: 'h_seed',
          contentHash: 'c_seed',
          sheetName: 'Sheet1',
          headerMap: {},
          parserVersion: '1.0.0',
          scopeNote: '',
          rowCount: students.length,
          status: 'ready',
          createdAt: now,
        },
        students
      );

      const { run, results } = executeCalculationRun(db, 'imp_seed_all', 'run_seed_v4', {
        ruleSetVersion: 'erp-tag-v4' as any,
      });

      expect(run.issueCounts['CLASS_NOT_MAPPED'] || 0).toBe(0);

      const unmappedStudents = results.filter((r) =>
        r.issues.some((i: any) => i.code === 'CLASS_NOT_MAPPED')
      );
      expect(unmappedStudents.length).toBe(0);

      db.close();
    });

    it('真正不存在於系統班級來源的名冊班名，care/math/english 正確產生 CLASS_NOT_MAPPED 且扣天為 0 fallback', () => {
      const db = new Database(':memory:');
      runMigrations(db);

      const now = new Date().toISOString();
      saveImportBatch(
        db,
        {
          id: 'imp_unmapped',
          fileName: 'unmapped.xlsx',
          fileHash: 'h_unmapped',
          contentHash: 'c_unmapped',
          sheetName: 'Sheet1',
          headerMap: {},
          parserVersion: '1.0.0',
          scopeNote: '',
          rowCount: 1,
          status: 'ready',
          createdAt: now,
        },
        [
          {
            personCode: 'U001',
            name: '未對應生',
            grade: 4,
            gradeRaw: '4',
            gradeStatus: 'valid' as const,
            branch: '本部',
            contact: null,
            schoolInfo: null,
            tagsRaw: '',
            tags: [],
            notesRaw: '',
            sourceRow: 1,
            enrollments: [
              {
                rawToken: '國小數學-全新未開班',
                yearPrefix: null,
                baseName: '國小數學-全新未開班',
                groupFlag: null,
                modifiers: [],
                withdrawalDate: null,
                erpBillingTierRaw: null,
                erpBillingTier: null,
                tierParseStatus: 'not_applicable' as const,
                parseStatus: 'ok' as const,
              },
            ],
          },
        ]
      );

      const { run, results } = executeCalculationRun(db, 'imp_unmapped', 'run_unmapped_v4', {
        ruleSetVersion: 'erp-tag-v4' as any,
      });

      expect(run.issueCounts['CLASS_NOT_MAPPED']).toBe(1);
      const studentRes = results[0];
      expect(studentRes.issues.some((i: any) => i.code === 'CLASS_NOT_MAPPED')).toBe(true);
      expect(studentRes.tutoringDays).toBe(5); // 未對應扣天 fallback 為 0 (年級 4 滿天 5)

      db.close();
    });
  });
});
