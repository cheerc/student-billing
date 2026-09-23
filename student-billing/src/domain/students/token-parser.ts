import { ParsedToken, TierParseStatus, EnrollmentParseStatus } from './types';

const KNOWN_TIERS_MAP: Record<string, number> = {
  '3': 3,
  '3_5': 3.5,
  '4': 4,
  '4_5': 4.5,
  '5': 5,
};

/**
 * 判斷該班名是否屬於「一般安親／課輔」班級（不含寫功課、美安、數學、美語等）。
 */
export function isRegularCareClass(baseName: string): boolean {
  if (!baseName.includes('國小輔導') && !baseName.includes('安親') && !baseName.includes('課輔')) {
    return false;
  }
  if (baseName.includes('寫功課') || baseName.includes('美安')) {
    return false;
  }
  return true;
}

/**
 * 解析單一班名 token 字串。
 * 格式範例：
 * - 115國小輔導-四年級A[團][4_5] (2026-10-01離班)
 * - 兒童美語-EA[團][Starter]
 * - 國小數學-三A[團]
 */
export function parseSingleClassToken(rawToken: string): ParsedToken {
  const trimmed = rawToken.trim();
  let working = trimmed;

  // 1. 抽取離班日期 (YYYY-MM-DD離班)
  let withdrawalDate: string | null = null;
  const withdrawalMatch = working.match(/\(([0-9]{4}-[0-9]{2}-[0-9]{2})離班\)\s*$/);
  if (withdrawalMatch) {
    withdrawalDate = withdrawalMatch[1];
    working = working.replace(withdrawalMatch[0], '').trim();
  }

  // 2. 抽取中括號標記 [團], [4_5], [Starter] 等
  const bracketRegex = /\[([^\]]+)\]/g;
  const bracketMatches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = bracketRegex.exec(working)) !== null) {
    bracketMatches.push(m[1]);
  }

  // 取得第一個中括號前的部分
  const firstBracketIndex = working.indexOf('[');
  const prefixAndBase = firstBracketIndex >= 0 ? working.substring(0, firstBracketIndex).trim() : working;

  // 3. 抽取年度前綴 (例如 115, 114)
  let yearPrefix: string | null = null;
  let baseName = prefixAndBase;
  const yearMatch = prefixAndBase.match(/^([0-9]{2,4})/);
  if (yearMatch) {
    yearPrefix = yearMatch[1];
    baseName = prefixAndBase.substring(yearPrefix.length).trim();
  }

  const groupFlag = bracketMatches.length > 0 ? bracketMatches[0] : null;
  const modifiers = bracketMatches.slice(1);

  // 4. 解析 ERP 登記級距 (U43)
  let erpBillingTierRaw: string | null = null;
  let erpBillingTier: number | null = null;
  let tierParseStatus: TierParseStatus = 'not_applicable';
  let parseStatus: EnrollmentParseStatus = 'ok';

  if (isRegularCareClass(baseName)) {
    if (modifiers.length === 0) {
      // 無後綴且無未知修飾時預設 5
      erpBillingTier = 5;
      erpBillingTierRaw = null;
      tierParseStatus = 'defaulted';
    } else {
      // 檢查是否符合已知級距
      const tierMod = modifiers.find((mod) => KNOWN_TIERS_MAP[mod] !== undefined);
      if (tierMod) {
        erpBillingTier = KNOWN_TIERS_MAP[tierMod];
        erpBillingTierRaw = tierMod;
        tierParseStatus = 'parsed';
      } else {
        // 未知修飾不可當無後綴回 5
        erpBillingTier = null;
        erpBillingTierRaw = modifiers[0];
        tierParseStatus = 'unavailable';
        parseStatus = 'needs_review';
      }
    }
  } else {
    // 寫功課／美安／美語／數學 不套一般級距
    tierParseStatus = 'not_applicable';
    erpBillingTier = null;
  }

  return {
    rawToken: trimmed,
    yearPrefix,
    baseName,
    groupFlag,
    modifiers,
    withdrawalDate,
    erpBillingTierRaw,
    erpBillingTier,
    tierParseStatus,
    parseStatus,
  };
}

/**
 * 解析以換行分隔的多個班名 token。
 */
export function parseClassTokens(classText: string | null | undefined): ParsedToken[] {
  if (!classText) return [];

  const lines = classText
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return lines.map((line) => parseSingleClassToken(line));
}

/**
 * 抽取舊版數學相容計算鍵 (U32)。
 * 從整段文字找第一個「國小數學-」到其後第一個「[團]」（含「[團]」）。
 */
export function extractLegacyMathKey(tokens: ParsedToken[]): string | null {
  for (const token of tokens) {
    const raw = token.rawToken;
    const matchIndex = raw.indexOf('國小數學-');
    if (matchIndex >= 0) {
      const fromMath = raw.substring(matchIndex);
      const groupIndex = fromMath.indexOf('[團]');
      if (groupIndex >= 0) {
        return fromMath.substring(0, groupIndex + 3);
      }
      return fromMath;
    }
  }
  return null;
}

/**
 * 抽取舊版美語相容計算鍵 (U32)。
 * 從整段文字找第一個「兒童美語-」到其後第一個「[團]」（含「[團]」）。
 */
export function extractLegacyEnglishKey(tokens: ParsedToken[]): string | null {
  for (const token of tokens) {
    const raw = token.rawToken;
    const matchIndex = raw.indexOf('兒童美語-');
    if (matchIndex >= 0) {
      const fromEnglish = raw.substring(matchIndex);
      const groupIndex = fromEnglish.indexOf('[團]');
      if (groupIndex >= 0) {
        return fromEnglish.substring(0, groupIndex + 3);
      }
      return fromEnglish;
    }
  }
  return null;
}
