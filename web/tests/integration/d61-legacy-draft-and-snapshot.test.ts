/**
 * D61 Phase 1（issue #184；specs/16 §4.1 場景 4）：舊版 `settings_versions` 相容讀取、run 快照與名單異動明細。
 *
 * ── 零突變的鑑別設計（獨立手算）──
 *  舊制（`12206ac` 以前）`category='none'` 的班從不進入扣天公式。本檔放一個舊制 `non_care`＋`none` 的虛構班
 *  「平日作文班」，時段 週三 17:00–19:00＝1020–1140（與課輔窗 990–1170 重疊 120 分、end∈(1110,1170) → 課輔特例 −1）。
 *  年級 4 ＝ 課輔側，課輔天數 ＝ max(3, 5 + 扣天)：
 *   - 舊制語意（不扣）→ 5 天；
 *   - 若讀取時單純把 non_care 改叫 other、而 skipDeduction 維持舊值 false → 該班被計入 → 4 天（**突變**）；
 *   - 正規化為 skipDeduction:true（Ruling 2）→ 5 天（零突變）。
 *  所以 5 天這個斷言只有在正規化真的發生時才成立。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';
import {
  buildSeedDraft,
  hashSettingsDraft,
  readStoredDraft,
  saveSettingsVersion,
} from '@/adapters/sqlite/settings-repository';
import { executeCalculationRun, resolveLatestSavedSettings } from '@/application/calculate-run';
import { loadRunClassCategories } from '@/application/applicable-rate';
import { computeRosterChanges } from '@/application/roster-changes';
import { buildClassSettingMap } from '@/application/calculate-run';
import { draftToAliasMap, draftToScheduleOverride } from '@/adapters/sqlite/settings-repository';
import { SettingsDraftSchema } from '@/contracts/settings';
import type { StudentSnapshot } from '@/domain/students/types';

const WED_17_19 = { weekday: '三', startMinutes: 1020, endMinutes: 1140 };

/** 以 `12206ac` 的 buildSeedDraft 形狀手工還原的舊版草稿（只有 care／non_care，無 hasMultiSubjectDiscount）。 */
function legacyDraftJson(extraClasses: Array<Record<string, unknown>>): string {
  const seed = buildSeedDraft();
  const classes = seed.classes.map((c) => {
    const legacy: Record<string, unknown> = {
      baseName: c.baseName,
      teacher: c.teacher,
      active: c.active,
      sessions: c.sessions.map((s) => ({ weekday: s.weekday, startMinutes: s.startMinutes, endMinutes: s.endMinutes, skipDeduction: false })),
      classType: c.classType === 'care' ? 'care' : 'non_care',
    };
    return legacy;
  });
  return JSON.stringify({ classes: [...classes, ...extraClasses], aliases: [], careWindows: seed.careWindows });
}

const LEGACY_NONE_CLASS = {
  baseName: '平日作文班',
  teacher: null,
  active: true,
  sessions: [{ ...WED_17_19, skipDeduction: false }],
  classType: 'non_care',
  category: 'none',
  categorySource: 'manual',
};

const LEGACY_ENGLISH_CLASS = {
  baseName: '兒童美語-舊制手設',
  teacher: null,
  active: true,
  sessions: [{ ...WED_17_19, skipDeduction: false }],
  classType: 'non_care',
  category: 'english',
  categorySource: 'manual',
};

function token(baseName: string) {
  return {
    rawToken: baseName,
    yearPrefix: null,
    baseName,
    groupFlag: null,
    modifiers: [],
    withdrawalDate: null,
    erpBillingTierRaw: null,
    erpBillingTier: null,
    tierParseStatus: 'not_applicable' as const,
    parseStatus: 'ok' as const,
  };
}

