import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const verifierSource = path.join(webRoot, 'scripts', 'verify-full-e2e-report.mjs');
const otherFile = 'second.spec.ts';

type Fixture = {
  root: string;
  reports: string;
  blobs: string;
  verifier: string;
  specs: string[];
};

let fixture: Fixture;

function writeJson(filename: string, value: unknown): void {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'student-billing-issue-101-'));
  const reports = path.join(root, 'full-e2e');
  const blobs = path.join(root, 'blob-report', 'full-e2e');
  const scripts = path.join(root, 'scripts');
  const specRoot = path.join(root, 'tests', 'e2e');
  const logs = path.join(reports, 'logs');
  const htmlReport = path.join(reports, 'playwright-report');
  for (const dir of [reports, blobs, scripts, specRoot, logs, htmlReport]) fs.mkdirSync(dir, { recursive: true });

  const specs = ['demo.spec.ts', otherFile].sort();
  for (const spec of specs) fs.writeFileSync(path.join(specRoot, spec), '// synthetic verifier fixture\n');
  const verifier = path.join(scripts, 'verify-full-e2e-report.mjs');
  fs.copyFileSync(verifierSource, verifier);

  const expectedOrder = [...specs];
  writeJson(path.join(reports, 'manifest.json'), {
    schemaVersion: 1,
    kind: 'student-billing-full-e2e',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    specFiles: specs,
    runs: expectedOrder.map((file) => ({
      file,
      exitCode: 0,
      signal: null,
    })),
    complete: true,
  });

  const specSuite = (file: string, count: number) => ({
    specs: Array.from({ length: count }, (_, index) => ({
      file: `tests/e2e/${file}`,
      id: `${file}-case-${index}`,
      title: `case-${index}`,
      tests: [{
        projectName: 'chromium',
        status: 'expected',
        expectedStatus: 'passed',
        results: [{ status: 'passed', retry: 0 }],
      }],
    })),
  });
  writeJson(path.join(reports, 'results.json'), {
    suites: [specSuite('demo.spec.ts', 1), specSuite(otherFile, 3)],
    stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 0 },
    errors: [],
  });

  for (const file of specs) {
    const slug = file.slice(0, -'.spec.ts'.length);
    fs.writeFileSync(path.join(blobs, `report-${slug}.zip`), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    fs.writeFileSync(path.join(logs, `${slug}.log`), `synthetic run log for ${file}\n`);
  }
  fs.writeFileSync(path.join(htmlReport, 'index.html'), '<!doctype html><title>synthetic report</title>');
  fs.writeFileSync(path.join(reports, 'junit.xml'), '<testsuites tests="4"/>');
  return { root, reports, blobs, verifier, specs };
}

function runVerifier(current: Fixture) {
  const stepSummary = path.join(current.root, 'step-summary.md');
  return spawnSync(process.execPath, [current.verifier], {
    cwd: current.root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: stepSummary, GITHUB_SHA: 'synthetic-fixture' },
  });
}

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe('Issue #101 full E2E report verifier', () => {
  it('accepts a complete single-stage report with every spec executed once', () => {
    const result = runVerifier(fixture);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.reports, 'summary.json'), 'utf8'))).toMatchObject({
      status: 'PASS',
      specFiles: 2,
      blobs: 2,
      testCases: 4,
      passed: 4,
      skipped: 0,
      failed: 0,
    });
  });

  it.each([
    ['missing Blob', (current: Fixture) => fs.rmSync(path.join(current.blobs, 'report-demo.zip'))],
    ['empty Blob', (current: Fixture) => fs.writeFileSync(path.join(current.blobs, 'report-demo.zip'), '')],
    ['missing merged JSON', (current: Fixture) => fs.rmSync(path.join(current.reports, 'results.json'))],
    ['missing merged JUnit', (current: Fixture) => fs.rmSync(path.join(current.reports, 'junit.xml'))],
    ['missing merged HTML', (current: Fixture) => fs.rmSync(path.join(current.reports, 'playwright-report', 'index.html'))],
    ['missing per-spec log', (current: Fixture) => fs.rmSync(path.join(current.reports, 'logs', 'demo.log'))],
    ['spec with zero executed test cases', (current: Fixture) => {
      const filename = path.join(current.reports, 'results.json');
      const json = JSON.parse(fs.readFileSync(filename, 'utf8'));
      json.suites[1].specs = [];
      json.stats.expected = 1;
      writeJson(filename, json);
    }],
    ['stats expected mismatch', (current: Fixture) => {
      const filename = path.join(current.reports, 'results.json');
      const json = JSON.parse(fs.readFileSync(filename, 'utf8'));
      json.stats.expected = 999;
      writeJson(filename, json);
    }],
    ['skipped test case', (current: Fixture) => {
      const filename = path.join(current.reports, 'results.json');
      const json = JSON.parse(fs.readFileSync(filename, 'utf8'));
      json.suites[1].specs[0].tests[0].status = 'skipped';
      json.suites[1].specs[0].tests[0].results = [];
      json.stats.expected = 3;
      json.stats.skipped = 1;
      writeJson(filename, json);
    }],
    ['duplicate test identity', (current: Fixture) => {
      const filename = path.join(current.reports, 'results.json');
      const json = JSON.parse(fs.readFileSync(filename, 'utf8'));
      json.suites[1].specs[1].id = json.suites[1].specs[0].id;
      writeJson(filename, json);
    }],
    ['failed child invocation', (current: Fixture) => {
      const filename = path.join(current.reports, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
      manifest.runs[0].exitCode = 1;
      writeJson(filename, manifest);
    }],
    ['incomplete manifest', (current: Fixture) => {
      const filename = path.join(current.reports, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
      manifest.complete = false;
      writeJson(filename, manifest);
    }],
    ['spec omitted from execution manifest', (current: Fixture) => {
      const filename = path.join(current.reports, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
      manifest.runs.pop();
      writeJson(filename, manifest);
    }],
    ['unexpected extra spec in manifest', (current: Fixture) => {
      const filename = path.join(current.reports, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
      manifest.runs.push({ file: 'extra.spec.ts', exitCode: 0, signal: null });
      writeJson(filename, manifest);
    }],
  ])('fails closed for %s', (_name, mutate) => {
    mutate(fixture);
    const result = runVerifier(fixture);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.reports, 'summary.json'), 'utf8')).status).toBe('FAIL');
  });
});
