import Database from 'better-sqlite3';
import {
  FormalRuleSetVersion,
  TARGET_FORMAL_RULE_SET_VERSION,
  isFormalRuleSetVersion,
} from '@/domain/billing/rule-set';

/**
 * 由 server 決定的規則版本（D1；03 §5「規則版本入口」）。
 * 名單 diff、扣天預覽、calculate、activate、apply 全部經這裡取得版本，client 一律不得指定。
 */

/** 記錄的目標規則版本不是正式軌版本（apply 端轉成 500 PREVIEW_CORRUPTED）。 */
export class RuleSetResolutionError extends Error {
  code: 'UPGRADE_REQUIRED' | 'INVALID_RULE_SET' = 'INVALID_RULE_SET';
  constructor(message: string, code: 'UPGRADE_REQUIRED' | 'INVALID_RULE_SET' = 'INVALID_RULE_SET') {
    super(message);
    this.name = 'RuleSetResolutionError';
    this.code = code;
  }
}

/**
 * 歷史／展示用途取得 active formal ruleSetVersion；這個 accessor 不得用來授權建立新 run。
 * 新計算必須使用 resolveTargetRuleSetVersion，並在舊 active run 上要求明確升級。
 *
 * D2b（Q11）：空 DB 直接預設目標正式軌（D2b 時為 erp-tag-v3；#112 起為 erp-tag-v4），解析器層即可回傳目標版本；
 * 舊版 active run 不會沿用到新計算；它的結果仍只讀取已保存的 run 列。
 */
export function resolveFormalRuleSetVersion(db: Database.Database): FormalRuleSetVersion {
  const active = db.prepare('SELECT active_run_id FROM active_state WHERE id = 1').get() as
    | { active_run_id: string | null }
    | undefined;
  if (active?.active_run_id) {
    const run = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(active.active_run_id) as
      | { rule_set_version: string }
      | undefined;
    if (run && isFormalRuleSetVersion(run.rule_set_version)) {
      return run.rule_set_version;
    }
  }
  return TARGET_FORMAL_RULE_SET_VERSION;
}

function readActiveRunRuleSetVersion(db: Database.Database): string | null {
  const active = db.prepare('SELECT active_run_id FROM active_state WHERE id = 1').get() as
    | { active_run_id: string | null }
    | undefined;
  if (!active?.active_run_id) return null;
  const run = db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(active.active_run_id) as
    | { rule_set_version: string }
    | undefined;
  if (!run) {
    throw new RuleSetResolutionError(
      `現行 active Run「${active.active_run_id}」不存在，無法安全建立新 Run。`,
      'INVALID_RULE_SET'
    );
  }
  return run.rule_set_version;
}

/**
 * 目標規則版本（Q11／S manifest §2.3）：
 *  - 新預覽僅允許目標 v4；傳入舊版明確拒絕；
 *  - 未指定時，v4 active / 空 DB 使用 v4；v1／v2／v3 active 必須先明確選擇升級 v4。
 *
 * 這個值記錄在 preview 列（target_rule_set_version），apply 只讀它建 run；
 * 因此「使用者在預覽看到的版本」與「實際套用產生的 run 版本」必然一致（D1 F-3 契約延伸）。
 */
export function resolveTargetRuleSetVersion(
  db: Database.Database,
  requested?: string | null
): FormalRuleSetVersion {
  if (requested !== null && requested !== undefined && requested !== TARGET_FORMAL_RULE_SET_VERSION) {
    throw new RuleSetResolutionError(
      `新計算只支援 ${TARGET_FORMAL_RULE_SET_VERSION}；請選擇明確升級至 v4。`,
      'UPGRADE_REQUIRED'
    );
  }
  if (requested === TARGET_FORMAL_RULE_SET_VERSION) return TARGET_FORMAL_RULE_SET_VERSION;
  const activeVersion = readActiveRunRuleSetVersion(db);
  if (activeVersion !== null && activeVersion !== TARGET_FORMAL_RULE_SET_VERSION) {
    throw new RuleSetResolutionError(
      `現行 Run 使用 ${activeVersion}。請先在課表設定中預覽並確認升級至 ${TARGET_FORMAL_RULE_SET_VERSION}。`,
      'UPGRADE_REQUIRED'
    );
  }
  return TARGET_FORMAL_RULE_SET_VERSION;
}

/**
 * apply 使用的規則版本＝preview 當時記錄的目標版本（settings_previews.target_rule_set_version）：
 *  - 記錄值是正式軌版本 → 採用；
 *  - 沒有記錄（null／undefined：migration 0007 之前建立的舊 preview，TTL 15 分鐘，實務上幾乎不存在）→
 *    視為「建立當時的 active 版本」。apply 與 preview 之間有 revision CAS，active 沒變，所以等於現在 server 解析的值；
 *  - 其他（含診斷軌 compat、未知字串）→ 拋 RuleSetResolutionError，不猜。
 */
export function resolveRuleSetForApply(
  db: Database.Database,
  recorded: string | null | undefined
): FormalRuleSetVersion {
  if (recorded === TARGET_FORMAL_RULE_SET_VERSION) return TARGET_FORMAL_RULE_SET_VERSION;
  if (recorded === null || recorded === undefined) {
    return resolveTargetRuleSetVersion(db);
  }
  throw new RuleSetResolutionError(
    `預覽記錄的規則版本「${recorded}」已停止建立新 Run；請重新預覽並明確升級至 ${TARGET_FORMAL_RULE_SET_VERSION}。`,
    'UPGRADE_REQUIRED'
  );
}
