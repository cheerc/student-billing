/**
 * Note 的共用型別與存取輔助。
 *
 * PR #119 已把 `buildNotes` 的回傳形狀統一，Note 的欄位集合是固定的——
 * 這正是把共用層抽成 `.ts` 的前提：若形狀不一致，`Note` 會退化成 union，
 * 所有消費者都得永遠寫 `?.`，且 tsc 無法驗證欄位存在。
 *
 * 注意 `tags` 目前**沒有任何消費者**（`buildNotes` 內部用的是區域變數 `tags`，
 * 不是 `note.tags`）。保留它只是為了欄位集合固定；填值不影響任何輸出。
 */

/** 差異說明的語氣，決定 HTML 樣式（`.note-text.is-warn` / `.match` / `.neutral`）。 */
export type NoteTone = 'match' | 'warn' | 'neutral';

/** 報告中「課程費 NN折」以外的獨立折扣明細（普測優惠、訂金、期中補扣等）。 */
export interface NoteTag {
  code?: string;
  category?: string;
  message?: string;
  [key: string]: unknown;
}

/** ERP 登記級距與計算值不一致的一筆。 */
export interface NoteTierMismatch {
  status: string;
  erpDeclaredTier: number | null;
  computedTier: number | null;
  rawToken: string;
  [key: string]: unknown;
}

/** 單一學生的差異說明。欄位集合固定，不可省略。 */
export interface Note {
  readonly tone: NoteTone;
  readonly notes: string[];
  readonly tags: string[];
  readonly homework: boolean;
  readonly withdrawal: boolean;
  readonly dupIssues: NoteTag[];
  readonly mismatches: NoteTierMismatch[];
}

/** 全空 Note。buildNotes 的預設值基底。 */
export const EMPTY_NOTE: Note = Object.freeze({
  tone: 'warn',
  notes: [],
  tags: [],
  homework: false,
  withdrawal: false,
  dupIssues: [],
  mismatches: [],
});

/**
 * 消費端讀旗標的單一入口。
 *
 * 渲染層只用 truthiness 判斷「是否進歸納群組」，故此處把 `undefined` 與
 * 空集合正規化為 false，避免各處重複寫 `?.length > 0`。
 */
export function noteFlags(note: Note): {
  homework: boolean;
  withdrawal: boolean;
  hasDupIssues: boolean;
  hasMismatches: boolean;
} {
  return {
    homework: Boolean(note.homework),
    withdrawal: Boolean(note.withdrawal),
    hasDupIssues: (note.dupIssues?.length ?? 0) > 0,
    hasMismatches: (note.mismatches?.length ?? 0) > 0,
  };
}
