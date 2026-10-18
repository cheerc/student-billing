import { CareDaysResult, CalculationStatus } from './types';

export interface CareDaysInput {
  grade: number | null;
  mathDeductionAnqin: number;
  mathDeductionTutoring: number;
  englishDeductionAnqin: number;
  englishDeductionTutoring: number;
  extraDeduction: number | null;
  hasHomeworkOrMeian: boolean;
  isEnrolledAnqin?: boolean;
  isEnrolledTutoring?: boolean;
  /** #147: 固定 5 天在額外扣天前套用，額外扣天扣在固定 5 天之後 (但受年級下限保底)。必填以防漏傳。 */
  extraDeductionAfterFloor: boolean;
}

/**
 * 計算安親與課輔之每週收費天數 (R11, R12)。
 * - 安親 (R11): 小一至小二，下限 3.5 天；若含寫功課/美安則保底 5 天。
 * - 課輔 (R12): 小三至小六，下限 3.0 天；若含寫功課則保底 5 天。
 * - 若帶有 extraDeduction 則附加 *額 標記 (如 4.5*額, 5*額)。
 * - extraDeductionAfterFloor (v3+): 額外扣天在固定 5 天之後套用，但受年級下限 (3.5/3.0) 保底。
 */
export function calculateCareDays(input: CareDaysInput): CareDaysResult {
  const extra = input.extraDeduction ?? 0;
  const hasExtraFlag = input.extraDeduction !== null;

  // 1. 安親天數 (R11)
  let anqinDays: number | null = null;
  let anqinDisplay: string | null = null;
  let anqinStatus: CalculationStatus = 'unavailable';

  if (input.grade === 1 || input.grade === 2) {
    const homeworkFloor = input.hasHomeworkOrMeian ? 5 : 0;
    if (input.extraDeductionAfterFloor) {
      // 正式軌 (v3 起): 固定 5 天在額外扣天前套用，額外扣天扣在固定 5 天之後，但受年級下限 3.5 保底
      const baseVal = Math.max(5 + input.mathDeductionAnqin + input.englishDeductionAnqin, homeworkFloor);
      anqinDays = Math.max(3.5, baseVal - extra);
    } else {
      // 歷史軌 (v1 / v2 / compat): 凍結原 Excel 公式 (MAX 第三參數保底 5 天)
      const rawVal = 5 + input.mathDeductionAnqin + input.englishDeductionAnqin - extra;
      anqinDays = Math.max(3.5, rawVal, homeworkFloor);
    }
    anqinDisplay = hasExtraFlag ? `${anqinDays}*額` : `${anqinDays}`;
    anqinStatus = 'calculated';
  } else if (input.grade !== null && input.grade >= 3 && input.grade <= 6) {
    anqinStatus = 'not_applicable'; // 非安親
  } else {
    anqinStatus = 'unavailable';
  }

  // 2. 課輔天數 (R12)
  let tutoringDays: number | null = null;
  let tutoringDisplay: string | null = null;
  let tutoringStatus: CalculationStatus = 'unavailable';

  if (input.grade !== null && input.grade >= 3 && input.grade <= 6) {
    const homeworkFloor = input.hasHomeworkOrMeian ? 5 : 0;
    if (input.extraDeductionAfterFloor) {
      // 正式軌 (v3 起): 固定 5 天在額外扣天前套用，額外扣天扣在固定 5 天之後，但受年級下限 3.0 保底
      const baseVal = Math.max(5 + input.mathDeductionTutoring + input.englishDeductionTutoring, homeworkFloor);
      tutoringDays = Math.max(3.0, baseVal - extra);
    } else {
      // 歷史軌 (v1 / v2 / compat): 凍結原 Excel 公式 (MAX 第三參數保底 5 天)
      const rawVal = 5 + input.mathDeductionTutoring + input.englishDeductionTutoring - extra;
      tutoringDays = Math.max(3.0, rawVal, homeworkFloor);
    }
    tutoringDisplay = hasExtraFlag ? `${tutoringDays}*額` : `${tutoringDays}`;
    tutoringStatus = 'calculated';
  } else if (input.grade === 1 || input.grade === 2) {
    tutoringStatus = 'not_applicable'; // 非課輔
  } else {
    tutoringStatus = 'unavailable';
  }

  return {
    anqin: {
      days: anqinDays,
      displayDays: anqinDisplay,
      status: anqinStatus,
      hasExtraFlag,
      isEnrolled: input.isEnrolledAnqin ?? false,
    },
    tutoring: {
      days: tutoringDays,
      displayDays: tutoringDisplay,
      status: tutoringStatus,
      hasExtraFlag,
      isEnrolled: input.isEnrolledTutoring ?? false,
    },
  };
}
