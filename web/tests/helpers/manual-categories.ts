import type { ClassCategory, ClassSettingLookup } from '@/domain/classification/class-category';

/**
 * 測試 fixture：**明確宣告**這些虛構班級屬於哪個折扣類別。
 *
 * #157 Ruling 1 廢除了班名自動偵測，因此「某個虛構班是數學班」這件事必須由測試自己說出來，
 * 不能再由產品依班名猜。這不是把舊偵測規則搬回測試——本函式只認得呼叫端正面表列的班名；
 * 未列出的班名一律不在 map 中（＝該班未被宣告，產品會視為未設定）。若某個測試需要一個
 * 「未設定」的班，就**不要**把它放進這張表。
 *
 * 用法：
 *   const settings = manualCategories({ care: ['國小輔導-四年級'], math: ['國小數學-四A'] });
 */
export function manualCategories(
  byCategory: Partial<Record<Exclude<ClassCategory, 'unset'>, string[]>>
): Map<string, ClassSettingLookup> {
  const map = new Map<string, ClassSettingLookup>();
  for (const [category, names] of Object.entries(byCategory)) {
    for (const name of names ?? []) {
      map.set(name, { category: category as ClassCategory, categorySource: 'manual' });
    }
  }
  return map;
}
