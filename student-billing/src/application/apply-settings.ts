import Database from 'better-sqlite3';
import crypto from 'crypto';
import { SettingsApplyRequestSchema } from '@/contracts/settings';
import {
  getSettingsPreview,
  hashSettingsDraft,
  saveSettingsVersion,
  draftToAliasMap,
  draftToScheduleOverride,
} from '@/adapters/sqlite/settings-repository';
import { executeCalculationRun } from './calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';

export class SettingsApplyError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, message: string, code = 'SETTINGS_APPLY_FAILED') {
    super(message);
    this.name = 'SettingsApplyError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface SettingsApplyResult {
  settingsVersionId: string;
  runId: string;
  revision: number;
  totalStudents: number;
  mismatchCount: number;
}

/**
 * T05: 套用設定預覽（payload 一致性＋CAS＋快照封存＋重算新 run，原子交易）。
 */
export function applySettingsPreview(
  db: Database.Database,
  rawBody: unknown
): SettingsApplyResult {
  const parsed = SettingsApplyRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new SettingsApplyError(400, `套用請求格式錯誤：${parsed.error.message}`, 'INVALID_REQUEST');
  }
  const { previewId, expectedRevision, idempotencyKey } = parsed.data;

  const preview = getSettingsPreview(db, previewId);
  if (!preview) {
    throw new SettingsApplyError(404, `找不到設定預覽 ${previewId}（可能已過期或 previewId 錯誤）`, 'PREVIEW_NOT_FOUND');
  }
  if (preview.expectedRevision !== expectedRevision) {
    throw new SettingsApplyError(
      409,
      `版本衝突：預覽建立時 revision 為 ${preview.expectedRevision}，請求為 ${expectedRevision}，請重新預覽`,
      'REVISION_CONFLICT'
    );
  }

  const active = db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as any;
  if (!active) throw new SettingsApplyError(500, 'ActiveState 未初始化');
  if (active.revision !== expectedRevision) {
    throw new SettingsApplyError(
      409,
      `版本衝突：目前 revision 為 ${active.revision}，請求為 ${expectedRevision}`,
      'REVISION_CONFLICT'
    );
  }

  // 冪等性：同 key 回原結果
  const existingIdemp = db
    .prepare('SELECT response_payload FROM idempotency_records WHERE idempotency_key = ?')
    .get(idempotencyKey) as { response_payload: string } | undefined;
  if (existingIdemp) {
    return JSON.parse(existingIdemp.response_payload) as SettingsApplyResult;
  }

  const draft = JSON.parse(preview.draftJson);
  const inputHash = hashSettingsDraft(draft);
  if (inputHash !== preview.inputHash) {
    throw new SettingsApplyError(500, '預覽草稿完整性檢查失敗', 'PREVIEW_CORRUPTED');
  }

  const settingsVersionId = `setv_${inputHash.slice(0, 12)}_${Date.now()}`;
  const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const nextRevision = active.revision + 1;
  const now = new Date().toISOString();

  let result!: SettingsApplyResult;

  const txn = db.transaction(() => {
    // 封存設定快照
    saveSettingsVersion(db, {
      id: settingsVersionId,
      contentHash: inputHash,
      contentJson: preview.draftJson,
      effectiveFrom: draft.effectiveFrom ?? null,
      effectiveTo: draft.effectiveTo ?? null,
      createdAt: now,
      createdFromPreviewId: previewId,
      revision: nextRevision,
    });

    // 以新設定重算（alias + schedule 覆寫）
    const aliasMap = draftToAliasMap(draft);
    const scheduleOverride = draftToScheduleOverride(draft);
    const { run, results } = executeCalculationRun(db, preview.importId, runId, {
      scheduleVersionId: settingsVersionId,
      aliasMap,
      scheduleOverride,
    });
    saveCalculationRun(db, run, results);

    const mismatchCount = results.filter((r) => r.tierMismatch).length;

    db.prepare(
      `UPDATE active_state SET active_import_id = ?, active_run_id = ?, revision = ?, updated_at = ? WHERE id = 1`
    ).run(preview.importId, runId, nextRevision, now);

    result = {
      settingsVersionId,
      runId,
      revision: nextRevision,
      totalStudents: results.length,
      mismatchCount,
    };

    db.prepare(
      `INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(idempotencyKey, inputHash, runId, JSON.stringify(result), now);
  });

  txn();
  return result;
}
