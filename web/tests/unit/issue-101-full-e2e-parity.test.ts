import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

it('keeps the local full E2E command, nightly workflow and agent documentation in parity', () => {
  const result = spawnSync(process.execPath, ['scripts/check-e2e-parity.mjs'], {
    cwd: webRoot,
    encoding: 'utf8',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('PASS: local/nightly FULL E2E canonical command + docs parity');
});
