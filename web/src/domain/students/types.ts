export type GradeStatus = 'valid' | 'not_applicable' | 'unavailable';

export type TierParseStatus = 'parsed' | 'defaulted' | 'not_applicable' | 'unavailable';

export type EnrollmentParseStatus = 'ok' | 'needs_review';

export interface ParsedToken {
  /** 完整原始 token 字串 */
  rawToken: string;
  /** 民國/西元年份前綴，如 "115" */
  yearPrefix: string | null;
  /** 班名主體，如 "國小輔導-四年級A"、"國小數學-三A"、"兒童美語-EA" */
  baseName: string;
  /** 班型標記，通常為 "團" */
  groupFlag: string | null;
  /** 修飾標記清單，如 ["4_5"]、["Starter"]、["W1"] */
  modifiers: string[];
  /** 離班日期 YYYY-MM-DD，若有明確標記 */
  withdrawalDate: string | null;
  /** 原始 ERP 登記級距文字，如 "4_5" 或 null (無後綴) */
  erpBillingTierRaw: string | null;
  /** 解析後之數值級距 (天數)，如 4.5、5 或 null */
  erpBillingTier: number | null;
  /** 級距解析狀態 */
  tierParseStatus: TierParseStatus;
  /** Temporary preview projection from the latest saved settings; never persisted to the import row. */
  previewErpBillingTier?: number | null;
  previewErpBillingTierRaw?: string | null;
  previewTierParseStatus?: TierParseStatus;
  /** token 總體解析狀態 */
  parseStatus: EnrollmentParseStatus;
}

export interface StudentSnapshot {
  personCode: string;
  name: string;
  branch: string | null;
  gradeRaw: string | null;
  grade: number | null;
  gradeStatus: GradeStatus;
  contact: string | null;
  schoolInfo: string | null;
  tagsRaw: string | null;
  tags: string[];
  notesRaw: string | null;
  enrollments: ParsedToken[];
  sourceRow: number;
}
