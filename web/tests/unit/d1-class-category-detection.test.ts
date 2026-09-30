import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadModule } from '../helpers/d1-test-kit';

/**
 * D1 類別自動偵測純函式（specs/11 §3 D1、04 §8 UX43；S manifest §4.2；operator ruling d-20260930112930661160-25 的 Q1／Q2／Q7-A）。
 * D1 只交付「未接線」的純函式與測試；D2 才在設定草稿、計算、UI 使用它。
 *
 * 規則（全部為 operator 已定案，本檔的 expected 一律手算自規則文字，不是由實作反推）：
 *   1. 名稱含「寫功課」→ 不列入（Q1：寫功課優先；與 02 R17「先將寫功課分類、再判一般國小輔導」一致）。
 *   2. 否則，名稱含「國小輔導」「安親」「課輔」任一 → 安親課輔班（Q2：包含式，與 v2 現行 M1／M5 一致；寫功課已在 1. 排除）。
 *   3. 否則，含「國小數學」→ 數學班。
 *   4. 否則，含「兒童美語」→ 美語班。
 *   5. 否則 → 不列入。
 *   固定 5 天旗標（Q7-A）：名稱含「寫功課」或「美安」，與類別獨立（美安沒有寫功課時類別仍依 2–5 判斷）。
 * 條列順序＝優先順序：一個名稱同時符合多個類別時，取條列在前者（安親課輔 > 數學 > 美語）。
 */

interface Detection {
  detectClassCategory: (baseName: string) => 'care' | 'math' | 'english' | 'none';
  detectFixedFiveDays: (baseName: string) => boolean;
  detectClassAttributes: (baseName: string) => { category: 'care' | 'math' | 'english' | 'none'; fixedFiveDays: boolean };
}

const MODULE = '@/domain/classification/class-category';

type Row = [name: string, category: 'care' | 'math' | 'english' | 'none', fixedFiveDays: boolean, why: string];

const TABLE: Row[] = [
  // 安親課輔班（規則 2）
  ['國小輔導-四年級', 'care', false, '含「國小輔導」'],
  ['國小輔導-一A', 'care', false, '含「國小輔導」'],
  ['115國小輔導-四年級A', 'care', false, '含「國小輔導」（前綴年度不影響：包含式）'],
  ['國小安親-一A', 'care', false, '含「安親」'],
  ['國小課輔-三年級', 'care', false, '含「課輔」'],
  ['週六課輔', 'care', false, '含「課輔」（程式內既有的週六課輔名稱）'],
  ['安親班', 'care', false, 'Q2 包含式：含「安親」但不以「國小」開頭也算'],
  // 寫功課（規則 1）
  ['國小輔導-寫功課', 'none', true, 'Q1：同時含「國小輔導」與「寫功課」→ 寫功課優先→不列入，固定 5 天'],
  ['寫功課', 'none', true, '含「寫功課」'],
  ['寫功課班-A', 'none', true, '含「寫功課」'],
  ['國小數學-寫功課', 'none', true, '寫功課優先於數學'],
  ['兒童美語-寫功課', 'none', true, '寫功課優先於美語'],
  // 美安（固定 5 天旗標與類別獨立）
  ['美安', 'none', true, '只含「美安」：不屬三類、固定 5 天'],
  ['國小輔導美安', 'care', true, '含「國小輔導」且含「美安」：類別仍是安親課輔（v2 M1 也算一科），固定 5 天'],
  // 數學班（規則 3）
  ['國小數學-四A', 'math', false, '含「國小數學」'],
  ['國小數學-一', 'math', false, '含「國小數學」'],
  ['小六數學加強班', 'none', false, '不含「國小數學」（只有「數學」二字）→ 不列入'],
  // 美語班（規則 4）
  ['兒童美語-EA', 'english', false, '含「兒童美語」'],
  ['美語等班', 'none', false, '不含「兒童美語」→ 不列入（deriveSubject 會把它判成兒童美語，偵測式不同）'],
  // 不列入（規則 5）
  ['交通車', 'none', false, '不屬任何類別'],
  ['正音A班', 'none', false, '不屬任何類別'],
  ['小六英文加強班', 'none', false, '不屬任何類別'],
  ['', 'none', false, '空字串'],
  // 條列順序＝優先順序
  ['國小輔導兒童美語', 'care', false, '安親課輔 > 美語'],
  ['國小數學兒童美語', 'math', false, '數學 > 美語'],
  ['國小輔導國小數學', 'care', false, '安親課輔 > 數學'],
];

describe('類別自動偵測純函式（新模組 @/domain/classification/class-category）', () => {
  it('模組存在，並匯出 detectClassCategory／detectFixedFiveDays／detectClassAttributes', async () => {
    const mod = await loadModule<Detection>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    expect(typeof mod!.detectClassCategory).toBe('function');
    expect(typeof mod!.detectFixedFiveDays).toBe('function');
    expect(typeof mod!.detectClassAttributes).toBe('function');
  });

  it.each(TABLE)('「%s」→ 類別 %s、固定 5 天 %s（%s）', async (name, category, fixed) => {
    const mod = await loadModule<Detection>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    expect(mod!.detectClassCategory(name)).toBe(category);
    expect(mod!.detectFixedFiveDays(name)).toBe(fixed);
    expect(mod!.detectClassAttributes(name)).toEqual({ category, fixedFiveDays: fixed });
  });

  it('純函式：同一輸入多次呼叫結果相同、不依賴呼叫順序', async () => {
    const mod = await loadModule<Detection>(MODULE);
    expect(mod, `${MODULE} 需存在`).not.toBeNull();
    const forward = TABLE.map(([n]) => mod!.detectClassAttributes(n));
    const backward = [...TABLE].reverse().map(([n]) => mod!.detectClassAttributes(n)).reverse();
    expect(backward).toEqual(forward);
    expect(TABLE.map(([, c, f]) => ({ category: c, fixedFiveDays: f }))).toEqual(forward);
  });
});

describe('class-category 純函式架構約束', () => {
  const SRC = path.resolve(__dirname, '../../src');

  it('模組檔存在於 domain 層（src/domain/classification/class-category.ts）', () => {
    expect(fs.existsSync(path.join(SRC, 'domain', 'classification', 'class-category.ts'))).toBe(true);
  });

  it('模組本身為純 domain 函式，不得 import DB、UI 或外部層', () => {
    const own = path.join(SRC, 'domain', 'classification', 'class-category.ts');
    // 模組自身：domain 純函式，不得引用 adapters／application／components
    expect(fs.existsSync(own)).toBe(true);
    const text = fs.readFileSync(own, 'utf-8');
    expect(text).not.toMatch(/from\s+['"][^'"]*(adapters|application|components|next|react)[^'"]*['"]/);
  });
});
