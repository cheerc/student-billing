import { describe, it, expect } from 'vitest';
import { computeRosterChanges, type RosterChange } from '@/application/roster-changes';
import { buildSeedDraft, draftToAliasMap, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { buildClassSettingMap } from '@/application/calculate-run';
import type { ClassSettingLookup } from '@/domain/classification/class-category';
import { StudentSnapshot } from '@/domain/students';

/**
 * Round3 PR-1（-166）：異動明細的**逐班折扣變動＋結構化原因**資料層。
 *
 * 權威：operator decisions d-20261002162050527935-68（-68）、d-20261002173610753099-75（-75）、
 * d-20261002181024635288-76（-76，文案定稿；本 PR 只產資料不產文案）；specs/06 D43（PR63 已 merge）；
 * 分析報告 roster-changes-per-class-spike.md §A2／A3／A5／B1／B3／B4。
 * §A6（整體折扣兜底列）、§A7（零報名衝突）、§C1／C2 已被 -75 否決：**不加兜底、不顯示未報名課程的內部適用率**。
 *
 * 本檔只驗資料層，畫面與文案由 PR-2 處理。
 *
 * expected 全部獨立手算（不引用待測函式輸出）：
 *   - 基本折扣 R10：effectiveCount = subjectCount + sibling；>2 → 9000、=2 → 9500、其餘 10000；無報名（null）→ 10000（-66）
 *   - 適用率 R13：安親 園內生 max(9000, basic − 500)，否則 basic；R14 課輔 = basic；R15 數學／美語 = basic；
 *     not_configured 的班無適用率
 *   - 逐班取值：只有「該生實際報名此班」的一側才算值；未報名一側不取值（-75：不得顯示假異動）
 */

const contexts = (classSettings?: Map<string, ClassSettingLookup>) => {
  const draft = buildSeedDraft();
  const ctx = {
    aliasMap: draftToAliasMap(draft),
    scheduleOverride: draftToScheduleOverride(draft),
    ...(classSettings ? { classSettings } : {}),
  };
  return { beforeCtx: ctx, afterCtx: ctx };
};

function student(
  personCode: string,
  baseNames: string[],
  opts: { grade?: number | null; tagsRaw?: string } = {}
): StudentSnapshot {
  const grade = opts.grade ?? null;
  const tagsRaw = opts.tagsRaw ?? '';
  return {
    personCode,
    name: `學生${personCode}`,
    branch: '合成測試分校',
    gradeRaw: grade !== null ? `${grade}年級` : '',
    grade,
    gradeStatus: grade !== null ? 'valid' : 'not_applicable',
    contact: null,
    schoolInfo: null,
    tagsRaw,
    tags: tagsRaw ? tagsRaw.split(/[,;\s]+/).filter(Boolean) : [],
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
      tierParseStatus: 'not_applicable' as const,
      parseStatus: 'ok' as const,
    })),
    sourceRow: 1,
  };
}

/**
 * PR-1 新增的欄位（enrollmentChanges／classDiscountChanges）在本 RED commit 尚未存在於
 * `RosterChange`。以本地結構型別描述期望形狀並在取用時轉接，讓測試在 base 上以
 * **執行期斷言失敗**（而非編譯錯誤）作為 RED 證據；GREEN 後 `RosterChange` 正式帶這些欄位。
 */
type EnrollmentPresence = 'added' | 'removed' | 'kept' | 'switched';
interface EnrollmentChange {
  baseName: string;
  rawToken: string;
  presence: EnrollmentPresence;
}
type ClassDiscountReason =
  | { kind: 'enrollment_added' | 'enrollment_removed'; className: string }
  | { kind: 'tag_added' | 'tag_removed'; tag: string };
interface ClassDiscountChange {
  baseName: string;
  sideOf: 'care' | 'math' | 'english';
  beforeBps: number | null;
  afterBps: number | null;
  reasons: ClassDiscountReason[];
}
type ClassStructureChange = RosterChange & {
  enrollmentChanges: EnrollmentChange[];
  classDiscountChanges: ClassDiscountChange[];
};
const only = (result: { changes: RosterChange[] }): ClassStructureChange[] =>
  result.changes as ClassStructureChange[];