function student(personCode: string, grade: number, names: string[], sourceRow: number): StudentSnapshot {
  return {
    personCode,
    name: `合成${personCode}`,
    branch: null,
    grade,
    gradeRaw: String(grade),
    gradeStatus: 'valid',
    contact: null,
    schoolInfo: null,
    tagsRaw: '',
    tags: [],
    notesRaw: '',
    sourceRow,
    enrollments: names.map(token),
  };
}

describe('D61 舊版 settings_versions 相容讀取（readStoredDraft 單一入口）', () => {
  it('non_care＋none → other、hasMultiSubjectDiscount=false、既有時段正規化 skipDeduction=true', () => {
    const draft = readStoredDraft(legacyDraftJson([LEGACY_NONE_CLASS]));
    const c = draft.classes.find((x) => x.baseName === '平日作文班')! as Record<string, any>;
    expect(c.classType).toBe('other');
    expect(c.hasMultiSubjectDiscount).toBe(false);
    expect(c.sessions).toHaveLength(1);
    expect(c.sessions[0].skipDeduction).toBe(true);
  });

  it('non_care＋manual english → english、hasMultiSubjectDiscount=true、時段 skipDeduction 維持舊值 false', () => {
    const draft = readStoredDraft(legacyDraftJson([LEGACY_ENGLISH_CLASS]));
    const c = draft.classes.find((x) => x.baseName === '兒童美語-舊制手設')! as Record<string, any>;
    expect(c.classType).toBe('english');
    expect(c.hasMultiSubjectDiscount).toBe(true);
    expect(c.sessions[0].skipDeduction).toBe(false);
  });

  it('manual math 且 category=none（手動關閉折扣）的舊班 → other（舊制從不扣天），不是 math', () => {
    const legacy = { ...LEGACY_ENGLISH_CLASS, baseName: '國小數學-手動不列入', category: 'none' };
    const c = readStoredDraft(legacyDraftJson([legacy])).classes.find((x) => x.baseName === '國小數學-手動不列入')! as Record<string, any>;
    expect(c.classType).toBe('other');
    expect(c.sessions[0].skipDeduction).toBe(true);
  });

  it('seed 班（無 category 欄位的舊草稿）依 SEED_CLASS_TYPES 判定：兒童美語-Gino→english、國小數學-四A→math、小六加強班-自然→other', () => {
    const draft = readStoredDraft(legacyDraftJson([]));
    const typeOf = (n: string) => (draft.classes.find((x) => x.baseName === n) as Record<string, any>).classType;
    expect(typeOf('兒童美語-Gino')).toBe('english');
    expect(typeOf('國小數學-四A')).toBe('math');
    expect(typeOf('小六加強班-自然')).toBe('other');
    expect(typeOf('國小輔導-四年級')).toBe('care');
  });

  it('正規化後的草稿通過 SettingsDraftSchema，且已是新制的草稿讀取後 hash 不變（冪等）', () => {
    const draft = readStoredDraft(legacyDraftJson([LEGACY_NONE_CLASS, LEGACY_ENGLISH_CLASS]));
    expect(SettingsDraftSchema.safeParse(draft).success).toBe(true);

    const seed = buildSeedDraft();
    expect(hashSettingsDraft(readStoredDraft(JSON.stringify(seed)))).toBe(hashSettingsDraft(seed));
  });
});

