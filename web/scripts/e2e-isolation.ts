import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 隔離 E2E 的安全守衛（specs/10 §4、issue #25）。
 *
 * 現行 playwright.config.ts 以 `npm run dev`（寫死 3000 埠）搭配 `reuseExistingServer: !CI`，
 * 使用者開著的 3000 服務會被重用而連到真實資料庫。隔離執行必須同時保證：
 * - 埠不是使用者的 3000；
 * - 資料庫是系統臨時目錄下的獨立檔案，絕不是預設資料庫（`data/app.sqlite`）或專案 `data/` 目錄。
 */

/** 使用者 `npm run dev` 的埠；隔離執行不得使用。 */
export const USER_DEV_PORT = 3000;

/** 隔離執行的預設埠（10 §4）。 */
export const DEFAULT_ISOLATED_E2E_PORT = 3100;

export interface IsolatedE2eTarget {
  databasePath: string | undefined;
  port: number;
}

/** 取最近一個實際存在的祖先目錄的 realpath，再接回其餘路徑（DB 檔案與其目錄可能尚未建立）。 */
function resolveThroughExistingAncestor(target: string): string {
  const normalized = path.resolve(target);
  const rest: string[] = [];
  let current = normalized;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return normalized;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...rest);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 驗證隔離目標；任何違規直接丟錯，呼叫端不得吞掉。
 */
export function assertIsolatedE2eTarget(target: IsolatedE2eTarget): void {
  const { databasePath, port } = target;

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`E2E 埠必須是 1024–65535 的整數，收到 ${String(port)}`);
  }
  if (port === USER_DEV_PORT) {
    throw new Error(`E2E 埠不可為 ${USER_DEV_PORT}（使用者 dev 服務埠）`);
  }

  if (!databasePath) {
    throw new Error('未提供隔離的 DATABASE_PATH（E2E_DATABASE_PATH）：不得退回預設資料庫');
  }
  if (!path.isAbsolute(databasePath)) {
    throw new Error(`DATABASE_PATH 必須是絕對路徑，收到 ${databasePath}`);
  }

  const tmpRoot = fs.realpathSync(os.tmpdir());
  const resolved = resolveThroughExistingAncestor(databasePath);
  if (!isInside(resolved, tmpRoot)) {
    throw new Error(
      `DATABASE_PATH 必須位於系統臨時目錄（${tmpRoot}）下，收到 ${resolved}；不得使用預設資料庫或專案 data/ 目錄`
    );
  }
}
