import { z } from 'zod';
import seedData from '../domain/schedules/schedule-seed.json';
import { SEED_CLASS_TYPES } from '../domain/schedules/seed-manifest';
import { persistClassAttributes } from '@/domain/classification/persist-class-attributes';
import {
  normalizeLegacyClassSetting,
  type CategorySource,
  type ClassCategory,
} from '@/domain/classification/class-category';

/**
 * seed 內的 8 個預設安親課輔班（source=care_window）。
 */
export const DEFAULT_CARE_CLASS_NAMES: ReadonlySet<string> = new Set(
  (seedData.classes as Array<{ baseName: string; source?: string }>)
    .filter((c) => c.source === 'care_window')
    .map((c) => c.baseName)
);

/** D61：五種課程類型識別碼（固定順序：安親課輔班／美語班／數學班／其他班／不排課）。 */
export const ClassTypeSchema = z.enum(['care', 'english', 'math', 'other', 'unscheduled']);
export type ClassType = z.infer<typeof ClassTypeSchema>;

export const CLASS_TYPE_ORDER: readonly ClassType[] = [
  'care',
  'english',
  'math',
  'other',
  'unscheduled',
] as const;

export const CLASS_TYPE_LABELS: Record<ClassType, string> = {
  care: '安親課輔班',
  english: '美語班',
  math: '數學班',
  other: '其他班',
  unscheduled: '不排課',
};

/** 是否為可排課之課程類型（美語班／數學班／其他班為 true；安親課輔班／不排課為 false）。 */
export function isSchedulableClassType(t: ClassType): boolean {
  return t === 'english' || t === 'math' || t === 'other';
}

/** 是否支援「是否有多科折扣」開關（安親課輔班／美語班／數學班為 true）。 */
export function supportsMultiSubjectDiscount(t: ClassType): boolean {
  return t === 'care' || t === 'english' || t === 'math';
}

/** 該課程類型新增時段／空佔位列之預設「不計扣天」值（其他班預設 true，其餘為 false）。 */
export function defaultSkipDeductionForClassType(t: ClassType): boolean {
  return t === 'other';
}

