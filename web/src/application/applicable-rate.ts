/**
 * 本班適用折扣（specs/03 §5.1 B1 凍結；09 §5.1 F05）。
 *
 * 只讀已持久化的四個學生層適用率欄位，不新增計算；班級類別採 B1 暫定的 v2 名稱映射
 * （待 D37 改由設定快照取代）：
 *   - 名稱含「國小輔導」→ 依年級：一、二年級取安親側、三至六年級取課輔側，其他年級無法判定（null）
 *   - 名稱含「國小數學」→ 數學適用率
 *   - 名稱含「兒童美語」→ 美語適用率
 *   - 其餘 → 未配置（not_configured）：畫面顯示「未設定」，不當成 100%
 * SQL（query-students）與選項端點（query-student-options）共用同一個類別判斷，畫面也以此為準。
 */

import { historicalRuleSetMetadata } from '@/domain/billing/rule-set';

export type RateCategory = 'care' | 'math' | 'english';

export function rateCategoryOfClass(className: string): RateCategory | null {
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

/** run 的類別快照單列（v3；run_class_categories 的欄位形狀）。 */
export interface RunClassCategorySnapshot {
  base_name: string;
  category: string;
  fixed_five_days: number;
}

/**
 * v3 run 的類別快照查詢來源。
 * 以介面注入而非直接吃 db，讓同一份判定邏輯可同時供 server（adapters）與
 * client component（畫面以 server 傳下的快照陣列查詢）使用，不把 db 帶進瀏覽器。
 */
export interface ApplicableRateContext {
  /** 該 run 是否為 v3（相容舊簽章；v1／v2 走名稱映射，不讀快照） */
  isV3Run?: boolean;
  usesSnapshot?: boolean;
  ruleSetVersion?: string | null;
  fixedFiveDaysAffectsRate?: boolean;
  /** 以**名冊班名**查快照（快照的 base_name 存的就是名冊班名，secondary N-8 對齊） */
  findSnapshot: (rosterClassName: string) => RunClassCategorySnapshot | undefined;
}

/** 由 run_class_categories 查出該 run 的全部快照（server 端；缺表列回空陣列＝無法判定）。 */
export function loadRunClassCategories(db: any, runId: string): RunClassCategorySnapshot[] {
  try {
    return db
      .prepare('SELECT base_name, category, fixed_five_days FROM run_class_categories WHERE run_id = ?')
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
  if (context?.ruleSetVersion && !historicalRuleSetMetadata(context.ruleSetVersion).known) {
    return { status: 'not_configured' };
  }
  // Ruling 5: 旗標回退優先序為 usesSnapshot > ruleSetVersion > isV3Run
  const usesSnapshot =
    context?.usesSnapshot ??
    (context?.ruleSetVersion
      ? historicalRuleSetMetadata(context.ruleSetVersion).hasClassCategorySnapshot
      : context?.isV3Run ?? false);

  if (usesSnapshot && context?.findSnapshot) {
    const row = context.findSnapshot(className);
    if (!row) {
      // 缺該班快照 → 無法判定，嚴禁以當前班名猜測（03 §5.3.4）
      return { status: 'not_configured' };
    }
    // Ruling 5: 旗標回退優先序為 fixedFiveDaysAffectsRate > ruleSetVersion > isV3Run
    const fixedFiveDaysAffectsRate =
      context.fixedFiveDaysAffectsRate ??
      (context.ruleSetVersion
        ? historicalRuleSetMetadata(context.ruleSetVersion).fixedFiveDaysAffectsRate
        : context.isV3Run ?? false);

    if (fixedFiveDaysAffectsRate && row.fixed_five_days === 1) {
      // v3 Q7-A: 不列入但固定 5 天的班本班適用折扣顯示 100% 而非「未設定」
      return { status: 'configured', bps: 10000 };
    }
    if (row.category === 'math') return { status: 'configured', bps: s.applicableMathBps };
    if (row.category === 'english') return { status: 'configured', bps: s.applicableEnglishBps };
    if (row.category === 'care') {
      if (s.grade === 1 || s.grade === 2) return { status: 'configured', bps: s.applicableAnqinBps };
      if (s.grade !== null && s.grade >= 3 && s.grade <= 6) return { status: 'configured', bps: s.applicableTutoringBps };
      return { status: 'configured', bps: null };
    }
    return { status: 'not_configured' };
  }

  const category = rateCategoryOfClass(className);
  if (category === null) return { status: 'not_configured' };
  if (category === 'math') return { status: 'configured', bps: s.applicableMathBps };
  if (category === 'english') return { status: 'configured', bps: s.applicableEnglishBps };
  if (s.grade === 1 || s.grade === 2) return { status: 'configured', bps: s.applicableAnqinBps };
  if (s.grade !== null && s.grade >= 3 && s.grade <= 6) return { status: 'configured', bps: s.applicableTutoringBps };
  return { status: 'configured', bps: null };
}
