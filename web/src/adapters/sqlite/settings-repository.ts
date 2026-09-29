import Database from 'better-sqlite3';
import crypto from 'crypto';
import {
  SettingsDraft,
  buildSeedGridRows,
  gridRowsToClasses,
} from '@/contracts/settings';

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
  /** with_students＝鎖定的現行名單批次；settings_only＝null（09 §8.2.3，migration 0006 起可 null） */
  importId: string | null;
  resultJson: string;
  createdAt: string;
  expiresAt?: string | null;
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

/** 以版本 id 取得設定版本（run 的 scheduleVersionId 指向它）；不存在回 null。 */
export function getSettingsVersionById(
  db: Database.Database,
  id: string
): SettingsVersionRecord | null {
  const row = db.prepare('SELECT * FROM settings_versions WHERE id = ?').get(id) as any;
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
    expiresAt: row.expires_at ?? null,
  };
}

export function saveSettingsPreview(
  db: Database.Database,
  record: SettingsPreviewRecord
): void {
  const cols = db.prepare("PRAGMA table_info(settings_previews)").all() as Array<{ name: string }>;
  const hasExpiresAt = cols.some((c) => c.name === 'expires_at');

  if (hasExpiresAt) {
    db.prepare(
      `INSERT INTO settings_previews
        (preview_id, input_hash, draft_json, expected_revision, settings_version_id, import_id, result_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.previewId,
      record.inputHash,
      record.draftJson,
      record.expectedRevision,
      record.settingsVersionId,
      record.importId,
      record.resultJson,
      record.createdAt,
      record.expiresAt ?? null
    );
  } else {
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

/** 將草稿轉為計算管線可用的 scheduleOverride（09 §8.2.4 方案 A）。
 * 已儲存設定版本的全量 draft 是班級與時段的唯一來源（D25），seed 只作「尚無任何已儲存設定」的初始值：
 * - active 且有時段的班級 → 該時段；
 * - active 但 sessions 為空（刪光時段、清空所有列時間）＝無時段 → 空陣列（計算端判 schedule_empty，不扣天）；
 * - active=false → 空陣列（不扣天）；
 * - 班級不在 draft 內＝無此班 → 不出現於 map，計算端在有 override 時判 schedule_not_found（不退回 seed）。 */
export function draftToScheduleOverride(
  draft: SettingsDraft
): Map<string, Array<{ start: number; end: number; weekday?: string | null }>> {
  const map = new Map<string, Array<{ start: number; end: number; weekday?: string | null }>>();
  for (const c of draft.classes) {
    if (!c.active || c.sessions.length === 0) {
      map.set(c.baseName, []);
      continue;
    }
    map.set(
      c.baseName,
      c.sessions.map((s) => ({ start: s.startMinutes, end: s.endMinutes, weekday: s.weekday }))
    );
  }
  return map;
}

/** 由 seed 預設產生初始草稿（攜帶全量 89 筆平鋪時段消空 sessions 雙義性）。 */
export function buildSeedDraft(
  seedClasses?: Array<{ baseName: string; subject: string; teacher?: string | null }>,
  careWindows?: { anqin: { start: number; end: number }; tutoring: { start: number; end: number } }
): SettingsDraft {
  const seedRows = buildSeedGridRows();
  const fullSeedClasses = gridRowsToClasses(seedRows);

  return {
    classes: fullSeedClasses,
    aliases: [],
    careWindows: {
      anqin: {
        startMinutes: careWindows?.anqin?.start ?? 780,
        endMinutes: careWindows?.anqin?.end ?? 960,
      },
      tutoring: {
        startMinutes: careWindows?.tutoring?.start ?? 990,
        endMinutes: careWindows?.tutoring?.end ?? 1170,
      },
    },
    effectiveFrom: null,
    effectiveTo: null,
  };
}
