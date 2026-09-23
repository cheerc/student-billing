import { z } from 'zod';

/** 時段 session（分鐘制） */
export const SessionSchema = z.object({
  weekday: z.string().min(1).max(8),
  startMinutes: z.number().int().min(0).max(1440),
  endMinutes: z.number().int().min(0).max(1440),
}).refine((s) => s.endMinutes > s.startMinutes, { message: 'endMinutes 必須大於 startMinutes' });

/** 單一班級設定 */
export const ClassSettingSchema = z.object({
  baseName: z.string().min(1),
  subject: z.string().min(1),
  teacher: z.string().nullable().default(null),
  active: z.boolean().default(true),
  sessions: z.array(SessionSchema).default([]),
});

export type ClassSetting = z.infer<typeof ClassSettingSchema>;

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
