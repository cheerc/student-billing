import Database from 'better-sqlite3';
import crypto from 'crypto';
import { executeCalculationRun, resolveLatestSavedSettings, CalculateRunOptions } from './calculate-run';
import { saveCalculationRun } from '@/adapters/sqlite/runs-repository';

export class ActivateConflictError extends Error {
  statusCode = 409;
  code = 'REVISION_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'ActivateConflictError';
  }
}

export class ActivateError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, message: string, code = 'ACTIVATE_FAILED') {
    super(message);
    this.name = 'ActivateError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * activate 不接受 client 指定課表版本或設定覆寫（09 §8.2.1）：
 * scheduleVersionId／aliasMap／scheduleOverride 一律由 server 解析最新已儲存設定決定。
 */
export interface ActivateOptions
  extends Omit<CalculateRunOptions, 'scheduleVersionId' | 'aliasMap' | 'scheduleOverride'> {
  importId: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface ActivateResult {
  runId: string;
  revision: number;
  activeImportId: string;
  activeRunId: string;
  status: 'completed';
  issueCounts: Record<string, number>;
  totalStudents: number;
}

/**
 * 啟用指定匯入批次為正式計算 run (T04)。
 * 落實 CAS 409 樂觀鎖與 idempotencyKey 重送防護。
 */
export function activateImport(
  db: Database.Database,
  options: ActivateOptions
): ActivateResult {
  const { importId, expectedRevision, idempotencyKey } = options;

  if (expectedRevision === undefined || expectedRevision === null || isNaN(expectedRevision)) {
    throw new ActivateError(400, '缺少必要參數 expectedRevision');
  }

  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new ActivateError(400, '缺少必要參數 idempotencyKey');
  }

  // 1. 檢查冪等性紀錄 (Idempotency)
  const bodyHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        importId,
        expectedRevision,
        asOfDate: options.asOfDate || '',
        ruleSetVersion: (options as any).ruleSetVersion || 'erp-tag-v2',
      })
    )
    .digest('hex');

  const existingIdemp = db
    .prepare('SELECT request_body_hash, response_payload FROM idempotency_records WHERE idempotency_key = ?')
    .get(idempotencyKey) as { request_body_hash: string; response_payload: string } | undefined;

  if (existingIdemp) {
    if (existingIdemp.request_body_hash === bodyHash) {
      return JSON.parse(existingIdemp.response_payload);
    } else {
      throw new ActivateError(400, `相同 idempotencyKey「${idempotencyKey}」已被使用於不同的請求內容。`, 'IDEMPOTENCY_CONFLICT');
    }
  }

  // 2. 單一原子交易：CAS 檢查 → 解析最新已儲存設定 → 全量計算 → 切換 ActiveState → 寫冪等紀錄。
  //    設定解析與 run 建立同交易，run.scheduleVersionId 才會是實際用於計算的版本（09 §8.2.1）。
  const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  let activateResult!: ActivateResult;

  const transaction = db.transaction(() => {
    // 檢查 ActiveState revision (CAS)
    const activeState = db.prepare('SELECT revision FROM active_state WHERE id = 1').get() as
      | { revision: number }
      | undefined;

    if (!activeState) {
      throw new ActivateError(500, 'ActiveState 未初始化');
    }

    if (activeState.revision !== expectedRevision) {
      throw new ActivateConflictError(
        `版本衝突 (CAS Conflict)：目前系統版本為 ${activeState.revision}，而請求帶入之 expectedRevision 為 ${expectedRevision}。請重新整理取得最新狀態後再試。`
      );
    }

    const nextRevision = activeState.revision + 1;

    // 執行全量計算：每一次 activate 由 server 解析最新已儲存設定，
    // 忽略 client 傳入的 scheduleVersionId／alias／時段覆寫（09 §8.2.1）
    const { run, results } = executeCalculationRun(db, importId, runId, {
      ruleSetVersion: options.ruleSetVersion,
      numericPolicy: options.numericPolicy,
      asOfDate: options.asOfDate,
      ...resolveLatestSavedSettings(db),
    });

    // 儲存計算結果與 run
    saveCalculationRun(db, run, results);

    // 切換 ActiveState
    db.prepare(`
      UPDATE active_state
      SET active_import_id = ?, active_run_id = ?, revision = ?, updated_at = ?
      WHERE id = 1
    `).run(importId, runId, nextRevision, now);

    activateResult = {
      runId,
      revision: nextRevision,
      activeImportId: importId,
      activeRunId: runId,
      status: 'completed',
      issueCounts: run.issueCounts,
      totalStudents: run.totalStudents,
    };

    // 寫入冪等性記錄
    db.prepare(`
      INSERT INTO idempotency_records (
        idempotency_key, request_body_hash, run_id, response_payload, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(idempotencyKey, bodyHash, runId, JSON.stringify(activateResult), now);
  });

  transaction();

  return activateResult;
}
