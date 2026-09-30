import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { calculateSubjectCount } from '@/domain/billing/discount-rules';
import { StudentSnapshot } from '@/domain/students/types';
import { SEED_BASE_NAMES } from '@/domain/schedules/seed-manifest';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { executeCalculationRun } from '@/application/calculate-run';

describe('D2a: erp-tag-v3 班級類別計費核心與選班演算法', () => {
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
      // v2: 1 (care) + 1 (math) = 2, 寫功課減1 = 1 科 -> 基本率 10000 bps
      // v3: {care, math} = 2 科 -> 基本率 9500 bps
      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' },
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
          { rawToken: '國小數學-四A[團]', baseName: '國小數學-四A' },
        ],
      });

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2' });
      expect(resV2.subjectCount).toBe(1); // v2: 2 - 1 = 1
      expect(resV2.baseDiscountBps).toBe(10000);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.subjectCount).toBe(2); // v3: {care, math} = 2
      expect(resV3.baseDiscountBps).toBe(9500);
    });

    it('手算案例 D-02 + 兄弟姊妹折扣標籤', () => {
      // 在 D-02 基礎上加標籤「有兄弟姊妹折扣」
      // v2: effectiveCount = 1 + 1 = 2 -> 9500 bps
      // v3: effectiveCount = 2 + 1 = 3 -> 9000 bps
      const student = makeStudent({
        grade: 4,
        tagsRaw: '有兄弟姊妹折扣',
        enrollments: [
          { rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' },
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
          { rawToken: '國小數學-四A[團]', baseName: '國小數學-四A' },
        ],
      });

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2' });
      expect(resV2.baseDiscountBps).toBe(9500);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.baseDiscountBps).toBe(9000);
    });

    it('手算案例 D-02b: 一般輔導 + 寫功課 (無其他科) + 兄弟姊妹 (年級 4)', () => {
      // 班級：國小輔導-四年級 + 國小輔導-寫功課
      // v2: 1 - 1 = 0 科, effectiveCount = 0 + 1 = 1 -> 基本率 10000 bps
      // v3: {care} = 1 科, effectiveCount = 1 + 1 = 2 -> 基本率 9500 bps
      const student = makeStudent({
        grade: 4,
        tagsRaw: '有兄弟姊妹折扣',
        enrollments: [
          { rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' },
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
        ],
      });

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2' });
      expect(resV2.subjectCount).toBe(0);
      expect(resV2.baseDiscountBps).toBe(10000);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.subjectCount).toBe(1);
      expect(resV3.baseDiscountBps).toBe(9500);
    });

    it('同一類別重複報名多班，同類只算 1 科 (例如報兩班兒童美語)', () => {
      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '兒童美語-EA', baseName: '兒童美語-EA' },
          { rawToken: '兒童美語-EB', baseName: '兒童美語-EB' },
        ],
      });

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.subjectCount).toBe(1); // {english} = 1
      expect(resV3.baseDiscountBps).toBe(10000);
    });

    it('只有不列入班 (寫功課、交通車、正音班): 科數為 0，基本率為 10000', () => {
      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
          { rawToken: '交通車[中區]', baseName: '交通車[中區]' },
        ],
      });

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.subjectCount).toBe(0);
      expect(resV3.baseDiscountBps).toBe(10000);
    });
  });

  describe('2. R03 / D37 ② 衝堂扣天選班演算法 (取正量最多扣天)', () => {
    it('手算案例 D-01a: 重複美語，課輔側 (年級 4) 取正量最多', () => {
      // 學生年級 4 (課輔側窗口: 週一至五 16:30-19:30 = 990-1170)
      // 甲: 週一 16:30-18:00 (重疊 90 分鐘 -> raw -0.5 -> rounded -0.5，正量 0.5)
      // 乙: 週二 16:30-19:00 (重疊 150 分鐘且下課 19:00 在 (18:30, 19:30) 觸發特例 -> raw -1.0 -> rounded -1.0，正量 1.0)
      // v2: 取首班甲 -> 扣 0.5 -> 課輔天數 = max(3.0, 5 - 0.5) = 4.5
      // v3: 取正量最多乙 -> 扣 1.0 -> 課輔天數 = max(3.0, 5 - 1.0) = 4.0
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

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2', scheduleOverride });
      expect(resV2.careDays.tutoring.days).toBe(4.5);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride });
      expect(resV3.careDays.tutoring.days).toBe(4.0);
    });

    it('手算案例 D-01b: 重複美語，安親側 (年級 2) 取正量最多', () => {
      // 學生年級 2 (安親側窗口: 週一至五 13:00-16:00 = 780-960)
      // 甲: 週一 13:00-14:30 (重疊 90 分鐘 -> rounded -0.5，正量 0.5)
      // 乙: 週三 13:00-16:00 (重疊 180 分鐘 -> rounded -1.0，正量 1.0)
      // v2: 取首班甲 -> max(3.5, 5 - 0.5) = 4.5
      // v3: 取最多乙 -> max(3.5, 5 - 1.0) = 4.0
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

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2', scheduleOverride });
      expect(resV2.careDays.anqin.days).toBe(4.5);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride });
      expect(resV3.careDays.anqin.days).toBe(4.0);
    });

    it('手算案例 D-01c: 適用側決定選班', () => {
      // X: 週一 17:00-18:00 (課輔重疊 60 分鐘 -> 扣 0.5；安親重疊 0)
      // Y: 週一 13:30-14:30 (安親重疊 60 分鐘 -> 扣 0.5；課輔重疊 0)
      // 報名順序: X, Y
      // 年級 2 (安親側): X 安親扣 0、Y 安親扣 0.5 -> v3 選 Y -> 天數 = max(3.5, 5 - 0.5) = 4.5
      // (v2 首班 X 安親扣 0 -> 天數 5.0)
      // 年級 4 (課輔側): X 課輔扣 0.5、Y 課輔扣 0 -> v3 選 X -> 天數 = max(3.0, 5 - 0.5) = 4.5
      // (v2 首班 X 課輔扣 0.5 -> 天數 4.5)
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
      expect(calculateStudentBilling(studentG2, { ruleSetVersion: 'erp-tag-v2', scheduleOverride }).careDays.anqin.days).toBe(5.0);
      expect(calculateStudentBilling(studentG2, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride }).careDays.anqin.days).toBe(4.5);

      const studentG4 = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '兒童美語-X', baseName: '兒童美語-X', tokenIndex: 0 },
          { rawToken: '兒童美語-Y', baseName: '兒童美語-Y', tokenIndex: 1 },
        ],
      });
      expect(calculateStudentBilling(studentG4, { ruleSetVersion: 'erp-tag-v2', scheduleOverride }).careDays.tutoring.days).toBe(4.5);
      expect(calculateStudentBilling(studentG4, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride }).careDays.tutoring.days).toBe(4.5);
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

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride });
      expect(resV3.careDays.tutoring.days).toBe(4.5);
    });

    it('案例 D-01d: 首班未對應課表 (schedule_not_found)，第二班可計算時選第二班且保留首班警告', () => {
      // 學生報 丙 (課表中找不到) 與 乙 (週一 16:30-17:30，扣 0.5 天)
      // v2 取首班丙 -> not found -> 0 扣天 -> 天數 5.0
      // v3 只在可計算候選中選乙 -> 扣 0.5 -> 天數 4.5，且保留丙的 SCHEDULE_NOT_FOUND 警告
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

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2', scheduleOverride });
      expect(resV2.careDays.tutoring.days).toBe(5.0);
      expect(resV2.issues.some((i) => i.code === 'SCHEDULE_NOT_FOUND')).toBe(true);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride });
      expect(resV3.careDays.tutoring.days).toBe(4.5);
      expect(resV3.issues.some((i) => i.code === 'SCHEDULE_NOT_FOUND')).toBe(true);
    });

    it('Q5-B: 含未知星期候選以 fail-closed 值參與比較且保留 UNKNOWN_WEEKDAY 警告', () => {
      // 甲: 週一 16:30-19:00 (扣 1.0) + 星期「八」16:30-17:30 (未知 -> 0) -> 合計扣 1.0
      // 乙: 週一 16:30-17:30 (扣 0.5)
      // 甲的正量扣除 1.0 >= 乙的 0.5 -> v3 選甲 -> 課輔天數 = 5 - 1.0 = 4.0，並帶 UNKNOWN_WEEKDAY 警告
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

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride });
      expect(resV3.careDays.tutoring.days).toBe(4.0);
      expect(resV3.issues.some((i) => i.code === 'UNKNOWN_WEEKDAY')).toBe(true);
    });
  });

  describe('3. R11 / R12 / Q7-A 固定 5 天 (天數下限 5 與適用率 100%)', () => {
    it('固定 5 天在額外扣天之後套用: 有額外扣天也被壓回 5 天 (案例 D-12)', () => {
      // 學生年級 4，報「國小輔導-寫功課」，標籤「安課額外扣2天」
      // rawVal = 5 - 2 = 3; 但固定 5 天 -> max(3.0, 3, 5) = 5
      const student = makeStudent({
        grade: 4,
        tagsRaw: '安課額外扣2天',
        enrollments: [{ rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' }],
      });

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.careDays.tutoring.days).toBe(5);
      expect(resV3.applicableRates.tutoring).toBe(10000); // 固定 5 天適用率 100%
    });
  });

  describe('4. R17 / Q3 isEnrolled 判定', () => {
    it('案例 D-04: 只有「國小輔導-寫功課」的年級 5 學生，v3 isEnrolled 為 false (v2 為 true)', () => {
      const student = makeStudent({
        grade: 5,
        enrollments: [{ rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' }],
      });

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2' });
      expect(resV2.careDays.tutoring.isEnrolled).toBe(true);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.careDays.tutoring.isEnrolled).toBe(false);
    });
  });

  describe('5. R17 / Q8 重複報名提示', () => {
    it('Q8: 報名兩班寫功課 (固定 5 天且 none)，v3 仍出 DUPLICATE_SUBJECT_ENROLLMENT 提示', () => {
      const student = makeStudent({
        grade: 4,
        enrollments: [
          { rawToken: '國小輔導-寫功課A', baseName: '國小輔導-寫功課' },
          { rawToken: '國小輔導-寫功課B', baseName: '國小輔導-寫功課' },
        ],
      });

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      const dup = resV3.issues.find((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT');
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

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.issues.some((i) => i.code === 'DUPLICATE_SUBJECT_ENROLLMENT')).toBe(false);
    });
  });

  describe('6. F-8 美語缺課表警告與 Q4 未對應班 CLASS_NOT_MAPPED', () => {
    it('F-8: 美語班在課表中找不到時，v2 不出 SCHEDULE_NOT_FOUND，v3 補上需確認警告', () => {
      // 學生報「兒童美語-未排課」，在 scheduleOverride 或 seed 中找不到
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([]);

      const student = makeStudent({
        grade: 4,
        enrollments: [{ rawToken: '兒童美語-未排課', baseName: '兒童美語-未排課' }],
      });

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2', scheduleOverride });
      expect(resV2.issues.some((i) => i.code === 'SCHEDULE_NOT_FOUND')).toBe(false);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride });
      expect(resV3.issues.some((i) => i.code === 'SCHEDULE_NOT_FOUND')).toBe(true);
    });

    it('Q4-b: 未對應班若自動偵測為安親課輔/數學/美語，出 CLASS_NOT_MAPPED 需確認警告', () => {
      // 學生報「國小數學-新開未對應班」，在課表設定中未找到
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([]);

      const student = makeStudent({
        grade: 4,
        enrollments: [{ rawToken: '國小數學-新開未對應班', baseName: '國小數學-新開未對應班' }],
      });

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride });
      const unmapped = resV3.issues.find((i) => i.code === 'CLASS_NOT_MAPPED');
      expect(unmapped).toBeDefined();
      expect(unmapped?.message).toContain('班名未對應課表，請確認米豆奶班名或系統班級名稱');
    });

    it('Q4-b: 未對應班若自動偵測為 none (如交通車)，不出 CLASS_NOT_MAPPED', () => {
      const scheduleOverride = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([]);

      const student = makeStudent({
        grade: 4,
        enrollments: [{ rawToken: '交通車-東區', baseName: '交通車-東區' }],
      });

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any, scheduleOverride });
      expect(resV3.issues.some((i) => i.code === 'CLASS_NOT_MAPPED')).toBe(false);
    });
  });

  describe('R2-3: R06 兄弟姊妹折扣嚴格字面與全版本零回退', () => {
    it('標籤為「有兄弟姊妹」(無後綴) 時，v1/v2/compat/v3 之 sibling 恆 false，基本折扣維持 10000 bps', () => {
      const student = makeStudent({
        grade: 4,
        tagsRaw: '有兄弟姊妹',
        enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
      });

      const resV1 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v1' });
      expect(resV1.baseDiscountBps).toBe(10000);

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2' });
      expect(resV2.baseDiscountBps).toBe(10000);

      const resCompat = calculateStudentBilling(student, { ruleSetVersion: 'excel-v260922-compat' });
      expect(resCompat.baseDiscountBps).toBe(10000);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.baseDiscountBps).toBe(10000);
    });

    it('compat 軌備註為「有兄弟姊妹」(無後綴) 時，基本折扣維持 10000 bps', () => {
      const student = makeStudent({
        grade: 4,
        notesRaw: '有兄弟姊妹',
        enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
      });

      const resCompat = calculateStudentBilling(student, { ruleSetVersion: 'excel-v260922-compat' });
      expect(resCompat.baseDiscountBps).toBe(10000);
    });

    it('標籤為「有兄弟姊妹折扣」時，v1/v2/v3 之 sibling 命中，基本折扣為 9500 bps', () => {
      const student = makeStudent({
        grade: 4,
        tagsRaw: '有兄弟姊妹折扣',
        enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
      });

      const resV1 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v1' });
      expect(resV1.baseDiscountBps).toBe(9500);

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2' });
      expect(resV2.baseDiscountBps).toBe(9500);

      const resV3 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v3' as any });
      expect(resV3.baseDiscountBps).toBe(9500);
    });

    it('compat 軌備註為「有兄弟姊妹折扣」時，sibling 命中，基本折扣為 9500 bps', () => {
      const student = makeStudent({
        grade: 4,
        notesRaw: '有兄弟姊妹折扣',
        enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
      });

      const resCompat = calculateStudentBilling(student, { ruleSetVersion: 'excel-v260922-compat' });
      expect(resCompat.baseDiscountBps).toBe(9500);
    });

    it('標籤為「員工家屬, 有兄弟姊妹」時，R18 STAFF_FAMILY_NO_DISCOUNT 提示不被抑制', () => {
      const student = makeStudent({
        grade: 4,
        tagsRaw: '員工家屬, 有兄弟姊妹',
        enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
      });

      const resV2 = calculateStudentBilling(student, { ruleSetVersion: 'erp-tag-v2' });
      expect(resV2.issues.some((i) => i.code === 'STAFF_FAMILY_NO_DISCOUNT')).toBe(true);
    });
  });

  describe('R2-2: 49 個種子班級生產形狀計算 0 誤發與未對應班判定', () => {
    it('掃描全部 49 個 seed 班級，以生產形狀計算 v3，已存在班級 0 個 CLASS_NOT_MAPPED', () => {
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

      const { run, results } = executeCalculationRun(db, 'imp_seed_all', 'run_seed_v3', {
        ruleSetVersion: 'erp-tag-v3' as any,
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

      const { run, results } = executeCalculationRun(db, 'imp_unmapped', 'run_unmapped_v3', {
        ruleSetVersion: 'erp-tag-v3' as any,
      });

      expect(run.issueCounts['CLASS_NOT_MAPPED']).toBe(1);
      const studentRes = results[0];
      expect(studentRes.issues.some((i: any) => i.code === 'CLASS_NOT_MAPPED')).toBe(true);
      expect(studentRes.tutoringDays).toBe(5); // 未對應扣天 fallback 為 0 (年級 4 滿天 5)

      db.close();
    });
  });
});
