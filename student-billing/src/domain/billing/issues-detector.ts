import { ParsedToken } from '../students/types';
import { StudentIssue, TierComparison } from './types';

export interface IssueDetectionInput {
  personCode: string;
  tagsRaw: string | null | undefined;
  notesRaw: string | null | undefined;
  enrollments: ParsedToken[];
  sibling: boolean;
  internalStudent: boolean;
  specialDiscount: number | null;
  isStaffFamily: boolean;
}

export interface TierCompareInput {
  enrollmentId?: string;
  rawToken?: string;
  baseName?: string;
  computedTier: number | null;
  erpDeclaredTier: number | null;
  scheduleStatus?: string;
}

/**
 * 偵測學生之業務規則問題與提示 (R17, R18, U41 等)。
 */
export function detectStudentIssues(input: IssueDetectionInput): StudentIssue[] {
  const issues: StudentIssue[] = [];

  // 1. R17: 同類別重複報名提示 (DUPLICATE_SUBJECT_ENROLLMENT)
  // 統計四類別：兒童美語、國小數學、一般國小輔導 (不含寫功課)、寫功課
  const englishTokens = input.enrollments.filter((e) => e.baseName.includes('兒童美語'));
  const mathTokens = input.enrollments.filter((e) => e.baseName.includes('國小數學'));
  const careTokens = input.enrollments.filter(
    (e) => (e.baseName.includes('國小輔導') || e.baseName.includes('安親') || e.baseName.includes('課輔')) && !e.baseName.includes('寫功課')
  );
  const homeworkTokens = input.enrollments.filter((e) => e.baseName.includes('寫功課'));

  const categories: [string, ParsedToken[]][] = [
    ['兒童美語', englishTokens],
    ['國小數學', mathTokens],
    ['國小輔導', careTokens],
    ['寫功課', homeworkTokens],
  ];

  for (const [catName, tokens] of categories) {
    if (tokens.length > 1) {
      const details = tokens.map((t) => `${t.rawToken}(級距:${t.erpBillingTier ?? '無'})`).join(', ');
      issues.push({
        code: 'DUPLICATE_SUBJECT_ENROLLMENT',
        category: catName,
        message: `學生重複報名同類別「${catName}」${tokens.length} 班：${details}。天數扣除依規定僅取第一班，請核對 ERP 登記是否有誤。`,
      });
    }
  }

  // 2. R18: 員工家屬無折扣提示 (STAFF_FAMILY_NO_DISCOUNT)
  // 標籤含「員工家屬」，且無兄弟姊妹、無園內生、無特殊折扣
  if (input.isStaffFamily && !input.sibling && !input.internalStudent && input.specialDiscount === null) {
    issues.push({
      code: 'STAFF_FAMILY_NO_DISCOUNT',
      message: '學生標記有員工家屬，但未標明特殊折扣、兄弟姊妹或園內生優惠，請核對開單金額。',
    });
  }

  // 3. U41: 備註與標籤衝突診斷 (CONFLICTING_NOTE_SOURCE)
  // 只有備註存在明確優惠關鍵字，且該關鍵字未在標籤命中時才提示
  if (input.notesRaw) {
    const note = input.notesRaw;

    // 檢查園內生 (排除 "非園內生")
    if (note.includes('園內生') && !note.includes('非園內生') && !input.internalStudent) {
      issues.push({
        code: 'CONFLICTING_NOTE_SOURCE',
        category: '園內生',
        message: '備註提及園內生相關敘述，但標籤欄位未標記「園內生」，系統依正式軌 erp-tag-v1 以標籤為準。',
      });
    }

    // 檢查兄弟姊妹
    if (note.includes('兄弟姊妹') && !note.includes('無兄弟姊妹') && !input.sibling) {
      issues.push({
        code: 'CONFLICTING_NOTE_SOURCE',
        category: '兄弟姊妹',
        message: '備註提及兄弟姊妹相關敘述，但標籤欄位未標記「有兄弟姊妹折扣」，系統以標籤為準。',
      });
    }

    // 檢查特殊折扣
    if (note.includes('特殊折扣') && input.specialDiscount === null) {
      issues.push({
        code: 'CONFLICTING_NOTE_SOURCE',
        category: '特殊折扣',
        message: '備註提及特殊折扣，但標籤欄位未包含標準特殊折扣標籤，系統以標籤為準。',
      });
    }
  }

  return issues;
}

/**
 * 比較單一 enrollment 之計算級距與 ERP 登記級距 (U43, U47)。
 */
export function compareTier(input: TierCompareInput): TierComparison {
  const issues: string[] = [];
  let needsReview = false;

  if (input.scheduleStatus === 'schedule_not_found') {
    needsReview = true;
    issues.push('SCHEDULE_NOT_FOUND');
  } else if (input.scheduleStatus === 'schedule_empty') {
    needsReview = true;
    issues.push('SCHEDULE_EMPTY');
  } else if (input.scheduleStatus === 'schedule_incomplete') {
    needsReview = true;
    issues.push('SCHEDULE_INCOMPLETE');
  }

  let status: 'match' | 'mismatch' | 'not_applicable' | 'unavailable' = 'unavailable';

  if (input.erpDeclaredTier === null) {
    status = 'not_applicable';
  } else if (input.computedTier === null) {
    status = 'unavailable';
  } else if (input.computedTier === input.erpDeclaredTier) {
    status = 'match';
  } else {
    status = 'mismatch';
  }

  return {
    enrollmentId: input.enrollmentId || '',
    rawToken: input.rawToken || '',
    baseName: input.baseName || '',
    computedTier: input.computedTier,
    erpDeclaredTier: input.erpDeclaredTier,
    status,
    needsReview,
    issues,
  };
}
