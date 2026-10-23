import { describe, it, expect } from 'vitest';
import { calculateStudentBilling } from '@/domain/billing/billing-calculator';
import { buildClassSettingMap } from '@/application/calculate-run';
import { manualCategories } from '../helpers/manual-categories';
import type { StudentSnapshot } from '@/domain/students/types';

/**
 * D2d H（04 §8 UX67／UX68／UX69）：補齊既有 unit 標記「待補（D2d）」的**鑑別斷言**。
 *
 * decision d-20261001050915775646-5【三】：狀態標記只在缺口確實閉合時才可修正。經查證：
 *  - `d2a-class-category-billing.test.ts:234`（UX68 平手）只斷言 `days === 4.5`，
 *    而甲、乙兩班該案例的時段完全相同（同為週一 990–1080），扣天必然相同 →
 *    **無法區分選中的是甲還是乙**，故該列缺口未閉合，必須補。
 *  - 同檔 `:278`（UX69 Q5-B）只涵蓋非空非法星期「八」，未涵蓋**空白**星期，
 *    也未涵蓋**全部候選皆不可計算**，故該列缺口未閉合，必須補。
 *
 * ── 本檔的 expected 一律獨立手算（不引用被測函式輸出）──────────────
 * 課輔窗口 990–1170（16:30–19:30）、星期限一~五（`CARE_WINDOW_WEEKDAYS`）；
 * D24：同班各堂先加總為 d = −raw ≥ 0，再依 f = d − ⌊d⌋ 取整（f<0.3→0、0.3≤f<0.8→0.5、f≥0.8→1.0）；
 * 課輔特例：重疊 ≥120 分且 1110 < end < 1170 → 該堂 −1，否則 −overlap/180。
 * 天數下限：課輔 max(3.0, 5 + 扣天)（`calculateCareDays`，R12），年級 4 ＝課輔側。
 *
 * ── RED／characterization 分界（如實標記，不混稱）────────────────
 *  · **RED（待 B GREEN）**：UX68 的 `selection` 輸出。現行 calculator 不輸出選中班，
 *    故斷言選中甲／乙必然失敗——這正是 B 的缺口，GREEN B 後轉綠。
 *  · **characterization（base 上本來就通過）**：UX67／UX69 的扣天、天數下限與
 *    tierComparisons needsReview 語意。這些是「已存在且正確的行為」，本批只固定下來，
 *    不冒充 RED。空課表候選的 SCHEDULE_EMPTY **issue** 斷言屬 D（04 §8 UX73），
 *    本檔刻意不重複，避免同一缺口有兩份 RED。
 */

type Override = Map<string, Array<{ weekday: string; start: number; end: number }>>;

