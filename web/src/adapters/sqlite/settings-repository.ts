import Database from 'better-sqlite3';
import crypto from 'crypto';
import {
  ClassSetting,
  DEFAULT_CARE_CLASS_NAMES,
  SettingsDraft,
  buildSeedGridRows,
  gridRowsToClasses,
  supportsMultiSubjectDiscount,
} from '@/contracts/settings';
import { isFiveClassType, normalizeLegacyClassSetting } from '@/domain/classification/class-attributes';
import { SEED_CLASSES, SEED_CLASS_TYPES } from '@/domain/schedules/seed-manifest';

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
  /**
   * preview 當下由 server 決定的目標規則版本（migration 0007；D1 F-3）。apply 只讀這個值建 run。
   * null／未記錄＝0007 之前建立的舊 preview（見 resolveRuleSetForApply）。
   */
  targetRuleSetVersion?: string | null;
}

/**
 * 已存設定 JSON（settings_versions.content_json）唯一的讀取入口（D1 F-11；03 §4.2）。
 *
 * 之前有 7 處各自 `JSON.parse(x.contentJson) as SettingsDraft`，全部繞過 zod。之後設定草稿新增欄位時，
 * 舊 JSON 沒有這些欄位、且 `.default()` 不會套用在這種讀取上，每個讀取點會各自處理「欄位缺失」。
 * 收斂成單一入口後，欄位缺失的處理只有一處。
 *
 * 版本界線規則（D1 定案，寫入 03）：
 *  1. v1／v2 的計算與讀取永遠不讀新欄位；
 *  2. 欄位缺失＝未設定，只在（D2 之後的）新規則版本讀取當下解析，不回寫舊快照；
 *  3. 新快照一律寫出完整欄位；
 *  4. 新規則版本的 run 建立時，把「實際採用的類別」寫入 run_class_categories，之後不再重新偵測。
 * D1 沒有新欄位，因此本函式「不改形狀」：不補預設、不去除未知欄位、不改變欄位順序——
 * 否則 deductions 回傳的 draftHash（＝sha256(JSON.stringify(draft))）會與 D1 前不同。
 * 無效 JSON 與原本一致，拋出 SyntaxError（不吞錯、不回預設）。
 */
export function readStoredDraft(contentJson: string): SettingsDraft {
  const draft = JSON.parse(contentJson) as SettingsDraft;
  if (Array.isArray(draft?.classes)) {
    for (const cls of draft.classes) {
      if ((cls.categorySource as string) === 'auto') {
        cls.categorySource = 'unset';
      }
      if (cls.classType === 'non_care' || (cls.classType === 'care' && cls.hasMultiSubjectDiscount === undefined)) {
        const norm = normalizeLegacyClassSetting(cls.baseName, cls);
        cls.classType = norm.classType;
        cls.hasMultiSubjectDiscount = norm.hasMultiSubjectDiscount;
        // D61 Ruling 2：舊 'non_care' 歸入 'other' 之既有時段預設轉為 skipDeduction: true，保持既有計算零突變。
        if (norm.migratedLegacyNonCareToOther && Array.isArray(cls.sessions)) {
          for (const s of cls.sessions) {
            if (!s.skipDeduction) {
              s.skipDeduction = true;
            }
          }
        }
      }
    }
  }
  return draft;
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
    targetRuleSetVersion: row.target_rule_set_version ?? null,
  };
}