/** 將 "HH:mm" 時間字串轉換為當日分鐘數 (0~1440) */
export function timeStringToMinutes(timeStr: string | null | undefined): number | null {
  if (!timeStr) return null;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 將分鐘數 (0~1440) 轉換為 "HH:mm" 時間字串 */
export function minutesToTimeString(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || isNaN(minutes)) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 存檔契約的星期：1–8 字元。空白與過長者存檔（settings/preview、apply）一律拒絕；
 * 非空的非法值（如「八」）可存，run 端 fail-closed 並列 UNKNOWN_WEEKDAY 問題。
 * calculate 的唯讀輸入（CalculateSessionSchema）刻意放寬，見該處說明（09 §3.1、11 §3 A）。
 */
export const SavedWeekdaySchema = z.string().min(1).max(8);

/** 星期是否符合存檔契約（與 SessionSchema 同源，不各寫一份長度規則）。 */
export function isSavableWeekday(weekday: string): boolean {
  return SavedWeekdaySchema.safeParse(weekday).success;
}

/**
 * 平鋪列的星期（#82）：允許空字串或 null（行政先開班名、時間與星期還在協調中的佔位列），
 * 一律正規化為空字串，因此 row 型別仍是 `string`，下游的 `weekday.trim()` 不必全面改成 nullable。
 *
 * 這**只放寬平鋪列**（編輯中的草稿），存檔契約 `SavedWeekdaySchema`／`SessionSchema` 維持嚴格：
 * 空白星期的列本來就因為「起訖不完整」而不會被 `gridRowsToClasses` 轉成 session，
 * 而非空但未知的值存檔時仍被拒絕（09 §3.1「提交仍拒絕空白星期」不因本項放寬而改變）。
 */
export const GridRowWeekdaySchema = z
  .union([z.string().max(8), z.null()])
  .transform((val) => val ?? '')
  .default('');

/**
 * 時段 session（分鐘制）
 *
 * #113 follow-up：`skipDeduction` 改為**逐時段**設定——一個班可以有 2~3 個時段，
 * 園方只想讓其中 1~2 堂不扣天（例：第一堂與安親重疊不扣、第二堂與課輔重疊照扣）。
 * 缺欄位＝未勾選＝false（03 §5.2 版本界線規則第 2 點：欄位缺失＝預設，不回寫舊快照）。
 */
export const SessionSchema = z.object({
  weekday: SavedWeekdaySchema,
  startMinutes: z.number().int().min(0).max(1440),
  endMinutes: z.number().int().min(0).max(1440),
  /** #113 follow-up：此時段勾選「不計扣天」→ 重疊分鐘照實計算，但不列入扣天。 */
  skipDeduction: z.boolean().default(false),
}).refine((s) => s.endMinutes > s.startMinutes, { message: 'endMinutes 必須大於 startMinutes' });

export type Session = z.infer<typeof SessionSchema>;

/**
 * 時段是否「完整可計算」：起、迄皆有值且迄晚於起。
 * 存檔（gridRowsToClasses 丟掉不完整列）與 calculate（不完整列回 null＋missing_time）共用同一個判斷，
 * 兩邊對「哪些列算不完整」不會分歧（09 §8.1）。
 */
export function isCompleteTimeRange<T extends { startMinutes: number | null; endMinutes: number | null }>(
  s: T
): s is T & { startMinutes: number; endMinutes: number } {
  return s.startMinutes !== null && s.endMinutes !== null && s.endMinutes > s.startMinutes;
}

/** 時段是否同時滿足存檔星期（1–8 字元非空）與完整起迄區間（D61 §5.2 同源判斷）。 */
export function isSavableCompleteSession<
  T extends { weekday: string; startMinutes: number | null; endMinutes: number | null }
>(s: T): s is T & { startMinutes: number; endMinutes: number } {
  return isSavableWeekday(s.weekday) && isCompleteTimeRange(s);
}

/**
 * D61 Ruling 3：保存填寫一半的待補時段列（供存檔重載後還原，絕不進入計費核心 scheduleOverride）。
 */
export const IncompleteSessionSchema = z.object({
  weekday: z.string().max(8).default(''),
  startMinutes: z.number().int().min(0).max(1440).nullable().default(null),
  endMinutes: z.number().int().min(0).max(1440).nullable().default(null),
  skipDeduction: z.boolean().default(false),
});

export type IncompleteSession = z.infer<typeof IncompleteSessionSchema>;

/** 單一班級設定物件 Schema（未套用 refinement，供 extend 使用） */
const ClassSettingObjectSchema = z.object({
  baseName: z.string().min(1),
  teacher: z.string().nullable().default(null),
  active: z.boolean().default(true),
  sessions: z.array(SessionSchema).default([]),
  incompleteSessions: z.array(IncompleteSessionSchema).optional(),
  classType: z.union([ClassTypeSchema, z.literal('non_care')]).optional(),
  hasMultiSubjectDiscount: z.boolean().optional(),
  classTypeId: z.string().optional(),
  category: z.enum(['care', 'math', 'english', 'none', 'unset']).optional(),
  /**
   * #157 Ruling 4 & 5：若遇舊資料的 'auto'，讀取時直接視為 'unset'，不再寫回。
   */
  categorySource: z
    .enum(['auto', 'manual', 'unset', 'seed'])
    .transform((val) => (val === 'auto' ? 'unset' : val))
    .optional(),
  fixedFiveDays: z.boolean().optional(),
});

function validateClassSetting(
  cls: {
    classType?: ClassType | 'non_care';
    hasMultiSubjectDiscount?: boolean;
    fixedFiveDays?: boolean;
    sessions?: unknown[];
    incompleteSessions?: unknown[];
  },
  ctx: z.RefinementCtx
) {
  if (cls.classType !== undefined && cls.classType !== 'care' && cls.fixedFiveDays === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fixedFiveDays'],
      message: '非安親課輔班不支援固定 5 天',
    });
  }
  if (
    (cls.classType === 'other' || cls.classType === 'unscheduled') &&
    cls.hasMultiSubjectDiscount === true
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hasMultiSubjectDiscount'],
      message: '此課程類型不支援多科折扣',
    });
  }
  if (cls.classType === 'care' || cls.classType === 'unscheduled') {
    if (Array.isArray(cls.sessions) && cls.sessions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sessions'],
        message: '此課程類型不支援排課時段',
      });
    }
    if (Array.isArray(cls.incompleteSessions) && cls.incompleteSessions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['incompleteSessions'],
        message: '此課程類型不支援待補時段',
      });
    }
  }
}

