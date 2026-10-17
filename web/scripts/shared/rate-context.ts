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
// 值匯入不能帶 `.ts`（TS5097 只在 `import type` 上放行）；不帶副檔名與 scripts/*.ts 一致，tsx 可解析。
import { ruleSetCapabilities } from '../../src/domain/billing/rule-set';

/** API `/runs/{id}` 回應中本工具需要的部分。 */
export interface RunSnapshotPayload {
  isV3Run: boolean;
  classCategories: RunClassCategorySnapshot[] | null;
}

/**
 * 這個 run 是否「以類別快照計費」（issue #140 第 2 項）。
 *
 * 判定**一律取產品端** `ruleSetCapabilities(version).categoryBasedBilling`，
 * 與載入層（`runs-repository.ts`）同一套判準（CLAUDE.md §9.0 複寫禁令）。
 *
 * ## 為什麼不能寫 `ruleSetVersion === 'erp-tag-v3'`
 *
 * `specs/03 §5.3.1` 禁止字面版本比較：行為差異必須走能力旗標。字面比較在
 * **新增 v4 且同具 `categoryBasedBilling` 時會靜默漏判**——工具不會警告、
 * 也不會報錯，只是從此不再提醒「這個 run 本該有快照卻沒帶」。
 * 這個旗標是產品的單一定義處，v4 註冊時自動跟上。
 */
export function runUsesClassCategorySnapshot(ruleSetVersion: string | null | undefined): boolean {
  if (!ruleSetVersion) return false;
  return ruleSetCapabilities(ruleSetVersion).categoryBasedBilling;
}

/** 工具端 `main()` 收到的最小 run 形狀（`RunInfoLike` 的子集，見 `roster-api.ts`）。 */
export interface RunSnapshotSource {
  ruleSetVersion?: string | null;
  classCategories?: RunClassCategorySnapshot[] | null;
}

/**
 * 由 API 的 run 回應建出工具端唯一的快照入口；不該有快照（或 API 沒帶）時回 `undefined`。
 *
 * **兩台工具都必須經由本函式取得快照**，不得各自寫一次
 * `run?.classCategories ? { isV3Run: true, … } : undefined`——那正是讓「接線失效」
 * 無處可測的原因（issue #140 第 1 項）。
 *
 * 判定用「有沒有拿到陣列」而非能力旗標：`[]`（v3 但零快照列）**必須**產生 context，
 * 否則讀模型會退回名稱映射，正是 03 §5.3.4 明文禁止的猜測。`[]` 在 JS 為真值，
 * 這裡以 `Array.isArray` 明示，避免日後被改成 `!run.classCategories` 而靜默反轉語意。
 */
export function buildRunSnapshotContext(run: RunSnapshotSource | null | undefined): RunSnapshotPayload | undefined {
  if (!run || !Array.isArray(run.classCategories)) return undefined;
  return { isV3Run: true, classCategories: run.classCategories };
}

/**
 * 該不該警告「這個 run 本該有快照，API 卻沒帶」（issue #140 第 2 項）。
 *
 * 條件前半是**能力判定**（本該有），後半是**實際有無**（卻沒有）。
 * 兩者都在本函式內，工具端只呼叫這一個判斷，不再各自字面比較版本。
 */
export function shouldWarnMissingSnapshot(run: RunSnapshotSource | null | undefined): boolean {
  return (
    runUsesClassCategorySnapshot(run?.ruleSetVersion) && buildRunSnapshotContext(run) === undefined
  );
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
