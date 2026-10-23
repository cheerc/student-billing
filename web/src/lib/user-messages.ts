/**
 * 使用者可見的固定訊息（specs/09 §7：狀態碼與內部詞不外露，code 留在細節）。
 * 多個元件共用同一句，避免各自寫出不同措辭或把 HTTP 狀態碼寫進畫面。
 */

/** 啟用名單時遇到 409（CAS 版本衝突）：白話說明原因與下一步。 */
export const ACTIVATE_CONFLICT_MESSAGE =
  '資料已被其他操作更新（例如在另一個視窗使用了名單）。請重新整理頁面，確認目前的資料後再試一次。';

/**
 * 使用者可見的錯誤說明（09 §7；D39）：主文一律白話、告訴使用者下一步；
 * 錯誤代碼與伺服器原始訊息只放在可展開的「詳細資訊」，不在主畫面出現。
 */
export interface UserFacingError {
  /** 主畫面看得到的白話說明 */
  message: string;
  /** 「詳細資訊」摺疊區內容：代碼（若有）與原始訊息 */
  detail: string;
}

export interface RawFailure {
  /** HTTP 狀態；連線中斷等沒有回應時為 undefined */
  status?: number;
  /** API 回傳的錯誤代碼 */
  code?: string;
  /** API 回傳的原始訊息或例外訊息 */
  raw?: string;
}

/** 從失敗回應（JSON 主體＋狀態）取出 RawFailure；error 可能是字串或 { message }。 */
export function readRawFailure(status: number | undefined, json: unknown): RawFailure {
  const body = (json ?? {}) as { error?: unknown; code?: unknown };
  const e = body.error;
  const raw =
    typeof e === 'string'
      ? e
      : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
      ? (e as { message: string }).message
      : undefined;
  return { status, code: typeof body.code === 'string' ? body.code : undefined, raw };
}

function detailOf(f: RawFailure): string {
  const lines: string[] = [];
  if (f.code) lines.push(f.code);
  else if (f.status !== undefined) lines.push(`HTTP ${f.status}`);
  if (f.raw) lines.push(f.raw);
  return lines.join('\n');
}

/** 沒有任何回應（連線中斷、逾時）。例外訊息（如英文的 Failed to fetch）只放詳細資訊。 */
export const CONNECTION_FAILED_MESSAGE = '連線中斷或系統暫時沒有回應，請稍後再試一次。';

export const DRAFT_INVALID_MESSAGE =
  '課表有欄位還沒填好或格式不正確（例如星期沒有填）。請先回到課表修正，再按「確認變更」。';
export const SETTINGS_CONFLICT_MESSAGE = '資料已更新（例如在另一個視窗儲存了課表）。請重新整理頁面，再重新確認變更。';
export const PREVIEW_EXPIRED_MESSAGE = '預覽已逾期，請關閉視窗後重新按「確認變更」。';
export const SETTINGS_FAILED_MESSAGE = '暫時無法完成，請稍後再試；您的修改還在畫面上，沒有遺失。';

/** 課表「確認變更」預覽失敗（POST /settings/preview）。 */
export function describeSettingsPreviewError(f: RawFailure): UserFacingError {
  let message = SETTINGS_FAILED_MESSAGE;
  if (f.status === undefined) message = CONNECTION_FAILED_MESSAGE;
  else if (f.code === 'UPGRADE_REQUIRED') message = '目前核對結果使用舊版規則。請勾選「改用新規則（v4）」完成升級預覽，再確認設定。';
  else if (f.status === 409 || f.code === 'REVISION_CONFLICT') message = SETTINGS_CONFLICT_MESSAGE;
  else if (f.status === 400 && f.code === 'INVALID_DRAFT') message = DRAFT_INVALID_MESSAGE;
  else if (f.status === 400 && f.code === 'IMPORT_MISMATCH') message = '目前使用的名單已經變了，請重新整理頁面後再確認變更。';
  return { message, detail: detailOf(f) };
}