export const ClassSettingSchema = ClassSettingObjectSchema.superRefine(validateClassSetting);

export type ClassSetting = z.infer<typeof ClassSettingSchema>;

/** 平鋪排課時段列（對齊 S 表五欄平鋪模型，R4:E96 89 筆；支援空時段佔位列） */
export const ScheduleGridRowSchema = z
  .object({
    rowId: z.string().min(1),
    className: z.string().min(1, { message: '班級名稱不可為空' }),
    teacher: z.string().nullable().default(null),
    weekday: GridRowWeekdaySchema,
    startTime: z.string().refine((val) => val === '' || /^([01]\d|2[0-3]):([0-5]\d)$/.test(val), {
      message: '起始時間格式必須為 HH:mm 或留空',
    }),
    endTime: z.string().refine((val) => val === '' || /^([01]\d|2[0-3]):([0-5]\d)$/.test(val), {
      message: '結束時間格式必須為 HH:mm 或留空',
    }),
    startMinutes: z.number().int().min(0).max(1440).nullable().default(null),
    endMinutes: z.number().int().min(0).max(1440).nullable().default(null),
    active: z.boolean().default(true),
    /**
     * #113 follow-up：**逐列**的「不計扣天」。與類別／固定 5 天不同，它不是班級屬性——
     * 每一列各自勾選，勾第一列不會連動同班的其他時段。
     */
    skipDeduction: z.boolean().default(false),
  })
  .refine(
    (r) => {
      if (r.startMinutes !== null && r.endMinutes !== null) {
        return r.endMinutes > r.startMinutes;
      }
      return true;
    },
    {
      message: '結束時間 (迄) 必須大於起始時間 (起)',
      path: ['endTime'],
    }
  );

export type ScheduleGridRow = z.infer<typeof ScheduleGridRowSchema>;

/** 由 schedule-seed 產生全量 89 筆平鋪時段列（F1: 空時段原樣攜帶 null，不捏造假分鐘數；D61: 其他班預設 skipDeduction=true） */
export function buildSeedGridRows(): ScheduleGridRow[] {
  const rows: ScheduleGridRow[] = [];
  let rowSeq = 1;

  for (const cls of seedData.classes) {
    const defaultSkip = SEED_CLASS_TYPES.get(cls.baseName) === 'other';
    for (const session of cls.sessions) {
      const hasStart = session.startMinutes !== null && session.startMinutes !== undefined;
      const hasEnd = session.endMinutes !== null && session.endMinutes !== undefined;
      const weekday = session.weekday ?? '';
      const startMin = hasStart ? session.startMinutes! : null;
      const endMin = hasEnd ? session.endMinutes! : null;

      rows.push({
        rowId: `row-${rowSeq++}`,
        className: cls.baseName,
        teacher: session.teacher ?? cls.teacher ?? null,
        weekday,
        startTime: hasStart ? minutesToTimeString(startMin) : '',
        endTime: hasEnd ? minutesToTimeString(endMin) : '',
        startMinutes: startMin,
        endMinutes: endMin,
        active: true,
        skipDeduction: defaultSkip,
      });
    }
  }

  return rows;
}

