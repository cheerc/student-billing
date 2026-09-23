import { GradeStatus } from './types';

export interface GradeParseResult {
  grade: number | null;
  status: GradeStatus;
}

const VALID_GRADES_MAP: Record<string, number> = {
  '一年級': 1,
  '二年級': 2,
  '三年級': 3,
  '四年級': 4,
  '五年級': 5,
  '六年級': 6,
  '小一': 1,
  '小二': 2,
  '小三': 3,
  '小四': 4,
  '小五': 5,
  '小六': 6,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
};

const NOT_APPLICABLE_KEYWORDS = [
  '幼兒園',
  '幼幼班',
  '小班',
  '中班',
  '大班',
  '國一',
  '國二',
  '國三',
  '國中',
  '七年級',
  '八年級',
  '九年級',
];

/**
 * 解析年級字串 (U31 規範)
 * - 小一至小六 -> valid, grade: 1..6
 * - 幼兒園、國中 -> not_applicable, grade: null
 * - 空字串、null、"無"、未識別字串 -> unavailable, grade: null
 */
export function parseGrade(gradeRaw: string | null | undefined): GradeParseResult {
  if (!gradeRaw) {
    return { grade: null, status: 'unavailable' };
  }

  const trimmed = gradeRaw.trim();
  if (!trimmed || trimmed === '無') {
    return { grade: null, status: 'unavailable' };
  }

  if (VALID_GRADES_MAP[trimmed]) {
    return { grade: VALID_GRADES_MAP[trimmed], status: 'valid' };
  }

  for (const keyword of NOT_APPLICABLE_KEYWORDS) {
    if (trimmed.includes(keyword)) {
      return { grade: null, status: 'not_applicable' };
    }
  }

  return { grade: null, status: 'unavailable' };
}
