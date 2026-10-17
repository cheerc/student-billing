import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { RunInfoLike } from '../../scripts/shared/roster-api';
import {
  buildRunSnapshotContext,
  shouldWarnMissingSnapshot,
  runUsesClassCategorySnapshot,
} from '../../scripts/shared/rate-context';

/**
 * issue #140 第 2、3 項：`RunInfoLike` 的契約，以及工具端的版本判定。
 *
 * ## 第 3 項為什麼用型別斷言而不是字串比對
 *
 * `roster-api.ts` 是 `.ts`，會被 `npm run typecheck` 檢查。所以「宣告少了欄位」
 * 這件事**可以在編譯期**被抓到——下面的 `_contract` 常數就是為此存在：
 * 把 `classCategories` 從 `RunInfoLike` 拿掉，`npm run typecheck` 會紅，
 * 不必靠讀原始碼字串。
 *
 * 這是本項唯一可靠的護欄：讀取端是 `.mjs`，依 CLAUDE.md §9.0，`checkJs` 未開、
 * eslint 未啟用 `no-undef`，執行期不會有任何徵兆。
 *
 * ## 第 2 項：判定要走能力旗標（`specs/03 §5.3.1` 禁止字面版本比較）
 */

/**
 * 編譯期契約：`RunInfoLike` 必須能提供快照欄位。
 *
 * 若 `classCategories` 從 `RunInfoLike` 移除，這一行無法通過型別檢查，
 * `npm run typecheck` 即紅——這正是本項要的護欄。
 */
const _contract: RunInfoLike = {
  ruleSetVersion: 'erp-tag-v3',
  classCategories: [{ base_name: '班', category: 'care', fixed_five_days: 0 }],
};

describe('issue #140 第 3 項：RunInfoLike 宣告 classCategories', () => {
  it('型別契約成立（本條通過代表 typecheck 也接受 `classCategories`）', () => {
    expect(_contract.classCategories).toHaveLength(1);
  });

  it('`RunSnapshotSource` 與 `RunInfoLike` 對接：run 回應可直接餵進共用入口', () => {
    const run: RunInfoLike = { ruleSetVersion: 'erp-tag-v3', classCategories: [] };
    // 形狀必須相容，否則工具端得再轉一次手，就會出現第二份「怎麼讀快照」的實作
    expect(buildRunSnapshotContext(run)).toEqual({ isV3Run: true, classCategories: [] });
  });
});

describe('issue #140 第 2 項：工具端判定與載入層同一套能力旗標', () => {
  it('v3 run 缺快照 → 應警告（本該有卻沒有）', () => {
    expect(shouldWarnMissingSnapshot({ ruleSetVersion: 'erp-tag-v3' })).toBe(true);
  });

  it('v1／v2 run 缺快照 → 不警告（本來就沒有快照概念）', () => {
    expect(shouldWarnMissingSnapshot({ ruleSetVersion: 'erp-tag-v2' })).toBe(false);
    expect(shouldWarnMissingSnapshot({ ruleSetVersion: 'erp-tag-v1' })).toBe(false);
  });

  it('v3 帶快照（含零列 `[]`）→ 不警告', () => {
    expect(shouldWarnMissingSnapshot({ ruleSetVersion: 'erp-tag-v3', classCategories: [] })).toBe(false);
    expect(
      shouldWarnMissingSnapshot({
        ruleSetVersion: 'erp-tag-v3',
        classCategories: [{ base_name: '班', category: 'care', fixed_five_days: 0 }],
      })
    ).toBe(false);
  });

  it('未知版本字串 → 視為不具該能力，不警告也不猜測', () => {
    expect(runUsesClassCategorySnapshot('erp-tag-v9')).toBe(false);
    expect(runUsesClassCategorySnapshot(null)).toBe(false);
    expect(runUsesClassCategorySnapshot(undefined)).toBe(false);
  });

  /**
   * §5.3.1 的落實一致性：工具端不得再出現字面版本比較。
   *
   * ## 這條測試的實際強度（不誇大）
   *
   * 它是**原始碼代理檢查**，不是行為測試。真正的行為護欄是
   * `runUsesClassCategorySnapshot` 走產品能力旗標，由上一組測試釘住；
   * 本條防的只是「有人日後把那行改回字面比較」。
   *
   * 只掃**程式碼行**（跳過 `//`、`/*`、`*` 開頭的行）。理由：第一版沒有跳過註解，
   * 立刻咬到 `rate-context.ts` 裡**解釋這條規則本身**的註解——一個會處罰
   * 「把理由寫下來」的守衛，比沒有守衛更糟。
   *
   * 已知限制（明列，不假裝更強）：不做完整的字串／註解解析，因此
   * 「字面比較寫在字串常數裡」或「與其他程式碼同處一行且行首非註解」時，
   * 本條仍可能誤判。要完全消除這個不確定性只能靠 parser，而那已超出側腳本
   * 的維護優先度（CLAUDE.md §9.0）。
   */
  it('兩台工具與共用層的程式碼行沒有 `=== \'erp-tag-vN\'` 字面版本比較', () => {
    const files = [
      'scripts/compare-billing-report.mjs',
      'scripts/compare-session-pricing-report.mjs',
      'scripts/shared/rate-context.ts',
    ];
    for (const rel of files) {
      const codeLines = fs
        .readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8')
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n');
      expect(codeLines, `${rel} 的程式碼出現字面版本比較，違反 specs/03 §5.3.1`).not.toMatch(
        /===\s*['"]erp-tag-v\d+['"]/
      );
    }
  });
});
