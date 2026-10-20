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
  constructor(message: string) {
    super(message);
    this.name = 'RuleSetResolutionError';
  }
}

/**
 * 正式軌 ruleSetVersion（09 §8.1）：有 active run 且其版本為正式軌則採其值；
 * 否則（無 active run，或 active run 為診斷軌 compat）採現行預設版本 TARGET_FORMAL_RULE_SET_VERSION。
 *
 * D2b（Q11）：空 DB 直接預設目標正式軌（D2b 時為 erp-tag-v3；#112 起為 erp-tag-v4），解析器層即可回傳目標版本；
 * 既有 v2 DB 走 activate／apply 沿用其 active run 的 v2，直到使用者明確確認升級。
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

/**
 * 目標規則版本（Q11／S manifest §2.3）：
 *  - `requested` 明確指定 → 必須是正式軌版本，否則拋錯（不猜、不靜默降級）；
 *  - 未指定（undefined／null）→ 沿用現行正式軌版本，既有 v2 DB 因此不動、空 DB 得 v3。
 *
 * 這個值記錄在 preview 列（target_rule_set_version），apply 只讀它建 run；
 * 因此「使用者在預覽看到的版本」與「實際套用產生的 run 版本」必然一致（D1 F-3 契約延伸）。
 */
export function resolveTargetRuleSetVersion(
  db: Database.Database,
  requested?: string | null
): FormalRuleSetVersion {
  if (requested === null || requested === undefined) return resolveFormalRuleSetVersion(db);
  if (isFormalRuleSetVersion(requested)) return requested;
  throw new RuleSetResolutionError(`目標規則版本「${requested}」不是正式軌版本`);
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
  if (recorded === null || recorded === undefined) return resolveFormalRuleSetVersion(db);
  if (isFormalRuleSetVersion(recorded)) return recorded;
  throw new RuleSetResolutionError(`預覽記錄的目標規則版本「${recorded}」不是正式軌版本`);
}
