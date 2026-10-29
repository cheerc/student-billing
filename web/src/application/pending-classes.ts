import Database from 'better-sqlite3';
import { getLatestSettingsVersion, buildSeedDraft, readStoredDraft } from '@/adapters/sqlite/settings-repository';
import type { SettingsDraft } from '@/contracts/settings';

/**
 * 待確認的 ERP 班名＝既不是目前課表裡的班，也沒有被「班名對應」解析到課表裡的班。
 *
 * 課表以「最新已儲存設定」為準，尚無才用 seed（與課表設定頁 `/settings` 同源同判斷，
 * 兩頁對同一份名單的待確認數才會一致）。
 */
export function findPendingClassNames(db: Database.Database, erpBaseNames: string[]): string[] {
  const latest = getLatestSettingsVersion(db);
  const draft: SettingsDraft = latest ? readStoredDraft(latest.contentJson) : buildSeedDraft();
  const classNames = new Set(draft.classes.map((c) => c.baseName));
  const aliasMap = new Map(draft.aliases.map((a) => [a.rawBaseName.trim(), a.targetBaseName.trim()]));

  const pending = new Set<string>();
  for (const raw of erpBaseNames) {
    if (classNames.has(raw)) continue;
    const target = aliasMap.get(raw);
    if (target && classNames.has(target)) continue;
    pending.add(raw);
  }
  return Array.from(pending).sort((a, b) => a.localeCompare(b, 'zh-TW'));
}
