/**
 * 共用層：姓名正規化與名單索引。
 *
 * 兩邊（財務報表、米豆奶名單）必須走同一個正規化，否則索引端去括號、
 * 查詢端用原文會整批配對失敗，且失敗會被誤標成「名單已無此人」。
 */

export interface RosterStudentLike {
  name: string;
}

/**
 * 配對鍵：去掉括號英文名後的中文姓名。
 *
 * 同時接受半形與全形括號：名單由工具產生（半形），報表來自外部系統，可能為全形。
 */
export function normalizeName(name: string | null | undefined): string {
  return String(name ?? '').replace(/\s*[（(][^）)]*[）)]\s*/g, '').trim();
}

/** 一筆索引結果：值為 null 代表該中文姓名對應多人，無法唯一配對。 */
export type NameIndex<T> = Map<string, T | null>;

export interface NameIndexResult<T> {
  map: NameIndex<T>;
  /** 全部同名者的正規化姓名清單（用於報告的「名單重名」警告）。 */
  duplicates: string[];
}

/**
 * 以正規化後的中文姓名建立索引；回報重名以免誤配。
 *
 * **`continue` 是承重的，刪掉會造成靜默的錯誤配對。**
 *
 * 邏輯是這樣的：第一次出現時 map 內是學生物件；同名第二次出現時設為 null
 * （歧義）並 `continue`，**不再執行下面的 `map.set(key, s)`**。
 *
 * 若拿掉 `continue`，第三次同名會把 null 覆蓋成第三位學生的物件，歧義標記消失，
 * 報表上就會出現一個**看起來自信的錯誤配對**——而且 `duplicates` 仍會列出該姓名，
 * 看起來像有警告、實際已配對成功。這是最難察覺的一種錯誤，故在此明確註記。
 */
export function indexByName<T extends RosterStudentLike>(students: readonly T[]): NameIndexResult<T> {
  const map: NameIndex<T> = new Map();
  const duplicates: string[] = [];
  for (const s of students) {
    const key = normalizeName(s.name);
    if (map.has(key)) {
      // 同名多人：以 set 覆蓋會靜默配對到最後一人（review F-NEW-3）。改記為歧義，
      // 查詢時不可 unique 配對，必須要求人工以人員代碼核對。
      duplicates.push(key);
      map.set(key, null); // null = 該中文姓名對應多人，無法唯一配對
      continue;
    }
    map.set(key, s);
  }
  return { map, duplicates };
}
