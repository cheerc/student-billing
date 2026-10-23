import { z } from 'zod';
import seedData from '../domain/schedules/schedule-seed.json';
import { FORMAL_RULE_SET_VERSION_LIST } from '@/domain/billing/rule-set';
import { persistClassAttributes } from '@/domain/classification/persist-class-attributes';
import type { CategorySource, ClassCategory } from '@/domain/classification/class-category';

/**
 * seed 內的 8 個預設安親課輔班（source=care_window）。
 * 預設課程類型為 'care'，其餘 41 班預設為 'non_care'（specs/14 §3.9）。
 */
export const DEFAULT_CARE_CLASS_NAMES: ReadonlySet<string> = new Set(
  (seedData.classes as Array<{ baseName: string; source?: string }>)
    .filter((c) => c.source === 'care_window')
    .map((c) => c.baseName)
);

/** 舊設定檔中的兩個課程類型 id；新版本以 ClassTypeDefinition registry 為準。 */
export const ClassTypeSchema = z.enum(['care', 'non_care']);
export type ClassType = z.infer<typeof ClassTypeSchema>;
export type ClassTypeId = string;

/** 總表既有的八個天數欄位角色；不可擴成新欄位或計費公式。 */
export const SUMMARY_DAY_ROLES = [
  'anqinDays',
  'tutoringDays',
  'englishDays',
  'mathDays',
  'chineseDays',
  'homeworkDays',
  'intensiveEnglishDays',
  'saturdayTutoringDays',
] as const;
export const SummaryDayRoleSchema = z.enum(SUMMARY_DAY_ROLES);
export type SummaryDayRole = z.infer<typeof SummaryDayRoleSchema>;

/** 明確設定資料，不對應公式。`unset` 表示目前沒有核准的級距適用性。 */
export const ErpTierApplicabilitySchema = z.enum(['applicable', 'not_applicable', 'unset']);
export type ErpTierApplicability = z.infer<typeof ErpTierApplicabilitySchema>;

export const SemanticSettingSourceSchema = z.enum(['manual', 'seed', 'legacy_migration', 'unset']);
export type SemanticSettingSource = z.infer<typeof SemanticSettingSourceSchema>;

/** 僅支援既有畫面與固定欄位；這不是公式或 UI DSL。 */
export const ClassTypeScheduleModeSchema = z.enum(['care_window', 'timetable']);
export type ClassTypeScheduleMode = z.infer<typeof ClassTypeScheduleModeSchema>;

export const SupportedClassAttributeKeySchema = z.enum([
  'subject',
  'category',
  'fixedFiveDays',
  'skipDeduction',
  'summaryDayRoles',
  'erpTierApplicability',
]);
export type SupportedClassAttributeKey = z.infer<typeof SupportedClassAttributeKeySchema>;

export const ClassTypeDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, '課程類型 id 僅可使用小寫英數與底線'),
  label: z.string().trim().min(1).max(80),
  scheduleMode: ClassTypeScheduleModeSchema,
  supportedAttributeKeys: z.array(SupportedClassAttributeKeySchema).max(6),
  summaryRoleOptions: z.array(SummaryDayRoleSchema).max(SUMMARY_DAY_ROLES.length),
}).strict().superRefine((definition, ctx) => {
  if (definition.scheduleMode === 'care_window' && definition.supportedAttributeKeys.includes('skipDeduction')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supportedAttributeKeys'],
      message: '安親時段排課無逐時段不計扣天欄位',
    });
  }
  if (definition.scheduleMode === 'timetable' && definition.supportedAttributeKeys.includes('fixedFiveDays')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supportedAttributeKeys'],
      message: '個別時段排課無固定 5 天欄位',
    });
  }
});
export type ClassTypeDefinition = z.infer<typeof ClassTypeDefinitionSchema>;

