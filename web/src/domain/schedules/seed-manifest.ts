import { parseSingleClassToken } from '../students/token-parser';

export interface SeedClassItem {
  rawName: string;
  baseName: string;
  subject: string;
}

export const SEED_CLASS_RAW_NAMES = [
  '小六加強班-自然[團]',
  '小六加強班-國文[團]',
  '小六加強班-數學[團]',
  '兒童美語-Gino[團]',
  '兒童美語-Archy[團]',
  '兒童美語-Chevady[團]',
  '兒童美語-Cody[團]',
  '兒童美語-Ali[團]',
  '兒童美語-Dommie[團]',
  '兒童美語-EC[團]',
  '兒童美語-ED[團]',
  '兒童美語-Pluto[團]',
  '兒童美語-EF[團]',
  '兒童美語-EG[團]',
  '兒童美語-EK[團]',
  '兒童美語-EL[團]',
  '兒童美語-EM[團]',
  '兒童美語-Kirra[團]',
  '兒童美語-Norma[團]',
  '兒童美語-Hopper[團]',
  '兒童美語-Teffer[團]',
  '兒童美語-Toker[團]',
  '國小國語文-小三小四[團]',
  '國小國語文-小五[團]',
  '國小輔導-一A[團]',
  '國小輔導-一B[團]',
  '國小輔導-二A[團]',
  '國小輔導-二B[團]',
  '國小輔導-三年級[團]',
  '國小輔導-五年級[團]',
  '國小輔導-六年級[團]',
  '國小輔導-四年級[團]',
  '國小數學-一A[團]',
  '國小數學-一B[團]',
  '國小數學-二A[團]',
  '國小數學-二B[團]',
  '國小數學-三A[團]',
  '國小數學-三B[團]',
  '國小數學-五A[團]',
  '國小數學-五B[團]',
  '國小數學-六A[團]',
  '國小數學-六B[團]',
  '國小數學-四A[團]',
  '國小數學-四B[團]',
  '兒童美語-KA[團]',
  '兒童美語-KB[團]',
  '兒童美語-KC[團]',
  '兒童美語-EA[團]',
  '兒童美語-EB[團]',
] as const;

export function deriveSubject(baseName: string): string {
  if (baseName.includes('美語')) return '兒童美語';
  if (baseName.includes('數學')) return '國小數學';
  if (baseName.includes('國語文')) return '國小國語文';
  if (baseName.includes('加強班')) return '加強班';
  if (baseName.includes('國小輔導') || baseName.includes('安親') || baseName.includes('課輔')) {
    return '國小輔導';
  }
  return '其他';
}

export const SEED_CLASSES: SeedClassItem[] = SEED_CLASS_RAW_NAMES.map((raw) => {
  const baseName = parseSingleClassToken(raw).baseName;
  return {
    rawName: raw,
    baseName,
    subject: deriveSubject(baseName),
  };
});

export const SEED_BASE_NAMES = SEED_CLASSES.map((c) => c.baseName);

export interface BaseNameClassificationResult {
  matched: string[];
  matchedCount: number;
  unmatched: string[];
  unmatchedCount: number;
  seedNotAppeared: string[];
  seedNotAppearedCount: number;
  ambiguousCount: number;
}

/**
 * 將 ERP 匯入之 baseName 清單與初始 Seed 49 班進行對照分類 (I19)。
 * 42 個精確相等自動候選，12 個待設定，seed 側 7 個本批未出現，0 歧義。
 */
export function classifyErpBaseNames(erpBaseNames: string[]): BaseNameClassificationResult {
  const seedSet = new Set(SEED_BASE_NAMES);
  const erpSet = new Set(erpBaseNames);

  const matched: string[] = [];
  const unmatched: string[] = [];

  erpSet.forEach((b) => {
    if (seedSet.has(b)) {
      matched.push(b);
    } else {
      unmatched.push(b);
    }
  });

  const seedNotAppeared: string[] = [];
  seedSet.forEach((b) => {
    if (!erpSet.has(b)) {
      seedNotAppeared.push(b);
    }
  });

  return {
    matched: matched.sort(),
    matchedCount: matched.length,
    unmatched: unmatched.sort(),
    unmatchedCount: unmatched.length,
    seedNotAppeared: seedNotAppeared.sort(),
    seedNotAppearedCount: seedNotAppeared.length,
    ambiguousCount: 0,
  };
}