/** 課表套用（POST /settings/apply）失敗。 */
export function describeSettingsApplyError(f: RawFailure): UserFacingError {
  let message = SETTINGS_FAILED_MESSAGE;
  if (f.status === undefined) message = CONNECTION_FAILED_MESSAGE;
  else if (f.code === 'UPGRADE_REQUIRED') message = '目前核對結果使用舊版規則。請勾選「改用新規則（v4）」並完成升級預覽，再儲存設定。';
  else if (f.status === 409 || f.code === 'REVISION_CONFLICT') message = SETTINGS_CONFLICT_MESSAGE;
  else if (f.code === 'PREVIEW_EXPIRED' || /PREVIEW_EXPIRED/.test(f.raw ?? '')) message = PREVIEW_EXPIRED_MESSAGE;
  return { message, detail: detailOf(f) };
}

export const IMPORT_CORRUPT_MESSAGE = '無法讀取這個 Excel 檔案，請重新從米豆奶匯出後再上傳。';
export const IMPORT_MISSING_HEADERS_MESSAGE = '這個 Excel 檔案缺少必要的欄位，請確認是從米豆奶匯出的名單後再上傳。';
export const IMPORT_DUPLICATE_CODE_MESSAGE = '名單裡有重複的人員代碼（同一個人員代碼只能出現一列），請確認匯出的名單後再上傳。';
const IMPORT_GENERIC_MESSAGE = '無法處理這個檔案，請確認是從米豆奶匯出的 Excel 檔案後再上傳。';

/** 上傳名單（POST /imports/preview）失敗。 */
export function describeImportUploadError(f: RawFailure): UserFacingError {
  let message = IMPORT_GENERIC_MESSAGE;
  switch (f.code) {
    case 'INVALID_XLSX':
    case 'ZIP_BOMB_DETECTED':
      message = IMPORT_CORRUPT_MESSAGE;
      break;
    case 'UPGRADE_REQUIRED':
      message = '目前核對結果使用舊版規則。請先到課表設定預覽並確認改用 v4，再上傳名單。';
      break;
    case 'MISSING_REQUIRED_HEADERS':
      message = IMPORT_MISSING_HEADERS_MESSAGE;
      break;
    case 'DUPLICATE_HEADERS':
      message = '這個 Excel 檔案的標題列有重複的欄位，請重新從米豆奶匯出後再上傳。';
      break;
    case 'DUPLICATE_PERSON_CODE':
      message = IMPORT_DUPLICATE_CODE_MESSAGE;
      break;
    case 'ENCRYPTED_FILE':
      message = '這個 Excel 檔案有密碼保護，請解除保護或重新從米豆奶匯出後再上傳。';
      break;
    case 'FILE_TOO_LARGE':
      message = '這個檔案太大了，請確認是米豆奶匯出的名單，或分批匯出後再上傳。';
      break;
    case 'EMPTY_WORKBOOK':
    case 'SHEET_NOT_FOUND':
      message = '這個 Excel 檔案裡找不到名單資料，請重新從米豆奶匯出後再上傳。';
      break;
    default:
      if (f.status === undefined) message = CONNECTION_FAILED_MESSAGE;
  }
  return { message, detail: detailOf(f) };
}

/** 啟用名單（POST /imports/{id}/activate）失敗。409 沿用既有說明。 */
export function describeActivateError(f: RawFailure): UserFacingError {
  let message = '暫時無法使用這份名單，請稍後再試；名單仍保留在畫面上，沒有遺失。';
  if (f.status === undefined) message = CONNECTION_FAILED_MESSAGE;
  else if (f.code === 'UPGRADE_REQUIRED') message = '目前核對結果使用舊版規則。請先在課表設定預覽並確認升級 v4，再啟用名單。';
  else if (f.status === 409) message = ACTIVATE_CONFLICT_MESSAGE;
  return { message, detail: detailOf(f) };
}

/** 讀取資料失敗（查詢學生、名單）：說明目前畫面沒有被更動。 */
export function describeLoadError(subject: string, f: RawFailure): UserFacingError {
  const message =
    f.status === undefined
      ? CONNECTION_FAILED_MESSAGE
      : `${subject}暫時失敗，請稍後再試；目前畫面上的資料沒有被更動。`;
  return { message, detail: detailOf(f) };
}

/** 任意例外（例如 fetch 的 TypeError: Failed to fetch）→ 沒有回應的失敗，例外訊息放詳細資訊。 */
export function failureFromException(err: unknown): RawFailure {
  return { raw: err instanceof Error ? err.message : String(err) };
}
