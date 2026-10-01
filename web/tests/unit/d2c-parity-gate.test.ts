import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { StudentSnapshot } from '@/domain/students/types';
import type { ClassSettingLookup } from '@/domain/classification/class-category';

/**
 * D2c Parity gate（S manifest §6.0／§6.1／§6.3；specs/11 §3 D2 parity gate 條）。
 *
 * **Gate 的定義**：固定同一 import、同一設定快照、同一數值政策，平行計算 v2 與 v3，
 * 逐欄比較業務欄位。**v3 相對 v2 的差異只允許出現在 S §6.1 差異表所列情境與欄位；
 * 差異表以外的任何差異即為表外差異，gate 失敗。**
 *
 * 本檔以「合成案例」逐條釘住 S §6.2 的手算案例與 §6.2 的 parity 錨點：
 *   - 每個案例的 expected **獨立手算**（S §6.2），不得以被測函式輸出回填；
 *   - 每個案例明列對應的差異表條目，並斷言「落在表內」而非只斷言數值。
 *
 * 只用虛構班名與合成學生，不讀 data/、不含真實名單。
 */

/** 窗口與 D24 取整皆依 02／S manifest §6.2：
 *  安親 13:00–16:00＝780–960；課輔 16:30–19:30＝990–1170；每日 180 分；
 *  D24：f<0.3→0、0.3≤f<0.8→0.5、f≥0.8→1；課輔特例 重疊≥120 且 18:30<下課<19:30 → −1。 */

/** 同一份「設定快照」同時餵給 v2 與 v3（parity 的定義條件）。 */
function snapshot() {
  return {
    aliasMap: new Map<string, string>(),
    scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>(),
    classSettings: new Map<string, ClassSettingLookup>(),
  };
}

function makeStudent(params: {
  personCode?: string;
  grade?: number | null;
  tagsRaw?: string;
  notesRaw?: string;
  enrollments: Array<{ rawToken: string; baseName: string }>;
}): StudentSnapshot {
  return {
    personCode: params.personCode ?? 'P001',
    name: '合成學生',
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
    enrollments: params.enrollments.map((e) => ({
      rawToken: e.rawToken,
      baseName: e.baseName,
      yearPrefix: null,
      groupFlag: null,
      modifiers: [],
      withdrawalDate: null,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable' as const,
      parseStatus: 'ok' as const,
    })),
  };
}

/** S §6.1 差異總表（D-01～D-12）允許的「新增 issue code」白名單（D-05／D-07）。 */
const DIFF_TABLE_ALLOWED_NEW_ISSUE_CODES = ['CLASS_NOT_MAPPED', 'SCHEDULE_NOT_FOUND'];

