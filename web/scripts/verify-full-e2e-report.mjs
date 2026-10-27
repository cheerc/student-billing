/** Fail-closed full E2E report verifier. Input: this run's manifest + Blob + merged Playwright JSON. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.join(root, 'full-e2e');
const blobDir = path.join(root, 'blob-report', 'full-e2e');
const problems = [];
const error = msg => problems.push(msg);
const readJson = (p, name) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { error(`${name} is unavailable/invalid: ${e.message}`); return null; }
};
const currentSpecs = fs.readdirSync(path.join(root, 'tests', 'e2e')).filter(f => f.endsWith('.spec.ts')).sort();
const currentSet = new Set(currentSpecs);
const slugOf = f => f.slice(0, -'.spec.ts'.length).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
if (!currentSpecs.length) error('E2E inventory is empty');
const manifest = readJson(path.join(artifact, 'manifest.json'), 'manifest');
if (manifest) {
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'student-billing-full-e2e' || manifest.complete !== true) {
    error('Manifest schema/kind/complete contract invalid');
  }
  const started = Date.parse(manifest.startedAt);
  const finished = Date.parse(manifest.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) error('Manifest timestamps are missing or invalid');
  if (JSON.stringify(manifest.specFiles) !== JSON.stringify(currentSpecs)) error('Manifest spec inventory differs from checkout');
  const files = (manifest.runs ?? []).map(r => r.file);
  const expectedOrder = [...currentSpecs];
  if (JSON.stringify(files) !== JSON.stringify(expectedOrder)) error('Not every spec was attempted exactly once in expected order');
  for (const run of manifest.runs ?? []) {
    if (run.exitCode !== 0 || run.signal) error(`E2E child command failed/interrupted: ${run.file} exit=${run.exitCode}, signal=${run.signal}`);
    if (currentSet.has(run.file)) {
      const log = path.join(artifact, 'logs', `${slugOf(run.file)}.log`);
      if (!fs.existsSync(log) || fs.statSync(log).size === 0) error(`Missing or empty per-spec log: ${run.file}`);
    }
  }
}
const expectedNames = currentSpecs.map(f => `report-${slugOf(f)}.zip`).sort();
let blobNames = [];
try { blobNames = fs.readdirSync(blobDir).filter(f => f.endsWith('.zip')).sort(); }
catch (e) { error(`Blob directory unavailable: ${e.message}`); }
if (JSON.stringify(blobNames) !== JSON.stringify(expectedNames)) error(`Blob inventory mismatch: expected ${expectedNames.length}, found ${blobNames.length}`);
for (const name of expectedNames) {
  const filename = path.join(blobDir, name);
  if (!fs.existsSync(filename)) { error(`Missing Blob: ${name}`); continue; }
  const file = fs.readFileSync(filename);
  if (file.length < 4 || file.toString('ascii', 0, 2) !== 'PK') error(`Empty or non-ZIP Blob: ${name}`);
}
const report = readJson(path.join(artifact, 'results.json'), 'merged Playwright JSON');
for (const [filename, label] of [
  [path.join(artifact, 'playwright-report', 'index.html'), 'merged HTML report'],
  [path.join(artifact, 'junit.xml'), 'merged JUnit report'],
]) {
  if (!fs.existsSync(filename) || fs.statSync(filename).size === 0) error(`${label} is missing or empty`);
}
const tests = [];
function traverse(suite) {
  for (const spec of suite.specs ?? []) {
    const raw = String(spec.file || suite.file || '').replaceAll('\\', '/');
    const filename = path.posix.basename(raw);
    if (!currentSet.has(filename)) error(`Unknown/missing file in JSON: ${raw || '(empty)'}`);
    for (const test of spec.tests ?? []) {
      tests.push({ file: filename, id: spec.id, title: spec.title, project: test.projectName,
        status: test.status, expectedStatus: test.expectedStatus, results: test.results ?? [] });
    }
  }
  for (const sub of suite.suites ?? []) traverse(sub);
}
if (report) {
  if (!Array.isArray(report.suites)) error('JSON missing suites');
  else for (const suite of report.suites) traverse(suite);
  if (!report.stats) error('JSON missing stats');
  for (const e of report.errors ?? []) error(`Playwright global error: ${e.message ?? String(e)}`);
}
let passed = 0, skipped = 0, failed = 0;
const counted = new Map(currentSpecs.map(f => [f, 0]));
const ids = new Set();
for (const t of tests) {
  if (currentSet.has(t.file)) counted.set(t.file, (counted.get(t.file) ?? 0) + 1);
  const key = `${t.file}::${t.id}::${t.project}`;
  if (!t.id || t.project !== 'chromium') error(`Invalid test id/project: ${key}`);
  if (ids.has(key)) error(`Duplicate test case identity: ${key}`);
  ids.add(key);
  if (t.status === 'skipped') { skipped++; error(`Skipped test: ${t.file}/${t.title}`); }
  else if (t.status === 'expected' && t.expectedStatus === 'passed' && t.results.length === 1 &&
    t.results[0].status === 'passed' && t.results[0].retry === 0) passed++;
  else { failed++; error(`Non-first-pass test: ${t.file}/${t.title} ${t.status}`); }
}
for (const [file, n] of counted) if (n < 1) error(`No executed test case in spec: ${file}`);
if (report?.stats) {
  const { expected, unexpected, flaky, skipped: statSkipped } = report.stats;
  if (expected !== passed || unexpected !== 0 || flaky !== 0 || statSkipped !== 0 || tests.length !== passed + skipped + failed) {
    error(`Merged stats mismatch: expected=${expected}, unexpected=${unexpected}, flaky=${flaky}, skipped=${statSkipped}, countedPassed=${passed}`);
  }
}
const summary = {
  status: problems.length ? 'FAIL' : 'PASS',
  githubSha: process.env.GITHUB_SHA ?? null,
  specFiles: currentSpecs.length,
  blobs: blobNames.length,
  testCases: tests.length,
  passed, skipped, failed, problems,
};
fs.mkdirSync(artifact, { recursive: true });
fs.writeFileSync(path.join(artifact, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const markdown = `## Full E2E coverage gate\n\n- Status: **${summary.status}**\n- SHA: \`${summary.githubSha ?? 'local'}\`\n- Specs: **${summary.specFiles}**; Blob reports: **${summary.blobs}**\n- Cases: **${summary.testCases}**; passed **${passed}**, skipped **${skipped}**, failed **${failed}**\n${problems.map(s => `- ❌ ${s}`).join('\n')}\n`;
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
if (problems.length) process.exitCode = 1;