describe('PR-1 §1 報名班級集合（enrollmentChanges）與異動判定', () => {
  it('列出 before/after 全部報名班（以 rawToken 比對）與 presence，班名用名冊原文 baseName', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('P1', ['國小數學-三A', '兒童美語-EA']);
    const after = student('P1', ['國小數學-三A', '兒童美語-EB']);

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.enrollmentChanges.map((e) => [e.baseName, e.presence])).toEqual([
      ['國小數學-三A', 'kept'],
      ['兒童美語-EA', 'switched'],
      ['兒童美語-EB', 'switched'],
    ]);
    // switched 兩端互指同一組 rawToken
    expect(change.enrollmentChanges[1].switchedWith).toBe(change.enrollmentChanges[2].rawToken);
    expect(change.enrollmentChanges[2].switchedWith).toBe(change.enrollmentChanges[1].rawToken);
  });

  it('含 care 班與未設定折扣類別的班（寫功課）——不因「不計折扣」而從集合消失', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('P2', ['國小數學-三A']);
    const after = student('P2', ['國小數學-三A', '國小輔導-一A', '國小輔導-寫功課']);

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.enrollmentChanges.map((e) => [e.baseName, e.presence])).toEqual([
      ['國小數學-三A', 'kept'],
      ['國小輔導-一A', 'added'],
      ['國小輔導-寫功課', 'added'],
    ]);
  });

  it('同類換班：同類別一對一可靠配對 → switched（含 switchedWith）', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('P3', ['國小數學-三A']);
    const after = student('P3', ['國小數學-三B']);

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.enrollmentChanges.map((e) => [e.baseName, e.presence, e.switchedWith])).toEqual([
      ['國小數學-三A', 'switched', '國小數學-三B[團]'],
      ['國小數學-三B', 'switched', '國小數學-三A[團]'],
    ]);
  });

  it('無法可靠配對（同類別但不是一對一）→ 由 added ＋ removed 表達，不猜', () => {
    const { beforeCtx, afterCtx } = contexts();
    // before 一個數學班 → after 兩個數學班：removed 1、added 2，不是 1:1 → 不配對
    const before = student('P3b', ['國小數學-三A']);
    const after = student('P3b', ['國小數學-三A', '國小數學-三B']);

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.enrollmentChanges.map((e) => e.presence)).toEqual(['kept', 'added']);
    expect(change.enrollmentChanges.some((e) => e.presence === 'switched')).toBe(false);
  });

  /**
   * RC04（spike §B1）：before 只有寫功課 → after 加報數學。
   * v3 下科數 0 → 1，但基本折扣都是 10000、天數也沒變 → 現行判定為「未異動」。
   * 報名集合確實變了（-75／-68：新增／退出／換班即使折扣未變也要出現）→ 必須出現在 changes。
   */
  it('RC04：只有寫功課 → 加報數學，即使折扣與天數皆未變也出現在 changes', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('P4', ['國小輔導-寫功課'], { grade: 3 });
    const after = student('P4', ['國小輔導-寫功課', '國小數學-三A'], { grade: 3 });

    const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);

    expect(result.changes).toHaveLength(1);
    expect(result.stats.changedCount).toBe(1);
    expect((result.changes[0] as ClassStructureChange).enrollmentChanges.map((e) => [e.baseName, e.presence])).toEqual([
      ['國小輔導-寫功課', 'kept'],
      ['國小數學-三A', 'added'],
    ]);
  });

  it('報名集合未變且無其他變動 → 仍是未異動（unchangedCount）', () => {
    const { beforeCtx, afterCtx } = contexts();
    const s = student('P5', ['國小數學-三A'], { grade: 3 });

    const result = computeRosterChanges([s], [s], beforeCtx, afterCtx);

    expect(result.changes).toHaveLength(0);
    expect(result.stats.unchangedCount).toBe(1);
  });

  it('新增學生／本次未出現：報名集合仍列出該側全部班', () => {
    const { beforeCtx, afterCtx } = contexts();
    const existing = student('P6', ['國小數學-三A'], { grade: 3 });

    const added = only(computeRosterChanges([], [existing], beforeCtx, afterCtx))[0];
    expect(added.isNew).toBe(true);
    expect(added.before).toBeNull();
    expect(added.enrollmentChanges.map((e) => [e.baseName, e.presence])).toEqual([['國小數學-三A', 'added']]);

    const removed = only(computeRosterChanges([existing], [], beforeCtx, afterCtx))[0];
    expect(removed.isRemoved).toBe(true);
    expect(removed.after).toBeNull();
    expect(removed.enrollmentChanges.map((e) => [e.baseName, e.presence])).toEqual([['國小數學-三A', 'removed']]);
  });
});

