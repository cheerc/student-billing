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

/** Explicit subjects for the fixed seed manifest. New class names do not use this lookup. */
export const SEED_CLASS_SUBJECTS: ReadonlyMap<string, string> = new Map([
  ['小六加強班-自然', '加強班'],
  ['小六加強班-國文', '加強班'],
  ['小六加強班-數學', '國小數學'],
  ['兒童美語-Gino', '兒童美語'],
  ['兒童美語-Archy', '兒童美語'],
  ['兒童美語-Chevady', '兒童美語'],
  ['兒童美語-Cody', '兒童美語'],
  ['兒童美語-Ali', '兒童美語'],
  ['兒童美語-Dommie', '兒童美語'],
  ['兒童美語-EC', '兒童美語'],
  ['兒童美語-ED', '兒童美語'],
  ['兒童美語-Pluto', '兒童美語'],
  ['兒童美語-EF', '兒童美語'],
  ['兒童美語-EG', '兒童美語'],
  ['兒童美語-EK', '兒童美語'],
  ['兒童美語-EL', '兒童美語'],
  ['兒童美語-EM', '兒童美語'],
  ['兒童美語-Kirra', '兒童美語'],
  ['兒童美語-Norma', '兒童美語'],
  ['兒童美語-Hopper', '兒童美語'],
  ['兒童美語-Teffer', '兒童美語'],
  ['兒童美語-Toker', '兒童美語'],
  ['國小國語文-小三小四', '國小國語文'],
  ['國小國語文-小五', '國小國語文'],
  ['國小輔導-一A', '國小輔導'],
  ['國小輔導-一B', '國小輔導'],
  ['國小輔導-二A', '國小輔導'],
  ['國小輔導-二B', '國小輔導'],
  ['國小輔導-三年級', '國小輔導'],
  ['國小輔導-五年級', '國小輔導'],
  ['國小輔導-六年級', '國小輔導'],
  ['國小輔導-四年級', '國小輔導'],
  ['國小數學-一A', '國小數學'],
  ['國小數學-一B', '國小數學'],
  ['國小數學-二A', '國小數學'],
  ['國小數學-二B', '國小數學'],
  ['國小數學-三A', '國小數學'],
  ['國小數學-三B', '國小數學'],
  ['國小數學-五A', '國小數學'],
  ['國小數學-五B', '國小數學'],
  ['國小數學-六A', '國小數學'],
  ['國小數學-六B', '國小數學'],
  ['國小數學-四A', '國小數學'],
  ['國小數學-四B', '國小數學'],
  ['兒童美語-KA', '兒童美語'],
  ['兒童美語-KB', '兒童美語'],
  ['兒童美語-KC', '兒童美語'],
  ['兒童美語-EA', '兒童美語'],
  ['兒童美語-EB', '兒童美語'],
]);

export const SEED_CLASSES: SeedClassItem[] = SEED_CLASS_RAW_NAMES.map((raw) => {
  const baseName = parseSingleClassToken(raw).baseName;
  const subject = SEED_CLASS_SUBJECTS.get(baseName);
  if (!subject) throw new Error(`Missing explicit seed subject: ${baseName}`);
  return {
    rawName: raw,
    baseName,
    subject,
  };
});

export const SEED_BASE_NAMES = SEED_CLASSES.map((c) => c.baseName);

