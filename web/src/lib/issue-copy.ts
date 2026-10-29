/**
 * 待確認事項（問題類型）的使用者文案（D39 (4)；specs/09 §7）：
 * 日常介面只顯示中文名稱與白話說明，英文代碼與資料層的原始訊息只在明細的「技術資訊」。
 * 資料層的 message 可能含工程用語（fallback、alias、D24、erp-tag 等，且歷史 run 已經存了舊訊息），
 * 所以畫面一律以「代碼→白話說明」呈現；只有不含工程詞、且帶有班名等具體內容的訊息才沿用。
 */

export const ISSUE_LABELS: Record<string, string> = {
  SCHEDULE_NOT_FOUND: '排課缺漏',
  DUPLICATE_SUBJECT_ENROLLMENT: '重複報名',
  STAFF_FAMILY_NO_DISCOUNT: '員工家屬無折扣',
  CONFLICTING_NOTE_SOURCE: '備註衝突',
  CLASS_NOT_MAPPED: '班名未對應課表',
  SCHEDULE_EMPTY: '排課空時段',
  SCHEDULE_INCOMPLETE: '排課時段不完整',
  UNKNOWN_WEEKDAY: '未知星期',
};

/** 未知代碼的中文名稱：不外露代碼，說明需要人工確認。 */
export const UNKNOWN_ISSUE_LABEL = '其他待確認事項';

const ISSUE_MESSAGES: Record<string, string> = {
  SCHEDULE_NOT_FOUND: '報名的班級在課表裡找不到，這位學生的天數暫時當作 0 天扣除，請到課表設定新增該班，或在「課表設定 → 班名同步」把名冊班名同步到既有班級。',
  DUPLICATE_SUBJECT_ENROLLMENT: '同一類別的課程重複報名了，請到米豆奶確認學生的課程設定。',
  STAFF_FAMILY_NO_DISCOUNT: '標籤有「員工家屬」，但沒有標明特殊折扣、兄弟姊妹或園內生優惠，請核對開單金額。',
  CONFLICTING_NOTE_SOURCE: '備註提到的折扣和標籤欄位不一致，系統以標籤為準，請核對備註。',
  CLASS_NOT_MAPPED: '班名未對應課表，請確認米豆奶班名或系統班級名稱。',
  SCHEDULE_EMPTY: '這個班的課表還沒有填任何時段，請到課表設定補上。',
  SCHEDULE_INCOMPLETE: '這個班的課表時段不完整（缺班名、星期或起訖時間），請到課表設定補齊。',
  UNKNOWN_WEEKDAY: '課表裡有時段的星期沒有填或無法識別，該時段的衝堂一律當作 0，請把星期改成「一」到「日」。',
};

const ENGINEERING_TERMS = /fallback|alias|種子|D\d{2}\b|erp-tag|\bv[0-9]\b|[A-Z]{3,}_[A-Z_]+|mismatch|token/i;

export interface IssueLike {
  code: string;
  message?: string | null;
}

export function issueLabel(code: string): string {
  return ISSUE_LABELS[code] ?? UNKNOWN_ISSUE_LABEL;
}

/** 日常介面顯示的說明：已知代碼用白話說明；只有沒有工程詞的原始訊息才沿用（帶班名等具體內容）。 */
export function issueMessage(issue: IssueLike): string {
  const known = ISSUE_MESSAGES[issue.code];
  const raw = issue.message?.trim();
  if (raw && !ENGINEERING_TERMS.test(raw) && (issue.code === 'DUPLICATE_SUBJECT_ENROLLMENT' || !known)) return raw;
  return known ?? '這位學生有需要人工確認的事項，請核對米豆奶的資料。';
}
