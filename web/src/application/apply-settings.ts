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
  appliedAt: string;
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

  // B1: 冪等檢查先於 CAS（與 activate 同構）：相同 key＋同 body 的成功重送
  // 先回原成功結果，再處理新請求的 revision 檢查（03:76）。
  const bodyHash = `apply:${previewId}:${expectedRevision}`;
  const existingIdemp = db
    .prepare('SELECT request_body_hash, response_payload FROM idempotency_records WHERE idempotency_key = ?')
    .get(idempotencyKey) as
    | { request_body_hash: string; response_payload: string }
    | undefined;
  if (existingIdemp) {
    // N1: 同 key 異 body 不得靜默回放
    if (existingIdemp.request_body_hash !== bodyHash) {
      throw new SettingsApplyError(
        400,
        `相同 idempotencyKey「${idempotencyKey}」已被使用於不同的請求內容。`,
        'IDEMPOTENCY_CONFLICT'
      );
    }
    return JSON.parse(existingIdemp.response_payload) as SettingsApplyResult;
  }

  const preview = getSettingsPreview(db, previewId);
  if (!preview) {
    throw new SettingsApplyError(404, `找不到設定預覽 ${previewId}（可能已過期或 previewId 錯誤）`, 'PREVIEW_NOT_FOUND');
  }

  // TTL 逾期檢查 (15 分鐘失效，回 400 PREVIEW_EXPIRED)
  if (preview.expiresAt) {
    const expiresTime = new Date(preview.expiresAt).getTime();
    if (Date.now() > expiresTime) {
      throw new SettingsApplyError(
        400,
        `設定預覽已逾期 (PREVIEW_EXPIRED)：預覽有效期限為 15 分鐘，請重新執行 dry-run 預覽後再套用。`,
        'PREVIEW_EXPIRED'
      );
    }
  }

  if (preview.expectedRevision !== expectedRevision) {
    throw new SettingsApplyError(
      409,
      `版本衝突：預覽建立時 revision 為 ${preview.expectedRevision}，請求為 ${expectedRevision}，請重新預覽`,
      'REVISION_CONFLICT'
    );
  }

  const draft = JSON.parse(preview.draftJson);
  const inputHash = hashSettingsDraft(draft);
  if (inputHash !== preview.inputHash) {
    throw new SettingsApplyError(500, '預覽草稿完整性檢查失敗', 'PREVIEW_CORRUPTED');
  }

  const settingsVersionId = `setv_${inputHash.slice(0, 12)}_${Date.now()}`;
  const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const nextRevision = expectedRevision + 1;
  const now = new Date().toISOString();

  let result!: SettingsApplyResult;

  const txn = db.transaction(() => {
    // CAS 與 import 一致性檢查與後續寫入在同一交易內（與 activate 同構），
    // 避免「檢查後、寫入前」active_state 被另一請求改動而覆蓋其結果。
    const active = db
      .prepare('SELECT revision, active_import_id FROM active_state WHERE id = 1')
      .get() as { revision: number; active_import_id: string | null } | undefined;
    if (!active) throw new SettingsApplyError(500, 'ActiveState 未初始化');
    if (active.revision !== expectedRevision) {
      throw new SettingsApplyError(
        409,
        `版本衝突：目前 revision 為 ${active.revision}，請求為 ${expectedRevision}`,
        'REVISION_CONFLICT'
      );
    }
    // 09 §8.2.2：套用只針對「現行 active import」。預覽鎖定的批次若不是它（舊資料、竄改或已切換），
    // 一律拒絕；apply 不得藉儲存設定順便啟用別批名單。
    if (active.active_import_id !== preview.importId) {
      throw new SettingsApplyError(
        409,
        '預覽鎖定的名單批次與目前現行名單不符；儲存設定不會啟用或切換名單，請重新預覽。',
        'IMPORT_MISMATCH'
      );
    }

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

    // 不寫 active_import_id：apply 結構上不會改變哪一批是現行名單（上方已驗證 preview.importId 即現行）。
    db.prepare(
      `UPDATE active_state SET active_run_id = ?, revision = ?, updated_at = ? WHERE id = 1`
    ).run(runId, nextRevision, now);

    result = {
      settingsVersionId,
      runId,
      revision: nextRevision,
      totalStudents: results.length,
      mismatchCount,
      appliedAt: now,
    };

    db.prepare(
      `INSERT INTO idempotency_records (idempotency_key, request_body_hash, run_id, response_payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(idempotencyKey, bodyHash, runId, JSON.stringify(result), now);
  });

  txn();
  return result;
}
