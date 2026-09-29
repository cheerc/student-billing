import Database from 'better-sqlite3';
import { SettingsDraft } from '@/contracts/settings';
import {
  buildSeedDraft,
  getLatestSettingsVersion,
  getSettingsVersionById,
  hashSettingsDraft,
} from '@/adapters/sqlite/settings-repository';
import { getCalculationRun, getCurrentActiveRun } from '@/adapters/sqlite/runs-repository';
import { SEED_SCHEDULE_VERSION_ID } from './calculate-run';
import {
  buildSchedulePreview,
  isFormalRuleSetVersion,
  resolveFormalRuleSetVersion,
  SchedulePreviewCore,
  SchedulePreviewError,
} from './schedule-preview';

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

interface Snapshot {
  draft: SettingsDraft;
  scheduleVersionId: string;
  settingsRevision: number | null;
}

/** 以 run 的 scheduleVersionId 還原當時課表；資料不足（設定版本不存在）回 null。 */
function loadRunSnapshot(db: Database.Database, scheduleVersionId: string): Snapshot | null {
  if (scheduleVersionId === SEED_SCHEDULE_VERSION_ID) {
    return { draft: buildSeedDraft(), scheduleVersionId, settingsRevision: null };
  }
  const version = getSettingsVersionById(db, scheduleVersionId);
  if (!version) return null;
  return {
    draft: JSON.parse(version.contentJson) as SettingsDraft,
    scheduleVersionId: version.id,
    settingsRevision: version.revision,
  };
}

function respondForRun(db: Database.Database, runId: string, scope: 'run' | 'active_run'): DeductionsResponse {
  const run = getCalculationRun(db, runId);
  if (!run) {
    throw new SchedulePreviewError(404, `找不到計算 run: ${runId}`, 'RUN_NOT_FOUND');
  }
  // 診斷軌 run 的值不能以正式規則重建
  if (!isFormalRuleSetVersion(run.ruleSetVersion)) {
    throw new SchedulePreviewError(
      422,
      `run 使用的規則版本「${run.ruleSetVersion}」為診斷軌，不提供班級扣天快照。`,
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
    const draft = JSON.parse(latest.contentJson) as SettingsDraft;
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
