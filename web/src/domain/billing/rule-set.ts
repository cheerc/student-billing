/**
 * 規則版本的單一定義處（D1；specs/11 §3 D1、03 §5「規則版本入口」）。
 *
 * 之前「這個版本會不會做某件事」是散在各處的 `ruleSetVersion === 'erp-tag-v2'` 字面比較（4 處會改變行為）。
 * 新增規則版本時只要漏改任何一處，新版本就會靜默退回舊版本的行為，且沒有任何型別錯誤。
 * 現在行為差異一律讀 `ruleSetCapabilities(version)` 的旗標；新版本要在這裡明列每個旗標的值。
 *
 * D1 不新增任何規則版本（沒有 `erp-tag-v3` 型別成員），也不改變 `CURRENT_FORMAL_RULE_SET_VERSION`；
 * D2a 註冊 `erp-tag-v3` 型別成員，D2b 以 `TARGET_FORMAL_RULE_SET_VERSION` 決定空 DB 的目標版本（Q11）。
 */

/** 正式軌 ruleSetVersion（診斷軌 excel-v260922-compat 不作正式值，根 CLAUDE.md §2）。 */
export type FormalRuleSetVersion = 'erp-tag-v1' | 'erp-tag-v2' | 'erp-tag-v3' | 'erp-tag-v4';

