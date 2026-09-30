import { describe, it, expect } from 'vitest';
import { SEED_BASE_NAMES } from '@/domain/schedules/seed-manifest';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import type { SettingsDraft } from '@/contracts/settings';
import { loadModule, makeStudent, saveRun, saveSettings, saveSyntheticBatch, useGlobalTempDb } from '../helpers/d1-test-kit';

/**
 * D1 班名比對報告 read model（specs/11 §3 D1、04 §8 UX44–UX47；S manifest §8、Q12-b、D-09）。
 *
 * 兩份清單（都以「班名」為單位，人數一律是去重人數）：
 *   - 米豆奶有／系統無（rosterOnly）：本次名冊出現、但既不是設定裡的班、也沒有被「班名對應」解析到設定裡的班；
 *   - 系統有／本次名冊無（systemOnly）：設定裡的班，本次名冊沒有以該班名「直接」出現的報名。
 * 別名不對稱（畫面文案要明說）：米豆奶側，被別名對到系統班的名稱算「已對應」；系統側，只有別名覆蓋、
 * 本次名冊沒有直接以該班名報名的班，仍列在「系統有／本次名冊無」，並標出是由哪些別名覆蓋（不掩蓋真相，01 §4.3）。
 * Q12-b：系統有／名冊無 的「影響人數」＝「上一份名單」該班的去重人數（漂移參考），標註來源名單；沒有上一份名單 → null。
 * 範圍：latest（最新已存設定，尚無則 seed）／run（該 run 的設定快照；快照缺 → 「無法判定」，不猜）。
 * D1 的報告完全不含「類別」（類別是 D2 的功能）。
 */

const MODULE = '@/application/class-name-match-report';

type Scope = { kind: 'latest' } | { kind: 'run'; runId: string };
interface RosterOnlyRow { baseName: string; students: number; tokens: number }
interface SystemOnlyRow { baseName: string; active: boolean; aliasCoveredBy: string[]; previousRosterStudents: number | null }
interface Report {
  importId: string;
  scope: Scope;
  snapshotStatus: 'ok' | 'unavailable';
  rosterOnly: RosterOnlyRow[] | null;
  systemOnly: SystemOnlyRow[] | null;
  matchedCount: number | null;
  aliasCoveredCount: number | null;
  rosterOnlyStudents: number | null;
  systemOnlyPreviousRosterStudents: number | null;
  previousRoster: { importId: string; fileName: string; createdAt: string } | null;
}
interface Mod {
  getClassNameMatchReport: (db: unknown, input: { importId: string; scope: Scope; previousImportId?: string | null }) => Report;
  resolvePreviousRosterImportId: (db: unknown, importId: string) => string | null;
}

