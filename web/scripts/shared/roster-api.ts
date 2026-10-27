/**
 * 共用層：讀取本機唯讀 API。
 *
 * 兩個工具都要以「先問 active run 是哪一個，再分頁取名單」的順序取得資料。
 * 把這段抽成共用的理由不是省幾行，而是**錯誤訊息**：fetch 失敗時原始錯誤只有
 * "fetch failed"，對第一次使用工具的人毫無診斷價值；統一在這裡轉成明確訊息，
 * 兩個工具的失敗訊息就不會各寫各的而漂移。
 */

import type { RunClassCategorySnapshot } from '../../src/application/applicable-rate.ts';

/** 分頁上限；與 API 的 limit 契約一致。 */
const PAGE_LIMIT = 200;

export interface RunStudentsResult<T> {
  runId: string;
  students: T[];
}

/** 只宣告本工具實際讀到的欄位；其餘欄位在 runtime 存在但不進型別。 */
export interface RunInfoLike {
  activeRunId?: string | null;
  run?: { id?: string | null } | null;
  asOfDate?: string | null;
  ruleSetVersion?: string | null;
  numericPolicy?: string | null;
  /**
   * v3 run 的班級類別快照（`GET /runs/{id}` 的回應欄位；issue #122 起由載入層曝光）。
   *
   * 三態語意不可混淆（03 §5.3.4）：`undefined`＝v1／v2 沒有快照概念；
   * `[]`＝v3 但該 run 零快照列；非空＝v3 的實際類別。
   *
   * 工具端**不得自行判空**取用（`run.classCategories ? … : undefined` 會讓
   * 「`[]` 必須產生 context」這條不變式無處可測，issue #140 第 1 項），
   * 一律走 `rate-context.ts` 的 `buildRunSnapshotContext`。
   */
  classCategories?: RunClassCategorySnapshot[] | null;
  classSemantics?: Array<{
    baseName: string;
    resolvedBaseName: string;
    category: string;
    isHomework?: boolean;
    erpTierApplicability: 'applicable' | 'not_applicable' | 'unset';
  }> | null;
}

export interface StudentsPageLike<T> {
  items: T[];
  nextCursor?: string | null;
}

function normalizeBase(base: string): string {
  return base.replace(/\/$/, '');
}

/**
 * 解析 active run 的代碼；沒有完成的 run 時明確回報，讓使用者知道要先去算。
 */
export async function fetchRunInfo(base: string): Promise<{ runId: string; info: RunInfoLike }> {
  let infoRes: Response;
  try {
    infoRes = await fetch(`${normalizeBase(base)}/api/v1/runs/current`);
  } catch {
    throw new Error(
      `無法連線到 ${base}。請先啟動本機伺服器：cd web && npm run dev\n` +
      `（本工具唯讀讀取本機 API，伺服器未啟動時無法取得名單資料。）`,
    );
  }
  const info = (await infoRes.json()) as RunInfoLike;
  const runId = info.activeRunId || info.run?.id;
  if (!runId) throw new Error('找不到 active run，請先在網頁建立匯出並執行計算。');
  return { runId, info };
}

/**
 * `GET /runs/{id}`：取得該 run 的摘要（asOfDate、規則策略版本等）。
 *
 * 這支與 fetchRunStudents 分開是刻意的：名單可能數百筆、需要分頁，
 * 摘要則是一次就拿完的小物件。工具端在確定 runId 之後才呼叫本函式。
 */
export async function fetchRun<T extends RunInfoLike>(base: string, runId: string): Promise<T> {
  const res = await fetch(`${normalizeBase(base)}/api/v1/runs/${runId}`);
  if (!res.ok) {
    throw new Error(`讀取 run 失敗 (${res.status}): ${JSON.stringify(await safeJson(res))}`);
  }
  return (await res.json()) as T;
}

/**
 * 取得 active run 的完整名單（自動分頁）。
 *
 * 分頁迴圈以 `nextCursor` 為唯一終止條件：伺服器少給一個 cursor 就會靜默少拿一頁，
 * 故這裡只認伺服器的明確訊號，不以「拿到的件數小於上限」推測結束。
 */
export async function fetchRunStudents<T>(base: string): Promise<RunStudentsResult<T>> {
  const root = normalizeBase(base);
  const { runId } = await fetchRunInfo(base);

  const students: T[] = [];
  let cursor: string | null = null;
  while (true) {
    let url = `${root}/api/v1/runs/${runId}/students?limit=${PAGE_LIMIT}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`查詢學生失敗 (${res.status}): ${JSON.stringify(await safeJson(res))}`);
    const data = (await res.json()) as StudentsPageLike<T>;
    students.push(...data.items);
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return { runId, students };
}

/** 錯誤分支也可能拿到非 JSON 回應；不可讓錯誤處理本身再拋一次。 */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