export const FORMAL_RULE_SET_VERSIONS: ReadonlySet<string> = new Set<FormalRuleSetVersion>(['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'erp-tag-v4']);

/** 正式軌版本的可枚舉清單（API 契約用；與 FORMAL_RULE_SET_VERSIONS 同一份定義，不各寫一份）。 */
export const FORMAL_RULE_SET_VERSION_LIST = ['erp-tag-v1', 'erp-tag-v2', 'erp-tag-v3', 'erp-tag-v4'] as const;

/**
 * 空 DB 的目標正式軌（Q11）。既有 v2 DB 走 activate／apply 沿用其 active run 的版本，
 * 直到使用者明確確認升級（D2b 的升級確認流程），因此這裡不影響既有資料。
 */
export const TARGET_FORMAL_RULE_SET_VERSION: FormalRuleSetVersion = 'erp-tag-v4';

/**
 * D2 之前的「無 active run 時採用的版本」。D2b 起解析器改採 TARGET_FORMAL_RULE_SET_VERSION，
 * 這個常數已無產品程式碼引用，僅保留作為歷史 run 與規格敘述的對照點；
 * 新程式碼請用 TARGET_FORMAL_RULE_SET_VERSION 與 resolveTargetRuleSetVersion。
 */
export const CURRENT_FORMAL_RULE_SET_VERSION: FormalRuleSetVersion = 'erp-tag-v2';

export function isFormalRuleSetVersion(v: unknown): v is FormalRuleSetVersion {
  return typeof v === 'string' && FORMAL_RULE_SET_VERSIONS.has(v);
}

/** 規則版本之間「會改變計算結果」的行為差異；每個旗標的語意見欄位註解。 */
export interface RuleSetCapabilities {
  /** 衝堂只比對同一星期（週一至五）；關閉時以純時刻比對、不看星期。 */
  sameWeekdayOnly: boolean;
  /** 排課時段含未知星期（缺失或無法識別）時，出 UNKNOWN_WEEKDAY 警告；該時段衝堂一律計為 0。 */
  unknownWeekdayWarning: boolean;
  /** 含未知星期時，該學生各班級的級距核對狀態標為 schedule_incomplete（needs_review）。 */
  scheduleIncompleteOnUnknownWeekday: boolean;
  /** D2a: 依類別計算科數 (R03: 類別種數) 與 isEnrolled。 */
  categoryBasedBilling: boolean;
  /** D2a: 衝堂扣天取該類別中對學生適用側扣除量最多 (正量比較)。 */
  maxDeductionSelection: boolean;
  /** D2a / F-8: 美語缺課表補上需確認警告 (SCHEDULE_NOT_FOUND)。 */
  missingEnglishScheduleWarning: boolean;
  /** Historical D2a / Q12 capability metadata. #159 PR-1 retains the flag for version history, but new runs no longer invoke this diagnostic decomposition. */
  diagnosticsDecomposition: boolean;
  /** D2a / Q4-b: 未對應班標記 CLASS_NOT_MAPPED。（#157 Ruling 3 起範圍為「所有未對應班」，
   *  不再限 care/math/english；旗標本身只描述 v3 以後具此能力的軌道，不承載範圍。） */
  unmappedClassWarning: boolean;
  /** #147: 固定 5 天在額外扣天前套用，額外扣天扣在固定 5 天之後 (但受年級下限保底)。 */
  extraDeductionAfterFloor: boolean;
  /** #112: 固定 5 天與課程學費折扣解耦（不將 anqin／tutoring 強制覆蓋為 10000 bps）。 */
  homeworkDiscountDecoupled: boolean;
}

const NO_CAPABILITIES: RuleSetCapabilities = {
  sameWeekdayOnly: false,
  unknownWeekdayWarning: false,
  scheduleIncompleteOnUnknownWeekday: false,
  categoryBasedBilling: false,
  maxDeductionSelection: false,
  missingEnglishScheduleWarning: false,
  diagnosticsDecomposition: false,
  unmappedClassWarning: false,
  extraDeductionAfterFloor: false,
  homeworkDiscountDecoupled: false,
};

/**
 * 逐版明列旗標。沒有列在這裡的版本（含診斷軌 excel-v260922-compat、未知字串）一律全關，
 * 與 D1 之前「只有 erp-tag-v2 才成立」的字面比較語意相同。
 */
const CAPABILITIES: Readonly<Record<string, RuleSetCapabilities>> = {
  // 正式軌 v1：純時刻比對（不看星期），不出未知星期警告。
  'erp-tag-v1': NO_CAPABILITIES,
  // 診斷軌（Excel 相容）：不作正式值，比對方式同 v1。
  'excel-v260922-compat': NO_CAPABILITIES,
  // 正式軌 v2（現行）：同星期比對，未知星期 fail-closed 並警告。
  'erp-tag-v2': {
    sameWeekdayOnly: true,
    unknownWeekdayWarning: true,
    scheduleIncompleteOnUnknownWeekday: true,
    categoryBasedBilling: false,
    maxDeductionSelection: false,
    missingEnglishScheduleWarning: false,
    diagnosticsDecomposition: false,
    unmappedClassWarning: false,
    extraDeductionAfterFloor: false,
    homeworkDiscountDecoupled: false,
  },
  // 正式軌 v3（D2）：同星期比對、類別式科數、扣天取最多、美語缺課表警告、未對應班警告、診斷標籤分解、額外扣天在固定5天後扣除。
  'erp-tag-v3': {
    sameWeekdayOnly: true,
    unknownWeekdayWarning: true,
    scheduleIncompleteOnUnknownWeekday: true,
    categoryBasedBilling: true,
    maxDeductionSelection: true,
    missingEnglishScheduleWarning: true,
    diagnosticsDecomposition: true,
    unmappedClassWarning: true,
    extraDeductionAfterFloor: true,
    homeworkDiscountDecoupled: false,
  },
  // 正式軌 v4（#112）：繼承 v3 全部特性，並將固定 5 天與課程學費折扣解耦（固定 5 天不再覆寫折扣）。
  'erp-tag-v4': {
    sameWeekdayOnly: true,
    unknownWeekdayWarning: true,
    scheduleIncompleteOnUnknownWeekday: true,
    categoryBasedBilling: true,
    maxDeductionSelection: true,
    missingEnglishScheduleWarning: true,
    diagnosticsDecomposition: true,
    unmappedClassWarning: true,
    extraDeductionAfterFloor: true,
    homeworkDiscountDecoupled: true,
  },
};

export function ruleSetCapabilities(version: string): RuleSetCapabilities {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, version) ? CAPABILITIES[version] : NO_CAPABILITIES;
}