/** 兩個既有排課形式的 bounded registry；其他 id 必須重用其中一種形式。 */
export const DEFAULT_CLASS_TYPE_DEFINITIONS: readonly ClassTypeDefinition[] = [
  {
    id: 'care',
    label: '安親課輔班',
    scheduleMode: 'care_window',
    supportedAttributeKeys: ['subject', 'category', 'fixedFiveDays', 'summaryDayRoles', 'erpTierApplicability'],
    summaryRoleOptions: [...SUMMARY_DAY_ROLES],
  },
  {
    id: 'non_care',
    label: '非安親課輔班',
    scheduleMode: 'timetable',
    supportedAttributeKeys: ['subject', 'category', 'skipDeduction', 'summaryDayRoles', 'erpTierApplicability'],
    summaryRoleOptions: [...SUMMARY_DAY_ROLES],
  },
];

export function classTypeDefinitionOf(
  id: string | undefined,
  definitions: readonly ClassTypeDefinition[] = DEFAULT_CLASS_TYPE_DEFINITIONS
): ClassTypeDefinition | undefined {
  return id ? definitions.find((definition) => definition.id === id) : undefined;
}

export function legacyClassTypeForDefinition(definition: ClassTypeDefinition): ClassType {
  return definition.scheduleMode === 'care_window' ? 'care' : 'non_care';
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

/** 單一班級設定 */
export const ClassSettingSchema = z.object({
  baseName: z.string().min(1),
  /** Independent display/filter dimension; empty means explicitly not configured. */
  subject: z.string().default(''),
  subjectSource: SemanticSettingSourceSchema.optional(),
  teacher: z.string().nullable().default(null),
  active: z.boolean().default(true),
  sessions: z.array(SessionSchema).default([]),
  /** Additive class-type reference; old classType remains readable during migration. */
  classTypeId: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  classType: ClassTypeSchema.optional(),
  category: z.enum(['care', 'math', 'english', 'none', 'unset']).optional(),
  /**
   * #157 Ruling 4：來源狀態為「使用者決定」（`manual`）、「seed 基準」（`seed`）、
   * 「未設定」（`unset`）。
   * `auto` 僅保留為舊資料的接受值——讀取時其值一律不採用（Ruling 5），不再寫回。
   */
  categorySource: z.enum(['auto', 'manual', 'unset', 'seed']).optional(),
  fixedFiveDays: z.boolean().optional(),
  summaryDayRoles: z.array(SummaryDayRoleSchema).max(SUMMARY_DAY_ROLES.length).optional(),
  summaryDayRolesStatus: z.enum(['configured', 'unset', 'unavailable']).optional(),
  summaryDayRolesSource: SemanticSettingSourceSchema.optional(),
  erpTierApplicability: ErpTierApplicabilitySchema.optional(),
  erpTierApplicabilitySource: SemanticSettingSourceSchema.optional(),
  /**
   * #113 follow-up：不計扣天已改為**逐時段**（`sessions[].skipDeduction`），不再是班級屬性。
   * 本欄保留為舊快照的相容讀取位（值一律視為無效，只被剝除、不被讀取），
   * 讓 #113 初版寫下的設定版本仍可解析、且不會被誤當成有效旗標。
   */
  skipDeduction: z.boolean().optional(),
  skipDeductionSource: z.enum(['auto', 'manual']).optional(),
});

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

/** 由 schedule-seed 產生全量 89 筆平鋪時段列（F1: 空時段原樣攜帶 null，不捏造假分鐘數） */
export function buildSeedGridRows(): ScheduleGridRow[] {
  const rows: ScheduleGridRow[] = [];
  let rowSeq = 1;

  for (const cls of seedData.classes) {
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
        skipDeduction: false,
      });
    }
  }

  return rows;
}

/** 將平鋪時段列聚合為 ClassSetting[] 結構（F1: null 時段列不產出實體 session）。
 *  #113 follow-up：完整列各自帶自己的 `skipDeduction`（逐時段），不同於 category／fixedFiveDays 的整班共用。 */
