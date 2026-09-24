import { z } from 'zod';
import seedData from '../domain/schedules/schedule-seed.json';
import { deriveSubject } from '../domain/schedules/seed-manifest';

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

/** 時段 session（分鐘制） */
export const SessionSchema = z.object({
  weekday: z.string().min(1).max(8),
  startMinutes: z.number().int().min(0).max(1440),
  endMinutes: z.number().int().min(0).max(1440),
}).refine((s) => s.endMinutes > s.startMinutes, { message: 'endMinutes 必須大於 startMinutes' });

export type Session = z.infer<typeof SessionSchema>;

/** 單一班級設定 */
export const ClassSettingSchema = z.object({
  baseName: z.string().min(1),
  subject: z.string().min(1),
  teacher: z.string().nullable().default(null),
  active: z.boolean().default(true),
  sessions: z.array(SessionSchema).default([]),
});

export type ClassSetting = z.infer<typeof ClassSettingSchema>;

/** 平鋪排課時段列（對齊 S 表五欄平鋪模型，R4:E96 89 筆；支援空時段佔位列） */
export const ScheduleGridRowSchema = z
  .object({
    rowId: z.string().min(1),
    className: z.string().min(1, { message: '班級名稱不可為空' }),
    teacher: z.string().nullable().default(null),
    weekday: z.string().min(1).max(8),
    startTime: z.string().refine((val) => val === '' || /^([01]\d|2[0-3]):([0-5]\d)$/.test(val), {
      message: '起始時間格式必須為 HH:mm 或留空',
    }),
    endTime: z.string().refine((val) => val === '' || /^([01]\d|2[0-3]):([0-5]\d)$/.test(val), {
      message: '結束時間格式必須為 HH:mm 或留空',
    }),
    startMinutes: z.number().int().min(0).max(1440).nullable().default(null),
    endMinutes: z.number().int().min(0).max(1440).nullable().default(null),
    active: z.boolean().default(true),
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
    const isCareWindow = cls.source === 'care_window';
    for (const session of cls.sessions) {
      const hasStart = session.startMinutes !== null && session.startMinutes !== undefined;
      const hasEnd = session.endMinutes !== null && session.endMinutes !== undefined;
      const weekday = session.weekday ?? (isCareWindow ? '一~五' : '—');
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
      });
    }
  }

  return rows;
}

/** 將平鋪時段列聚合為 ClassSetting[] 結構（F1: null 時段列不產出實體 session） */
export function gridRowsToClasses(
  rows: ScheduleGridRow[],
  existingClasses?: ClassSetting[]
): ClassSetting[] {
  const existingMap = new Map<string, ClassSetting>();
  if (existingClasses) {
    for (const c of existingClasses) {
      existingMap.set(c.baseName, c);
    }
  }

  const grouped = new Map<string, ScheduleGridRow[]>();
  for (const r of rows) {
    if (!grouped.has(r.className)) {
      grouped.set(r.className, []);
    }
    grouped.get(r.className)!.push(r);
  }

  const classes: ClassSetting[] = [];
  for (const [className, classRows] of grouped.entries()) {
    const existing = existingMap.get(className);
    const subject = existing?.subject ?? deriveSubject(className);
    const teacher = classRows[0]?.teacher ?? existing?.teacher ?? null;
    const active = classRows.some((r) => r.active);

    const sessions = classRows
      .filter((r) => r.startMinutes !== null && r.endMinutes !== null && r.endMinutes > r.startMinutes)
      .map((r) => ({
        weekday: r.weekday,
        startMinutes: r.startMinutes!,
        endMinutes: r.endMinutes!,
      }));

    classes.push({
      baseName: className,
      subject,
      teacher,
      active,
      sessions,
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
        });
      }
    } else {
      // F2: 空時段班級展平為佔位列，保留該班級在平鋪表格之可見性與可編輯性
      rows.push({
        rowId: `grid-${c.baseName}-${rowSeq++}`,
        className: c.baseName,
        teacher: c.teacher,
        weekday: '—',
        startTime: '',
        endTime: '',
        startMinutes: null,
        endMinutes: null,
        active: c.active,
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

/** ERP alias 映射：待設定 token → 已核准 seed 班級 */
export const AliasMappingSchema = z.object({
  rawBaseName: z.string().min(1),
  targetBaseName: z.string().min(1),
});

export type AliasMapping = z.infer<typeof AliasMappingSchema>;

/** 整套設定草稿（一次 preview/apply 的原子單位） */
export const SettingsDraftSchema = z.object({
  classes: z.array(ClassSettingSchema).min(1),
  aliases: z.array(AliasMappingSchema).default([]),
  careWindows: z.object({
    anqin: z.object({ startMinutes: z.number().int(), endMinutes: z.number().int() }),
    tutoring: z.object({ startMinutes: z.number().int(), endMinutes: z.number().int() }),
  }),
  effectiveFrom: z.string().nullable().default(null),
  effectiveTo: z.string().nullable().default(null),
});

export type SettingsDraft = z.infer<typeof SettingsDraftSchema>;

export const SettingsPreviewRequestSchema = z.object({
  draft: SettingsDraftSchema,
  expectedRevision: z.number().int().min(0),
});

export const SettingsApplyRequestSchema = z.object({
  previewId: z.string().min(1),
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(1),
});
