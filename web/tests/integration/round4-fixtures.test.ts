import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import JSZip from 'jszip';

const roots: string[] = [];
const script = path.resolve(__dirname, '../../scripts/round4-fixtures.ts');
const loader = path.resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs');
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-round4-fixtures-')); roots.push(dir); return dir; };

afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function generate(dir: string, args: string[] = []) {
  const out = path.join(dir, 'output');
  const preload = path.join(dir, 'deny-private.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const path = require('node:path');
const forbidden = ${JSON.stringify([path.resolve(__dirname, '../../../data'), '/Users/cheerc/Projects/student-billing/data'])};
function check(p) { if (typeof p !== 'string' && !Buffer.isBuffer(p)) return; const target = path.resolve(String(p)); if (forbidden.some(root => target === root || target.startsWith(root + path.sep))) throw new Error('禁止讀取私有來源: ' + target); }
for (const name of ['readFileSync','openSync','createReadStream']) { const original = fs[name]; fs[name] = function(p, ...rest) { check(p); return original.call(this, p, ...rest); }; }
for (const name of ['readFile','open']) { const original = fs.promises[name]; fs.promises[name] = function(p, ...rest) { check(p); return original.call(this, p, ...rest); }; }
`);
  const result = spawnSync(process.execPath, ['--require', preload, '--import', loader, script, '--out', out, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  expect(result.error, 'CLI 必須正常退出').toBeUndefined();
  return { out, result };
}

interface Manifest {
  synthetic: boolean;
  students: number;
  cases: Array<{ code: string; tests: string; acceptance: string[]; baselineRow?: { classes: string[]; grade: string; tags: string[] }; variantRow?: { classes: string[]; grade: string; tags: string[] }; expected: Record<string, unknown>; specRefs: string[] }>;
  facetJourney: Array<{ step: string; action: string; panelCounts: Record<string, number>; resultCount: number }>;
}

describe('T4：第四輪合成驗收檔（baseline／variant）', () => {
  it('CLI：--help 說明輸出、拒絕既有目錄與 repo 內路徑', () => {
    const dir = temp();
    const help = spawnSync(process.execPath, ['--import', loader, script, '--help'], { cwd: dir, encoding: 'utf8' });
    expect(help.status, help.stderr).toBe(0);
    for (const token of ['round4-baseline.xlsx', 'round4-variant.xlsx', 'manifest.json', '--out']) expect(help.stdout).toContain(token);

    const existing = path.join(dir, 'existing');
    fs.mkdirSync(existing);
    expect(spawnSync(process.execPath, ['--import', loader, script, '--out', existing], { cwd: dir, encoding: 'utf8' }).status).not.toBe(0);
    const inRepo = spawnSync(process.execPath, ['--import', loader, script, '--out', path.resolve(__dirname, '../../../data/x')], { cwd: dir, encoding: 'utf8' });
    expect(inRepo.status).not.toBe(0);
    expect(inRepo.stderr).toContain('repo');
  });

  it('輸出兩份保形匿名 OOXML 與 manifest；兩份名冊都能被產品解析且人數相符', async () => {
    const { out, result } = generate(temp());
    expect(result.status, result.stderr).toBe(0);
    for (const file of ['round4-baseline.xlsx', 'round4-variant.xlsx']) {
      const buf = fs.readFileSync(path.join(out, file));
      const zip = await JSZip.loadAsync(buf);
      expect(zip.file('xl/sharedStrings.xml'), `${file} 必須是 inlineStr`).toBeNull();
      const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
      expect(xml).toContain('t="inlineStr"');
      expect(xml).not.toContain('<dimension');
    }
    const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.synthetic).toBe(true);
    expect(manifest.students).toBeGreaterThanOrEqual(20);
    for (const item of manifest.cases) {
      expect(typeof item.code, '每列要有合成代碼').toBe('string');
      expect(item.code).toMatch(/^R4_[A-Z0-9_]+$/);
      expect(item.tests.length, `${item.code} 要寫測什麼`).toBeGreaterThan(0);
      expect(item.specRefs.length, `${item.code} 要附 spec 出處`).toBeGreaterThan(0);
      for (const ref of item.acceptance) expect(ref).toMatch(/§?\d|N\d{2}|UX\d{2}/);
      expect(item.expected, `${item.code} 要有手算預期`).toBeTruthy();
    }
    expect(manifest.facetJourney.length).toBeGreaterThanOrEqual(4);
    for (const step of manifest.facetJourney) expect(step.action).toBeTruthy();
  });
});
