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
  /** 經由 Alias 映射覆蓋之目標班級清單 (獨立展示，不與 ERP 實體直配混淆) */
  aliasCovered?: string[];
  aliasCoveredCount?: number;
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

/** 具名漂移候選定義（D18 ＋ D22） */
export interface NamedCandidate {
  rawBaseName: string;
  targetBaseName: string;
  reason: string;
  category: 'D18' | 'D22';
  isValid?: boolean;
}

/**
 * D18 與 D22 具名候選清單（4 組）。
 * 沿用 D18 具名模式供人工確認，軟體嚴禁自動批准。
 */
export const NAMED_CANDIDATES: NamedCandidate[] = [
  {
    rawBaseName: '國小數學-一',
    targetBaseName: '國小數學-一A',
    reason: 'D18 確認事實：本次數學一班與一A為同班；preview 應展示 13 人各 -0.5 天、mismatch 5→18',
    category: 'D18',
  },
  {
    rawBaseName: '國小國語文-小三四',
    targetBaseName: '國小國語文-小三小四',
    reason: 'D22 純命名漂移：國小國語文小三四對應 seed 國小國語文-小三小四',
    category: 'D22',
  },
  {
    rawBaseName: '小六國文加強班',
    targetBaseName: '小六加強班-國文',
    reason: 'D22 純命名漂移：小六國文加強班對應 seed 小六加強班-國文',
    category: 'D22',
  },
  {
    rawBaseName: '小六數學加強班',
    targetBaseName: '小六加強班-數學',
    reason: 'D22 純命名漂移：小六數學加強班對應 seed 小六加強班-數學',
    category: 'D22',
  },
];

/** 雙軌對照視圖結果 */
export interface DualTrackClassificationResult {
  /** 軌道 1：初始 Seed 49 班盤點基準 (保持 I19 錨點 54/42/12/7) */
  seedInventory: BaseNameClassificationResult;
  /** 軌道 2：當前系統有效設定視圖 (動態 active classes + 已核准 aliases) */
  activeView: BaseNameClassificationResult;
  /** 候選清單 (驗證 target 存在於有效設定中) */
  candidates: NamedCandidate[];
}

/**
 * 雙軌對照引擎：
 * 同時提供 Seed 49 班基準盤點（固定錨點）與當前 active classes 設定視圖。
 */
export function classifyErpDualTrack(
  erpBaseNames: string[],
  activeClassBaseNames?: string[],
  approvedAliases?: Array<{ rawBaseName: string; targetBaseName: string }>
): DualTrackClassificationResult {
  const seedInventory = classifyErpBaseNames(erpBaseNames);

  const activeClasses = activeClassBaseNames && activeClassBaseNames.length > 0
    ? activeClassBaseNames
    : SEED_BASE_NAMES;
  const activeClassSet = new Set(activeClasses);

  const aliasMap = new Map<string, string>();
  if (approvedAliases) {
    for (const a of approvedAliases) {
      if (activeClassSet.has(a.targetBaseName)) {
        aliasMap.set(a.rawBaseName, a.targetBaseName);
      }
    }
  }

  const erpSet = new Set(erpBaseNames);
  const activeMatched: string[] = [];
  const activeUnmatched: string[] = [];
  const erpDirectCovered = new Set<string>();
  const aliasCoveredSet = new Set<string>();

  for (const b of erpSet) {
    if (activeClassSet.has(b)) {
      activeMatched.push(b);
      erpDirectCovered.add(b);
    } else if (aliasMap.has(b)) {
      activeMatched.push(b);
      aliasCoveredSet.add(aliasMap.get(b)!);
    } else {
      activeUnmatched.push(b);
    }
  }

  // F1: activeNotAppeared (seedNotAppeared) 嚴格按 ERP 實體直配判定 (01 §4.3)，
  // 即使目標班級由 alias 覆蓋，若本批無 ERP 實體 token 仍列為未出現，真相不被掩蓋。
  const activeNotAppeared: string[] = [];
  for (const c of activeClassSet) {
    if (!erpDirectCovered.has(c)) {
      activeNotAppeared.push(c);
    }
  }

  const activeView: BaseNameClassificationResult = {
    matched: activeMatched.sort(),
    matchedCount: activeMatched.length,
    unmatched: activeUnmatched.sort(),
    unmatchedCount: activeUnmatched.length,
    seedNotAppeared: activeNotAppeared.sort(),
    seedNotAppearedCount: activeNotAppeared.length,
    ambiguousCount: 0,
    aliasCovered: Array.from(aliasCoveredSet).sort(),
    aliasCoveredCount: aliasCoveredSet.size,
  };

  // N2: 標記候選有效性 (isValid)，target 存在於有效設定中即為有效
  const candidates = NAMED_CANDIDATES.map((c) => ({
    ...c,
    isValid: activeClassSet.has(c.targetBaseName),
  }));

  return {
    seedInventory,
    activeView,
    candidates,
  };
}
