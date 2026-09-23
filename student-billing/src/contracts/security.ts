export class SecurityError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, message: string, code = 'SECURITY_VIOLATION') {
    super(message);
    this.name = 'SecurityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * 驗證寫入請求是否符合 same-origin 安全政策 (specs/03 §7)。
 * 檢查 Origin 或 Referer 之 host 是否與請求之 Host 標頭相符。
 */
export function validateSameOrigin(request: Request): boolean {
  const host = request.headers.get('host') || request.headers.get('x-forwarded-host');
  if (!host) {
    return true;
  }

  // 1. 優先檢查 Origin 標頭
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) {
        return false;
      }
      return true;
    } catch (_e) {
      return false;
    }
  }

  // 2. 次之檢查 Referer 標頭
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.host !== host) {
        return false;
      }
      return true;
    } catch (_e) {
      return false;
    }
  }

  // 3. 檢查 Sec-Fetch-Site 標頭
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    return false;
  }

  return true;
}

/**
 * 檢查並淨化路徑參數（如 previewId, runId, personCode），防範路徑遍歷與字元注入。
 */
export function sanitizePathParam(param: string | undefined | null, paramName = '路徑參數'): string {
  if (!param || typeof param !== 'string' || param.trim() === '') {
    throw new SecurityError(400, `${paramName} 不得為空`, 'INVALID_PATH_PARAM');
  }

  const trimmed = param.trim();

  // 檢查是否含有路徑遍歷、斜線或空字元
  if (
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    !/^[a-zA-Z0-9_\-.:@]+$/.test(trimmed)
  ) {
    throw new SecurityError(
      400,
      `${paramName} 格式不合法或含有非法路徑字元: 「${trimmed}」`,
      'INVALID_PATH_PARAM'
    );
  }

  return trimmed;
}

/**
 * PII 資料保護過濾器：將手機號碼或敏感通訊資訊遮蔽，避免輸出至錯誤日誌或回應。
 */
export function maskSensitiveInfo(text: string): string {
  if (!text) return '';
  // 遮蔽台灣常見手機號碼 (09xx-xxx-xxx 或 09xxxxxxxx)
  return text.replace(/\b09\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/g, '09**-***-***');
}