export function gridRowsToClasses(
  rows: ScheduleGridRow[],
  existingClasses?: ClassSetting[],
  definitions: readonly ClassTypeDefinition[] = DEFAULT_CLASS_TYPE_DEFINITIONS
): ClassSetting[] {
  return groupGridRowsToClasses(rows, existingClasses, definitions, (classRows) =>
    classRows.filter(isCompleteTimeRange).map((r) => ({
      weekday: r.weekday,
      startMinutes: r.startMinutes,
      endMinutes: r.endMinutes,
      skipDeduction: r.skipDeduction ?? false,
    }))
  );
}

/**
 * 平鋪列 → 班級的共用分組（存檔與 calculate 同一套：班名分組、subject／teacher／active 的決定方式），
 * 只有「每班的 sessions 怎麼產生」由呼叫端決定。
 */
function groupGridRowsToClasses<S>(
  rows: ScheduleGridRow[],
  existingClasses: ClassSetting[] | undefined,
  definitions: readonly ClassTypeDefinition[],
  toSessions: (classRows: ScheduleGridRow[]) => S[]
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
    // New names carry no semantic evidence. A subject is supplied by an explicit setting/seed row.
    const subject = existing?.subject ?? '';
    const teacher = classRows[0]?.teacher ?? existing?.teacher ?? null;
    const active = classRows.some((r) => r.active);

    const classTypeId = existing?.classTypeId ?? existing?.classType ??
      (existing === undefined && DEFAULT_CARE_CLASS_NAMES.has(className) ? 'care' : undefined);
    const definition = classTypeId ? classTypeDefinitionOf(classTypeId, definitions) : undefined;
    // Unknown custom ids fail closed to the neutral timetable layout. SettingsDraftSchema rejects
    // them before persistence; this fallback keeps an in-progress grid serializable.
    const classType: ClassType | undefined = definition
      ? legacyClassTypeForDefinition(definition)
      : existing?.classType;

    // Both editor save and grid serialization use this single source rule: manual/unset write,
    // seed/legacy auto do not, and explicit fixedFiveDays=false remains in the draft.
    const attrs = persistClassAttributes({
      classType,
      category: existing?.category,
      categorySource: existing?.categorySource,
      fixedFiveDays: existing?.fixedFiveDays,
    });

    classes.push({
      baseName: className,
      subject,
      subjectSource: existing?.subjectSource ?? (existing?.subject ? 'legacy_migration' : 'unset'),
      teacher,
      active,
      // specs/14 §3.6 & A5：安親課輔班（classType === 'care'）sessions 一律輸出為 []
      sessions: classType === 'care' ? [] : toSessions(classRows),
      classType,
      classTypeId,
      ...attrs,
      summaryDayRoles: existing?.summaryDayRoles ?? [],
      summaryDayRolesStatus: existing?.summaryDayRolesStatus ?? 'unset',
      summaryDayRolesSource: existing?.summaryDayRolesSource ?? 'unset',
      erpTierApplicability: existing?.erpTierApplicability ?? 'unset',
      erpTierApplicabilitySource: existing?.erpTierApplicabilitySource ?? 'unset',
    });
  }

  return classes;
}