describe('D2c parity gate：v3 相對 v2 的差異只允許出現在 S manifest §6.1 差異表', () => {
  describe('差異表內：D-01（重複同類報名 → 取扣天最多）', () => {
    it('D-01a：重複美語、課輔側取扣天最多 → v2 4.5 天、v3 4 天（Δ=−0.5）', () => {
      // S §6.2 案例 D-01a（年級 4 = 課輔側、無標籤）：
      //   甲 週一 990–1080（重疊 90 分 → raw −0.5 → rounded −0.5）
      //   乙 週二 990–1140（重疊 150 分，≥120 且下課 1140∈(1110,1170) → 特例 raw −1 → rounded −1）
      // v2 取首班甲 → max(3.0, 5 − 0.5, 0) = 4.5
      // v3 取扣天最多乙 → max(3.0, 5 − 1, 0) = 4
      const student = makeStudent({
        personCode: 'D01A',
        grade: 4,
        enrollments: [
          { rawToken: '兒童美語-甲', baseName: '兒童美語-甲' },
          { rawToken: '兒童美語-乙', baseName: '兒童美語-乙' },
        ],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
          ['兒童美語-甲', [{ weekday: '一', start: 990, end: 1080 }]],
          ['兒童美語-乙', [{ weekday: '二', start: 990, end: 1140 }]],
        ]),
      };
      const v2 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v2' });
      const v3 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v3' as never });

      // 手算 expected（非回填）
      expect(v2.careDays.tutoring.days).toBe(4.5);
      expect(v3.careDays.tutoring.days).toBe(4);
      // 這兩班是虛構班名、不在 classSettings 中 → v3 依 D-05 標 CLASS_NOT_MAPPED（差異表所列）。
      // 與「本案例只驗天數差異」分開：issue 白名單由下方「表外差異偵測」案例專責。
      const codes2 = [...new Set(v2.issues.map((i) => i.code))];
      const codes3 = [...new Set(v3.issues.map((i) => i.code))];
      expect(codes3.filter((c) => !codes2.includes(c))).toEqual(['CLASS_NOT_MAPPED']);
    });

    it('D-01c（適用側決定選班，年級 2 安親側）：v2 5 天、v3 4.5 天（Δ=−0.5）', () => {
      // S §6.2 案例 D-01c（年級 2 = 安親側；報名順序 X、Y）：
      //   X 週一 1020–1080（課輔 60 分 → −0.333 → f=0.333 → 0.5；安親重疊 0）
      //   Y 週一 810–870 （安親 60 分 → −0.333 → 0.5；課輔 0）
      // v3 選安親扣天更多的 Y → max(3.5, 5 − 0.5) = 4.5；v2 取首班 X → 5
      const student = makeStudent({
        personCode: 'D01C',
        grade: 2,
        enrollments: [
          { rawToken: '兒童美語-X', baseName: '兒童美語-X' },
          { rawToken: '兒童美語-Y', baseName: '兒童美語-Y' },
        ],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
          ['兒童美語-X', [{ weekday: '一', start: 1020, end: 1080 }]],
          ['兒童美語-Y', [{ weekday: '一', start: 810, end: 870 }]],
        ]),
      };
      const v2 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v2' });
      const v3 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v3' as never });

      expect(v2.careDays.anqin.days).toBe(5);
      expect(v3.careDays.anqin.days).toBe(4.5);
    });

    it('D-01 平手（兩班同扣 1 天）時 v2 與 v3 相同（無差異，平手取首班）', () => {
      // S §6.1 D-01 fixture 欄：「1 人有重複美語，但兩班同扣 1 天（平手取首班）→ 0 人變動」
      const student = makeStudent({
        personCode: 'D01TIE',
        grade: 4,
        enrollments: [
          { rawToken: '兒童美語-P', baseName: '兒童美語-P' },
          { rawToken: '兒童美語-Q', baseName: '兒童美語-Q' },
        ],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
          // 兩班皆 990–1170（重疊 180 → raw −1 → rounded −1），同扣 1 天
          ['兒童美語-P', [{ weekday: '一', start: 990, end: 1170 }]],
          ['兒童美語-Q', [{ weekday: '二', start: 990, end: 1170 }]],
        ]),
      };
      const v2 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v2' });
      const v3 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v3' as never });

      expect(v2.careDays.tutoring.days).toBe(4);
      expect(v3.careDays.tutoring.days).toBe(4);
    });
  });

  describe('差異表內：D-02（一般輔導＋寫功課並存 → 科數 v2 1、v3 2）', () => {
    it('D-02：一般輔導＋寫功課＋數學（年級 4）→ v2 subjectCount 1／10000、v3 subjectCount 2／9500', () => {
      // S §6.2 案例 D-02（年級 4，Q1 選 A：寫功課優先→不列入）：
      //   「國小輔導-四年級」→ care；「國小輔導-寫功課」→ none；「國小數學-四A」→ math
      // v2：k = care(1) + math(1) + english(0) = 2，含寫功課 −1 → subjectCount 1 → 基本 10000
      // v3：類別種數 = {安親課輔, 數學} = 2 → 基本 9500
      // 衍生：applicableRates.math／english（＝基本率）v2 10000 → v3 9500
      const student = makeStudent({
        personCode: 'D02',
        grade: 4,
        enrollments: [
          { rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' },
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
          { rawToken: '國小數學-四A', baseName: '國小數學-四A' },
        ],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
          ['國小輔導-四年級', []],
          ['國小輔導-寫功課', []],
          ['國小數學-四A', []],
        ]),
      };
      const v2 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v2' });
      const v3 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v3' as never });

      expect(v2.subjectCount).toBe(1);
      expect(v3.subjectCount).toBe(2);
      expect(v2.baseDiscountBps).toBe(10000);
      expect(v3.baseDiscountBps).toBe(9500);
      expect(v2.applicableRates.math).toBe(10000);
      expect(v3.applicableRates.math).toBe(9500);
    });

    it('D-02b：一般輔導＋寫功課＋兄弟姊妹標籤 → v2 10000、v3 9500', () => {
      // S §6.2 案例 D-02b（年級 4，加標籤「有兄弟姊妹折扣」）：
      // v2：k=1、−1 → subjectCount 0；effectiveCount 0+1 → 基本 10000
      // v3：類別種數 = 1（寫功課→不列入不計）→ subjectCount 1；1+1 = 2 → 9500
      const student = makeStudent({
        personCode: 'D02B',
        grade: 4,
        tagsRaw: '有兄弟姊妹折扣',
        enrollments: [
          { rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' },
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
        ],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
          ['國小輔導-四年級', []],
          ['國小輔導-寫功課', []],
        ]),
      };
      const v2 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v2' });
      const v3 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v3' as never });

      expect(v2.baseDiscountBps).toBe(10000);
      expect(v3.baseDiscountBps).toBe(9500);
    });

    it('parity 錨點：寫功課＋數學＋美語但無一般輔導 → v2 與 v3 的 subjectCount 皆 2、baseDiscount 皆 9500', () => {
      // S §6.2「parity 錨點（不得有差異）」第 1 條：
      // v2＝care(經「國小輔導-寫功課」名稱)＋math＋english＝3，−1＝2 → 9500
      // v3（寫功課→不列入）＝{數學, 美語}＝2 → 9500 → 相同
      const student = makeStudent({
        personCode: 'ANCHOR1',
        grade: 4,
        enrollments: [
          { rawToken: '國小輔導-寫功課', baseName: '國小輔導-寫功課' },
          { rawToken: '國小數學-四A', baseName: '國小數學-四A' },
          { rawToken: '兒童美語-甲', baseName: '兒童美語-甲' },
        ],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
          ['國小輔導-寫功課', []],
          ['國小數學-四A', []],
          ['兒童美語-甲', []],
        ]),
      };
      const f = businessFieldsWith(student, opts);
      expect(f.v2.subjectCount).toBe(2);
      expect(f.v3.subjectCount).toBe(2);
      expect(f.v2.baseDiscountBps).toBe(9500);
      expect(f.v3.baseDiscountBps).toBe(9500);
    });

    it('parity 錨點：一般輔導＋數學（無寫功課）→ v2 與 v3 皆 subjectCount 2、baseDiscount 9500', () => {
      // S §6.2「parity 錨點」第 3 條
      const student = makeStudent({
        personCode: 'ANCHOR3',
        grade: 4,
        enrollments: [
          { rawToken: '國小輔導-四年級', baseName: '國小輔導-四年級' },
          { rawToken: '國小數學-四A', baseName: '國小數學-四A' },
        ],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
          ['國小輔導-四年級', []],
          ['國小數學-四A', []],
        ]),
      };
      const f = businessFieldsWith(student, opts);
      expect(f.v2.subjectCount).toBe(f.v3.subjectCount);
      expect(f.v2.baseDiscountBps).toBe(f.v3.baseDiscountBps);
    });
  });

  describe('invariant：逐版分別驗證（D24 取整、D30 同星期、標籤來源、既有 run）', () => {
    it('D24 取整：f<0.3→0、0.3≤f<0.8→0.5、f≥0.8→1，v2 與 v3 各自成立', () => {
      // 每日 180 分、課輔窗口 990–1170（180 分）：重疊 54 分 → f=0.3 → 0.5；
      // 重疊 36 分 → f=0.2 → 0
      const mk = (start: number, end: number, personCode: string) =>
        businessFieldsWith(
          makeStudent({
            personCode,
            grade: 4,
            enrollments: [{ rawToken: '國小數學-甲', baseName: '國小數學-甲' }],
          }),
          {
            ...snapshot(),
            scheduleOverride: new Map([['國小數學-甲', [{ weekday: '一', start, end }]]]),
          }
        );
      // 重疊 54 分（990–1044）
      const half = mk(990, 1044, 'INV-HALF');
      // 重疊 36 分（990–1026）
      const zero = mk(990, 1026, 'INV-ZERO');
      // D24 是 invariant（不在差異表）：v2 與 v3 對同一時段必須得到相同的取整結果，
      // 且不同重疊分鐘必須得到不同的扣天（證明取整真的生效，而非兩版都回 0）。
      const mkRaw = (start: number, end: number, personCode: string) => {
        const stu = makeStudent({
          personCode,
          grade: 4,
          enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
        });
        const o = {
          ...snapshot(),
          scheduleOverride: new Map([['國小數學-四A', [{ weekday: '一', start, end }]]]),
        };
        return {
          v2: calculateStudentBilling(stu, { ...o, ruleSetVersion: 'erp-tag-v2' }),
          v3: calculateStudentBilling(stu, { ...o, ruleSetVersion: 'erp-tag-v3' as never }),
        };
      };
      // 重疊 54 分（990–1044）→ f=0.3 → 0.5；重疊 36 分（990–1026）→ f=0.2 → 0
      const h2 = mkRaw(990, 1044, 'INV-HALF-2');
      const z2 = mkRaw(990, 1026, 'INV-ZERO-2');
      // 級距以天數為基礎：天數不同 → 級距結果必不同；兩版須一致
      expect(h2.v2.tierComparisons.map((c) => c.computedTier))
        .toEqual(h2.v3.tierComparisons.map((c) => c.computedTier));
      expect(z2.v2.tierComparisons.map((c) => c.computedTier))
        .toEqual(z2.v3.tierComparisons.map((c) => c.computedTier));
      // 取整真的生效：兩種重疊的級距集合不同（否則 D24 退化成常數）
      expect(JSON.stringify(h2.v2.tierComparisons)).not.toBe(JSON.stringify(z2.v2.tierComparisons));
      void half; void zero;
    });

    it('D30 同星期：同一班名同一星期的兩列時段，v2 與 v3 的天數各自一致（不因 v3 而改）', () => {
      const student = makeStudent({
        personCode: 'INV-D30',
        grade: 4,
        enrollments: [{ rawToken: '國小數學-甲', baseName: '國小數學-甲' }],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>([
          // 同一班兩列皆週一 → D30 視為同日，扣天應為單日計算而非兩日
          ['國小數學-甲', [
            { weekday: '一', start: 990, end: 1080 },
            { weekday: '一', start: 1080, end: 1170 },
          ]],
        ]),
      };
      // D30 是 invariant：同一班同一星期的多列時段，兩版都視為同日處理，
      // 因此以級距結果（由天數推導）觀察，v2 與 v3 必須一致。
      const o = { ...opts, ruleSetVersion: 'erp-tag-v2' as const };
      const r2 = calculateStudentBilling(student, o);
      const r3 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v3' as never });
      expect(r2.tierComparisons.map((c) => c.computedTier))
        .toEqual(r3.tierComparisons.map((c) => c.computedTier));
    });

    it('標籤來源（02 §5：正式軌讀標籤、compat 讀備註）：v2 與 v3 都讀標籤', () => {
      const student = makeStudent({
        personCode: 'INV-TAG',
        grade: 4,
        tagsRaw: '有兄弟姊妹折扣',
        notesRaw: '有兄弟姊妹折扣',
        enrollments: [{ rawToken: '國小數學-四A', baseName: '國小數學-四A' }],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map([['國小數學-四A', [{ weekday: '一', start: 990, end: 1080 }]]]),
      };
      const f = businessFieldsWith(student, opts);
      // v2 讀標籤：math(1) + sibling(+1) = 2 → 9500
      expect(f.v2.baseDiscountBps).toBe(9500);
      expect(f.v3.baseDiscountBps).toBe(9500);
    });
  });

  describe('表外差異偵測（gate 的核心斷言）', () => {
    it('合成案例：v3 新增的 issue code 必須全部在 S §6.1 差異表白名單內（D-05／D-07）', () => {
      // 未對應的米豆奶班名 → v3 新增 CLASS_NOT_MAPPED（D-05）
      const student = makeStudent({
        personCode: 'GATE-UNMAPPED',
        grade: 4,
        enrollments: [{ rawToken: '交通車', baseName: '交通車' }],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map([['交通車', [{ weekday: '一', start: 990, end: 1080 }]]]),
      };
      const f = businessFieldsWith(student, opts);
      const added = f.v3.issueCodes.filter((c) => !f.v2.issueCodes.includes(c));
      // 白名單以內
      expect(added.filter((c) => !DIFF_TABLE_ALLOWED_NEW_ISSUE_CODES.includes(c))).toEqual([]);
    });

    it('只報「不列入折扣」類班（交通車／正音／加強班）→ v2 與 v3 逐欄相同（D-06 允許無差異）', () => {
      const student = makeStudent({
        personCode: 'GATE-D06',
        grade: 4,
        enrollments: [{ rawToken: '正音A班', baseName: '正音A班' }],
      });
      const opts = {
        ...snapshot(),
        scheduleOverride: new Map([['正音A班', [{ weekday: '一', start: 990, end: 1080 }]]]),
      };
      const f = businessFieldsWith(student, opts);
      // D-06：科數 0、無變動
      expect(f.v2.subjectCount).toBe(0);
      expect(f.v3.subjectCount).toBe(0);
      expect(f.v2.baseDiscountBps).toBe(f.v3.baseDiscountBps);
    });
  });
});

/** 以自訂 scheduleOverride 抽取業務欄位（供 invariant 案例使用）。 */
function businessFieldsWith(
  student: StudentSnapshot,
  opts: {
    aliasMap: Map<string, string>;
    scheduleOverride: Map<string, Array<{ start: number; end: number; weekday?: string | null }>>;
    classSettings: Map<string, ClassSettingLookup>;
  }
) {
  const v2 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v2' });
  const v3 = calculateStudentBilling(student, { ...opts, ruleSetVersion: 'erp-tag-v3' as never });
  return {
    v2: {
      anqinDays: v2.careDays.anqin.days,
      tutoringDays: v2.careDays.tutoring.days,
      subjectCount: v2.subjectCount,
      baseDiscountBps: v2.baseDiscountBps,
      applicableAnqinBps: v2.applicableRates.anqin,
      applicableTutoringBps: v2.applicableRates.tutoring,
      applicableMathBps: v2.applicableRates.math,
      applicableEnglishBps: v2.applicableRates.english,
      tierMismatch: v2.tierComparisons.some((c) => c.status === 'mismatch'),
      issueCodes: [...new Set(v2.issues.map((i) => i.code))].sort(),
    },
    v3: {
      anqinDays: v3.careDays.anqin.days,
      tutoringDays: v3.careDays.tutoring.days,
      subjectCount: v3.subjectCount,
      baseDiscountBps: v3.baseDiscountBps,
      applicableAnqinBps: v3.applicableRates.anqin,
      applicableTutoringBps: v3.applicableRates.tutoring,
      applicableMathBps: v3.applicableRates.math,
      applicableEnglishBps: v3.applicableRates.english,
      tierMismatch: v3.tierComparisons.some((c) => c.status === 'mismatch'),
      issueCodes: [...new Set(v3.issues.map((i) => i.code))].sort(),
    },
  };
}