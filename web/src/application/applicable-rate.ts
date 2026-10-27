/**
 * 本班適用折扣（specs/03 §5.1 B1 凍結；09 §5.1 F05）。
 *
 * 只讀已持久化的四個學生層適用率欄位，不新增計算；班級類別一律取該 Run 的
 * class category snapshot（run_class_categories）。缺 resolver 或缺該班快照＝無法判定，
 * 回 `not_configured`，嚴禁以班名猜測類別（03 §5.3.4）。
 * SQL（query-students）與選項端點（query-student-options）共用同一個類別判斷，畫面也以此為準。
 */

export type RateCategory = 'care' | 'math' | 'english';

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

/**
 * run 的類別快照查詢來源。
 * 以介面注入而非直接吃 db，讓同一份判定邏輯可同時供 server（adapters）與
 * client component（畫面以 server 傳下的快照陣列查詢）使用，不把 db 帶進瀏覽器。
 */
export interface ApplicableRateContext {
  /** 以**名冊班名**查快照（快照的 base_name 存的就是名冊班名，secondary N-8 對齊） */
  findSnapshot?: (rosterClassName: string) => RunClassCategorySnapshot | undefined;
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
  const row = context?.findSnapshot?.(className);
  // 缺 resolver 或缺該班快照 → 無法判定，嚴禁以當前班名猜測（03 §5.3.4）
  if (!row) return { status: 'not_configured' };
  return applicableRateForCategory(row.category as RateCategory | 'none' | 'unset', s);
}
