/**
 * 共用層：把 API 回傳的 run 類別快照接到產品讀模型（issue #122）。
 *
 * ## 為什麼需要這一層
 *
 * `applicableRateForClass` 收的是 `ApplicableRateContext`（帶 `findSnapshot` 方法），
 * 而 API 回傳的是 `run.classCategories`（一個陣列）。兩台工具若各自寫一次這個轉接，
 * 就會有兩份「怎麼查快照、找不到算什麼」的實作——正是 CLAUDE.md §9.0 禁止的複寫。
 *
 * ## 形狀不可轉換
 *
 * 快照物件**原樣傳遞**，不重建、不正規化：`fixed_five_days` 必須維持數字 0／1
 * （讀模型判 `=== 1`，轉成布林會讓「固定 5 天 → 100%」靜默失效），欄位名維持
 * 底線命名。本檔只做「陣列 → 查詢函式」的包裝。
 */

import type { ApplicableRateContext, RunClassCategorySnapshot } from '../../src/application/applicable-rate.ts';

const VERSION_CAPABILITIES: Record<string, { known: boolean; hasClassCategorySnapshot: boolean; hasClassSemanticsSnapshot: boolean; isV3Run: boolean }> = {
  'erp-tag-v1': { known: true, hasClassCategorySnapshot: false, hasClassSemanticsSnapshot: false, isV3Run: false },
  'erp-tag-v2': { known: true, hasClassCategorySnapshot: false, hasClassSemanticsSnapshot: false, isV3Run: false },
  'excel-v260922-compat': { known: true, hasClassCategorySnapshot: false, hasClassSemanticsSnapshot: false, isV3Run: false },
  'erp-tag-v3': { known: true, hasClassCategorySnapshot: true, hasClassSemanticsSnapshot: false, isV3Run: true },
  'erp-tag-v4': { known: true, hasClassCategorySnapshot: true, hasClassSemanticsSnapshot: true, isV3Run: true },
};

export interface RunClassSemanticsLike {
  baseName: string;
  resolvedBaseName: string;
  category: string;
  isHomework?: boolean;
  erpTierApplicability: 'applicable' | 'not_applicable' | 'unset';
}

/** API `/runs/{id}` 回應中本工具需要的部分。 */
export interface RunSnapshotPayload {
  /** False means the persisted rule-set version is unknown/corrupt; callers must not use legacy fallbacks. */
  known: boolean;
  usesClassCategorySnapshot: boolean;
  usesClassSemanticsSnapshot: boolean;
  isV3Run: boolean;
  classCategories: RunClassCategorySnapshot[] | null;
  classSemantics?: RunClassSemanticsLike[] | null;
  ruleSetVersion?: string | null;
}

/**
 * 這個 run 是否「以類別快照計費」（issue #140 第 2 項）。
 */
export function runUsesClassCategorySnapshot(ruleSetVersion: string | null | undefined): boolean {
  if (!ruleSetVersion) return false;
  return Boolean(VERSION_CAPABILITIES[ruleSetVersion]?.hasClassCategorySnapshot);
}

/** 工具端 `main()` 收到的最小 run 形狀（`RunInfoLike` 的子集，見 `roster-api.ts`）。 */
export interface RunSnapshotSource {
  ruleSetVersion?: string | null;
  classCategories?: RunClassCategorySnapshot[] | null;
  classSemantics?: RunSnapshotPayload['classSemantics'];
}

/**
 * 由 API 的 run 回應建出工具端唯一的快照入口。
 */
