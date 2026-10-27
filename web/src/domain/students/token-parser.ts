import { ParsedToken } from './types';

const KNOWN_TIERS_MAP: Record<string, number> = {
  '3': 3,
  '3_5': 3.5,
  '4': 4,
  '4_5': 4.5,
  '5': 5,
};

/**
 * Parse token syntax only. Tier meaning is projected later from the aliased run class setting.
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

  return {
    rawToken: trimmed,
    yearPrefix,
    baseName,
    groupFlag,
    modifiers,
    withdrawalDate,
    erpBillingTierRaw: null,
    erpBillingTier: null,
    tierParseStatus: 'unavailable',
    parseStatus: 'needs_review',
  };
}

/** Interpret tier modifiers from the class's resolved, run-specific metadata. */
export function projectTierForApplicability(
  token: ParsedToken,
  applicability: 'applicable' | 'not_applicable' | 'unset'
): ParsedToken {
  if (applicability === 'not_applicable') {
    return {
      ...token,
      erpBillingTierRaw: null,
      erpBillingTier: null,
      tierParseStatus: 'not_applicable',
      parseStatus: 'ok',
    };
  }

  if (applicability === 'unset') {
    return {
      ...token,
      erpBillingTierRaw: token.modifiers[0] ?? null,
      erpBillingTier: null,
      tierParseStatus: 'unavailable',
      parseStatus: 'needs_review',
    };
  }

  if (token.modifiers.length === 0) {
    return {
      ...token,
      erpBillingTierRaw: null,
      erpBillingTier: 5,
      tierParseStatus: 'defaulted',
      parseStatus: 'ok',
    };
  }

  const tierMod = token.modifiers.find((modifier) => KNOWN_TIERS_MAP[modifier] !== undefined);
  if (tierMod) {
    return {
      ...token,
      erpBillingTierRaw: tierMod,
      erpBillingTier: KNOWN_TIERS_MAP[tierMod],
      tierParseStatus: 'parsed',
      parseStatus: 'ok',
    };
  }

  return {
    ...token,
    erpBillingTierRaw: token.modifiers[0],
    erpBillingTier: null,
    tierParseStatus: 'unavailable',
    parseStatus: 'needs_review',
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