/** 將 ClassSetting[] 展平為平鋪時段列（F2: 空 sessions 班級展平為佔位列，不丟失空班） */
export function classesToGridRows(classes: ClassSetting[]): ScheduleGridRow[] {
  const rows: ScheduleGridRow[] = [];
  let rowSeq = 1;

  for (const c of classes) {
    if (c.sessions.length > 0) {
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
    } else {
      // F2: 空時段班級展平為佔位列，保留該班級在平鋪表格之可見性與可編輯性。
      // 星期是**空字串**（#82：只有班名時段，其他欄可留空）——不要用 '—' 當佔位：
      // '—' 是 `normalizeWeekday` 不認得的非空值，會讓這一列被當成「需確認／無法識別的星期」，
      // 而且會讓 #81 的 Excel 匯出檔被自己的匯入端整批拒絕（匯入只接受一到日或空白）。
      // 畫面把空星期顯示成「未定」，所以這裡存空字串不會讓使用者看到空白欄。
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
        skipDeduction: false,
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
  classTypeId?: string;
  classType?: ClassType;
  category?: 'care' | 'math' | 'english' | 'none' | 'unset';
  categorySource?: CategorySource;
  fixedFiveDays?: boolean;
  subject?: string;
  summaryDayRoles?: SummaryDayRole[];
  summaryDayRolesStatus?: 'configured' | 'unset' | 'unavailable';
  summaryDayRolesSource?: SemanticSettingSource;
  erpTierApplicability?: ErpTierApplicability;
  erpTierApplicabilitySource?: SemanticSettingSource;
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
        ca.classTypeId !== ba.classTypeId ||
        ca.category !== ba.category ||
        ca.categorySource !== ba.categorySource ||
        ca.fixedFiveDays !== ba.fixedFiveDays ||
        ca.subject !== ba.subject ||
        JSON.stringify(ca.summaryDayRoles ?? []) !== JSON.stringify(ba.summaryDayRoles ?? []) ||
        ca.summaryDayRolesStatus !== ba.summaryDayRolesStatus ||
        ca.summaryDayRolesSource !== ba.summaryDayRolesSource ||
        ca.erpTierApplicability !== ba.erpTierApplicability ||
        ca.erpTierApplicabilitySource !== ba.erpTierApplicabilitySource
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
  /** Missing on old settings versions; the read model supplies the built-in registry in memory. */
  classTypeDefinitions: z.array(ClassTypeDefinitionSchema).max(32).optional(),
  aliases: z.array(AliasMappingSchema).default([]),
  careWindows: z.object({
    anqin: z.object({ startMinutes: z.number().int(), endMinutes: z.number().int() }),
    tutoring: z.object({ startMinutes: z.number().int(), endMinutes: z.number().int() }),
  }),
  effectiveFrom: z.string().nullable().default(null),
  effectiveTo: z.string().nullable().default(null),
});

function validateDraftSemantics(
  draft: {
    classes: Array<{
      classTypeId?: string;
      classType?: ClassType;
      subject?: string;
      category?: ClassCategory;
      fixedFiveDays?: boolean;
      summaryDayRoles?: SummaryDayRole[];
      summaryDayRolesStatus?: 'configured' | 'unset' | 'unavailable';
      erpTierApplicability?: ErpTierApplicability;
      sessions?: Array<{ skipDeduction?: boolean }>;
    }>;
    classTypeDefinitions?: ClassTypeDefinition[];
  },
  ctx: z.RefinementCtx
): void {
  const definitions = draft.classTypeDefinitions ?? DEFAULT_CLASS_TYPE_DEFINITIONS;
  const ids = new Set<string>();
  for (const [index, definition] of definitions.entries()) {
    if (ids.has(definition.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classTypeDefinitions', index, 'id'], message: '課程類型 id 不可重複' });
    }
    ids.add(definition.id);
  }
  for (const [id, requiredMode] of [['care', 'care_window'], ['non_care', 'timetable']] as const) {
    const builtin = definitions.find((definition) => definition.id === id);
    if (!builtin || builtin.scheduleMode !== requiredMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['classTypeDefinitions'],
        message: `必須保留內建課程類型 ${id} 與其排課形式`,
      });
    }
  }
  for (const [index, definition] of definitions.entries()) {
    if (definition.summaryRoleOptions.length > 0 && !definition.supportedAttributeKeys.includes('summaryDayRoles')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classTypeDefinitions', index, 'summaryRoleOptions'], message: '摘要角色選項需要宣告 summaryDayRoles 欄位' });
    }
  }
  for (const [index, cls] of draft.classes.entries()) {
    const id = cls.classTypeId ?? cls.classType;
    if (!id && draft.classTypeDefinitions !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classes', index, 'classTypeId'], message: '新設定班級必須明確選擇課程類型' });
      continue;
    }
    if (id && !ids.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classes', index, 'classTypeId'], message: `找不到課程類型 ${id}` });
      continue;
    }
    const definition = definitions.find((item) => item.id === id);
    if (!definition) continue;
    if (cls.classTypeId && cls.classType && legacyClassTypeForDefinition(definition) !== cls.classType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['classes', index, 'classType'],
        message: `相容課程類型與課程類型 ${id} 的排課形式不一致`,
      });
    }
    if (cls.subject?.trim() && !definition.supportedAttributeKeys.includes('subject')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classes', index, 'subject'], message: `課程類型 ${id} 不支援科目` });
    }
    if (cls.category && cls.category !== 'unset' && !definition.supportedAttributeKeys.includes('category')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classes', index, 'category'], message: `課程類型 ${id} 不支援折扣類別` });
    }
    if (cls.fixedFiveDays !== undefined && !definition.supportedAttributeKeys.includes('fixedFiveDays')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classes', index, 'fixedFiveDays'], message: `課程類型 ${id} 不支援固定 5 天` });
    }
    if (cls.sessions?.some((session) => session.skipDeduction === true) && !definition.supportedAttributeKeys.includes('skipDeduction')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classes', index, 'sessions'], message: `課程類型 ${id} 不支援不計扣天` });
    }
    const roles = cls.summaryDayRoles ?? [];
    for (const role of roles) {
      if (!definition.summaryRoleOptions.includes(role)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classes', index, 'summaryDayRoles'], message: `課程類型 ${id} 不支援 ${role}` });
        break;
      }
    }
    if ((roles.length > 0 || cls.summaryDayRolesStatus === 'configured') && !definition.supportedAttributeKeys.includes('summaryDayRoles')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classes', index, 'summaryDayRoles'], message: `課程類型 ${id} 不支援摘要角色` });
    }
    if (cls.erpTierApplicability && cls.erpTierApplicability !== 'unset' && !definition.supportedAttributeKeys.includes('erpTierApplicability')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classes', index, 'erpTierApplicability'], message: `課程類型 ${id} 不支援級距適用性` });
    }
  }
}

