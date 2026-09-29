import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * specs/09 §7（line 16、122）：固定寫預期筆數會把 fixture 變成業務目標，遇到真實名單時數字會誤導。
 * 「預期N人」只准出現在測試（fixture 斷言），不得寫進產品文案或註解成驗收目標。
 *
 * Reviewer B3（PR #32）：`active-run-view.tsx` 仍留有「⚠ 僅顯示級距差異 (5筆)」，
 * 而 PR 卻宣稱已移除所有硬寫筆數——因為沒有任何守衛。本測試把 Lead 驗收用的 grep 固定下來。
 */

const SRC_ROOT = path.resolve(__dirname, '../../src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: '括號內的固定筆數，例如「(5筆)」', re: /\(\s*\d+\s*筆\s*\)/ },
  { label: '「(預期…」', re: /\(\s*預期/ },
  { label: '「預期N人」', re: /預期\s*\d+\s*人/ },
  { label: '「篩出 N 筆」（把 fixture 筆數當驗收重點）', re: /篩出\s*\d+\s*筆/ },
  { label: 'Lead 驗收 grep：5筆 / 13人', re: /5筆|13人/ },
];

describe('產品程式碼不含 fixture 硬寫筆數（09 §7）', () => {
  it('src 下沒有任何固定筆數／預期人數字樣', () => {
    const hits: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        for (const { label, re } of FORBIDDEN) {
          if (re.test(line)) hits.push(`${path.relative(SRC_ROOT, file)}:${i + 1} [${label}] ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