describe('PR-1 §4 逐班前後折扣（classDiscountChanges）', () => {
  /**
   * 三年級學生（課輔側）：basic 10000 → 加報一科後 effectiveCount=2 → basic 9500 → 課輔適用率 9500。
   * before：國小數學-三A（math）＋ 兒童美語-EA（english）→ 科數 2 → basic 9500（math／english 適用率 = basic）。
   * after：另加國小輔導-一A（care）→ 科數 3 → basic 9000。
   * → math 與 english 兩班各自「9500 → 9000」；care 班是 after 才報名（before 無值），
   *   依 -75「未報名一側不產生『無折扣 → X』假異動」不列。
   */
  it('care／math／english 逐班各一項；只列實際值有變的班；未報名一側不產假異動', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('D1', ['國小數學-三A', '兒童美語-EA'], { grade: 3 });
    const after = student('D1', ['國小數學-三A', '兒童美語-EA', '國小輔導-一A'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges.map((c) => [c.baseName, c.sideOf, c.beforeBps, c.afterBps])).toEqual([
      ['國小數學-三A', 'math', 9500, 9000],
      ['兒童美語-EA', 'english', 9500, 9000],
    ]);
  });

  it('not_configured 的班不產生折扣變動項（交通車、無折扣類別班）', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('D2', ['國小數學-三A'], { grade: 3 });
    const after = student('D2', ['國小數學-三A', '交通車'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges.some((c) => c.baseName === '交通車')).toBe(false);
  });

  /**
   * 同類多班：科數只算「類別存在性」（R09），所以再加一個數學班**不會**改科數 → 沒有折扣變動。
   * 這是照實呈現（D17）：沒有變動就沒有變動項，不是漏列。
   */
  it('同類多班（再加一個數學班）→ 科數不變，無折扣變動項（不是漏列）', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('D3', ['國小數學-三A', '兒童美語-EA'], { grade: 3 });
    const after = student('D3', ['國小數學-三A', '國小數學-三B', '兒童美語-EA'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges).toEqual([]);
    expect(change.enrollmentChanges.map((e) => [e.baseName, e.presence])).toEqual([
      ['國小數學-三A', 'kept'],
      ['兒童美語-EA', 'kept'],
      ['國小數學-三B', 'added'],
    ]);
  });

  it('同類多班各自一項、不合併：兩人各報的班都要能看到自己的折扣', () => {
    const { beforeCtx, afterCtx } = contexts();
    // before 兩個數學班（科數 1 → basic 10000）＋ after 再加一個英文班（科數 2 → 9500）
    const before = student('D3b', ['國小數學-三A', '國小數學-三B'], { grade: 3 });
    const after = student('D3b', ['國小數學-三A', '國小數學-三B', '兒童美語-EA'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges.map((c) => [c.baseName, c.sideOf, c.beforeBps, c.afterBps])).toEqual([
      ['國小數學-三A', 'math', 10000, 9500],
      ['國小數學-三B', 'math', 10000, 9500],
    ]);
  });

  it('適用率未變的班不列（只收實際值有變的班）', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('D4', ['國小數學-三A'], { grade: 3 });
    // 加報寫功課：科數 1 → 1（寫功課不列入折扣），basic 不變；安親適用率才可能受影響，數學班不變
    const after = student('D4', ['國小數學-三A', '國小輔導-寫功課'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges).toEqual([]);
  });

  it('園內生只改安親適用率：無 care 班時不產生任何班級折扣變動項（spike §B5）', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('D5', ['國小數學-三A'], { grade: 3 });
    const after = student('D5', ['國小數學-三A'], { grade: 3, tagsRaw: '園內生' });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges).toEqual([]);
  });
});

