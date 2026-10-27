/** Static contract: nightly FULL E2E must remain the exact same local npm script. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '..');
const workflow = fs.readFileSync(path.join(root,'.github/workflows/nightly-e2e.yml'),'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(web,'package.json'),'utf8'));
const rootGuide = fs.readFileSync(path.join(root,'CLAUDE.md'),'utf8');
const webGuide = fs.readFileSync(path.join(web,'CLAUDE.md'),'utf8');
const e2eGuide = fs.readFileSync(path.join(web,'tests/e2e/CLAUDE.md'),'utf8');
const failures = [];
if (pkg.scripts?.['test:e2e:full'] !== 'node scripts/e2e-full.mjs') failures.push('package script test:e2e:full changed');
const matches = workflow.match(/^\s*run:\s*npm run test:e2e:full\s*$/gm) ?? [];
if (matches.length !== 1) failures.push('nightly workflow must have exactly one run: npm run test:e2e:full');
if (/run:\s*.*(?:test:e2e:isolated|playwright test|merge-reports)/.test(workflow)) failures.push('workflow has alternate E2E execution path');
if (!rootGuide.includes('npm run test:e2e:full')) failures.push('root CLAUDE.md lacks canonical command');
if (!webGuide.includes('@AGENTS.md') || !webGuide.includes('@tests/e2e/CLAUDE.md')) failures.push('web/CLAUDE.md delegation missing');
if (!e2eGuide.includes('npm run test:e2e:full')) failures.push('E2E CLAUDE.md lacks canonical command');
if (failures.length) {for (const f of failures) console.error(`PARITY CONTRACT FAIL: ${f}`);process.exitCode=1;}
else console.log('PASS: local/nightly FULL E2E canonical command + docs parity');
