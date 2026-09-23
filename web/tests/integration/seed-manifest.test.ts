import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { readErpWorkbook } from '@/adapters/xlsx/erp-reader';
import {
  SEED_CLASSES,
  SEED_BASE_NAMES,
  classifyErpBaseNames,
} from '@/domain/schedules/seed-manifest';

describe('I19: 初始排課班名唯讀 Seed Manifest 與 ERP 對照總量測試', () => {
  it('Seed 班級應恰好有 49 班且唯讀定義完整', () => {
    expect(SEED_CLASSES).toHaveLength(49);
    expect(SEED_BASE_NAMES).toHaveLength(49);

    // 檢查是否有包含關鍵班級
    expect(SEED_BASE_NAMES).toContain('國小輔導-一A');
    expect(SEED_BASE_NAMES).toContain('國小輔導-一B');
    expect(SEED_BASE_NAMES).toContain('國小輔導-四年級');
    expect(SEED_BASE_NAMES).toContain('國小數學-一A');
    expect(SEED_BASE_NAMES).toContain('兒童美語-EA');
  });

  it('與真實 ERP 檔 (保形匿名 fixture) 95 tokens / 54 baseNames 完整對照斷言', async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/conforming-erp-fixture.xlsx');
    const buf = fs.readFileSync(fixturePath);
    const erp = await readErpWorkbook(buf);

    const erpTokens = new Set<string>();
    const erpBaseNames = new Set<string>();

    for (const student of erp.students) {
      for (const enr of student.enrollments) {
        erpTokens.add(enr.rawToken);
        erpBaseNames.add(enr.baseName);
      }
    }

    // 斷言 ERP 原始 tokens 總量收斂
    expect(erpTokens.size).toBe(95);
    expect(erpBaseNames.size).toBe(54);

    // 執行對照分析
    const comparison = classifyErpBaseNames(Array.from(erpBaseNames));

    // 42 自動候選 / 12 待設定 / 0 歧義 / seed 側 7 個未出現
    expect(comparison.matchedCount).toBe(42);
    expect(comparison.unmatchedCount).toBe(12);
    expect(comparison.seedNotAppearedCount).toBe(7);
    expect(comparison.ambiguousCount).toBe(0);

    // 驗證 12 個待設定班級清單精確吻合 I19 規範
    expect(comparison.unmatched.sort()).toEqual([
      '交通車',
      '國小國語文-小三四',
      '國小數學-一',
      '國小輔導-四年級A',
      '國小輔導-四年級B',
      '國小輔導-寫功課',
      '小六國文加強班',
      '小六數學加強班',
      '小六英文加強班',
      '正音A班',
      '正音B班',
      '美語等班',
    ]);

    // 驗證 7 個本批 ERP 未出現之 seed 班級精確吻合 I19 規範
    expect(comparison.seedNotAppeared.sort()).toEqual([
      '國小國語文-小三小四',
      '國小數學-一A',
      '國小數學-一B',
      '國小輔導-四年級',
      '小六加強班-國文',
      '小六加強班-數學',
      '小六加強班-自然',
    ]);
  });
});
