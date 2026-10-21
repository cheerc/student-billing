import type { ClassCategory } from '@/domain/classification/class-category';
import type { ClassSettingLookup } from '@/domain/classification/class-category';

/**
 * 測試 fixture：**明確宣告**這些虛構班級屬於哪個折扣類別。
 *
 * #157 Ruling 1 廢除了班名自動偵測，因此「某個虛構班是數學班」這件事必須由測試自己說出來，
 * 不能再由產品依班名猜。這不是把舊偵測規則搬回測試——`categoryOf` 只在被要求時回答，
 * 而且只認得本檔正面表列的班名；未列出的班名一律回 `undefined`（＝測試沒有宣告該班的意圖，
 * 呼叫端應自行明確指定）。若某個測試需要一個「未設定」的班，就**不要**把它放進這張表。
 *
 * 用法：
 *   const settings = manualCategories({ care: ['國小輔導-四年級'], math: ['國小數學-四A'] });
 */
export function manualCategories(byCategory: Partial<Record<Exclude<ClassCategory, 'unset'>, string[]>>): Map<
  string,
  ClassSettingLookup
> {
  const map = new Map<string, ClassSettingLookup>();
  for (const [category, names] of Object.entries(byCategory)) {
    for (const name of names ?? []) {
      map.set(name, { category: category as ClassCategory, categorySource: 'manual' });
    }
  }
  return map;
}

/** 在既有的 classSettings 上附加明確宣告的類別（後者覆蓋前者同名項目）。 */
export function withManualCategories(
  base: Map<string, ClassSettingLookup> | undefined,
  byCategory: Partial<Record<Exclude<ClassCategory, 'unset'>, string[]>>
): Map<string, ClassSettingLookup> {
  const map = new Map(base ?? []);
  for (const [name, lookup] of manualCategories(byCategory)) map.set(name, lookup);
  return map;
}