/**
 * 將可排課班級的輸入時段拆分為完整合法 `sessions` 與待補 `incompleteSessions`（供 gridRowsToClasses 與 toSaveEquivalentDraft 共用）。
 * - `care` 與 `unscheduled` 一律輸出 `sessions: []` 且不帶 `incompleteSessions`。
 * - 單列全空佔位（星期空、起迄皆 null、skipDeduction 為該類型預設值）省略 `incompleteSessions`。
 */
export function splitSavableSessions(
  classType: ClassType,
  rows: ReadonlyArray<{
    weekday: string;
    startMinutes: number | null;
    endMinutes: number | null;
    skipDeduction?: boolean;
  }>
): { sessions: Session[]; incompleteSessions?: IncompleteSession[] } {
  if (!isSchedulableClassType(classType)) {
    return { sessions: [] };
  }

  const defaultSkip = defaultSkipDeductionForClassType(classType);
  const sessions: Session[] = [];
  const incomplete: IncompleteSession[] = [];

  for (const r of rows) {
    const skip = r.skipDeduction ?? false;
    if (isSavableCompleteSession(r)) {
      sessions.push({
        weekday: r.weekday,
        startMinutes: r.startMinutes,
        endMinutes: r.endMinutes,
        skipDeduction: skip,
      });
    } else if (r.weekday.length <= 8) {
      incomplete.push({
        weekday: r.weekday,
        startMinutes: r.startMinutes,
        endMinutes: r.endMinutes,
        skipDeduction: skip,
      });
    }
  }

  if (incomplete.length === 0) {
    return { sessions };
  }

  if (
    sessions.length === 0 &&
    incomplete.length === 1 &&
    incomplete[0].weekday.trim() === '' &&
    incomplete[0].startMinutes === null &&
    incomplete[0].endMinutes === null &&
    incomplete[0].skipDeduction === defaultSkip
  ) {
    return { sessions };
  }

  return { sessions, incompleteSessions: incomplete };
}

/** 將平鋪時段列聚合為 ClassSetting[] 結構（F1: null 時段列不產出實體 session；D61: 保留填寫一半的 incompleteSessions）。 */
export function gridRowsToClasses(
  rows: ScheduleGridRow[],
  existingClasses?: ClassSetting[]
): ClassSetting[] {
  return groupGridRowsToClasses(rows, existingClasses, (classType, classRows) =>
    splitSavableSessions(classType, classRows)
  );
}

/**
 * 平鋪列 → 班級的共用分組（存檔與 calculate 同一套：班名分組、teacher／active 的決定方式），
 * 只有「每班的 sessions／incompleteSessions 怎麼產生」由呼叫端決定。
 */
function groupGridRowsToClasses<S>(
  rows: ScheduleGridRow[],
  existingClasses: ClassSetting[] | undefined,
  toSessions: (
    classType: ClassType,
    classRows: ScheduleGridRow[]
  ) => { sessions: S[]; incompleteSessions?: IncompleteSession[] }
): Array<Omit<ClassSetting, 'sessions'> & { sessions: S[] }> {
  const existingMap = new Map<string, ClassSetting>();
  if (existingClasses) {
    for (const c of existingClasses) {
      existingMap.set(c.baseName, c);
    }
  }

  const grouped = new Map<string, ScheduleGridRow[]>();
  for (const r of rows) {
    // F1 rework: 班級名稱空白（僅空白）之列直接丟棄，不產出 baseName 空字串班
    if (r.className.trim() === '') continue;
    if (!grouped.has(r.className)) {
      grouped.set(r.className, []);
    }
    grouped.get(r.className)!.push(r);
  }

  const classes: Array<Omit<ClassSetting, 'sessions'> & { sessions: S[] }> = [];
  for (const [className, classRows] of grouped.entries()) {
    const existing = existingMap.get(className);
    const teacher = classRows[0]?.teacher ?? existing?.teacher ?? null;
    const active = classRows.some((r) => r.active);

    const norm = normalizeLegacyClassSetting(className, existing);
    const classType: ClassType = norm.classType;

    // Both editor save and grid serialization use this single source rule: manual/unset write,
    // seed/legacy auto do not, and explicit fixedFiveDays=false remains in the draft.
    const attrs = persistClassAttributes({
      classType,
      hasMultiSubjectDiscount: norm.hasMultiSubjectDiscount,
      category: existing?.category,
      categorySource: existing?.categorySource,
      fixedFiveDays: existing?.fixedFiveDays,
    });

    const { sessions, incompleteSessions } = isSchedulableClassType(classType)
      ? toSessions(classType, classRows)
      : { sessions: [] as S[], incompleteSessions: undefined };

    classes.push({
      baseName: className,
      teacher,
      active,
      sessions,
      ...(incompleteSessions !== undefined ? { incompleteSessions } : {}),
      classType,
      ...attrs,
    });
  }

  return classes;
}