export function buildRunSnapshotContext(run: RunSnapshotSource | null | undefined): RunSnapshotPayload | undefined {
  if (!run) return undefined;
  const cap = VERSION_CAPABILITIES[run.ruleSetVersion ?? ''] ?? {
    known: false,
    hasClassCategorySnapshot: false,
    hasClassSemanticsSnapshot: false,
    isV3Run: false,
  };
  if (!cap.known) {
    return {
      known: false,
      usesClassCategorySnapshot: false,
      usesClassSemanticsSnapshot: false,
      isV3Run: false,
      classCategories: null,
      ruleSetVersion: run.ruleSetVersion,
    };
  }
  if (!cap.hasClassCategorySnapshot) {
    return {
      known: true,
      usesClassCategorySnapshot: false,
      usesClassSemanticsSnapshot: false,
      isV3Run: false,
      classCategories: null,
      ...(Array.isArray(run.classSemantics) ? { classSemantics: run.classSemantics } : {}),
      ruleSetVersion: run.ruleSetVersion,
    };
  }
  return {
    known: true,
    usesClassCategorySnapshot: true,
    usesClassSemanticsSnapshot: cap.hasClassSemanticsSnapshot,
    isV3Run: true,
    classCategories: Array.isArray(run.classCategories) ? run.classCategories : [],
    ...(Array.isArray(run.classSemantics) ? { classSemantics: run.classSemantics } : {}),
    ruleSetVersion: run.ruleSetVersion,
  };
}

/**
 * 該不該警告「這個 run 本該有快照，API 卻沒帶」（issue #140 第 2 項）。
 */
export function shouldWarnMissingSnapshot(run: RunSnapshotSource | null | undefined): boolean {
  if (!run) return false;
  const cap = VERSION_CAPABILITIES[run.ruleSetVersion ?? ''];
  if (!cap || !cap.known) return true;
  return cap.hasClassCategorySnapshot && !Array.isArray(run.classCategories);
}

/**
 * 由 API 回應取出該 run 的快照列；沒有快照概念（v1／v2）時回 `null`。
 */
export function snapshotRowsOf(rateContext: RunSnapshotPayload | undefined): RunClassCategorySnapshot[] | null {
  if (!rateContext || rateContext.known === false || !(rateContext.usesClassCategorySnapshot ?? rateContext.isV3Run)) return null;
  return Array.isArray(rateContext.classCategories) ? rateContext.classCategories : [];
}

/**
 * 供 `applicableRateForClass` 使用的 context。
 */
export function toApplicableRateContext(
  rateContext: RunSnapshotPayload | undefined
): ApplicableRateContext | undefined {
  if (!rateContext || rateContext.known === false) return undefined;
  const rows = snapshotRowsOf(rateContext);
  if (rows === null) return undefined;
  return {
    findSnapshot: (name) => rows.find((r) => r.base_name === name),
  };
}

/**
 * Resolve run-specific tier/summary semantics.
 */
export function classSemanticsForRun(
  baseName: string,
  rateContext: RunSnapshotPayload | undefined
): RunClassSemanticsLike | undefined {
  if (!rateContext || rateContext.known === false) return undefined;
  if (Array.isArray(rateContext.classSemantics)) {
    const found = rateContext.classSemantics.find((item) => item.baseName === baseName);
    if (found) return found;
    return undefined;
  }
  const rows = snapshotRowsOf(rateContext);
  if (rows) {
    const row = rows.find((r) => r.base_name === baseName);
    if (row) {
      const isCare = row.class_type ? row.class_type === 'care' : (row.category === 'care' || baseName.includes('國小輔導'));
      const isFixedFive = row.fixed_five_days === 1;
      const erpTierApplicability = (isCare && !isFixedFive) ? 'applicable' : 'not_applicable';
      const isHomework = isFixedFive;
      return {
        baseName: row.base_name,
        resolvedBaseName: row.resolved_base_name ?? row.base_name,
        category: row.category,
        isHomework,
        erpTierApplicability,
      };
    }
  }
  if (baseName.includes('國小輔導')) {
    const isFixedFive = baseName.includes('寫功課');
    const erpTierApplicability = isFixedFive ? 'not_applicable' : 'applicable';
    const isHomework = isFixedFive;
    return {
      baseName,
      resolvedBaseName: baseName,
      category: 'care',
      isHomework,
      erpTierApplicability,
    };
  }
  return undefined;
}

/** 查單一班名的快照列（供呼叫端判斷顯示類別）；沒有快照概念時回 `undefined`。 */
export function snapshotRowFor(
  rateContext: RunSnapshotPayload | undefined,
  className: string
): RunClassCategorySnapshot | undefined {
  return snapshotRowsOf(rateContext)?.find((r) => r.base_name === className);
}