function makeStudent(enrollments: string[], grade = 4): StudentSnapshot {
  return {
    personCode: 'S-D2D-H',
    name: '合成學生',
    branch: null,
    grade,
    gradeRaw: String(grade),
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    sourceRow: 1,
    enrollments: enrollments.map((b) => ({
      baseName: b,
      rawToken: b,
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

function run(enrollments: string[], override: Override) {
  return calculateStudentBilling(makeStudent(enrollments), {
    ruleSetVersion: 'erp-tag-v3',
    aliasMap: new Map(),
    // #157 Ruling 1：本檔驗的是「選班邊界」，候選班必須是使用者指定過的類別。
    // 舊制靠班名自動判定，現在由測試明確宣告（只宣告本檔用到的虛構班名）。
    classSettings: manualCategories({
      // 「不存在甲／乙」是**已收錄於課表設定、但課表查無時段**的班（schedule_not_found），
      // 因此必須出現在這裡；它們不是「班名未對應」（那是 CLASS_NOT_MAPPED，屬另一個案例）。
      math: [
        '國小數學-甲', '國小數學-乙', '國小數學-合法性', '國小數學-合法',
        '國小數學-空甲', '國小數學-空乙',
        '國小數學-空白', '國小數學-空白甲', '國小數學-空白乙',
        '國小數學-不存在甲', '國小數學-不存在乙',
      ],
      english: ['兒童美語-甲', '兒童美語-乙'],
    }),
    scheduleOverride: override,
  });
}

/** calculator 預期契約（S §7.5 第 6 點）：輸出選中班供下游共用（B 的 GREEN 產物）。 */
function selectionOf(result: unknown): Record<string, { selectedBaseName?: string }> {
  return (result as { selection?: Record<string, { selectedBaseName?: string }> }).selection ?? {};
}

describe('D2d H: UX67／UX68／UX69 選班邊界的鑑別斷言', () => {
  describe('UX67: 兩班扣天皆為 0 或負 → 取正量最多，不得任選一班當作「有扣天」', () => {
    it('兩班扣天皆 0（週六不在課輔窗口星期內 → 重疊 0）：天數維持 5 天，不得宣稱有扣天', () => {
      // 手算：週六（'六'）不在 CARE_WINDOW_WEEKDAYS（一~五）→ calculateOverlapMinutes 因
      // 同星期檢查回 0 → 每堂 raw 0 → d = 0 → f = 0 < 0.3 → rounded 0。
      // 甲、乙 正量皆 0 → 課輔天數 max(3.0, 5 + 0) = 5（不是 4.x，沒有任何扣天）。
      const override: Override = new Map([
        ['國小數學-甲', [{ weekday: '六', start: 990, end: 1080 }]],
        ['國小數學-乙', [{ weekday: '六', start: 990, end: 1080 }, { weekday: '六', start: 990, end: 1080 }]],
      ]);
      const res = run(['國小數學-甲', '國小數學-乙'], override);

      expect(res.careDays.tutoring.days).toBe(5);
      // 負向保證：不得因「兩班都可計算」就記錄任何扣天量
      expect(res.careDays.tutoring.days).toBeGreaterThan(4.5);
    });

    it('全缺（兩班都不在課表 → schedule_not_found）：沿用 0 扣天 fallback，天數 5、需確認', () => {
      // 傳了 scheduleOverride ⇒ classMapFor 改用 NO_SEED_CLASSES，不在 override 的班一律
      // schedule_not_found（billing-calculator.ts:48-50、:79-82）。
      // 手算：calculables 為空 → 取 evals[0]、扣天 0 → max(3.0, 5) = 5。
      const res = run(['國小數學-不存在甲', '國小數學-不存在乙'], new Map());

      expect(res.careDays.tutoring.days).toBe(5);
      const codes = res.issues.map((i) => i.code);
      expect(codes).toContain('SCHEDULE_NOT_FOUND');
      expect(res.tierComparisons.some((c) => c.needsReview)).toBe(true);
    });

    it('全空（兩班都已對應但時段為空 → schedule_empty）：扣天 0、天數 5、需確認（SCHEDULE_EMPTY issue 屬 UX73／D）', () => {
      // 手算：兩候選 status 都是 schedule_empty（override 存在但 sessions 長度 0，
      // billing-calculator.ts:73-75）→ calculables 為空 → 取 evals[0]、扣天 0 → 天數 5。
      const override: Override = new Map([
        ['國小數學-空甲', []],
        ['國小數學-空乙', []],
      ]);
      const res = run(['國小數學-空甲', '國小數學-空乙'], override);

      expect(res.careDays.tutoring.days).toBe(5);
      // tierComparisons 已反映 schedule_empty → 需確認（D2d D 的 RED 針對的是
      // additionalIssues 缺 SCHEDULE_EMPTY，這裡固定的是比較層已正確）
      expect(res.tierComparisons.some((c) => c.needsReview)).toBe(true);
    });
  });

  describe('UX68: 平手取報名順序在前者，且必須能區分選中甲或乙', () => {
    it('扣天相同（甲乙皆 −0.5）時必須斷言選中的是 token_index 較小的甲', () => {
      // 手算（兩班時段刻意相同，扣天必然相同 → 唯一能區分選中者的就是報名順序）：
      //   週一 990–1080，課輔窗口 990–1170 → overlap 90 分；
      //   課輔特例需 overlap ≥120，此處 90 < 120 不成立 → raw = −90/180 = −0.5；
      //   d = 0.5、f = 0.5 ∈ [0.3,0.8) → rounded −0.5。
      //   甲、乙 正量皆 0.5 → 平手 → 取報名順序在前者（token_index 0 的甲）。
      const override: Override = new Map([
        ['兒童美語-甲', [{ weekday: '一', start: 990, end: 1080 }]],
        ['兒童美語-乙', [{ weekday: '一', start: 990, end: 1080 }]],
      ]);
      const res = run(['兒童美語-甲', '兒童美語-乙'], override);

      expect(res.careDays.tutoring.days).toBe(4.5);
      // 鑑別斷言（RED，待 B GREEN）：只靠 days 無法分辨選中者，必須讀 selection。
      expect(selectionOf(res).english?.selectedBaseName).toBe('兒童美語-甲');
    });

    it('調換報名順序後選中者必須跟著換成乙（否則上一條可能只是碰巧）', () => {
      const override: Override = new Map([
        ['兒童美語-甲', [{ weekday: '一', start: 990, end: 1080 }]],
        ['兒童美語-乙', [{ weekday: '一', start: 990, end: 1080 }]],
      ]);
      const res = run(['兒童美語-乙', '兒童美語-甲'], override);

      expect(res.careDays.tutoring.days).toBe(4.5);
      expect(selectionOf(res).english?.selectedBaseName).toBe('兒童美語-乙');
    });
  });

  describe('UX69: 未知星期候選（空白星期、全部候選不可計算）', () => {
    it('空白星期候選以 fail-closed 0 參與比較，並保留 UNKNOWN_WEEKDAY 需確認警告', () => {
      // 手算：weekday 為空字串 → normalizeWeekday 回 null → isUnknownWeekday 為真
      // （overlap-calculator.ts:44-55、:85-87）→ 同星期檢查使重疊為 0 → 該候選扣天 0。
      // 甲（空白星期，1 堂）與乙（週一 990–1080，扣 0.5）：乙 正量 0.5 > 甲 0 → 選乙。
      // 天數 max(3.0, 5 − 0.5) = 4.5；甲的未知列內部為 0、合法列照算。
      const override: Override = new Map([
        ['國小數學-空白', [{ weekday: '', start: 990, end: 1170 }]],
        ['國小數學-合法', [{ weekday: '一', start: 990, end: 1080 }]],
      ]);
      const res = run(['國小數學-空白', '國小數學-合法'], override);

      expect(res.careDays.tutoring.days).toBe(4.5);
      const codes = res.issues.map((i) => i.code);
      expect(codes).toContain('UNKNOWN_WEEKDAY');
      expect(res.tierComparisons.some((c) => c.needsReview)).toBe(true);
    });

    it('全部候選都只有空白星期 → 全部扣天 0、天數維持 5，不冒充「已驗證無衝堂」', () => {
      // 手算：兩候選皆只有空白星期列 → 皆重疊 0 → 正量皆 0 → 天數 max(3.0, 5) = 5；
      // 但因兩列皆未知，UNKNOWN_WEEKDAY 警告必須仍在（不得因天數等於無扣天就靜默）。
      const override: Override = new Map([
        ['國小數學-空白甲', [{ weekday: '', start: 990, end: 1170 }]],
        ['國小數學-空白乙', [{ weekday: '   ', start: 990, end: 1170 }]],
      ]);
      const res = run(['國小數學-空白甲', '國小數學-空白乙'], override);

      expect(res.careDays.tutoring.days).toBe(5);
      expect(res.issues.map((i) => i.code)).toContain('UNKNOWN_WEEKDAY');
    });

    it('全部候選皆不可計算（兩個班都不在課表）→ 天數 5 且不得有未知星期警告', () => {
      // 手算：兩候選 status 都是 schedule_not_found → 不經過 deductSessions →
      // unknownWeekdayCount 維持 0 → 不應出現 UNKNOWN_WEEKDAY（避免把「查無課表」
      // 誤報成「星期無法識別」），而以 SCHEDULE_NOT_FOUND 表達。
      const res = run(['國小數學-不存在甲', '國小數學-不存在乙'], new Map());

      expect(res.careDays.tutoring.days).toBe(5);
      const codes = res.issues.map((i) => i.code);
      expect(codes).toContain('SCHEDULE_NOT_FOUND');
      expect(codes).not.toContain('UNKNOWN_WEEKDAY');
    });
  });
});