/** 將 ClassSetting[] 展平為平鋪時段列（合併 sessions 與 incompleteSessions；皆空時展開 1 筆空佔位列，skipDeduction 依類型預設） */
export function classesToGridRows(classes: ClassSetting[]): ScheduleGridRow[] {
  const rows: ScheduleGridRow[] = [];
  let rowSeq = 1;

  for (const c of classes) {
    const norm = normalizeLegacyClassSetting(c.baseName, c);
    const defaultSkip = defaultSkipDeductionForClassType(norm.classType);
    const incomplete = isSchedulableClassType(norm.classType) ? (c.incompleteSessions ?? []) : [];

    if (c.sessions.length > 0 || incomplete.length > 0) {
      for (const s of c.sessions) {
        rows.push({
          rowId: `grid-${c.baseName}-${rowSeq++}`,
          className: c.baseName,
          teacher: c.teacher,
          weekday: s.weekday,
          startTime: minutesToTimeString(s.startMinutes),
          endTime: minutesToTimeString(s.endMinutes),
          startMinutes: s.startMinutes,
          endMinutes: s.endMinutes,
          active: c.active,
          // #113 follow-up：逐時段帶出自己的不計扣天旗標
          skipDeduction: s.skipDeduction ?? false,
        });
      }
      for (const inc of incomplete) {
        rows.push({
          rowId: `grid-${c.baseName}-${rowSeq++}`,
          className: c.baseName,
          teacher: c.teacher,
          weekday: inc.weekday ?? '',
          startTime: inc.startMinutes !== null ? minutesToTimeString(inc.startMinutes) : '',
          endTime: inc.endMinutes !== null ? minutesToTimeString(inc.endMinutes) : '',
          startMinutes: inc.startMinutes ?? null,
          endMinutes: inc.endMinutes ?? null,
          active: c.active,
          skipDeduction: inc.skipDeduction ?? defaultSkip,
        });
      }
    } else {
      rows.push({
        rowId: `grid-${c.baseName}-${rowSeq++}`,
        className: c.baseName,
        teacher: c.teacher,
        weekday: '',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: c.active,
        skipDeduction: defaultSkip,
      });
    }
  }

  return rows;
}

export interface SplitClassWarning {
  originalName: string;
  splitNames: string[];
}

