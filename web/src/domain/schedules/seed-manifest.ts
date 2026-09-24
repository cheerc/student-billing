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

/** D32-C 動態候選行：由當批 ERP 差集組裝，純資料，不含寫死後果數字 */
export interface DynamicCandidate {
  rawBaseName: string;
  /** 確定性建議目標；無確定性規則時為空字串，由人工填寫（D32-C 凍結） */
  suggestedTarget: string;
  /** 去重人數（COUNT DISTINCT person_code；I19／preview 口徑） */
  studentCount: number;
  /** token 筆數（COUNT(*)） */
  tokenCount: number;
  /** 中性說明，不含寫死人數／後果數字；影響以後果預覽為準 */
  reason: string;
  /** 建議目標有效性（為空視為中性 true；非空則需存在於有效設定） */
  isValid: boolean;
}

/** D32-C 候選人數口徑：key 為 baseName */
export type CandidateCounts = Map<string, { studentCount: number; tokenCount: number }>;

/**
 * D32-C 動態候選組裝層（純函式）：
 * activeUnmatched 差集 → 候選行（rawBaseName＋去重人數／筆數＋建議目標）。
 * - 建議目標凍結為空字串由人工填寫（不做模糊匹配，CLAUDE.md 別名政策）。
 * - 後果數字一律由 preview 產生，reason 不寫死任何數字。
 * - 不建立 alias、不修改傳入的 active 集合或 alias 表（嚴禁自動批准）。
 */
export function buildDynamicCandidates(
  activeUnmatched: string[],
  counts?: CandidateCounts,
  activeClassSet?: Set<string>
): DynamicCandidate[] {
  const rows: DynamicCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of activeUnmatched) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    // 防禦性過濾：已對齊（存在於有效班級）者不進候選（對齊消失自動消失）
    if (activeClassSet && activeClassSet.has(raw)) continue;
    const c = counts?.get(raw);
    rows.push({
      rawBaseName: raw,
      suggestedTarget: '',
      studentCount: c?.studentCount ?? 0,
      tokenCount: c?.tokenCount ?? 0,
      reason: 'D32-C 動態候選：本批 ERP 與系統差集待設定；影響以後果預覽（preview）為準，不在此寫死',
      isValid: true,
    });
  }
  rows.sort((a, b) => (a.rawBaseName < b.rawBaseName ? -1 : a.rawBaseName > b.rawBaseName ? 1 : 0));
  return rows;
}

/** 雙軌對照視圖結果 */
export interface DualTrackClassificationResult {
  /** 軌道 1：初始 Seed 49 班盤點基準 (保持 I19 錨點 54/42/12/7) */
  seedInventory: BaseNameClassificationResult;
  /** 軌道 2：當前系統有效設定視圖 (動態 active classes + 已核准 aliases) */
  activeView: BaseNameClassificationResult;
  /** D32-C 動態候選清單（由當批差集組裝；D32-B 隱藏語義內建） */
  candidates: DynamicCandidate[];
}

/**
 * 雙軌對照引擎：
 * 同時提供 Seed 49 班基準盤點（固定錨點）與當前 active classes 設定視圖。
 */
export function classifyErpDualTrack(
  erpBaseNames: string[],
  activeClassBaseNames?: string[],
  approvedAliases?: Array<{ rawBaseName: string; targetBaseName: string }>,
  candidateCounts?: CandidateCounts
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

  // D32-C: 動態候選由當批差集組裝（activeUnmatched 為已排除 alias 覆蓋與已對齊者）。
  // D32-B 隱藏語義由 buildDynamicCandidates 內建（raw 已在 active 即不進候選）。
  const candidates = buildDynamicCandidates(activeUnmatched, candidateCounts, activeClassSet);

  return {
    seedInventory,
    activeView,
    candidates,
  };
}
