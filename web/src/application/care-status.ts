/**
 * 安親／課輔單側狀態與「整班狀態」的合併（09 §5.2、04 §8 UX26；11 §3 A：F02）。
 *
 * 這個檔案要能被 client component 引用，因此**只放純型別與純函式，不得 import 任何 server 模組**
 * （better-sqlite3、schedule-seed 等），否則會被打進瀏覽器 bundle。
 */

/** 單堂／班級某一類照顧（安親／課輔）的狀態：警告類與「已驗證無衝堂」分開。 */
export type CareStatus =
  | 'calculated' // 有重疊，已計算
  | 'no_overlap' // 星期合法且已驗證與窗口無交集（含合法週六）
  | 'no_deduction' // #113：班級勾選「不計扣天」；時段保留且合法，重疊刻意不扣天
  | 'unknown_weekday' // 星期缺失、空白或無法識別：v2 fail-closed 為 0，但不是「無衝堂」
  | 'missing_time' // 列：起訖不完整（缺起／缺迄／迄≤起）；班級（無任何列）：沒有時段（待補）
  | 'incomplete' // 班級層：含不完整列。扣天只統計完整列，不顯示成 calculated
  | 'shared_window' // seed 的共用窗口班（care_window），本身沒有 session，不捏造
  | 'inactive'; // 班級停用，不計算

/**
 * 整班優先序（數字小者優先顯示）：停用／共用窗口（班級層旗標）＞ 未知／不完整（不可信，需人處理）＞ 已計算 ＞ 無重疊。
 * 「未知／不完整」三種（incomplete、missing_time、unknown_weekday）同一層級，不分先後——實務上兩側會是同一種，
 * 兩側不同時取第一個引數（安親側）。
 *
 * #113：不計扣天與「已計算」同層級（在兩者之間取前者）：勾選是一種**可解釋的刻意結果**，
 * 不是「算不出來」，因此仍要讓畫面看見「這班確實有重疊、只是政策不扣」，
 * 不可被「無重疊」掩蓋，也不可蓋掉需確認／待補那些真正不可信的狀態。
 */
const CARE_STATUS_RANK: Record<CareStatus, number> = {
  inactive: 0,
  shared_window: 1,
  incomplete: 2,
  missing_time: 2,
  unknown_weekday: 2,
  calculated: 3,
  no_deduction: 3,
  no_overlap: 4,
};

/**
 * 合併安親側與課輔側的狀態成整班狀態：任一側未知／不完整不被另一側的正常狀態掩蓋；
 * 任一側「已計算」不被另一側的「無重疊」掩蓋（例：只與課輔窗口重疊的班不得顯示「無重疊」）。
 */
export function combineCareStatuses(anqin: CareStatus, tutoring: CareStatus): CareStatus {
  return CARE_STATUS_RANK[tutoring] < CARE_STATUS_RANK[anqin] ? tutoring : anqin;
}