describe('PR-1 §5 結構化原因（reasons：型別化資料，非文案）', () => {
  it('加報有折扣類別的班 → enrollment_added', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('R1', ['國小數學-三A'], { grade: 3 });
    const after = student('R1', ['國小數學-三A', '兒童美語-EA'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    for (const item of change.classDiscountChanges) {
      expect(item.reasons).toEqual([{ kind: 'enrollment_added', className: '兒童美語-EA' }]);
    }
  });

  it('退出有折扣類別的班 → enrollment_removed', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('R2', ['國小數學-三A', '兒童美語-EA'], { grade: 3 });
    const after = student('R2', ['國小數學-三A'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    for (const item of change.classDiscountChanges) {
      expect(item.reasons).toEqual([{ kind: 'enrollment_removed', className: '兒童美語-EA' }]);
    }
  });

  /**
   * Lead r1 裁定（rework：報名原因只列「真的會影響該班適用率輸入」者）：
   * 寫功課讓 `hasHomeworkOrMeian` 改變 → **只影響 care（安親／課輔）**。
   *
   * 手算（before 三年級：輔導＋數學 → 科數 2 → basic 9500；after 輔導＋寫功課 → 科數 1 → basic 10000；
   *       寫功課 → hasHomeworkOrMeian=true → 課輔適用率固定 10000）：
   *   - 輔導班（care，kept）：9500 → 10000 ✔ 會變動；原因＝退數學（enrollment_removed）＋加寫功課（enrollment_added）
   *   - 數學班：before only，不列
   * → 若實作無過濾，輔導班的 reasons 會同時出現寫功課與數學退班；本案例要求兩者都在（寫功課**確實**影響 care），
   *   另一案例（無維護交通車）才驗證 none 類別班不得出現。
   */
  it('寫功課是 care 班的原因（影響 hasHomeworkOrMeian），但只掛在 care 班上', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('R3', ['國小輔導-一A', '國小數學-一A'], { grade: 3 });
    const after = student('R3', ['國小輔導-一A', '國小輔導-寫功課'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges.map((c) => [c.baseName, c.sideOf, c.beforeBps, c.afterBps])).toEqual([
      ['國小輔導-一A', 'care', 9500, 10000],
    ]);
    // 兩個原因都在（退掉數學 ＋ 加寫功課）；順序＝先 added 再 removed
    expect(change.classDiscountChanges[0].reasons).toEqual([
      { kind: 'enrollment_added', className: '國小輔導-寫功課' },
      { kind: 'enrollment_removed', className: '國小數學-一A' },
    ]);
  });

  /**
   * 同一個學生若同時有數學／美語班的變動，寫功課**不得**出現在那些班的原因
   * （hasHomeworkOrMeian 在 math／english 分支不被消費，discount-rules calculateApplicableRate）。
   */
  it('寫功課不得掛到數學／美語班（同一生同時有兩類班變動）', () => {
    const { beforeCtx, afterCtx } = contexts();
    // before：數學＋英文（科數 2 → 9500）；after：數學＋英文＋寫功課（科數 2 → 9500，數值不變）→ 無變動項
    // 改用會變動的組合：before 數學＋英文 → after 數學＋英文＋第三類輔導（科數 3 → 9000）
    // 再疊加寫功課：hasHomeworkOrMeian=true → 輔導班課輔 10000；math／english 仍 9000
    const b = student('R3b', ['國小數學-一A', '兒童美語-EA'], { grade: 3 });
    const a = student('R3b', ['國小數學-一A', '兒童美語-EA', '國小輔導-一A', '國小輔導-寫功課'], { grade: 3 });

    const change = only(computeRosterChanges([b], [a], beforeCtx, afterCtx))[0];

    for (const item of change.classDiscountChanges) {
      expect(
        item.reasons,
        `${item.baseName}（${item.sideOf}）不得出現寫功課`
      ).not.toContainEqual({ kind: 'enrollment_added', className: '國小輔導-寫功課' });
    }
  });

  /** 其他 none 類別班（交通車）永不列為原因（Lead r1 裁定：none 類別班永不列）。 */
  it('其他 none 類別班（交通車）永不列為原因', () => {
    const { beforeCtx, afterCtx } = contexts();
    // before：輔導＋數學（科數 2 → 9500）；after：輔導＋數學＋交通車 → 科數仍 2 → 無變動
    // 改用會變動者：before 輔導（科數 1 → 10000）＋數學 → after 加交通車並退數學 → 科數 1 → 10000（無變）
    // 最簡可區分：退掉數學 + 加交通車，同時讓輔導班有真實變動
    const b = student('R3c', ['國小輔導-一A', '國小數學-一A'], { grade: 3 });
    const a = student('R3c', ['國小輔導-一A', '交通車'], { grade: 3 });

    const change = only(computeRosterChanges([b], [a], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges.map((c) => c.baseName)).toEqual(['國小輔導-一A']);
    expect(change.classDiscountChanges[0].reasons).toEqual([
      { kind: 'enrollment_removed', className: '國小數學-一A' },
    ]);
    expect(change.enrollmentChanges.map((e) => [e.baseName, e.presence])).toEqual([
      ['國小輔導-一A', 'kept'],
      ['國小數學-一A', 'removed'],
      ['交通車', 'added'],
    ]);
  });

  /**
   * primary B-1：數學班因兄弟姊妹折扣移除而變動、**同時**移除園內生 → reasons 只有兄弟姊妹。
   * 手算：科數 1（math）＋兄弟姊妹 → effective 2 → 9500；移除 → 10000。math 適用率 = basic。
   */
  it('數學班因兄弟姊妹變動、且同時移除園內生 → reasons 只有兄弟姊妹，不含園內生', () => {
    const { beforeCtx, afterCtx } = contexts();
    const b = student('R3d', ['國小數學-三A'], { grade: 3, tagsRaw: '園內生 有兄弟姊妹折扣' });
    const a = student('R3d', ['國小數學-三A'], { grade: 3 });

    const change = only(computeRosterChanges([b], [a], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges).toHaveLength(1);
    expect(change.classDiscountChanges[0].sideOf).toBe('math');
    expect(change.classDiscountChanges[0].beforeBps).toBe(9500);
    expect(change.classDiscountChanges[0].afterBps).toBe(10000);
    expect(change.classDiscountChanges[0].reasons).toEqual([
      { kind: 'tag_removed', tag: '有兄弟姊妹折扣' },
    ]);
  });

  /** 美語班同型（primary B-1 的 english 對照）。 */
  it('美語班因兄弟姊妹變動、且同時移除園內生 → reasons 只有兄弟姊妹，不含園內生', () => {
    const { beforeCtx, afterCtx } = contexts();
    const b = student('R3e', ['兒童美語-EA'], { grade: 3, tagsRaw: '園內生 有兄弟姊妹折扣' });
    const a = student('R3e', ['兒童美語-EA'], { grade: 3 });

    const change = only(computeRosterChanges([b], [a], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges).toHaveLength(1);
    expect(change.classDiscountChanges[0].sideOf).toBe('english');
    expect(change.classDiscountChanges[0].reasons).toEqual([{ kind: 'tag_removed', tag: '有兄弟姊妹折扣' }]);
  });

  /**
   * 同類換班不改變「計入科數的類別集合」→ 不是原因（Lead r1 裁定：只有改變類別集合才算）。
   * before：數學三A（科數 1 → 10000）；after：數學三A 換成數學三B（科數仍 1 → 10000）。
   * 同時加兄弟姊妹 → effective 2 → 9500，數學班變動；原因只有兄弟姊妹，換班不得出現。
   */
  it('同類換班不改變類別集合 → 不作為原因（即使同時間有真實原因）', () => {
    const { beforeCtx, afterCtx } = contexts();
    // 同類換班：math → math、english → english，兩側類別集合相同（Lead r1 裁定：不算原因）
    // switched 只在「恰好一進一出且同類別」時給出；此例兩班同時換，故為 added ＋ removed。
    const b = student('R3f', ['國小數學-三A', '兒童美語-EA'], { grade: 3 });
    const a = student('R3f', ['國小數學-三B', '兒童美語-EB'], { grade: 3 });

    const change = only(computeRosterChanges([b], [a], beforeCtx, afterCtx))[0];

    expect(change.enrollmentChanges.map((e) => e.presence)).toEqual(['removed', 'removed', 'added', 'added']);
    // 報名集合有變 → 出現在 changes（-75）；且兩側類別集合相同 → 無班級折扣變動
    expect(change.classDiscountChanges).toEqual([]);
  });

  /** 同類換班 + 真實原因同時發生：換班的兩個班名不得作為原因。 */
  it('同類換班＋真實原因（加報英文班）→ 換班班名不作為原因，只有真實原因', () => {
    const { beforeCtx, afterCtx } = contexts();
    // 手算（R09 名稱式科數 ＋ R10）：
    //   before：輔導 ＋數學三A（k=2 → 9500）
    //   after ：輔導 ＋數學三B ＋英文 EB ＋兄弟姊妹（k=3、effective 4 → 9000）
    //   換班（數學三A → 三B）：拿掉任一個，另一個仍在 → 都不決定計入 → 不是原因
    //   加報英文 EB：english 類別首次出現 → 決定計入 → 是原因
    const b = student('R3f2', ['國小輔導-一A', '國小數學-三A'], { grade: 3 });
    const a = student('R3f2', ['國小輔導-一A', '國小數學-三B', '兒童美語-EB'], { grade: 3 });

    const change = only(computeRosterChanges([b], [a], beforeCtx, afterCtx))[0];

    expect(change.enrollmentChanges.filter((e) => e.presence !== 'kept').map((e) => e.baseName)).toEqual([
      '國小數學-三A',
      '國小數學-三B',
      '兒童美語-EB',
    ]);
    expect(change.classDiscountChanges.length).toBeGreaterThan(0);
    for (const item of change.classDiscountChanges) {
      const names = item.reasons.flatMap((r) => ('className' in r ? [r.className] : []));
      // 換班的兩個班名都不是原因（Lead r1 裁定：計入是存在性，兩側都有 math → 都不決定計入）
      expect(names, `${item.baseName} 的換班不得作為原因`).not.toContain('國小數學-三A');
      expect(names).not.toContain('國小數學-三B');
      // 真正原因只有「加報英文班」（english 類別首次出現）
      expect(item.reasons).toEqual([{ kind: 'enrollment_added', className: '兒童美語-EB' }]);
    }
  });

  /** 加報第二個數學班：類別集合不變（math 已在）→ 加報該班不是原因。 */
  it('加報同類別第二個數學班：類別集合未變 → 不列為原因', () => {
    const { beforeCtx, afterCtx } = contexts();
    // before：輔導（科數 1 → 10000）；after：輔導＋數學三A＋數學三B（科數 2 → 9500）
    const b = student('R3g', ['國小輔導-一A'], { grade: 3 });
    const a = student('R3g', ['國小輔導-一A', '國小數學-三A', '國小數學-三B'], { grade: 3 });

    const change = only(computeRosterChanges([b], [a], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges).toHaveLength(1);
    expect(change.classDiscountChanges[0].baseName).toBe('國小輔導-一A');
    // 手算（R09 名稱式，探針實測）：兩個數學班拿掉任一個，k 都是 2（另一個仍在）→ **兩個都不決定計入**
    // → 沒有任何報名原因是真因，reasons 為空陣列（Lead r1 裁定：只有改變計入科數者才算；
    //   PR-2 會顯示「名單資料變動」）。這不是缺陷：報名確實變了，只是無法歸因到某一門課。
    expect(change.classDiscountChanges[0].reasons).toEqual([]);
    expect(change.enrollmentChanges.map((e) => [e.baseName, e.presence])).toEqual([
      ['國小輔導-一A', 'kept'],
      ['國小數學-三A', 'added'],
      ['國小數學-三B', 'added'],
    ]);
  });

  it('加報兄弟姊妹折扣標籤 → tag_added（tag 為原字串）', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('R4', ['國小數學-三A'], { grade: 3 });
    // 加報寫功課不動科數；兄弟姊妹 +1 → effectiveCount 2 → basic 9500 → math 班 10000 → 9500
    const after = student('R4', ['國小數學-三A'], { grade: 3, tagsRaw: '有兄弟姊妹折扣' });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges).toHaveLength(1);
    expect(change.classDiscountChanges[0].baseName).toBe('國小數學-三A');
    expect(change.classDiscountChanges[0].reasons).toEqual([{ kind: 'tag_added', tag: '有兄弟姊妹折扣' }]);
  });

  it('移除兄弟姊妹折扣標籤 → tag_removed', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('R5', ['國小數學-三A'], { grade: 3, tagsRaw: '有兄弟姊妹折扣' });
    const after = student('R5', ['國小數學-三A'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges[0].reasons).toEqual([{ kind: 'tag_removed', tag: '有兄弟姊妹折扣' }]);
  });

  it('加報特殊折扣標籤 → tag_added（特殊折扣直接覆蓋合計折扣）', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('R6', ['國小數學-三A'], { grade: 3 });
    const after = student('R6', ['國小數學-三A'], { grade: 3, tagsRaw: '特殊折扣85折' });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges[0].reasons).toEqual([{ kind: 'tag_added', tag: '特殊折扣85折' }]);
  });

  it('園內生只掛在安親／課輔類的班，不掛數學班', () => {
    const { beforeCtx, afterCtx } = contexts();
    // 一年級（安親側）：加報國小輔導-一B → 科數 1 → 2 → basic 9500；
    // 同時加園內生 → 安親適用率 max(9000, 9500−500) = 9000；數學班適用率 = basic 9500（不受園內生影響）
    const before = student('R7', ['國小數學-一A', '國小輔導-一A'], { grade: 1 });
    const after = student('R7', ['國小數學-一A', '國小輔導-一B'], { grade: 1, tagsRaw: '園內生' });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    const careItem = change.classDiscountChanges.find((c) => c.baseName === '國小輔導-一B');
    expect(careItem, '同類換班：新報的班是 added，before 無值 → 不列').toBeUndefined();

    const mathItem = change.classDiscountChanges.find((c) => c.baseName === '國小數學-一A');
    expect(mathItem, 'care 未報名（換班退出）不影響 math 的 basic → math 不變').toBeUndefined();
  });

  it('園內生加在同一個 care 班上 → 只有該 care 班掛園內生原因，且 math 班不掛', () => {
    const { beforeCtx, afterCtx } = contexts();
    // before：數學一班 ＋ 輔導一班（科數 2 → basic 9500，安親 9500）
    // after：同樣兩班 ＋ 園內生 → 安親適用率 max(9000, 9500−500) = 9000；math 仍 9500
    const before = student('R8', ['國小數學-一A', '國小輔導-一A'], { grade: 1 });
    const after = student('R8', ['國小數學-一A', '國小輔導-一A'], { grade: 1, tagsRaw: '園內生' });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges.map((c) => [c.baseName, c.sideOf, c.beforeBps, c.afterBps])).toEqual([
      ['國小輔導-一A', 'care', 9500, 9000],
    ]);
    expect(change.classDiscountChanges[0].reasons).toEqual([{ kind: 'tag_added', tag: '園內生' }]);
  });

  it('兩側都有同一標籤 → 不算原因（值未因它改變）', () => {
    const { beforeCtx, afterCtx } = contexts();
    // before：數學班（科數 1 → basic 10000）＋ 園內生 ＋ 有兄弟姊妹折扣（effectiveCount 2 → 9500）
    // after：加報英文班 → 科數 2 ＋ 兄弟姊妹（effectiveCount 3 → 9000）
    // 兩側都有「園內生」「有兄弟姊妹折扣」，所以不是原因；值變了是因為加報了英文班。
    const before = student('R9', ['國小數學-三A'], { grade: 3, tagsRaw: '園內生 有兄弟姊妹折扣' });
    const after = student('R9', ['國小數學-三A', '兒童美語-EA'], { grade: 3, tagsRaw: '園內生 有兄弟姊妹折扣' });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    expect(change.classDiscountChanges).toHaveLength(1);
    expect(change.classDiscountChanges[0].baseName).toBe('國小數學-三A');
    expect(change.classDiscountChanges[0].reasons).toEqual([
      { kind: 'enrollment_added', className: '兒童美語-EA' },
    ]);
    expect(change.classDiscountChanges[0].reasons.some((r) => r.kind === 'tag_added' || r.kind === 'tag_removed')).toBe(
      false
    );
  });

  it('無法歸因 → reasons 為空陣列（PR-2 會顯示「名單資料變動」）', () => {
    const { beforeCtx, afterCtx } = contexts();
    // 年級變動：二年級 → 三年級，報名不變；三年級走課輔側。安親適用率不變、math 不變 → 無班級折扣變動
    const before = student('R10', ['國小數學-三A'], { grade: 2 });
    const after = student('R10', ['國小數學-三A'], { grade: 3 });

    const result = computeRosterChanges([before], [after], beforeCtx, afterCtx);

    // 年級變動不改 math 適用率（= basic），故不應有任何班級折扣變動項
    expect((result.changes[0] as ClassStructureChange | undefined)?.classDiscountChanges ?? []).toEqual([]);
  });

  it('原因只掛在實際變動的班，不散播到所有班', () => {
    const { beforeCtx, afterCtx } = contexts();
    const before = student('R11', ['國小數學-三A', '兒童美語-EA'], { grade: 3 });
    const after = student('R11', ['國小數學-三A', '兒童美語-EB'], { grade: 3 });

    const change = only(computeRosterChanges([before], [after], beforeCtx, afterCtx))[0];

    for (const item of change.classDiscountChanges) {
      expect(item.reasons).toEqual([{ kind: 'enrollment_removed', className: '兒童美語-EA' }]);
      expect(item.reasons.some((r) => r.kind === 'enrollment_added')).toBe(false);
    }
  });
});

describe('PR-1 §1 classSettings 接線（spike §B4：與 run 端類別解析同源）', () => {
  /**
   * §B4 場景：把「國小數學-三A」從自動偵測的 math 改成**手動**的 care。
   * run 端（帶 classSettings）：CD（輔導＋數學）科數 2 → 1、basic 9500 → 10000。
   * 異動明細 before 側若未帶 classSettings 會退回自動偵測 → 2 科 9500（與 run 端不符，違反 D17／specs/11:72）。
   * 本例：before 名單與 after 名單相同（都是輔導＋數學），只有設定不同才會有差異——
   * 故直接以帶 classSettings 的 ctx 計算兩側，驗證兩側都讀到手動 care。
   */
  it('手動類別與自動偵測不同時，異動明細兩側都依 classSettings（與 run 端一致）', () => {
    const draft = buildSeedDraft();
    const manual = buildClassSettingMap(draft);
    // 覆寫：國小數學-三A 由自動 math 改為手動 care
    const override: ClassSettingLookup = {
      category: 'care',
      categorySource: 'manual',
      fixedFiveDays: false,
      fixedSource: 'auto',
    };
    for (const key of ['國小數學-三A', '國小數學-三A[團]']) manual.set(key, override);

    const { beforeCtx, afterCtx } = contexts(manual);
    const s = student('C1', ['國小輔導-一A', '國小數學-三A'], { grade: 3 });

    const result = computeRosterChanges([s], [s], beforeCtx, afterCtx);

    // 手動 care 後：兩個班都是 care → 科數 1 → basic 10000。
    // 若未接 classSettings（退回自動偵測）會是 care＋math → 科數 2 → basic 9500。
    expect(result.changes).toHaveLength(0); // 兩側相同 → 未異動
    expect(result.stats.unchangedCount).toBe(1);
  });

  it('未帶 classSettings 時退回自動偵測（既有行為不變，向後相容）', () => {
    const { beforeCtx, afterCtx } = contexts();
    const s = student('C2', ['國小輔導-一A', '國小數學-三A'], { grade: 3 });

    const result = computeRosterChanges([s], [s], beforeCtx, afterCtx);

    expect(result.stats.unchangedCount).toBe(1);
  });
});
