/**
 * 資料表欄位定義（specs/19 §3 B1、D65）。表頭文字／樣式／排序／篩選入口的單一來源，
 * 欄名清單由此推導，不在各表重列。B2 起 client 表以 `sort: { type, accessor }` 啟用排序（use-client-sort）；`{ server }` 為學生總表 server 排序（B3）。
 */
export type SortAccessor<Row> = (row: Row) => string | number | null | undefined;

export type ColumnSort<Row> =
  | { type: 'text' | 'number'; accessor: SortAccessor<Row> }
  | { server: string };

export interface ColumnDef<Row = unknown> {
  /** 穩定欄位代號（排序／篩選／測試用） */
  key: string;
  /** 表頭顯示文字；同時是表頭篩選觸發鈕名稱「{label}篩選」的來源 */
  label: string;
  className?: string;
  /** 表頭單位（例如「天」），顯示在欄名後 */
  unit?: string;
  /** 排序設定；未設＝該欄不可排序 */
  sort?: ColumnSort<Row>;
  /** 對應表頭篩選的條件 key（呼叫端據此決定要放哪個 HeaderFilter） */
  filterKey?: string;
}

/** 由欄位定義推導欄名清單（維持單一來源）。 */
export function columnLabels<const C extends readonly { label: string }[]>(defs: C): { [I in keyof C]: C[I]['label'] } {
  return defs.map((d) => d.label) as never;
}
