import Database from 'better-sqlite3';
import { getLatestSettingsVersion, buildSeedDraft } from '@/adapters/sqlite/settings-repository';
import { classifyErpDualTrack } from '@/domain/schedules/seed-manifest';
import type { SettingsDraft } from '@/contracts/settings';

/**
 * 待確認的 ERP 班名＝既不是目前課表裡的班，也沒有被「班名對應」解析到課表裡的班。
 *
 * 課表以「最新已儲存設定」為準，尚無才用 seed（與課表設定頁 `/settings` 同源同判斷，
 * 兩頁對同一份名單的待確認數才會一致）。
 */
export function findPendingClassNames(db: Database.Database, erpBaseNames: string[]): string[] {
  const latest = getLatestSettingsVersion(db);
  const draft: SettingsDraft = latest ? (JSON.parse(latest.contentJson) as SettingsDraft) : buildSeedDraft();
  const result = classifyErpDualTrack(
    Array.from(new Set(erpBaseNames)),
    draft.classes.map((c) => c.baseName),
    draft.aliases
  );
  return result.activeView.unmatched;
}
