import Database from 'better-sqlite3';
import { SettingsDraft } from '@/contracts/settings';
import {
  buildSeedDraft,
  draftToAliasMap,
  draftToScheduleOverride,
  getLatestSettingsVersion,
  hashSettingsDraft,
  readStoredDraft,
} from '@/adapters/sqlite/settings-repository';
import { getCalculationRun, getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { SEED_SCHEDULE_VERSION_ID } from './calculate-run';
import { buildSchedulePreview, SchedulePreviewCore, SchedulePreviewError } from './schedule-preview';
import { isFormalRuleSetVersion } from '@/domain/billing/rule-set';
import { resolveFormalRuleSetVersion } from './rule-set-resolver';
import { loadRunSnapshot } from './run-snapshot';

/**
 * GET /api/v1/settings/deductions（09 §8.1、§5.2）：班級扣天的固定快照，只讀不寫。
 * - 指定 runId：讀該 run 當時的課表快照（run.scheduleVersionId 指向的設定版本／seed），不用最新課表補舊 run；
 * - 未指定且有 active run：讀 active run 的快照；
 * - 無 active run：讀最新已儲存設定；連已儲存設定都沒有才讀 seed 預設課表。
 */

export type DeductionsScope = 'run' | 'active_run' | 'saved_settings' | 'seed';

export interface DeductionsResponse extends SchedulePreviewCore {
  scope: DeductionsScope;
  runId: string | null;
  scheduleVersionId: string;
  /** 設定版本的 revision；seed 為 null */
  settingsRevision: number | null;
  draftHash: string;
}

function respondForRun(db: Database.Database, runId: string, scope: 'run' | 'active_run'): DeductionsResponse {
  const run = getCalculationRun(db, runId);
  if (!run) {
    throw new SchedulePreviewError(404, `找不到計算 run: ${runId}`, 'RUN_NOT_FOUND');
  }
  // 只為可辨識的歷史版本重建；unknown/corrupt 版本不能套用任一版本的規則猜測。
  if (!isFormalRuleSetVersion(run.ruleSetVersion)) {
    throw new SchedulePreviewError(
      422,
      'run 使用無法辨識或不支援的規則版本，無法安全重建班級扣天。',
      'UNSUPPORTED_RULESET'
    );
  }
  const snapshot = loadRunSnapshot(db, run.scheduleVersionId);
  if (!snapshot) {
    throw new SchedulePreviewError(
      409,
      `找不到該 run 當時的課表快照（版本 ${run.scheduleVersionId}）：資料不足，無法重建，不會改用最新設定補算。`,
      'SNAPSHOT_UNAVAILABLE'
    );
  }
  return {
    scope,
    runId: run.id,
    scheduleVersionId: snapshot.scheduleVersionId,
    settingsRevision: snapshot.settingsRevision,
    draftHash: hashSettingsDraft(snapshot.draft),
    ...buildSchedulePreview(snapshot.draft, run.ruleSetVersion),
  };
}

export function getScheduleDeductions(db: Database.Database, options: { runId?: string } = {}): DeductionsResponse {
  if (options.runId !== undefined) {
    return respondForRun(db, options.runId, 'run');
  }

  const active = getCurrentActiveRun(db);
  if (active.activeRunId) {
    return respondForRun(db, active.activeRunId, 'active_run');
  }

  const latest = getLatestSettingsVersion(db);
  const ruleSetVersion = resolveFormalRuleSetVersion(db);
  if (latest) {
    const draft = readStoredDraft(latest.contentJson);
    return {
      scope: 'saved_settings',
      runId: null,
      scheduleVersionId: latest.id,
      settingsRevision: latest.revision,
      draftHash: hashSettingsDraft(draft),
      ...buildSchedulePreview(draft, ruleSetVersion),
    };
  }

  const seed = buildSeedDraft();
  return {
    scope: 'seed',
    runId: null,
    scheduleVersionId: SEED_SCHEDULE_VERSION_ID,
    settingsRevision: null,
    draftHash: hashSettingsDraft(seed),
    ...buildSchedulePreview(seed, ruleSetVersion),
  };
}

/**
 * 待設定班級（09 §8.3：取代 UI 的 UNMAPPED_CLASSES 固定集合）。
 *
 * ERP 班名經班名對應（alias）解析後，仍不在該 run 當時課表快照的班級清單裡，就是「待設定」。
 * 判斷來源是 run 的課表快照（與班級扣天同一份），不是寫死的班名，也不是最新設定
 * （歷史 run 不得套用最新設定，§5.2）。
 * 找不到 run，或當時的課表快照已不存在（資料不足）時回 null＝無法判斷；呼叫端不顯示提示，也不猜。
 */
export function findUnmappedClasses(db: Database.Database, runId: string, classNames: string[]): string[] | null {
  const run = getCalculationRun(db, runId);
  if (!run) return null;
  const snapshot = loadRunSnapshot(db, run.scheduleVersionId);
  if (!snapshot) return null;

  const alias = draftToAliasMap(snapshot.draft);
  const known = draftToScheduleOverride(snapshot.draft);
  return classNames.filter((name) => !known.has(alias.get(name) ?? name));
}
