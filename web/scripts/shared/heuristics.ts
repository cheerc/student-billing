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

/**
 * 檢驗學費金額除以堂數是否為整數。
 * 無法整除代表平均單價具小數點，可能為插班、扣款或非標準計價。
 */
export function checkTuitionDivisibility(
  tuitionAmount: number | null,
  sessions: number | null
): DivisibilityResult {
  if (tuitionAmount == null || sessions == null || sessions <= 0) {
    return {
      isDivisible: true,
      unitPrice: null,
      note: null,
    };
  }

  const unitPrice = tuitionAmount / sessions;
  const isDivisible = tuitionAmount % sessions === 0;

  if (isDivisible) {
    return {
      isDivisible: true,
      unitPrice,
      note: null,
    };
  }

  const note = `學費 $${tuitionAmount.toLocaleString('zh-TW')} 除以 ${sessions} 堂無法整除（${unitPrice.toFixed(2)} 元）`;
  return {
    isDivisible: false,
    unitPrice,
    note,
  };
}

/**
 * 同班堂數眾數與偏離分析。
 * 若某堂數佔全班 >= 50%，定義為常規堂數；少數偏離者標示為 outlier。
 */
export function analyzeClassSessions(
  classRecords: Array<{ sessions: number | null }>
): ClassSessionsAnalysis {
  const validSessions = classRecords
    .map(r => r.sessions)
    .filter((s): s is number => typeof s === 'number' && s > 0);

  const totalWithSessions = validSessions.length;
  if (totalWithSessions === 0) {
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

  const freq = new Map<number, number>();
  for (const s of validSessions) {
    freq.set(s, (freq.get(s) ?? 0) + 1);
  }

  let maxCount = 0;
  let candidateMode: number | null = null;
  for (const [s, count] of freq.entries()) {
    if (count > maxCount) {
      maxCount = count;
      candidateMode = s;
    }
  }

  const modeRatio = maxCount / totalWithSessions;
  const classModeSessions = modeRatio >= 0.5 ? candidateMode : null;
  const modeCount = classModeSessions !== null ? maxCount : 0;

  const isOutlier = (sessions: number | null): boolean => {
    if (sessions == null || classModeSessions == null) return false;
    return sessions !== classModeSessions;
  };

  const checkSession = (sessions: number | null): SessionUniformityResult => {
    const outlier = isOutlier(sessions);
    const notes: string[] = [];
    if (outlier && sessions != null && classModeSessions != null) {
      notes.push(
        `同班常規堂數為 ${classModeSessions} 堂（佔 ${Math.round(modeRatio * 100)}%），此生為 ${sessions} 堂，堂數偏離常模。`
      );
    }
    return {
      classModeSessions,
      modeCount,
      totalWithSessions,
      isOutlier: outlier,
      notes,
    };
  };

  return {
    classModeSessions,
    modeCount,
    totalWithSessions,
    modeRatio,
    isOutlier,
    checkSession,
  };
}

/**
 * 同班附加費用常模統計與偏離檢驗。
 * 若同班有 >= 50% 學生收取特定非零金額，該金額即為常模。
 */
export function analyzeClassAncillaryNorms(
  classStudentFees: Map<string, AncillaryItem[]>
): Map<string, AncillaryNormResult[]> {
  const result = new Map<string, AncillaryNormResult[]>();
  const totalStudents = classStudentFees.size;
  if (totalStudents === 0) return result;

  // 1. 整理每個學生在各科目的金額彙總
  const studentSubjectMap = new Map<string, Map<string, { totalAmount: number; details: string[] }>>();
  const allSubjects = new Set<string>();

  for (const [studentName, items] of classStudentFees.entries()) {
    const subjectMap = new Map<string, { totalAmount: number; details: string[] }>();
    for (const item of items) {
      if (!item.subject) continue;
      allSubjects.add(item.subject);
      const existing = subjectMap.get(item.subject) ?? { totalAmount: 0, details: [] };
      existing.totalAmount += item.amount ?? 0;
      if (item.detail) existing.details.push(item.detail);
      subjectMap.set(item.subject, existing);
    }
    studentSubjectMap.set(studentName, subjectMap);
    result.set(studentName, []);
  }

  // 2. 對每個科目計算常模
  const subjectNorms = new Map<string, { normAmount: number | null; count: number }>();
  for (const subject of allSubjects) {
    const amountFreq = new Map<number, number>();
    for (const studentName of classStudentFees.keys()) {
      const studentFee = studentSubjectMap.get(studentName)?.get(subject);
      const amt = studentFee?.totalAmount ?? 0;
      if (amt > 0) {
        amountFreq.set(amt, (amountFreq.get(amt) ?? 0) + 1);
      }
    }

    let normAmount: number | null = null;
    let maxCount = 0;
    for (const [amt, count] of amountFreq.entries()) {
      if (count > maxCount) {
        maxCount = count;
        if (count / totalStudents >= 0.5) {
          normAmount = amt;
        }
      }
    }
    subjectNorms.set(subject, { normAmount, count: maxCount });
  }

  // 3. 對每位學生比對常模
  for (const studentName of classStudentFees.keys()) {
    const studentList = result.get(studentName)!;
    const subjectMap = studentSubjectMap.get(studentName);

    for (const subject of allSubjects) {
      const normInfo = subjectNorms.get(subject);
      const normAmount = normInfo?.normAmount ?? null;
      const studentFee = subjectMap?.get(subject);
      const studentAmount = studentFee?.totalAmount ?? 0;
      const details = studentFee?.details.join('、') ?? '';

      if (normAmount !== null) {
        if (studentAmount === normAmount) {
          studentList.push({
            subject,
            normAmount,
            studentAmount,
            isAnomaly: false,
            note: null,
          });
        } else {
          const note = studentAmount === 0
            ? `同班${subject}常模為 $${normAmount.toLocaleString('zh-TW')}，此生為 $0（未收取），請確認是否自備教材或漏收。`
            : `同班${subject}常模為 $${normAmount.toLocaleString('zh-TW')}，此生為 $${studentAmount.toLocaleString('zh-TW')}，金額偏離常模。`;
          studentList.push({
            subject,
            normAmount,
            studentAmount,
            isAnomaly: true,
            note,
          });
        }
      } else if (studentAmount > 0) {
        // 非常模項目（例如少數人領取的商品）
        const detailPart = details ? `${details} ` : '';
        const note = `此生另有${subject}明細：${detailPart}($${studentAmount.toLocaleString('zh-TW')})`;
        studentList.push({
          subject,
          normAmount: null,
          studentAmount,
          isAnomaly: false,
          note,
        });
      }
    }
  }

  return result;
}
