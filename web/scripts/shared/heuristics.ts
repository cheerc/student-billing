/**
 * 啟發式檢驗與同班常模統計共用模組。
 * 不依賴產品領域層，純數學與統計邏輯。
 */

export interface DivisibilityResult {
  isDivisible: boolean;
  unitPrice: number | null;
  note: string | null;
}

export interface SessionUniformityResult {
  classModeSessions: number | null;
  modeCount: number;
  totalWithSessions: number;
  isOutlier: boolean;
  notes: string[];
}

export interface ClassSessionsAnalysis {
  classModeSessions: number | null;
  modeCount: number;
  totalWithSessions: number;
  modeRatio: number;
  isOutlier: (sessions: number | null) => boolean;
  checkSession: (sessions: number | null) => SessionUniformityResult;
}

export interface AncillaryItem {
  subject: string;
  detail: string;
  amount: number | null;
}

export interface AncillaryNormResult {
  subject: string;
  normAmount: number | null;
  studentAmount: number | null;
  isAnomaly: boolean;
  note: string | null;
}

/** 計算整除性（Stub for TDD RED） */
export function checkTuitionDivisibility(
  _tuitionAmount: number | null,
  _sessions: number | null
): DivisibilityResult {
  return {
    isDivisible: true,
    unitPrice: null,
    note: null,
  };
}

/** 同班堂數眾數與偏離計算（Stub for TDD RED） */
export function analyzeClassSessions(
  _classRecords: Array<{ sessions: number | null }>
): ClassSessionsAnalysis {
  return {
    classModeSessions: null,
    modeCount: 0,
    totalWithSessions: 0,
    modeRatio: 0,
    isOutlier: () => false,
    checkSession: () => ({
      classModeSessions: null,
      modeCount: 0,
      totalWithSessions: 0,
      isOutlier: false,
      notes: [],
    }),
  };
}

/** 同班附加費用常模統計與偏離檢驗（Stub for TDD RED） */
export function analyzeClassAncillaryNorms(
  _classStudentFees: Map<string, AncillaryItem[]>
): Map<string, AncillaryNormResult[]> {
  return new Map();
}
