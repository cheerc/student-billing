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
}

/**
 * 計算安親與課輔之每週收費天數 (R11, R12)。
 * - 安親 (R11): 小一至小二，下限 3.5 天；若含寫功課/美安則保底 5 天。
 * - 課輔 (R12): 小三至小六，下限 3.0 天；若含寫功課則保底 5 天。
 * - 若帶有 extraDeduction 則附加 *額 標記 (如 4.5*額, 5*額)。
 */
export function calculateCareDays(input: CareDaysInput): CareDaysResult {
  const extra = input.extraDeduction ?? 0;
  const hasExtraFlag = input.extraDeduction !== null;

  // 1. 安親天數 (R11)
  let anqinDays: number | null = null;
  let anqinDisplay: string | null = null;
  let anqinStatus: CalculationStatus = 'unavailable';

  if (input.grade === 1 || input.grade === 2) {
    const rawVal = 5 + input.mathDeductionAnqin + input.englishDeductionAnqin - extra;
    const homeworkFloor = input.hasHomeworkOrMeian ? 5 : 0;
    anqinDays = Math.max(3.5, rawVal, homeworkFloor);
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
    const rawVal = 5 + input.mathDeductionTutoring + input.englishDeductionTutoring - extra;
    const homeworkFloor = input.hasHomeworkOrMeian ? 5 : 0;
    tutoringDays = Math.max(3.0, rawVal, homeworkFloor);
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