export const SettingsDraftSchema = SettingsDraftObjectSchema.superRefine(validateDraftSemantics);

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

export const CalculateClassSchema = ClassSettingSchema.extend({
  sessions: z.array(CalculateSessionSchema).default([]),
});

export const CalculateDraftSchema = SettingsDraftObjectSchema.extend({
  classes: z.array(CalculateClassSchema).min(1),
}).superRefine(validateDraftSemantics);

export type CalculateDraft = z.infer<typeof CalculateDraftSchema>;

/**
 * ScheduleGridRow[] → calculate 用班級：與 gridRowsToClasses 同一套分組，
 * 差別只在 sessions 保留「每一列」（含不完整列）並帶 grid 的 rowId，讓結果能一對一掛回畫面的列。
 * #113 follow-up：逐列帶上自己的 `skipDeduction`，唯讀計算因此與存檔後的 run 同源。
 */
export function gridRowsToCalculateClasses(
  rows: ScheduleGridRow[],
  existingClasses?: ClassSetting[],
  definitions: readonly ClassTypeDefinition[] = DEFAULT_CLASS_TYPE_DEFINITIONS
): CalculateDraft['classes'] {
  return groupGridRowsToClasses(rows, existingClasses, definitions, (classRows) =>
    classRows.map((r) => ({
      rowId: r.rowId,
      weekday: r.weekday,
      startMinutes: r.startMinutes,
      endMinutes: r.endMinutes,
      skipDeduction: r.skipDeduction ?? false,
    }))
  );
}

export const SettingsPreviewRequestSchema = z.object({
  draft: SettingsDraftSchema,
  expectedRevision: z.number().int().min(0),
  /**
   * D2b 4（Q11）：使用者明確確認升級時帶入的目標規則版本。
   * 缺省＝沿用現行正式軌版本（既有 v2 DB 因此不動、空 DB 得目標版本 erp-tag-v4）；
   * 帶入非正式軌版本（含診斷軌與未知字串）一律 400，不猜、不靜默降級。
   */
  targetRuleSetVersion: z.enum(FORMAL_RULE_SET_VERSION_LIST).optional(),
});

export const SettingsApplyRequestSchema = z.object({
  previewId: z.string().min(1),
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(1),
});