/** 偵測原同名多時段班級是否被改散拆分為不同班名 (D28) */
export function detectSplitClasses(
  originalRows: ScheduleGridRow[],
  currentRows: ScheduleGridRow[]
): SplitClassWarning[] {
  const originalClassRows = new Map<string, string[]>(); // className -> rowIds

  for (const r of originalRows) {
    if (!originalClassRows.has(r.className)) {
      originalClassRows.set(r.className, []);
    }
    originalClassRows.get(r.className)!.push(r.rowId);
  }

  const currentRowMap = new Map<string, ScheduleGridRow>();
  for (const r of currentRows) {
    currentRowMap.set(r.rowId, r);
  }

  const warnings: SplitClassWarning[] = [];

  for (const [origClass, rowIds] of originalClassRows.entries()) {
    if (rowIds.length <= 1) continue;

    const currentNames = new Set<string>();
    for (const id of rowIds) {
      const curRow = currentRowMap.get(id);
      if (curRow && curRow.className.trim()) {
        currentNames.add(curRow.className.trim());
      }
    }

    if (currentNames.size > 1) {
      warnings.push({
        originalName: origClass,
        splitNames: Array.from(currentNames).sort(),
      });
    }
  }

  return warnings;
}

/** 班級層屬性（classType／category／fixedFiveDays）。
 *  #113 follow-up：不計扣天已改為逐時段（`ScheduleGridRow.skipDeduction`），不再是班級屬性。
 *  specs/14 §3.10：固定 5 天為純布林值，不再有 fixedSource。新增 classType。 */
export interface ClassAttributeSetting {
  className: string;
  classType?: ClassType | 'non_care';
  hasMultiSubjectDiscount?: boolean;
  category?: 'care' | 'math' | 'english' | 'none' | 'unset';
  categorySource?: CategorySource;
  fixedFiveDays?: boolean;
}

export interface SettingsBaseline {
  rows: ScheduleGridRow[];
  aliases: Array<{ rawBaseName: string; targetBaseName: string }>;
  classAttrs?: ClassAttributeSetting[];
}

/**
 * D31 / F-13: 判斷目前排課表格列、aliases 或班級屬性是否相對於基準狀態有未儲存變更 (dirty)。
 */
export function isSettingsDirty(
  baseline: SettingsBaseline,
  currentRows: ScheduleGridRow[],
  currentAliases: Array<{ rawBaseName: string; targetBaseName: string }>,
  currentAttrs?: ClassAttributeSetting[]
): boolean {
  if (currentRows.length !== baseline.rows.length) return true;

  for (let i = 0; i < currentRows.length; i++) {
    const cr = currentRows[i];
    const br = baseline.rows[i];
    if (
      cr.rowId !== br.rowId ||
      cr.className !== br.className ||
      cr.teacher !== br.teacher ||
      cr.weekday !== br.weekday ||
      cr.startTime !== br.startTime ||
      cr.endTime !== br.endTime ||
      cr.active !== br.active ||
      // #113 follow-up：不計扣天是逐列欄位，改勾選即為未儲存變更
      (cr.skipDeduction ?? false) !== (br.skipDeduction ?? false)
    ) {
      return true;
    }
  }

  if (currentAliases.length !== baseline.aliases.length) return true;

  const baseAliasKeys = new Set(
    baseline.aliases.map((a) => `${a.rawBaseName}→${a.targetBaseName}`)
  );
  for (const a of currentAliases) {
    if (!baseAliasKeys.has(`${a.rawBaseName}→${a.targetBaseName}`)) {
      return true;
    }
  }

  if (baseline.classAttrs !== undefined || currentAttrs !== undefined) {
    const baseAttrs = baseline.classAttrs ?? [];
    const curAttrs = currentAttrs ?? [];
    if (baseAttrs.length !== curAttrs.length) return true;
    const baseAttrMap = new Map(baseAttrs.map((b) => [b.className, b]));
    for (const ca of curAttrs) {
      const ba = baseAttrMap.get(ca.className);
      if (!ba) return true;
      if (
        ca.classType !== ba.classType ||
        ca.hasMultiSubjectDiscount !== ba.hasMultiSubjectDiscount ||
        ca.category !== ba.category ||
        ca.categorySource !== ba.categorySource ||
        ca.fixedFiveDays !== ba.fixedFiveDays
      ) {
        return true;
      }
    }
  }

  return false;
}

