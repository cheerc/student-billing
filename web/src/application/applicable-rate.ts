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

export interface ApplicableRateContext {
  db?: any;
  runId?: string;
}

export function applicableRateForClass(
  className: string,
  s: ApplicableRateFields,
  context?: ApplicableRateContext
): ApplicableRate {
  if (context?.db && context?.runId) {
    const run = context.db.prepare('SELECT rule_set_version FROM calculation_runs WHERE id = ?').get(context.runId) as { rule_set_version: string } | undefined;
    if (run?.rule_set_version === 'erp-tag-v3') {
      const row = context.db.prepare('SELECT category, fixed_five_days FROM run_class_categories WHERE run_id = ? AND base_name = ?').get(context.runId, className) as {
        category: string;
        fixed_five_days: number;
      } | undefined;
      if (!row) {
        return { status: 'not_configured' };
      }
      if (row.fixed_five_days === 1) {
        // Q7-A: 不列入但固定 5 天的班本班適用折扣顯示 100% 而非「未設定」
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
  }

  const category = rateCategoryOfClass(className);
  if (category === null) return { status: 'not_configured' };
  if (category === 'math') return { status: 'configured', bps: s.applicableMathBps };
  if (category === 'english') return { status: 'configured', bps: s.applicableEnglishBps };
  if (s.grade === 1 || s.grade === 2) return { status: 'configured', bps: s.applicableAnqinBps };
  if (s.grade !== null && s.grade >= 3 && s.grade <= 6) return { status: 'configured', bps: s.applicableTutoringBps };
  return { status: 'configured', bps: null };
}
