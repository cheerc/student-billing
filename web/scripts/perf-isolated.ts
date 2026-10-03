import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { assertIsolatedE2eTarget } from './e2e-isolation';
import { seedPerformanceDatabase } from './perf-fixture';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--port')) {
    throw new Error('用法：npm run test:perf:isolated -- [--port <非3000埠>]');
  }
  const port = args.length ? Number(args[1]) : 3400;
  // mkdir／build／seed 前先拒絕錯誤埠；實際 DB 再沿用同一個 isolation 守衛。
  assertIsolatedE2eTarget({ databasePath: path.join(os.tmpdir(), 'sb-perf-validation.sqlite'), port });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-'));
  const databasePath = path.join(tempDir, 'app.sqlite');
  assertIsolatedE2eTarget({ databasePath, port });
  let child: ChildProcess | undefined;
  let interrupted = false;
  const stop = () => { interrupted = true; child?.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_PATH: databasePath, NEXT_TELEMETRY_DISABLED: '1' };
  const run = (argv: string[], commandEnv = env) => new Promise<void>((resolve, reject) => {
    if (interrupted) return reject(new Error('效能量測已中止'));
    child = spawn(process.execPath, argv, { env: commandEnv, stdio: 'inherit', timeout: 180_000 });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      child = undefined;
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(`效能子程序失敗 code=${code} signal=${signal}`));
    });
  });
  try {
    const runId = seedPerformanceDatabase(databasePath, port);
    console.log('[perf environment] ' + JSON.stringify({
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(),
      os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
      buildMode: 'next build + next start / NODE_ENV=production', students: 477,
      workers: 1, retries: 0, coldRequestsPerPath: 1, warmupRequestsPerPath: 1, samplesPerPath: 10,
      median: '(sorted[4]+sorted[5])/2', p95: 'nearest-rank ceil(0.95*10)=10', budget: 'p95 < 200ms',
      boundary: 'Chromium same-origin fetch → response body read; no UI render',
    }));
    await run(['node_modules/next/dist/bin/next', 'build']);
    await run(['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.perf.config.ts'], {
      ...env, PERF_DATABASE_PATH: databasePath, PERF_PORT: String(port), PERF_RUN_ID: runId,
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
