import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { computeInvarianceSnapshot } from './d1-invariance-snapshot';

/**
 * 產生 tests/fixtures/d1-invariance-golden.json。
 *
 * 政策邊界（operator 裁決 d-20260930131128030911-29 授權）：
 * 本產生器僅在**未修改之不可變 baseline 8961c03**（D1 之前）執行，用於建立 pre-change differential characterization
 * 差異特徵基準，以驗證 D1 重構未引發非預期行為改變；本輸出不是獨立正確性 oracle。
 * 嚴禁在重構過程中從新 HEAD 重新生成本檔案以消除測試失敗。
 *
 *   cd web && npx tsx tests/helpers/generate-d1-invariance-golden.ts [輸出路徑]
 */
async function main() {
  const out = process.argv[2] ?? path.resolve(__dirname, '../fixtures/d1-invariance-golden.json');
  const legacyGolden = path.resolve(__dirname, '../fixtures/d1-invariance-golden.json');
  const expectedV4Golden = path.resolve(__dirname, '../fixtures/d1-v4-current-golden.json');
  if (path.resolve(out) === legacyGolden) {
    throw new Error(
      'Refusing to overwrite immutable d1-invariance-golden.json. Use a separate output path for a new characterization.',
    );
  }
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
  let detachedHead = false;
  try {
    execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    detachedHead = true;
  }
  if (sourceHead !== '99de0e7f23c57d3129bcf9c93d69db5f7069d078' || !detachedHead) {
    throw new Error(
      'Refusing regeneration outside the detached immutable PR-1 base 99de0e7f23c57d3129bcf9c93d69db5f7069d078.',
    );
  }
  if (path.resolve(out) !== expectedV4Golden) {
    throw new Error(
      'The detached-base v4 characterization may only write d1-v4-current-golden.json.',
    );
  }
  const snapshot = await computeInvarianceSnapshot();
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 1) + '\n');
  console.log(`wrote ${out}`);
  console.log(`students=${snapshot.fixtureStudents}`);
  for (const [k, v] of Object.entries(snapshot.calculator)) console.log(`calculator ${k} rollup=${v.rollup} issues=${JSON.stringify(v.issueCodeCounts)}`);
  for (const [k, v] of Object.entries(snapshot.run)) console.log(`run ${k} rollup=${v.rollup} issues=${JSON.stringify(v.runIssueCounts)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
