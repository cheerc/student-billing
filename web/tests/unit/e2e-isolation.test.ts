import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import {
  assertIsolatedE2eTarget,
  DEFAULT_ISOLATED_E2E_PORT,
  USER_DEV_PORT,
} from '../../scripts/e2e-isolation';

/**
 * 10 §4／issue #25：隔離 E2E 的安全守衛。
 * 目標：任何隔離執行都不可能連到使用者的 3000 服務，或讀寫使用者的預設資料庫。
 */
describe('R0：隔離 E2E 守衛 assertIsolatedE2eTarget', () => {
  // 不建立實際目錄（守衛須能處理尚未存在的臨時路徑），避免測試殘留檔案
  const tmpDb = () => path.join(os.tmpdir(), `sb-e2e-guard-${process.pid}-${Math.random().toString(36).slice(2)}`, 'app.sqlite');

  it('預設埠是 3100，且不是使用者的 3000', () => {
    expect(USER_DEV_PORT).toBe(3000);
    expect(DEFAULT_ISOLATED_E2E_PORT).toBe(3100);
  });

  it('臨時目錄下的 DB＋非 3000 埠：通過', () => {
    expect(() => assertIsolatedE2eTarget({ databasePath: tmpDb(), port: 3100 })).not.toThrow();
  });

  it('埠為 3000（使用者服務）：拒絕', () => {
    expect(() => assertIsolatedE2eTarget({ databasePath: tmpDb(), port: 3000 })).toThrowError(/3000/);
  });

  it('埠非整數或超出範圍：拒絕', () => {
    for (const port of [0, 80, 65536, 3100.5, Number.NaN]) {
      expect(() => assertIsolatedE2eTarget({ databasePath: tmpDb(), port })).toThrowError(/埠/);
    }
  });

  it('未提供 DB 路徑：拒絕（不得退回預設資料庫）', () => {
    expect(() => assertIsolatedE2eTarget({ databasePath: undefined, port: 3100 })).toThrowError(/DATABASE_PATH|資料庫/);
    expect(() => assertIsolatedE2eTarget({ databasePath: '', port: 3100 })).toThrowError(/DATABASE_PATH|資料庫/);
  });

  it('專案預設資料庫路徑：拒絕', () => {
    expect(() =>
      assertIsolatedE2eTarget({ databasePath: path.resolve(process.cwd(), '..', 'data', 'app.sqlite'), port: 3100 })
    ).toThrowError(/臨時目錄|預設/);
  });

  it('專案 data/ 目錄下的路徑：拒絕', () => {
    const repoData = path.resolve(process.cwd(), '..', 'data', 'app.sqlite');
    expect(() => assertIsolatedE2eTarget({ databasePath: repoData, port: 3100 })).toThrowError(/臨時目錄|預設/);
  });

  it('相對路徑或不在臨時目錄下：拒絕', () => {
    expect(() => assertIsolatedE2eTarget({ databasePath: 'app.sqlite', port: 3100 })).toThrowError(/絕對路徑/);
    expect(() =>
      assertIsolatedE2eTarget({ databasePath: path.join(os.homedir(), 'app.sqlite'), port: 3100 })
    ).toThrowError(/臨時目錄/);
  });

  it('以 .. 跳出臨時目錄：拒絕', () => {
    const escaping = path.join(os.tmpdir(), 'sb-e2e-guard-x', '..', '..', 'app.sqlite');
    expect(() => assertIsolatedE2eTarget({ databasePath: escaping, port: 3100 })).toThrowError(/臨時目錄/);
  });
});
