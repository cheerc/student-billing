/**
 * 班級類別自動偵測（純函式，D37 用途 ①–④ 的單一來源；D1 只交付、未接線，D2 才在設定草稿／計算／UI 使用）。
 *
 * operator 裁決（d-20260930112930661160-25）：
 *  - Q1：名稱含「寫功課」→ 不列入（寫功課優先，與 02 R17「先將寫功課分類、再判一般國小輔導」一致）。
 *  - Q2：安親課輔班＝名稱「包含」國小輔導／安親／課輔（與 v2 現行 M1／M5 一致；寫功課已在 Q1 排除）。
 *  - 其次含「國小數學」→ 數學班；含「兒童美語」→ 美語班；其餘 → 不列入。
 *    條列順序＝優先順序：同時符合多類時取前者（安親課輔 > 數學 > 美語）。
 *  - Q7-A：固定 5 天旗標＝名稱含「寫功課」或「美安」，與類別獨立
 *    （旗標同時是天數下限 5 與安親／課輔適用率 100% 的來源，v2 本來同源）。
 *
 * 不依賴 DB／UI／規則版本：D1 不新增規則版本，這組規則是新規則版本（D2）將採用的偵測式。
 */

export type ClassCategory = 'care' | 'math' | 'english' | 'none';

export interface ClassAttributes {
  category: ClassCategory;
  fixedFiveDays: boolean;
}

const HOMEWORK = '寫功課';
const MEIAN = '美安';
const CARE_WORDS = ['國小輔導', '安親', '課輔'] as const;

export function detectClassCategory(baseName: string): ClassCategory {
  if (baseName.includes(HOMEWORK)) return 'none';
  if (CARE_WORDS.some((w) => baseName.includes(w))) return 'care';
  if (baseName.includes('國小數學')) return 'math';
  if (baseName.includes('兒童美語')) return 'english';
  return 'none';
}

export function detectFixedFiveDays(baseName: string): boolean {
  return baseName.includes(HOMEWORK) || baseName.includes(MEIAN);
}

export function detectClassAttributes(baseName: string): ClassAttributes {
  return { category: detectClassCategory(baseName), fixedFiveDays: detectFixedFiveDays(baseName) };
}

export interface ResolvedClassEnrollment {
  rawToken: string;
  baseName: string;
  resolvedBaseName: string;
  mapped: boolean;
  category: ClassCategory;
  categorySource: 'auto' | 'manual';
  fixedFiveDays: boolean;
  fixedSource: 'auto' | 'manual';
}

export interface ClassSettingLookup {
  category?: ClassCategory;
  categorySource?: 'auto' | 'manual';
  fixedFiveDays?: boolean;
  fixedSource?: 'auto' | 'manual';
}

/**
 * D2a: 解析學生報名班級的類別與固定 5 天屬性 (S manifest §4.2, §7, D37 3)。
 * 名冊班名有對應系統班級 -> 用該班級設定；無對應 -> 依米豆奶班名自動偵測。
 */
export function resolveClassEnrollment(
  token: { rawToken: string; baseName: string },
  aliasMap?: Map<string, string>,
  classSettingMap?: Map<string, ClassSettingLookup>
): ResolvedClassEnrollment {
  const resolvedBaseName = aliasMap?.get(token.baseName) ?? token.baseName;
  const cls = classSettingMap?.get(resolvedBaseName);

  if (cls) {
    const auto = detectClassAttributes(resolvedBaseName);
    return {
      rawToken: token.rawToken,
      baseName: token.baseName,
      resolvedBaseName,
      mapped: true,
      category: cls.category ?? auto.category,
      categorySource: cls.categorySource ?? 'auto',
      fixedFiveDays: cls.fixedFiveDays ?? auto.fixedFiveDays,
      fixedSource: cls.fixedSource ?? 'auto',
    };
  }

  const auto = detectClassAttributes(resolvedBaseName);
  return {
    rawToken: token.rawToken,
    baseName: token.baseName,
    resolvedBaseName,
    mapped: false,
    category: auto.category,
    categorySource: 'auto',
    fixedFiveDays: auto.fixedFiveDays,
    fixedSource: 'auto',
  };
}