/** ERP alias 映射：待設定 token → 已核准 seed 班級 */
export const AliasMappingSchema = z.object({
  rawBaseName: z.string().min(1),
  targetBaseName: z.string().min(1),
});

export type AliasMapping = z.infer<typeof AliasMappingSchema>;

/** 整套設定草稿（一次 preview/apply 的原子單位） */
const SettingsDraftObjectSchema = z.object({
  classes: z.array(ClassSettingSchema).min(1),
  aliases: z.array(AliasMappingSchema).default([]),
  careWindows: z.object({
    anqin: z.object({ startMinutes: z.number().int(), endMinutes: z.number().int() }),
    tutoring: z.object({ startMinutes: z.number().int(), endMinutes: z.number().int() }),
  }),
});

export const SettingsDraftSchema = SettingsDraftObjectSchema;

export type SettingsDraft = z.infer<typeof SettingsDraftSchema>;

/**
 * calculate 專用輸入（09 §8.1）：編輯中的 draft 允許「不完整列」——起或迄為 null，或迄 ≤ 起——
 * 並可帶 client 的 rowId（對應 ScheduleGridRow.rowId，server 原樣回傳）。
 * 這只用於唯讀計算；settings/preview 與 apply 仍用 SettingsDraftSchema（只收完整時段）。
 * 存檔時不完整列會被 gridRowsToClasses 丟掉，calculate 以 toSaveEquivalentDraft 取得同樣的結果。
 */
export const CalculateSessionSchema = z.object({
  rowId: z.string().min(1).max(200).optional(),
  /**
   * 09 §3.1（11 §3 A；F01）：calculate 接受空白與過長的星期，並回該列 unknown_weekday 的問題，
   * 不讓一個未填好的星期使整個唯讀計算回 400。這只放寬唯讀輸入；存檔契約（SavedWeekdaySchema：1–8 字元）不變，
   * 空白星期的完整時段列送 settings/preview 仍回 400。上限 64 只擋不合理的 payload。
   */
  weekday: z.string().max(64),
  startMinutes: z.number().int().min(0).max(1440).nullable().default(null),
  endMinutes: z.number().int().min(0).max(1440).nullable().default(null),
  /** #113 follow-up：逐時段的不計扣天（唯讀計算也要看得到每一列自己的勾選）。 */
  skipDeduction: z.boolean().default(false),
});

export type CalculateSession = z.infer<typeof CalculateSessionSchema>;

export const CalculateClassSchema = ClassSettingObjectSchema.extend({
  sessions: z.array(CalculateSessionSchema).default([]),
}).superRefine(validateClassSetting);

export const CalculateDraftSchema = SettingsDraftObjectSchema.extend({
  classes: z.array(CalculateClassSchema).min(1),
});

export type CalculateDraft = z.infer<typeof CalculateDraftSchema>;

/**
 * ScheduleGridRow[] → calculate 用班級：與 gridRowsToClasses 同一套分組，
 * 差別只在 sessions 保留「每一列」（含不完整列）並帶 grid 的 rowId，讓結果能一對一掛回畫面的列。
 * #113 follow-up：逐列帶上自己的 `skipDeduction`，唯讀計算因此與存檔後的 run 同源。
 */
export function gridRowsToCalculateClasses(
  rows: ScheduleGridRow[],
  existingClasses?: ClassSetting[]
): CalculateDraft['classes'] {
  return groupGridRowsToClasses(rows, existingClasses, (_classType, classRows) => ({
    sessions: classRows.map((r) => ({
      rowId: r.rowId,
      weekday: r.weekday,
      startMinutes: r.startMinutes,
      endMinutes: r.endMinutes,
      skipDeduction: r.skipDeduction ?? false,
    })),
  }));
}

export const SettingsPreviewRequestSchema = z.object({
  draft: SettingsDraftSchema,
  expectedRevision: z.number().int().min(0),
});

export const SettingsApplyRequestSchema = z.object({
  previewId: z.string().min(1),
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(1),
});
