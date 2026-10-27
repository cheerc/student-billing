/**
 * 本班適用折扣（specs/03 §5.1 B1 凍結；09 §5.1 F05）。
 *
 * 只讀已持久化的四個學生層適用率欄位，不新增計算。明確 v1/v2 Run 沿用 frozen
 * historical name mapping；v3/v4 必須讀該 Run 的 class category snapshot；unknown、缺少
 * version 或應有 resolver/row 的 Run 都回 `not_configured`：
 *   - 名稱含「國小輔導」→ 依年級：一、二年級取安親側、三至六年級取課輔側，其他年級無法判定（null）
 *   - 名稱含「國小數學」→ 數學適用率
 *   - 名稱含「兒童美語」→ 美語適用率
 *   - 其餘 → 未配置（not_configured）：畫面顯示「未設定」，不當成 100%
 * SQL（query-students）與選項端點（query-student-options）共用同一個類別判斷，畫面也以此為準。
 */

import { historicalRuleSetMetadata, isFormalRuleSetVersion } from '@/domain/billing/rule-set';

export type RateCategory = 'care' | 'math' | 'english';

/** Frozen mapper for read-only historical v1/v2 run displays; current v3/v4 paths use run snapshots. */
export function historicalRateCategoryOfClass(className: string): RateCategory | null {
  if (className.includes('國小輔導')) return 'care';
  if (className.includes('國小數學')) return 'math';
  if (className.includes('兒童美語')) return 'english';
  return null;
}

export interface ApplicableRateFields {
  grade: number | null;
  applicableAnqinBps: number | null;
  applicableTutoringBps: number | null;
  applicableMathBps: number | null;
  applicableEnglishBps: number | null;
}

/** 未配置與 null 分開：未配置＝這個班沒有設定適用折扣；null＝已配置但這位學生無法判定／不適用。 */
export type ApplicableRate = { status: 'not_configured' } | { status: 'configured'; bps: number | null };

/** Read a rate using already-resolved class semantics; current callers must not classify by name. */
export function applicableRateForCategory(
  category: RateCategory | 'none' | 'unset' | null,
  s: ApplicableRateFields
): ApplicableRate {
  if (category === 'math') return { status: 'configured', bps: s.applicableMathBps };
  if (category === 'english') return { status: 'configured', bps: s.applicableEnglishBps };
  if (category === 'care') {
    if (s.grade === 1 || s.grade === 2) return { status: 'configured', bps: s.applicableAnqinBps };
    if (s.grade !== null && s.grade >= 3 && s.grade <= 6) return { status: 'configured', bps: s.applicableTutoringBps };
    return { status: 'configured', bps: null };
  }
  return { status: 'not_configured' };
}

/** run 的類別快照單列（run_class_categories 的欄位形狀）。 */
export interface RunClassCategorySnapshot {
  base_name: string;
  resolved_base_name?: string | null;
  class_type?: 'care' | 'non_care' | string | null;
  category: string;
  fixed_five_days: number;
  mapped?: number;
  source?: string;
}

/** Minimal v4 semantic snapshot fields needed to validate the category projection. */
export interface RunClassSemanticsRateSnapshot {
  baseName: string;
  category: string;
}

/**
 * v3/v4 run 的類別快照查詢來源。
 * 以介面注入而非直接吃 db，讓同一份判定邏輯可同時供 server（adapters）與
 * client component（畫面以 server 傳下的快照陣列查詢）使用，不把 db 帶進瀏覽器。
 */
export interface ApplicableRateContext {
  /** Historical compatibility hint; an explicit snapshot-capable version still requires its snapshot. */
  isV3Run?: boolean;
  usesSnapshot?: boolean;
  ruleSetVersion?: string | null;
  fixedFiveDaysAffectsRate?: boolean;
  /** 以**名冊班名**查快照（快照的 base_name 存的就是名冊班名，secondary N-8 對齊） */
  findSnapshot?: (rosterClassName: string) => RunClassCategorySnapshot | undefined;
  /** v4 additionally requires a semantic row that agrees with the category snapshot (retired in Phase 1). */
  findSemanticSnapshot?: (rosterClassName: string) => RunClassSemanticsRateSnapshot | undefined;
}

/** 由 run_class_categories 查出該 run 的全部快照（server 端；缺表列回空陣列＝無法判定）。 */
export function loadRunClassCategories(db: any, runId: string): RunClassCategorySnapshot[] {
  try {
    return db
      .prepare('SELECT base_name, resolved_base_name, class_type, category, fixed_five_days, mapped, source FROM run_class_categories WHERE run_id = ?')
      .all(runId) as RunClassCategorySnapshot[];
  } catch {
    return [];
  }
}

export function applicableRateForClass(
  className: string,
  s: ApplicableRateFields,
  context?: ApplicableRateContext
): ApplicableRate {
  const version = context?.ruleSetVersion;
  const metadata = version ? historicalRuleSetMetadata(version) : undefined;
  if (version && !metadata?.known) {
    return { status: 'not_configured' };
  }
  // Snapshot capability in persisted Run metadata cannot be overridden to re-enable name
  // mapping. Hints can request a snapshot path, but v3/v4 always require the Run resolver.
  const usesSnapshot = Boolean(
    metadata?.hasClassCategorySnapshot || context?.usesSnapshot === true || context?.isV3Run === true
  );

  if (usesSnapshot) {
    if (!context?.findSnapshot) return { status: 'not_configured' };
    const row = context.findSnapshot(className);
    if (!row) {
      // 缺該班快照 → 無法判定，嚴禁以當前班名猜測（03 §5.3.4）
      return { status: 'not_configured' };
    }
    if (metadata?.hasClassSemanticsSnapshot && context.findSemanticSnapshot) {
      const semantics = context.findSemanticSnapshot(className);
      if (!semantics || semantics.baseName !== row.base_name || semantics.category !== row.category) {
        return { status: 'not_configured' };
      }
    }
    // Ruling 5: 旗標回退優先序為 fixedFiveDaysAffectsRate > ruleSetVersion > isV3Run
    const fixedFiveDaysAffectsRate =
      context.fixedFiveDaysAffectsRate ?? metadata?.fixedFiveDaysAffectsRate ?? context.isV3Run ?? false;

    if (fixedFiveDaysAffectsRate && row.fixed_five_days === 1) {
      // v3 Q7-A: 不列入但固定 5 天的班本班適用折扣顯示 100% 而非「未設定」
      return { status: 'configured', bps: 10000 };
    }
    return applicableRateForCategory(row.category as RateCategory | 'none' | 'unset', s);
  }

  // Only explicit known formal v1/v2 Runs use the frozen historical name mapper.
  if (!version || !isFormalRuleSetVersion(version) || version === 'erp-tag-v3' || version === 'erp-tag-v4') {
    return { status: 'not_configured' };
  }

  return applicableRateForCategory(historicalRateCategoryOfClass(className), s);
}
