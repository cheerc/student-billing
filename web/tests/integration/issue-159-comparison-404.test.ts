import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve a local port');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe('Issue #159 PR-1: comparison endpoint retirement', () => {
  it('GET to the removed comparison route returns the Next.js 404 response', async () => {
    const port = await unusedPort();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-issue-159-comparison-404-'));
    const child: ChildProcess = spawn(process.execPath, [
      path.resolve(process.cwd(), 'node_modules/next/dist/bin/next'),
      'dev', '--hostname', '127.0.0.1', '--port', String(port),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_PATH: path.join(tempDir, 'test.sqlite'),
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout?.on('data', (chunk) => { logs = `${logs}${String(chunk)}`.slice(-6000); });
    child.stderr?.on('data', (chunk) => { logs = `${logs}${String(chunk)}`.slice(-6000); });

    try {
      const url = `http://127.0.0.1:${port}/api/v1/runs/synthetic-run/comparison?againstRuleSet=excel-v260922-compat`;
      let response: Response | undefined;
      const deadline = Date.now() + 60_000;
      while (!response && Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Next dev server exited early. ${logs}`);
        try {
          response = await fetch(url);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      expect(response, `Next dev server did not respond. ${logs}`).toBeDefined();
      expect(response!.status).toBe(404);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timeout = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 70_000);
});
