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
 *
 * ## Versioned snapshot semantics
 *
 * Known v1/v2 contexts have no category snapshot and callers use the frozen historical
 * projection. v3 has a category snapshot; v4 has both category and class-semantics snapshots.
 * Snapshot-capable versions retain `[]` when rows are absent so consumers fail closed instead
 * of falling back to current names. Unknown versions are marked `known: false`.
 */

import type { ApplicableRateContext, RunClassCategorySnapshot, RunClassSemanticsRateSnapshot } from '../../src/application/applicable-rate.ts';
// 值匯入不能帶 `.ts`（TS5097 只在 `import type` 上放行）；不帶副檔名與 scripts/*.ts 一致，tsx 可解析。
import { historicalRuleSetMetadata, isFormalRuleSetVersion } from '../../src/domain/billing/rule-set';
import { legacyClassSemanticsOf } from '../../src/domain/classification/legacy-class-semantics';

export interface RunClassSemanticsLike {
  baseName: string;
  resolvedBaseName: string;
  category: string;
  summaryDayRoles: string[];
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
 *
 * 判定**一律取產品端** `historicalRuleSetMetadata(version).hasClassCategorySnapshot`，
 * 與載入層（`runs-repository.ts`）同一套只讀歷史 metadata（CLAUDE.md §9.0 複寫禁令）。
 *
 * ## 為什麼不能寫 `ruleSetVersion === 'erp-tag-v3'`
 *
 * 歷史快照 presence 由獨立 read-only metadata 決定，不能依賴新 calculator 的 capability table。
 */
export function runUsesClassCategorySnapshot(ruleSetVersion: string | null | undefined): boolean {
  if (!ruleSetVersion) return false;
  return historicalRuleSetMetadata(ruleSetVersion).hasClassCategorySnapshot;
}

export function runUsesClassSemanticsSnapshot(rateContext: RunSnapshotPayload | undefined): boolean {
  if (!rateContext || rateContext.known === false) return false;
  if (typeof rateContext.usesClassSemanticsSnapshot === 'boolean') return rateContext.usesClassSemanticsSnapshot;
  return rateContext.ruleSetVersion
    ? historicalRuleSetMetadata(rateContext.ruleSetVersion).hasClassSemanticsSnapshot
    : false;
}

/** True only for an explicitly identified, known pre-v4 formal Run. */
export function usesFrozenLegacyProjection(rateContext: RunSnapshotPayload | undefined): boolean {
  const version = rateContext?.ruleSetVersion;
  if (rateContext?.known !== true || !isFormalRuleSetVersion(version)) return false;
  const metadata = historicalRuleSetMetadata(version);
  return metadata.known && !metadata.hasClassSemanticsSnapshot;
}

/** 工具端 `main()` 收到的最小 run 形狀（`RunInfoLike` 的子集，見 `roster-api.ts`）。 */
export interface RunSnapshotSource {
  ruleSetVersion?: string | null;
  classCategories?: RunClassCategorySnapshot[] | null;
  classSemantics?: RunSnapshotPayload['classSemantics'];
}

/**
 * 由 API 的 run 回應建出工具端唯一的快照入口。
 *
 * **兩台工具都必須經由本函式取得快照**，不得各自寫一次
 * `run?.classCategories ? { isV3Run: true, … } : undefined`——那正是讓「接線失效」
 * 無處可測的原因（issue #140 第 1 項）。
 *
 * Snapshot-capable versions always produce a context; absent rows become `[]` so readers
 * cannot silently fall back to current name mapping. `[]` is distinct from an absent snapshot
 * marker and this boundary keeps that distinction explicit.
 */
export function buildRunSnapshotContext(run: RunSnapshotSource | null | undefined): RunSnapshotPayload | undefined {
  if (!run) return undefined;
  const metadata = historicalRuleSetMetadata(run.ruleSetVersion ?? '');
  if (!metadata.known) {
    return {
      known: false,
      usesClassCategorySnapshot: false,
      usesClassSemanticsSnapshot: false,
      isV3Run: false,
      classCategories: null,
      ruleSetVersion: run.ruleSetVersion,
    };
  }
  if (!metadata.hasClassCategorySnapshot) {
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
    usesClassSemanticsSnapshot: metadata.hasClassSemanticsSnapshot,
    isV3Run: true,
    // A supported snapshot-capable run with missing rows must fail closed, not fall back to
    // today's class-name mapping. Keep [] distinct from undefined for that reason.
    classCategories: Array.isArray(run.classCategories) ? run.classCategories : [],
    ...(Array.isArray(run.classSemantics) ? { classSemantics: run.classSemantics } : {}),
    ruleSetVersion: run.ruleSetVersion,
  };
}

/**
 * 該不該警告「這個 run 本該有快照，API 卻沒帶」（issue #140 第 2 項）。
 *
 * 條件前半是**能力判定**（本該有），後半是**實際有無**（卻沒有）。
 * 兩者都在本函式內，工具端只呼叫這一個判斷，不再各自字面比較版本。
 */
export function shouldWarnMissingSnapshot(run: RunSnapshotSource | null | undefined): boolean {
  if (!run) return false;
  const metadata = historicalRuleSetMetadata(run.ruleSetVersion ?? '');
  if (!metadata.known) return true;
  if (metadata.hasClassCategorySnapshot && !Array.isArray(run.classCategories)) return true;
  return metadata.hasClassSemanticsSnapshot && !Array.isArray(run.classSemantics);
}

/**
 * 由 API 回應取出該 run 的快照列；沒有快照概念（v1／v2）時回 `null`。
 *
 * 回 `null` 而非 `[]`：呼叫端據此區分「沒快照概念」與「v3 但查無此班」。
 */
export function snapshotRowsOf(rateContext: RunSnapshotPayload | undefined): RunClassCategorySnapshot[] | null {
  if (!rateContext || rateContext.known === false || !(rateContext.usesClassCategorySnapshot ?? rateContext.isV3Run)) return null;
  return Array.isArray(rateContext.classCategories) ? rateContext.classCategories : [];
}

/**
 * 供 `applicableRateForClass` 使用的 context；v1／v2 時回 `undefined`（走名稱映射）。
 */
export function toApplicableRateContext(
  rateContext: RunSnapshotPayload | undefined
): ApplicableRateContext | undefined {
  if (!rateContext || rateContext.known === false) return undefined;
  const rows = snapshotRowsOf(rateContext);
  if (rows === null) return undefined;
  return {
    isV3Run: true,
    ruleSetVersion: rateContext?.ruleSetVersion,
    findSnapshot: (name) => rows.find((r) => r.base_name === name),
    ...(Array.isArray(rateContext?.classSemantics)
      ? { findSemanticSnapshot: (name: string) => rateContext.classSemantics!.find((item) => item.baseName === name) as RunClassSemanticsRateSnapshot | undefined }
      : {}),
  };
}

/**
 * Resolve run-specific tier/summary semantics. v4 must use its immutable semantic snapshot;
 * only known pre-v4 runs use the frozen historical projection. Unknown versions and missing
 * v4 rows stay unavailable, never falling back to current class names.
 */
export function classSemanticsForRun(
  baseName: string,
  rateContext: RunSnapshotPayload | undefined
): RunClassSemanticsLike | undefined {
  if (!rateContext || rateContext.known === false) return undefined;
  if (runUsesClassSemanticsSnapshot(rateContext)) {
    return Array.isArray(rateContext.classSemantics)
      ? rateContext.classSemantics.find((item) => item.baseName === baseName)
      : undefined;
  }
  if (!usesFrozenLegacyProjection(rateContext)) return undefined;
  const legacy = legacyClassSemanticsOf(baseName);
  return {
    baseName,
    resolvedBaseName: baseName,
    category: 'unset',
    ...legacy,
  };
}

/** 查單一班名的快照列（供呼叫端判斷顯示類別）；沒有快照概念時回 `undefined`。 */
export function snapshotRowFor(
  rateContext: RunSnapshotPayload | undefined,
  className: string
): RunClassCategorySnapshot | undefined {
  return snapshotRowsOf(rateContext)?.find((r) => r.base_name === className);
}
