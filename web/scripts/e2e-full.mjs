/**
 * Single Source of Truth for FULL E2E: run via `npm run test:e2e:full`.
 * GitHub Actions nightly and developers invoke the SAME command.
 * Candidate implementation for Issue #101 (not yet hosted-verified).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specRoot = path.join(webRoot, 'tests', 'e2e');
const reportsRoot = path.join(webRoot, 'full-e2e');
const blobRoot = path.join(webRoot, 'blob-report', 'full-e2e');
const outputRoot = path.join(webRoot, 'test-results', 'full-e2e');
const manifestPath = path.join(reportsRoot, 'manifest.json');
let infraFailure = false;

if (process.cwd() !== webRoot) {
  console.error(`Run from web/: expected ${webRoot}, got ${process.cwd()}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(webRoot, 'package-lock.json')) || !fs.existsSync(path.join(webRoot, 'playwright.isolated.config.ts'))) {
  console.error('Missing package lock or isolated Playwright config; check worktree and npm ci.');
  process.exit(1);
}

const specs = fs.readdirSync(specRoot).filter(f => f.endsWith('.spec.ts')).sort();
if (!specs.length) {
  console.error('Invalid inventory: 0 specs found');
  process.exit(1);
}
const slugOf = f => f.slice(0, -'.spec.ts'.length).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
const runOrder = [...specs];
const slugs = specs.map(slugOf);
if (new Set(slugs).size !== specs.length || slugs.some(s => !s)) {
  console.error('Duplicate/invalid report slug in E2E spec filenames');
  process.exit(1);
}

// Clear previous run artifacts AND stale Next dev cache. Never touch root data/ or port 3000.
for (const dirname of [reportsRoot, blobRoot, outputRoot, path.join(webRoot, '.next')]) {
  fs.rmSync(dirname, { recursive: true, force: true });
}
for (const dirname of [reportsRoot, blobRoot, outputRoot, path.join(reportsRoot, 'logs')]) {
  fs.mkdirSync(dirname, { recursive: true });
}

const manifest = {
  schemaVersion: 1,
  kind: 'student-billing-full-e2e',
  startedAt: new Date().toISOString(),
  sha: process.env.GITHUB_SHA ?? null,
  node: process.version,
  os: `${os.platform()}-${os.arch()}`,
  specFiles: specs,
  runs: [],
  complete: false,
};
const saveManifest = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
saveManifest();

/** Stream child output to console AND a per-spec file; do not overwrite shared logs. */
async function runLogged(program, args, env, file) {
  return await new Promise(resolve => {
    const log = fs.createWriteStream(file, { flags: 'w' });
    let finished = false;
    const child = spawn(program, args, {
      cwd: webRoot, env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const forward = (source, dest) => source?.on('data', chunk => {
      dest.write(chunk);
      log.write(chunk);
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('error', error => {
      log.write(`\n[spawn error] ${error.stack || error}\n`);
      console.error(error);
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      log.end(() => resolve({ code: code ?? 1, signal: signal ?? null }));
    });
  });
}

let executeStatus = 0;
for (const spec of runOrder) {
  const slug = slugOf(spec);
  const file = `tests/e2e/${spec}`;
  const blobFile = path.join(blobRoot, `report-${slug}.zip`);
  const childEnv = {
    ...process.env,
    E2E_FULL_RUN: '1',
    E2E_SPEC_SLUG: slug,
    PLAYWRIGHT_BLOB_OUTPUT_FILE: blobFile,
  };
  const args = ['run', 'test:e2e:isolated', '--', file];
  const began = Date.now();
  console.log(`\n=== FULL E2E ${runOrder.indexOf(spec) + 1}/${runOrder.length}: ${file} ===`);
  const result = await runLogged('npm', args, childEnv, path.join(reportsRoot, 'logs', `${slug}.log`));
  manifest.runs.push({ file: spec, exitCode: result.code, signal: result.signal, durationMs: Date.now() - began });
  saveManifest();
  if (result.code !== 0 || result.signal) executeStatus = 1;
}
manifest.complete = true;
manifest.finishedAt = new Date().toISOString();
saveManifest();

const combined = path.join(reportsRoot, 'results.json');
const mergeEnv = {
  ...process.env,
  PLAYWRIGHT_HTML_OPEN: 'never',
  PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(reportsRoot, 'playwright-report'),
  PLAYWRIGHT_JUNIT_OUTPUT_FILE: path.join(reportsRoot, 'junit.xml'),
  PLAYWRIGHT_JSON_OUTPUT_FILE: combined,
};
console.log('\n=== Merge all per-spec Blob reports ===');
const blobFiles = fs.readdirSync(blobRoot).filter(f => f.endsWith('.zip'));
if (!blobFiles.length) {
  console.error('No Blob report exists: merge cannot succeed.');
  infraFailure = true;
} else {
  const merged = await runLogged('npx', ['--no-install', 'playwright', 'merge-reports', '--reporter=html,junit,json', blobRoot], mergeEnv, path.join(reportsRoot, 'merge.log'));
  if (merged.code !== 0 || merged.signal) infraFailure = true;
}

// Verify regardless of missing/failed merge. Verifier always writes machine summary on failure.
console.log('\n=== Verify coverage and report integrity (fail-closed) ===');
const verified = await runLogged(process.execPath, ['scripts/verify-full-e2e-report.mjs'], process.env, path.join(reportsRoot, 'verify.log'));
if (verified.code !== 0 || verified.signal) infraFailure = true;
const failed = executeStatus || infraFailure;
console.log(`\n=== FULL E2E ${failed ? 'FAIL' : 'PASS'}: ${specs.length} spec files, status ${failed ? 1 : 0} ===`);
process.exitCode = failed ? 1 : 0;