/**
 * seed 49 個既有班級的**折扣類別基準**（`ClassCategory`），單一定義處（逐班明列的資料）。
 *
 * #157 Ruling 1 之後類別不再由班名推導；若完全沒有這組基準，seed 班會全落為「未設定」。
 * 以同一份 rev 82 設定比較「舊 auto 班名偵測」與「全部 unset」，有報名者母體（372 位 distinct person_code）
 * 有 345 位（92.7%）科數不同；全部匯入學生母體（431 位 loadStudentsForImport）有 345 位（80.0%）不同。
 * 這是「不帶 seed 基準」的反事實量測，不是現行 seed 基準下的影響比例。seed 是**匯入前既有的機構設定**，
 * 不是使用者尚未填寫的空白，因此這組類別是 seed 的既有基準。
 *
 * **這是資料，不是規則**：本表逐班明列 49 個 seed 班級的類別。**使用者在課表設定新增的班
 * （不在本表）一律是「未設定」**，不會因班名含「國小數學」之類的字樣而被推導——這正是
 * #157 Ruling 1 要去除的行為。
 *
 * 各值的依據（依**課程性質**，不是班名關鍵字比對）：
 *  - 國小輔導 → `care`（安親課輔班）
 *  - 國小數學 → `math`（數學班）
 *  - 兒童美語 → `english`（美語班）
 *  - 加強班／國語文 → `none`（不列入多科折扣；02 §9A.3／R15 視其本班適用折扣為 not_configured）
 *  合計 49 班：care 8／math 12／english 24／none 5。
 *
 * 與 #157 之前 `detectClassCategory` 對這 49 個班名的判定結果**逐班相同**（49/49 一致）。
 * 刻意如此：讓「移除自動偵測」在既有資料上不造成 seed 班級的類別漂移。
 * 其中「小六加強班-數學」是**加強班**課程（與其姊妹班「小六加強班-自然」「小六加強班-國文」
 * 同類），故為 `none`——舊的班名關鍵字規則因該名不含「國小數學」而恰好也得到 `none`，
 * 兩者在此班一致；本表**不以班名關鍵字為依據**，而以課程性質為依據。
 */
export type SeedClassType = 'care' | 'english' | 'math' | 'other';

/**
 * D61：seed 49 個既有班級的五種課程類型基準（逐班明列，不依班名關鍵字推導）。
 * - 國小輔導 8 班 → `care`（安親課輔班）
 * - 兒童美語 24 班 → `english`（美語班）
 * - 國小數學 12 班 → `math`（數學班）
 * - 加強班 3 班＋國語文 2 班共 5 班 → `other`（其他班）
 */
export const SEED_CLASS_TYPES: ReadonlyMap<string, SeedClassType> = new Map([
  ["小六加強班-自然", "other"],
  ["小六加強班-國文", "other"],
  ["小六加強班-數學", "other"],
  ["兒童美語-Gino", "english"],
  ["兒童美語-Archy", "english"],
  ["兒童美語-Chevady", "english"],
  ["兒童美語-Cody", "english"],
  ["兒童美語-Ali", "english"],
  ["兒童美語-Dommie", "english"],
  ["兒童美語-EC", "english"],
  ["兒童美語-ED", "english"],
  ["兒童美語-Pluto", "english"],
  ["兒童美語-EF", "english"],
  ["兒童美語-EG", "english"],
  ["兒童美語-EK", "english"],
  ["兒童美語-EL", "english"],
  ["兒童美語-EM", "english"],
  ["兒童美語-Kirra", "english"],
  ["兒童美語-Norma", "english"],
  ["兒童美語-Hopper", "english"],
  ["兒童美語-Teffer", "english"],
  ["兒童美語-Toker", "english"],
  ["國小國語文-小三小四", "other"],
  ["國小國語文-小五", "other"],
  ["國小輔導-一A", "care"],
  ["國小輔導-一B", "care"],
  ["國小輔導-二A", "care"],
  ["國小輔導-二B", "care"],
  ["國小輔導-三年級", "care"],
  ["國小輔導-五年級", "care"],
  ["國小輔導-六年級", "care"],
  ["國小輔導-四年級", "care"],
  ["國小數學-一A", "math"],
  ["國小數學-一B", "math"],
  ["國小數學-二A", "math"],
  ["國小數學-二B", "math"],
  ["國小數學-三A", "math"],
  ["國小數學-三B", "math"],
  ["國小數學-五A", "math"],
  ["國小數學-五B", "math"],
  ["國小數學-六A", "math"],
  ["國小數學-六B", "math"],
  ["國小數學-四A", "math"],
  ["國小數學-四B", "math"],
  ["兒童美語-KA", "english"],
  ["兒童美語-KB", "english"],
  ["兒童美語-KC", "english"],
  ["兒童美語-EA", "english"],
  ["兒童美語-EB", "english"],
]);

export type SeedClassCategory = 'care' | 'math' | 'english' | 'none';

/** 由 SEED_CLASS_TYPES 同源導出（`other -> 'none'`，其餘同名），維持單一資料來源。 */
export const SEED_CLASS_CATEGORIES: ReadonlyMap<string, SeedClassCategory> = new Map(
  Array.from(SEED_CLASS_TYPES.entries(), ([baseName, classType]) => [
    baseName,
    classType === 'other' ? 'none' : classType,
  ])
);

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