describe('D61 舊版設定 → run 管線零突變與快照讀模型', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const now = new Date().toISOString();
    saveImportBatch(
      db,
      {
        id: 'imp_d61',
        fileName: 'f.xlsx',
        fileHash: 'h',
        contentHash: 'c',
        sheetName: 'Sheet1',
        headerMap: {},
        parserVersion: '1.0.0',
        scopeNote: '',
        rowCount: 2,
        status: 'ready',
        createdAt: now,
      },
      [
        student('S001', 4, ['國小輔導-四年級', '平日作文班', '交通車-未對應'], 1),
        student('S002', 4, ['國小輔導-四年級', '兒童美語-舊制手設'], 2),
      ]
    );
    saveSettingsVersion(db, {
      id: 'setv_legacy',
      contentHash: 'legacy',
      contentJson: legacyDraftJson([LEGACY_NONE_CLASS, LEGACY_ENGLISH_CLASS]),
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: now,
      createdFromPreviewId: null,
      revision: 1,
    });
  });

  afterEach(() => db.close());

  function runLegacy() {
    const saved = resolveLatestSavedSettings(db);
    const res = executeCalculationRun(db, 'imp_d61', 'run_d61', { ruleSetVersion: 'erp-tag-v4', ...saved });
    saveCalculationRun(db, res.run, res.results, res.classCategories);
    return res;
  }

  it('舊 none 班（平日作文班）不被計入扣天：課輔 5 天、科數 1；舊 english 班照扣：課輔 4 天、科數 2', () => {
    const res = runLegacy();
    const s1 = res.results.find((r) => r.personCode === 'S001')!;
    const s2 = res.results.find((r) => r.personCode === 'S002')!;
    // S001：care 1 科；作文班是 none 不計科、也不扣天（舊制語意）；交通車未對應
    expect(s1.subjectCount).toBe(1);
    expect(s1.tutoringDays).toBe(5);
    // S002：care ＋ english = 2 科；週三 −1 → 課輔 4
    expect(s2.subjectCount).toBe(2);
    expect(s2.baseDiscountBps).toBe(9500);
    expect(s2.tutoringDays).toBe(4);
  });

  it('run_class_categories 快照：五類型 class_type、投影後 category；未對應班維持 unset 並發 CLASS_NOT_MAPPED', () => {
    const res = runLegacy();
    const rows = loadRunClassCategories(db, 'run_d61');
    const rowOf = (n: string) => rows.find((r) => r.base_name === n)!;

    expect([rowOf('平日作文班').class_type, rowOf('平日作文班').category]).toEqual(['other', 'none']);
    expect([rowOf('兒童美語-舊制手設').class_type, rowOf('兒童美語-舊制手設').category]).toEqual(['english', 'english']);
    expect([rowOf('國小輔導-四年級').class_type, rowOf('國小輔導-四年級').category]).toEqual(['care', 'care']);

    const unmapped = res.classCategories!.find((r) => r.baseName === '交通車-未對應')!;
    expect([unmapped.classType, unmapped.category, unmapped.mapped]).toEqual([null, 'unset', 0]);
    const s1 = res.results.find((r) => r.personCode === 'S001')!;
    expect(s1.issues.map((i) => i.code)).toContain('CLASS_NOT_MAPPED');
  });

  it('快照不再寫入舊值 non_care', () => {
    runLegacy();
    const rows = loadRunClassCategories(db, 'run_d61');
    expect(rows.filter((r) => r.class_type === 'non_care')).toEqual([]);
  });
});

describe('D61 名單異動明細納入其他班', () => {
  it('其他班不計扣天由 true 改 false：S 的課輔天數 5→4，classBreakdown 列出該班', () => {
    const settingsFor = (skip: boolean) => {
      const draft = readStoredDraft(
        legacyDraftJson([
          {
            baseName: '平日作文班',
            teacher: null,
            active: true,
            sessions: [{ ...WED_17_19, skipDeduction: skip }],
            classType: 'other',
            hasMultiSubjectDiscount: false,
          },
        ])
      );
      return {
        aliasMap: draftToAliasMap(draft),
        scheduleOverride: draftToScheduleOverride(draft),
        classSettings: buildClassSettingMap(draft),
      };
    };
    const s = student('S001', 4, ['國小輔導-四年級', '平日作文班'], 1);
    const result = computeRosterChanges([s], [s], settingsFor(true), settingsFor(false));

    expect(result.changes).toHaveLength(1);
    const change = result.changes[0];
    expect([change.before?.tutoringDays, change.after?.tutoringDays]).toEqual([5, 4]);
    expect(change.dayChange?.classBreakdown.map((b) => b.rawToken)).toContain('平日作文班');
  });
});
