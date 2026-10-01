import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import JSZip from 'jszip';
import { createDatabase } from '@/adapters/sqlite/db';
import { runMigrations } from '@/adapters/sqlite/migrator';
import { generateImportPreview } from '@/application/import-preview';
import { saveImportBatch } from '@/adapters/sqlite/import-repository';
import { activateImport } from '@/application/activate-import';
import { executeCalculationRun } from '@/application/calculate-run';
import { getClassNameMatchReport } from '@/application/class-name-match-report';
import { previewSettingsChange } from '@/application/settings-preview';
import { applySettingsPreview } from '@/application/apply-settings';
import { buildSeedDraft } from '@/adapters/sqlite/settings-repository';

const roots: string[] = [];
const script = path.resolve(__dirname, '../../scripts/round3-fixtures.ts');
const loader = path.resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs');
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-round3-fixtures-'));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function generate(dir: string) {
  const out = path.join(dir, 'output');
  // 空 cwd＋攔截禁止來源路徑：不以「沒有操作過」推論不存在來源讀取。
  const forbidden = [
    path.resolve(__dirname, '../../../data'),
    path.resolve(__dirname, '../../../嘉義縣私立資優生文教機構.xlsx'),
    '/Users/cheerc/Projects/student-billing/data',
    '/Users/cheerc/Projects/student-billing/嘉義縣私立資優生文教機構.xlsx',
    path.join(os.homedir(), 'Downloads/student-billing-private'),
  ];
  const preload = path.join(dir, 'deny-private.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const path = require('node:path');
const forbidden = ${JSON.stringify(forbidden)};
function check(p) { if (typeof p !== 'string' && !Buffer.isBuffer(p)) return; const target = path.resolve(String(p)); if (forbidden.some(root => target === root || target.startsWith(root + path.sep))) throw new Error('禁止讀取私有來源: ' + target); }
for (const name of ['readFileSync','openSync','createReadStream']) { const original = fs[name]; fs[name] = function(p, ...args) { check(p); return original.call(this, p, ...args); }; }
for (const name of ['readFile','open']) { const original = fs.promises[name]; fs.promises[name] = function(p, ...args) { check(p); return original.call(this, p, ...args); }; }
`);
  const result = spawnSync(process.execPath, ['--require', preload, '--import', loader, script, '--out', out], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  expect(result.error, 'CLI 必須正常退出，不能留下程序').toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return out;
}

describe('T3：純合成驗收 xlsx CLI → 真產品解析與計算', () => {
  it('產生 A/B/C 各 2/3/4 人，manifest 手算摘要、OOXML 格式與 contentHash 都可區分', async () => {
    const out = generate(temp());
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    // 預期固定來自設計：三份合成資料分別2、3、4列，不採 parser 輸出回填 manifest。
    expect(manifest.batches.map((batch: { students: number }) => batch.students)).toEqual([2, 3, 4]);
    const hashes: string[] = [];
    for (const [index, batch] of manifest.batches.entries()) {
      const buf = fs.readFileSync(path.join(out, batch.file));
      const zip = await JSZip.loadAsync(buf);
      expect(zip.file('xl/sharedStrings.xml')).toBeNull();
      const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
      expect(xml).toContain('t="inlineStr"');
      expect(xml).not.toContain('<dimension');
      const preview = await generateImportPreview(buf, batch.file);
      expect(preview.stats.totalStudents).toBe(index + 2);
      hashes.push(preview.contentHash);
    }
    expect(new Set(hashes).size).toBe(3);
    const source = fs.readFileSync(script, 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"]*generate-conforming-fixture/);
  });

  it('A 有數學0天學生；B 有非空解析失敗原文與可有效對應班名', async () => {
    const dir = temp();
    const out = generate(dir);
    const db = createDatabase(path.join(dir, 'app.sqlite'));
    runMigrations(db);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
      const importIds: string[] = [];
      let revision = 0;
      for (const [index, batch] of manifest.batches.entries()) {
        const preview = await generateImportPreview(fs.readFileSync(path.join(out, batch.file)), batch.file);
        saveImportBatch(db, {
          id: preview.previewId, fileName: preview.fileName, fileHash: preview.fileHash,
          contentHash: preview.contentHash, sheetName: preview.sheetName, headerMap: preview.headerMapping,
          parserVersion: '1.0.0', scopeNote: preview.scopeNote, rowCount: preview.stats.totalStudents,
          status: 'ready', createdAt: new Date(2026, 0, index + 1).toISOString(),
        }, preview.students);
        const activated = activateImport(db, { importId: preview.previewId, expectedRevision: revision, idempotencyKey: `round3-${index}`, asOfDate: '2026-10-01' });
        revision = activated.revision;
        importIds.push(preview.previewId);
        expect(activated.totalStudents).toBe(index + 2);
        const report = getClassNameMatchReport(db, { importId: preview.previewId, scope: { kind: 'latest' } });
        expect(report.previousRoster?.importId ?? null).toBe(index === 0 ? null : importIds[index - 1]);
        if (index === 0) {
          const calculation = db.prepare('SELECT math_days FROM student_calculations WHERE run_id = ? AND person_code = ?').get(activated.runId, manifest.zeroDayPersonCode);
          expect(calculation).toEqual({ math_days: 0 });
        }
        if (index === 1) {
          expect(db.prepare("SELECT COUNT(*) AS n FROM student_enrollments WHERE import_id = ? AND raw_token = '[團]' AND base_name = ''").get(preview.previewId)).toEqual({ n: 1 });
          const alias = manifest.alias;
          expect(db.prepare('SELECT COUNT(*) AS n FROM student_enrollments WHERE import_id = ? AND base_name = ?').get(preview.previewId, alias.rawBaseName)).toEqual({ n: 1 });
          expect(report.rosterOnly?.some((entry) => entry.baseName === alias.rawBaseName)).toBe(true);
          const draft = { ...buildSeedDraft(), aliases: [alias] };
          const settingsPreview = previewSettingsChange(db, undefined, { draft, expectedRevision: revision });
          const applied = applySettingsPreview(db, { previewId: settingsPreview.previewId, expectedRevision: revision, idempotencyKey: 'round3-b-alias' });
          revision = applied.revision;
          const mapped = getClassNameMatchReport(db, { importId: preview.previewId, scope: { kind: 'latest' } });
          expect(mapped.rosterOnly?.some((entry) => entry.baseName === alias.rawBaseName)).toBe(false);
          const calculation = executeCalculationRun(db, preview.previewId, 'run_round3_alias', { aliasMap: new Map([[alias.rawBaseName, alias.targetBaseName]]) });
          expect(calculation.results.flatMap((student) => student.issues).filter((issue: { code: string }) => issue.code === 'SCHEDULE_NOT_FOUND')).toEqual([]);
        }
      }
    } finally {
      db.close();
    }
  });
});
