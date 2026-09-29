import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * 10 §4／issue #25：E2E spec 不得碰使用者的真實資料庫。
 * 舊版 recovery-ui.spec.ts 的 beforeEach／afterEach 會刪除 `../../../data/app.sqlite*`；
 * 在主工作樹執行時，該路徑就是使用者的真實 SQLite。資料庫隔離一律由
 * `npm run test:e2e:isolated`（每個 spec 檔全新臨時 DB）負責，spec 本身不得引用資料庫檔或 data/ 目錄。
 */
describe('R0：E2E spec 不得引用真實資料庫路徑', () => {
  const e2eDir = path.resolve(__dirname, '../e2e');
  const specs = fs.readdirSync(e2eDir).filter((f) => f.endsWith('.ts'));

  it('tests/e2e 下有 spec 檔（避免守衛因路徑錯誤而空轉）', () => {
    expect(specs.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of specs) {
    it(`${file}：不引用 app.sqlite 或專案 data/ 目錄`, () => {
      const source = fs.readFileSync(path.join(e2eDir, file), 'utf-8');
      expect(source).not.toMatch(/app\.sqlite/);
      expect(source).not.toMatch(/['"`](?:\.\.\/)+data['"`\/]/);
    });
  }
});
