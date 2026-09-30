import Database from 'better-sqlite3';
import { SettingsDraft } from '@/contracts/settings';
import { buildSeedDraft, getSettingsVersionById, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import { SEED_SCHEDULE_VERSION_ID } from './calculate-run';

/**
 * run 的設定快照載入（D1；03 §4.3）：所有「讀歷史 run」的入口（班級扣天、待設定班級、comparison、classes、
 * 班名比對報告）共用這一個載入函式，一律讀「該 run 當時的設定快照」——不用最新設定補算，也不退回 seed 猜。
 *
 * run.scheduleVersionId：
 *  - 'seed-v250922'：該 run 沒有任何已儲存設定，以 seed 課表計算（不帶 alias／時段覆寫）；
 *  - 其他：settings_versions.id。
 */
export interface RunSnapshot {
  draft: SettingsDraft;
  scheduleVersionId: string;
  /** 設定版本的 revision；seed 為 null */
  settingsRevision: number | null;
}

/** 以 run 的 scheduleVersionId 還原當時設定；資料不足（設定版本不存在）回 null＝無法判定。 */
export function loadRunSnapshot(db: Database.Database, scheduleVersionId: string): RunSnapshot | null {
  if (scheduleVersionId === SEED_SCHEDULE_VERSION_ID) {
    return { draft: buildSeedDraft(), scheduleVersionId, settingsRevision: null };
  }
  const version = getSettingsVersionById(db, scheduleVersionId);
  if (!version) return null;
  return {
    draft: readStoredDraft(version.contentJson),
    scheduleVersionId: version.id,
    settingsRevision: version.revision,
  };
}
