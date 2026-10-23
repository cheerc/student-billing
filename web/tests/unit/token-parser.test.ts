import { describe, it, expect } from 'vitest';
import {
  parseClassTokens,
  projectTierForApplicability,
  extractLegacyMathKey,
  extractLegacyEnglishKey,
} from '@/domain/students/token-parser';

describe('班名 token 詞法解析與 run 級距投影 (U32, U43, U44, U45, U46)', () => {
  it('U32: 保留全部原文，正確抽取第一個數學班與美語班到 [團]', () => {
    const raw = '115國小數學-三A[團]\n兒童美語-EA[團][Starter]\n國小數學-二[團]';
    const tokens = parseClassTokens(raw);
    expect(tokens).toHaveLength(3);

    expect(tokens[0].rawToken).toBe('115國小數學-三A[團]');
    expect(tokens[1].rawToken).toBe('兒童美語-EA[團][Starter]');
    expect(tokens[2].rawToken).toBe('國小數學-二[團]');

    // Legacy 抽取鍵：數學抽第一個前綴至 [團]（不含年度前綴）
    const mathKey = extractLegacyMathKey(tokens);
    expect(mathKey).toBe('國小數學-三A[團]');

    // Legacy 抽取鍵：美語抽第一個前綴至 [團]（不含後續級別修飾）
    const englishKey = extractLegacyEnglishKey(tokens);
    expect(englishKey).toBe('兒童美語-EA[團]');
  });

  it('U43: 一般安親/課輔登記級距解析與預設值', () => {
    // [3], [3_5], [4], [4_5], [5]
    const t3 = projectTierForApplicability(parseClassTokens('國小輔導-三年級[團][3]')[0], 'applicable');
    expect(t3.erpBillingTier).toBe(3);
    expect(t3.erpBillingTierRaw).toBe('3');
    expect(t3.tierParseStatus).toBe('parsed');

    const t35 = projectTierForApplicability(parseClassTokens('國小輔導-三年級[團][3_5]')[0], 'applicable');
    expect(t35.erpBillingTier).toBe(3.5);
    expect(t35.erpBillingTierRaw).toBe('3_5');
    expect(t35.tierParseStatus).toBe('parsed');

    const t4 = projectTierForApplicability(parseClassTokens('國小輔導-四年級[團][4]')[0], 'applicable');
    expect(t4.erpBillingTier).toBe(4);
    expect(t4.tierParseStatus).toBe('parsed');

    const t45 = projectTierForApplicability(parseClassTokens('115國小輔導-四年級A[團][4_5]')[0], 'applicable');
    expect(t45.erpBillingTier).toBe(4.5);
    expect(t45.erpBillingTierRaw).toBe('4_5');
    expect(t45.tierParseStatus).toBe('parsed');

    const t5 = projectTierForApplicability(parseClassTokens('國小輔導-五年級[團][5]')[0], 'applicable');
    expect(t5.erpBillingTier).toBe(5);
    expect(t5.tierParseStatus).toBe('parsed');

    // 無後綴且無未知修飾時預設 5 (僅限一般安課)
    const tDefault = projectTierForApplicability(parseClassTokens('國小輔導-二年級[團]')[0], 'applicable');
    expect(tDefault.erpBillingTier).toBe(5);
    expect(tDefault.erpBillingTierRaw).toBeNull();
    expect(tDefault.tierParseStatus).toBe('defaulted');

    // 未知後綴不可當無後綴回 5
    const tUnknown = projectTierForApplicability(parseClassTokens('國小輔導-二年級[團][未知修飾]')[0], 'applicable');
    expect(tUnknown.erpBillingTier).toBeNull();
    expect(tUnknown.tierParseStatus).toBe('unavailable');
    expect(tUnknown.parseStatus).toBe('needs_review');

    // 寫功課／美安不套一般級距預設 5
    const tHomework = projectTierForApplicability(parseClassTokens('國小輔導-寫功課[團]')[0], 'not_applicable');
    expect(tHomework.erpBillingTier).toBeNull();
    expect(tHomework.tierParseStatus).toBe('not_applicable');

    // 美語／數學修飾不是天數
    const tEnglish = projectTierForApplicability(parseClassTokens('兒童美語-EA[團][W1]')[0], 'not_applicable');
    expect(tEnglish.erpBillingTier).toBeNull();
    expect(tEnglish.tierParseStatus).toBe('not_applicable');
  });

  it('U44: 同學生多個安課 enrollment 獨立解析', () => {
    const raw = '國小輔導-三年級[團][5]\n國小輔導-三年級[團][4]';
    const tokens = parseClassTokens(raw).map((token) => projectTierForApplicability(token, 'applicable'));
    expect(tokens).toHaveLength(2);
    expect(tokens[0].erpBillingTier).toBe(5);
    expect(tokens[1].erpBillingTier).toBe(4);
  });

  it('U45: 正確解析明確離班標記，不排除學生', () => {
    const tokenWithWithdrawal = projectTierForApplicability(parseClassTokens('115國小輔導-四年級A[團][4_5] (2026-10-01離班)')[0], 'applicable');
    expect(tokenWithWithdrawal.withdrawalDate).toBe('2026-10-01');
    expect(tokenWithWithdrawal.baseName).toBe('國小輔導-四年級A');
    expect(tokenWithWithdrawal.groupFlag).toBe('團');
    expect(tokenWithWithdrawal.modifiers).toContain('4_5');
    expect(tokenWithWithdrawal.erpBillingTier).toBe(4.5);

    // 一般無離班標記
    const normal = parseClassTokens('115國小輔導-四年級A[團][4_5]')[0];
    expect(normal.withdrawalDate).toBeNull();
  });

  it('U46: 結構化班名區分四年級 A/B 與無 A/B，不模糊合併', () => {
    const token4A = parseClassTokens('國小輔導-四年級A[團]')[0];
    const token4B = parseClassTokens('國小輔導-四年級B[團]')[0];
    const token4 = parseClassTokens('國小輔導-四年級[團]')[0];
    const math1 = parseClassTokens('國小數學-一[團]')[0];

    expect(token4A.baseName).toBe('國小輔導-四年級A');
    expect(token4B.baseName).toBe('國小輔導-四年級B');
    expect(token4.baseName).toBe('國小輔導-四年級');
    expect(math1.baseName).toBe('國小數學-一');

    // 互不相等
    expect(token4A.baseName).not.toBe(token4B.baseName);
    expect(token4A.baseName).not.toBe(token4.baseName);
  });
});