export function saveSettingsPreview(
  db: Database.Database,
  record: SettingsPreviewRecord
): void {
  db.prepare(
    `INSERT INTO settings_previews (
      preview_id, input_hash, draft_json, expected_revision, settings_version_id,
      import_id, result_json, created_at, expires_at, target_rule_set_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.previewId,
    record.inputHash,
    record.draftJson,
    record.expectedRevision,
    record.settingsVersionId,
    record.importId,
    record.resultJson,
    record.createdAt,
    record.expiresAt ?? null,
    record.targetRuleSetVersion ?? null
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

/** draftToScheduleOverride 產出的單一時段：分鐘制起迄、星期與逐時段的不計扣天（#113 follow-up）。 */
export interface ScheduleOverrideSession {
  start: number;
  end: number;
  weekday?: string | null;
  /** 此時段勾選「不計扣天」→ 重疊照實計算，但不列入扣天。缺值＝未勾選＝false。 */
  skipDeduction?: boolean;
}

/** 將草稿轉為計算管線可用的 scheduleOverride（09 §8.2.4 方案 A）。
 * 已儲存設定版本的全量 draft 是班級與時段的唯一來源（D25），seed 只作「尚無任何已儲存設定」的初始值：
 * - active 且有時段的班級 → 該時段（逐時段帶自己的 skipDeduction，#113 follow-up）；
 * - active 但 sessions 為空（刪光時段、清空所有列時間）＝無時段 → 空陣列（計算端判 schedule_empty，不扣天）；
 * - active=false → 空陣列（不扣天）；
 * - 班級不在 draft 內＝無此班 → 不出現於 map，計算端在有 override 時判 schedule_not_found（不退回 seed）。 */
export function draftToScheduleOverride(
  draft: SettingsDraft
): Map<string, ScheduleOverrideSession[]> {
  const map = new Map<string, ScheduleOverrideSession[]>();
  for (const c of draft.classes) {
    if (!c.active || c.sessions.length === 0) {
      map.set(c.baseName, []);
      continue;
    }
    map.set(
      c.baseName,
      c.sessions.map((s) => ({
        start: s.startMinutes,
        end: s.endMinutes,
        weekday: s.weekday,
        skipDeduction: s.skipDeduction ?? false,
      }))
    );
  }
  return map;
}

/**
 * 由 seed 預設產生初始草稿（攜帶全量 89 筆平鋪時段消空 sessions 雙義性）。
 *
 * #157 Ruling 1：`category` 不再由班名推導。若此草稿完全不採 seed 基準，seed 班會全落為「未設定」。
 * 以同一份 rev 82 設定比較「舊 auto 班名偵測」與「全部 unset」，有報名者母體（372 位 distinct person_code）
 * 有 345 位（92.7%）科數不同；全部匯入學生母體（431 位 loadStudentsForImport）有 345 位（80.0%）不同。
 * 這是「不帶 seed 基準」的反事實量測，不是現行 seed 基準下的影響比例。
 *
 * seed 是**匯入前的既有機構設定**（不是使用者尚未填寫的空白），它在舊制下就對應到一組
 * 明確的類別。那組類別由 `seed-manifest` 的 `SEED_CLASS_CATEGORIES` 單一定義，並在
 * **「讀取已儲存設定」路徑**同樣套用（`effectiveCategoryOf` 的 seed 基準）。
 *
 * 因此本函式**刻意不寫** `category`／`categorySource`：
 *  - 寫 `manual` 會把 seed 基準偽裝成使用者的決定，正是 Ruling 5 要避免的；
 *  - 寫 `seed` 會讓 seed 基準看起來像被存進草稿的設定內容；
 *  - 不寫則全新 DB 與既有 DB 走的是**同一條** seed 基準路徑，對同一份設定算出相同結果。
 *
 * 使用者一旦自行指定（`manual`）或撤回（`unset`），該值會被寫進設定版本並優先於 seed 基準。
 */
export function buildSeedDraft(
  seedClasses?: Array<{ baseName: string; teacher?: string | null }>,
  careWindows?: { anqin: { start: number; end: number }; tutoring: { start: number; end: number } }
): SettingsDraft {
  const seedRows = buildSeedGridRows();
  const explicitSeedClasses: ClassSetting[] = (seedClasses ?? SEED_CLASSES).map((seed) => {
    const seedType =
      SEED_CLASS_TYPES.get(seed.baseName) ??
      (DEFAULT_CARE_CLASS_NAMES.has(seed.baseName) ? 'care' : 'other');
    return {
      baseName: seed.baseName,
      teacher: null,
      active: true,
      sessions: [],
      classType: seedType,
      hasMultiSubjectDiscount: supportsMultiSubjectDiscount(seedType),
    };
  });
  const fullSeedClasses = gridRowsToClasses(seedRows, explicitSeedClasses);

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
  };
}
