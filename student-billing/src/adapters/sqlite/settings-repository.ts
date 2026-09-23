import Database from 'better-sqlite3';
import crypto from 'crypto';
import { SettingsDraft } from '@/contracts/settings';

export interface SettingsVersionRecord {
  id: string;
  contentHash: string;
  contentJson: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
  createdFromPreviewId: string | null;
  revision: number;
}

export interface SettingsPreviewRecord {
  previewId: string;
  inputHash: string;
  draftJson: string;
  expectedRevision: number;
  settingsVersionId: string;
  importId: string;
  resultJson: string;
  createdAt: string;
}

export function hashSettingsDraft(draft: SettingsDraft): string {
  return crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
}

function rowToVersion(row: any): SettingsVersionRecord {
  return {
    id: row.id,
    contentHash: row.content_hash,
    contentJson: row.content_json,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    createdFromPreviewId: row.created_from_preview_id,
    revision: row.revision,
  };
}

/** 取得指定 revision 對應的設定版本；null 表示初始 seed 預設設定。 */
export function getSettingsVersion(
  db: Database.Database,
  revision: number | null
): SettingsVersionRecord | null {
  if (revision === null || revision === 0) return null;
  const row = db
    .prepare('SELECT * FROM settings_versions WHERE revision = ?')
    .get(revision) as any;
  return row ? rowToVersion(row) : null;
}

/** 取得最新設定版本；無則回 null（使用 seed 預設）。 */
export function getLatestSettingsVersion(
  db: Database.Database
): SettingsVersionRecord | null {
  const row = db
    .prepare('SELECT * FROM settings_versions ORDER BY revision DESC LIMIT 1')
    .get() as any;
  return row ? rowToVersion(row) : null;
}

export function getSettingsPreview(
  db: Database.Database,
  previewId: string
): SettingsPreviewRecord | null {
  const row = db
    .prepare('SELECT * FROM settings_previews WHERE preview_id = ?')
    .get(previewId) as any;
  if (!row) return null;
  return {
    previewId: row.preview_id,
    inputHash: row.input_hash,
    draftJson: row.draft_json,
    expectedRevision: row.expected_revision,
    settingsVersionId: row.settings_version_id,
    importId: row.import_id,
    resultJson: row.result_json,
    createdAt: row.created_at,
  };
}

export function saveSettingsPreview(
  db: Database.Database,
  record: SettingsPreviewRecord
): void {
  db.prepare(
    `INSERT INTO settings_previews
      (preview_id, input_hash, draft_json, expected_revision, settings_version_id, import_id, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.previewId,
    record.inputHash,
    record.draftJson,
    record.expectedRevision,
    record.settingsVersionId,
    record.importId,
    record.resultJson,
    record.createdAt
  );
}

export function saveSettingsVersion(
  db: Database.Database,
  record: SettingsVersionRecord
): void {
  db.prepare(
    `INSERT INTO settings_versions
      (id, content_hash, content_json, effective_from, effective_to, created_at, created_from_preview_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.contentHash,
    record.contentJson,
    record.effectiveFrom,
    record.effectiveTo,
    record.createdAt,
    record.createdFromPreviewId,
    record.revision
  );
}

/** 將草稿轉為計算管線可用的 aliasMap。 */
export function draftToAliasMap(draft: SettingsDraft): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of draft.aliases) {
    map.set(a.rawBaseName, a.targetBaseName);
  }
  return map;
}

/** 將草稿轉為計算管線可用的 scheduleOverride。
 * 僅含明確填寫時段的班級；sessions 為空表示「未變更」，沿用 seed 預設時段，
 * 避免空陣列誤把全體 seed 時段清空。 */
export function draftToScheduleOverride(
  draft: SettingsDraft
): Map<string, Array<{ start: number; end: number }>> {
  const map = new Map<string, Array<{ start: number; end: number }>>();
  for (const c of draft.classes) {
    if (c.sessions.length === 0) continue;
    map.set(
      c.baseName,
      c.sessions.map((s) => ({ start: s.startMinutes, end: s.endMinutes }))
    );
  }
  return map;
}

/** 由 seed 預設產生初始草稿（供 UI 編輯起點）。 */
export function buildSeedDraft(
  seedClasses: Array<{ baseName: string; subject: string; teacher?: string | null }>,
  careWindows: { anqin: { start: number; end: number }; tutoring: { start: number; end: number } }
): SettingsDraft {
  return {
    classes: seedClasses.map((c) => ({
      baseName: c.baseName,
      subject: c.subject,
      teacher: c.teacher ?? null,
      active: true,
      sessions: [],
    })),
    aliases: [],
    careWindows: {
      anqin: { startMinutes: careWindows.anqin.start, endMinutes: careWindows.anqin.end },
      tutoring: { startMinutes: careWindows.tutoring.start, endMinutes: careWindows.tutoring.end },
    },
    effectiveFrom: null,
    effectiveTo: null,
  };
}