/** 小型設定：五個班＋兩個別名（其餘 seed 班刪除，讓清單可手算）。 */
function smallDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  const seed = buildSeedDraft();
  const keep = new Set(['國小數學-一A', '國小數學-二A', '國小輔導-四年級', '兒童美語-EA', '國小輔導-三年級']);
  return {
    ...seed,
    classes: seed.classes.filter((c) => keep.has(c.baseName)).map((c) => (c.baseName === '兒童美語-EA' ? { ...c, active: false } : c)),
    aliases: [
      { rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' },
      { rawBaseName: '國小輔導-三年級A', targetBaseName: '國小輔導-三年級' },
    ],
    ...overrides,
  };
}

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe('班名比對報告 read model（新模組 @/application/class-name-match-report）', () => {
  const ctx = useGlobalTempDb('sb-d1-cnr-');

  /**
   * 本次名冊 imp_new（s1–s7）與上一份現行名單 imp_old（p1–p5）。
   * 本次：
   *   s1 [一A, 四年級]          s2 [一（別名→一A）, 四年級]   s3 [一（別名）]
   *   s4 [交通車]               s5 [交通車, 正音A班]           s6 [正音A班, 正音A班]（同班兩筆報名）
   *   s7 [三年級A（別名→三年級）]
   * 上一份：p1 [二A]  p2 [二A, 三年級]  p3 [三年級]  p4 [兒童美語-EA]  p5 [一A]
   */
  function scenario() {
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_old', 'old.xlsx', '2026-09-01T08:00:00.000Z', [
      makeStudent('p1', ['國小數學-二A']),
      makeStudent('p2', ['國小數學-二A', '國小輔導-三年級']),
      makeStudent('p3', ['國小輔導-三年級']),
      makeStudent('p4', ['兒童美語-EA']),
      makeStudent('p5', ['國小數學-一A']),
    ]);
    saveSyntheticBatch(db, 'imp_new', 'new.xlsx', '2026-09-10T08:00:00.000Z', [
      makeStudent('s1', ['國小數學-一A', '國小輔導-四年級']),
      makeStudent('s2', ['國小數學-一', '國小輔導-四年級']),
      makeStudent('s3', ['國小數學-一']),
      makeStudent('s4', ['交通車']),
      makeStudent('s5', ['交通車', '正音A班']),
      makeStudent('s6', ['正音A班', '正音A班']),
      makeStudent('s7', ['國小輔導-三年級A']),
    ]);
    saveSettings(db, 'setv_1', 1, smallDraft());
    db.prepare('UPDATE active_state SET active_import_id = ? WHERE id = 1').run('imp_old');
    return db;
  }

  it('模組存在，匯出 getClassNameMatchReport／resolvePreviousRosterImportId', async () => {
    const mod = await loadModule<Mod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    expect(typeof mod!.getClassNameMatchReport).toBe('function');
    expect(typeof mod!.resolvePreviousRosterImportId).toBe('function');
  });

  it('latest 範圍：兩份清單、去重人數、別名不對稱、上一份名單人數（手算）', async () => {
    const mod = await loadModule<Mod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    const db = scenario();
    const report = mod!.getClassNameMatchReport(db, { importId: 'imp_new', scope: { kind: 'latest' }, previousImportId: 'imp_old' });

    expect(report.importId).toBe('imp_new');
    expect(report.scope).toEqual({ kind: 'latest' });
    expect(report.snapshotStatus).toBe('ok');

    // 米豆奶有／系統無：交通車（s4、s5＝2 人 2 筆）、正音A班（s5、s6＝2 人；s6 報兩筆＝3 筆）
    // 排序：人數多者在前；同人數依班名（交 U+4EA4 < 正 U+6B63）
    expect(report.rosterOnly).toEqual([
      { baseName: '交通車', students: 2, tokens: 2 },
      { baseName: '正音A班', students: 2, tokens: 3 },
    ]);
    // 影響人數去重：s4、s5、s6＝3（逐班相加 4，因為 s5 兩班都有）
    expect(report.rosterOnlyStudents).toBe(3);

    // 已對應：一A（直接）、四年級（直接）、一（別名）、三年級A（別名）＝4 個名冊班名
    expect(report.matchedCount).toBe(4);
    // 被別名覆蓋到的系統班：一A、三年級＝2
    expect(report.aliasCoveredCount).toBe(2);

    // 系統有／本次名冊無：二A、兒童美語-EA（停用）、三年級（只有別名覆蓋、沒有直接報名）。
    // 一A 雖然也被別名指到，但本次名冊有直接以「國小數學-一A」報名（s1）→ 不在此清單。
    // 排序：班名 code point（兒 U+5152 < 國 U+570B；國小數學 < 國小輔導 因「數」U+6578 < 「輔」U+8F14）
    expect(report.systemOnly).toEqual([
      { baseName: '兒童美語-EA', active: false, aliasCoveredBy: [], previousRosterStudents: 1 },
      { baseName: '國小數學-二A', active: true, aliasCoveredBy: [], previousRosterStudents: 2 },
      { baseName: '國小輔導-三年級', active: true, aliasCoveredBy: ['國小輔導-三年級A'], previousRosterStudents: 2 },
    ]);
    // 上一份名單去重：p1、p2、p3、p4＝4（逐班相加 5，因為 p2 在二A 與三年級都有）
    expect(report.systemOnlyPreviousRosterStudents).toBe(4);
    expect(report.previousRoster).toEqual({ importId: 'imp_old', fileName: 'old.xlsx', createdAt: '2026-09-01T08:00:00.000Z' });
  });

  it('沒有上一份名單（previousImportId 為 null）→ 系統有／名冊無 的人數為 null（不顯示 0），previousRoster 為 null', async () => {
    const mod = await loadModule<Mod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    const db = scenario();
    const report = mod!.getClassNameMatchReport(db, { importId: 'imp_new', scope: { kind: 'latest' }, previousImportId: null });
    expect(report.systemOnly!.map((r) => r.baseName)).toEqual(['兒童美語-EA', '國小數學-二A', '國小輔導-三年級']);
    for (const row of report.systemOnly!) expect(row.previousRosterStudents, row.baseName).toBeNull();
    expect(report.systemOnlyPreviousRosterStudents).toBeNull();
    expect(report.previousRoster).toBeNull();
    // 米豆奶側不受影響
    expect(report.rosterOnly).toHaveLength(2);
    expect(report.rosterOnlyStudents).toBe(3);
  });

  it('D1 的報告不含「類別」：任何巢狀層級都沒有 category 相關欄位', async () => {
    const mod = await loadModule<Mod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    const db = scenario();
    const report = mod!.getClassNameMatchReport(db, { importId: 'imp_new', scope: { kind: 'latest' }, previousImportId: 'imp_old' });
    const keys = [...collectKeys(report)];
    expect(keys.filter((k) => /categor|類別/i.test(k))).toEqual([]);
  });

  it('沒有已存設定 → latest 以 seed 為準：seed 班（一A）直接出現算已對應，其餘 48 個 seed 班都在「系統有／名冊無」', async () => {
    const mod = await loadModule<Mod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    const db = ctx.db();
    saveSyntheticBatch(db, 'imp_a', 'a.xlsx', '2026-09-10T08:00:00.000Z', [
      makeStudent('a1', ['國小數學-一A']),
      makeStudent('a2', ['虛構班-X']),
    ]);
    const report = mod!.getClassNameMatchReport(db, { importId: 'imp_a', scope: { kind: 'latest' }, previousImportId: null });
    expect(SEED_BASE_NAMES).toHaveLength(49);
    expect(report.snapshotStatus).toBe('ok');
    expect(report.rosterOnly).toEqual([{ baseName: '虛構班-X', students: 1, tokens: 1 }]);
    expect(report.matchedCount).toBe(1);
    expect(report.systemOnly).toHaveLength(48);
    expect(report.systemOnly!.some((r) => r.baseName === '國小數學-一A')).toBe(false);
    expect(report.systemOnly!.every((r) => r.active === true && r.aliasCoveredBy.length === 0)).toBe(true);
  });

  describe('run 範圍：讀該 run 當時的設定快照', () => {
    /** 舊快照：一→一A 別名；最新設定：沒有別名。名冊：一（1 人）、一A（1 人）。 */
    function runScenario() {
      const db = ctx.db();
      saveSyntheticBatch(db, 'imp_a', 'a.xlsx', '2026-09-10T08:00:00.000Z', [
        makeStudent('a1', ['國小數學-一']),
        makeStudent('a2', ['國小數學-一A']),
      ]);
      const classes = ['國小數學-一A', '國小輔導-四年級'];
      const seed = buildSeedDraft();
      const base = { ...seed, classes: seed.classes.filter((c) => classes.includes(c.baseName)) };
      saveSettings(db, 'setv_old', 1, { ...base, aliases: [{ rawBaseName: '國小數學-一', targetBaseName: '國小數學-一A' }] });
      saveSettings(db, 'setv_new', 2, { ...base, aliases: [] });
      saveRun(db, 'run_old', 'imp_a', 'setv_old', '2026-09-11T00:00:00.000Z');
      saveRun(db, 'run_seed', 'imp_a', 'seed-v250922', '2026-09-11T01:00:00.000Z');
      saveRun(db, 'run_gone', 'imp_a', 'setv_missing', '2026-09-11T02:00:00.000Z');
      return db;
    }

    it('run_old 的快照有別名 → 「一」已對應；最新設定沒有別名 → 「一」在米豆奶有／系統無（同一份名冊，兩個範圍結果不同）', async () => {
      const mod = await loadModule<Mod>(MODULE);
      expect(mod, `${MODULE} 需存在`).not.toBeNull();
      const db = runScenario();

      const latest = mod!.getClassNameMatchReport(db, { importId: 'imp_a', scope: { kind: 'latest' }, previousImportId: null });
      expect(latest.rosterOnly).toEqual([{ baseName: '國小數學-一', students: 1, tokens: 1 }]);
      expect(latest.matchedCount).toBe(1);
      expect(latest.aliasCoveredCount).toBe(0);
      expect(latest.systemOnly!.map((r) => r.baseName)).toEqual(['國小輔導-四年級']);

      const run = mod!.getClassNameMatchReport(db, { importId: 'imp_a', scope: { kind: 'run', runId: 'run_old' }, previousImportId: null });
      expect(run.scope).toEqual({ kind: 'run', runId: 'run_old' });
      expect(run.snapshotStatus).toBe('ok');
      expect(run.rosterOnly).toEqual([]);
      expect(run.rosterOnlyStudents).toBe(0);
      expect(run.matchedCount).toBe(2);
      expect(run.aliasCoveredCount).toBe(1);
      expect(run.systemOnly!.map((r) => r.baseName)).toEqual(['國小輔導-四年級']);
    });

    it("run 的設定快照是 seed（scheduleVersionId＝'seed-v250922'）→ 以 seed 49 班為準", async () => {
      const mod = await loadModule<Mod>(MODULE);
      expect(mod, `${MODULE} 需存在`).not.toBeNull();
      const db = runScenario();
      const report = mod!.getClassNameMatchReport(db, { importId: 'imp_a', scope: { kind: 'run', runId: 'run_seed' }, previousImportId: null });
      expect(report.snapshotStatus).toBe('ok');
      // 「國小數學-一」不是 seed 班、seed 沒有別名 → 米豆奶有／系統無；一A 是 seed 班 → 已對應
      expect(report.rosterOnly).toEqual([{ baseName: '國小數學-一', students: 1, tokens: 1 }]);
      expect(report.matchedCount).toBe(1);
      expect(report.systemOnly).toHaveLength(48);
    });

    it('快照缺失 → 無法判定：snapshotStatus＝unavailable，清單與各計數都是 null（不是空清單、不是 0，不猜、不改用最新設定）', async () => {
      const mod = await loadModule<Mod>(MODULE);
      expect(mod, `${MODULE} 需存在`).not.toBeNull();
      const db = runScenario();
      const report = mod!.getClassNameMatchReport(db, { importId: 'imp_a', scope: { kind: 'run', runId: 'run_gone' }, previousImportId: null });
      expect(report.snapshotStatus).toBe('unavailable');
      expect(report.rosterOnly).toBeNull();
      expect(report.systemOnly).toBeNull();
      expect(report.matchedCount).toBeNull();
      expect(report.aliasCoveredCount).toBeNull();
      expect(report.rosterOnlyStudents).toBeNull();
      expect(report.systemOnlyPreviousRosterStudents).toBeNull();
    });
  });

  describe('上一份名單的解析（resolvePreviousRosterImportId）', () => {
    // 規則（寫入 04 UX45、03）：
    //   1. importId 不是現行名單且有現行名單 → 上一份＝現行名單（匯入預覽：本次剛上傳、尚未啟用）；
    //   2. importId 就是現行名單，或沒有現行名單 → 上一份＝比它更早建立的最近一份 ready 名單；沒有 → null。
    it('importId 不是現行名單 → 上一份＝現行名單（匯入預覽的情境：本次剛上傳、尚未啟用）', async () => {
      const mod = await loadModule<Mod>(MODULE);
      expect(mod, `${MODULE} 需存在`).not.toBeNull();
      const db = scenario();
      expect(mod!.resolvePreviousRosterImportId(db, 'imp_new')).toBe('imp_old');
    });

    it('importId 就是現行名單 → 上一份＝更早建立的最近一份 ready 名單；沒有更早的 → null', async () => {
      const mod = await loadModule<Mod>(MODULE);
      expect(mod, `${MODULE} 需存在`).not.toBeNull();
      const db = scenario();
      // imp_old 是現行名單，且是最早的一份 → 沒有上一份
      expect(mod!.resolvePreviousRosterImportId(db, 'imp_old')).toBeNull();
      // 改成 imp_new 現行 → 上一份是更早建立的 imp_old
      db.prepare('UPDATE active_state SET active_import_id = ? WHERE id = 1').run('imp_new');
      expect(mod!.resolvePreviousRosterImportId(db, 'imp_new')).toBe('imp_old');
      // 規則是「現行名單優先」：importId 不是現行名單時，上一份一律是現行名單（即使現行名單比它晚建立），
      // 讓匯入預覽（重傳同檔會沿用較舊的既有批次）與完整報告用同一份名單當參考，兩處數字一致
      expect(mod!.resolvePreviousRosterImportId(db, 'imp_old')).toBe('imp_new');
    });

    it('沒有現行名單時：取比 importId 更早建立的最近一份 ready 名單', async () => {
      const mod = await loadModule<Mod>(MODULE);
      expect(mod, `${MODULE} 需存在`).not.toBeNull();
      const db = scenario();
      db.prepare('UPDATE active_state SET active_import_id = NULL WHERE id = 1').run();
      expect(mod!.resolvePreviousRosterImportId(db, 'imp_new')).toBe('imp_old');
      expect(mod!.resolvePreviousRosterImportId(db, 'imp_old')).toBeNull();
    });
  });

  it('未知的 importId → 拋出錯誤（不回空報告）', async () => {
    const mod = await loadModule<Mod>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    const db = scenario();
    expect(() => mod!.getClassNameMatchReport(db, { importId: 'imp_nope', scope: { kind: 'latest' }, previousImportId: null })).toThrow();
  });
});
