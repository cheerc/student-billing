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
 * ## 三態語意
 *
 * `undefined`＝v1／v2，此 run 沒有快照概念 → 呼叫端走名稱映射。
 * `{ isV3Run: true, … }`＝v3（含零快照列）→ 讀模型一律以快照為準，缺則 `not_configured`。
 * 兩者不可互相取代，故此處**不**把「v3 但零列」摺疊成 undefined。
 */

import type { ApplicableRateContext, RunClassCategorySnapshot } from '../../src/application/applicable-rate.ts';

/** API `/runs/{id}` 回應中本工具需要的部分。 */
export interface RunSnapshotPayload {
  isV3Run: boolean;
  classCategories: RunClassCategorySnapshot[] | null;
}

/**
 * 由 API 回應取出該 run 的快照列；沒有快照概念（v1／v2）時回 `null`。
 *
 * 回 `null` 而非 `[]`：呼叫端據此區分「沒快照概念」與「v3 但查無此班」。
 */
export function snapshotRowsOf(rateContext: RunSnapshotPayload | undefined): RunClassCategorySnapshot[] | null {
  if (!rateContext || !rateContext.isV3Run) return null;
  return Array.isArray(rateContext.classCategories) ? rateContext.classCategories : [];
}

/**
 * 供 `applicableRateForClass` 使用的 context；v1／v2 時回 `undefined`（走名稱映射）。
 */
export function toApplicableRateContext(
  rateContext: RunSnapshotPayload | undefined
): ApplicableRateContext | undefined {
  const rows = snapshotRowsOf(rateContext);
  if (rows === null) return undefined;
  return { isV3Run: true, findSnapshot: (name) => rows.find((r) => r.base_name === name) };
}

/** 查單一班名的快照列（供呼叫端判斷顯示類別）；沒有快照概念時回 `undefined`。 */
export function snapshotRowFor(
  rateContext: RunSnapshotPayload | undefined,
  className: string
): RunClassCategorySnapshot | undefined {
  return snapshotRowsOf(rateContext)?.find((r) => r.base_name === className);
}
