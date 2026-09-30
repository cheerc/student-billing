import fs from 'fs';
import path from 'path';
import { computeInvarianceSnapshot } from './d1-invariance-snapshot';

/**
 * 產生 tests/fixtures/d1-invariance-golden.json。
 * 只應在**未修改的 8961c03**（D1 之前）執行；D1 之後重跑必須得到 byte-identical 的內容（不變式測試會比對）。
 *
 *   cd web && npx tsx tests/helpers/generate-d1-invariance-golden.ts [輸出路徑]
 */
async function main() {
  const out = process.argv[2] ?? path.resolve(__dirname, '../fixtures/d1-invariance-golden.json');
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
