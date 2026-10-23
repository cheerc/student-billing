# Issue #161 implementation evidence

Implementation source commit: `402f9b7c64ff48fb333b59d1e1d9d3e9ffff7c33`

Base: `7479c2cee68f6efb3bb1c5c680fa5afff09eab49`

Branch: `fix/issue-161-run-diagnostics`

## Environment

- Node.js `v24.19.0`
- Vitest `v3.2.7`
- TypeScript `5.9.3`
- Next.js `16.3.6`
- Dependencies installed with `npm ci`.

## RED/GREEN and final verification

The regression tests use a committed, manually specified synthetic golden. It covers a historical false positive, a historical false negative, exact response ordering/category/value fields, `null` versus zero, no-difference snapshots, legacy/unavailable states, and calculator-not-called/read-only guards. Migration, atomicity, idempotency, audit, preview, and `settings_only` cases use synthetic SQLite databases.

Commands run on the implementation source commit:

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test -- --maxWorkers=1 --minWorkers=1 tests/integration/issue-161-diagnostics-versioning.test.ts tests/integration/issue-157-run-class-categories-unset.test.ts tests/unit/issue-157-seed-category-fallback.test.ts` | PASS, 3 files / 16 tests |
| `env TMPDIR=/var/tmp npm test -- --maxWorkers=1 --minWorkers=1` | PASS, 150 files passed / 1 skipped; 1,464 tests passed / 1 skipped (1,465 total), 256.65 seconds |
| `npm run build` | PASS; Next.js production build completed and included `/api/v1/runs/[runId]/comparison` |
| `npm exec -- tsx scripts/audit-issue-161-diagnostics.ts --help` | PASS; prints usage without selecting or opening a database |

The added seed/manual/unset regression was first run against the previous capture logic with `npm test -- --maxWorkers=1 --minWorkers=1 tests/integration/issue-161-diagnostics-versioning.test.ts -t 'effective input evidence'`: it failed 1 test / skipped 4 because the snapshot reported `兒童美語-Gino` as `unset/unset` rather than its effective `english/seed`, and retained the stale category on the explicit-unset math class. After the fix, the focused command in the table passed, and the full suite passed.

At exact source commit `d94198a0661f6825c067d633c2dd2522f59fe309`, an earlier unconstrained full-suite attempt exhausted `/tmp` while existing acceptance-gate tests created temporary project copies. That attempt was stopped, only test-generated `/tmp/sb130-*` directories were removed, and the suite passed serially with `TMPDIR=/var/tmp` and one Vitest worker. A stale orphan Vitest process from that failed attempt was terminated before that successful run. The current rework's final full suite again ran serially with `TMPDIR=/var/tmp` and passed.

## Synthetic storage and latency measurement

The integration measurement builds and activates a 200-student synthetic run in the test's temporary SQLite database. It measures the existing run-creation path and comparison GET with `performance.now()` and serializes the saved JSON payload/effective-input evidence to count bytes. The final full-suite sample reported:

- Payload: 38,182 bytes
- Effective-input evidence: 20,727 bytes
- Combined diagnostic JSON: 58,909 bytes per run
- Create run: 19.83 ms
- Comparison GET: 9.27 ms

These are single-run synthetic test-process measurements, not a production benchmark. Repeated focused runs varied (for example 18.63 ms create / 10.20 ms GET), so latency should be treated as indicative only. No real student database or source spreadsheet was accessed.

## Reviewer finding addressed

The reviewer found that raw draft `category` and `categorySource` were not always the values billing consumed: `effectiveCategoryOf` can apply seed fallback and ignore legacy `auto` or explicit `unset` values. Effective input capture now calls that same resolver for each configured class, while the billing path and outputs remain unchanged. The regression creates only synthetic data and verifies four cases against persisted `run_class_categories`: omitted seed category, stale legacy `auto` category falling back to the seed manifest, manual override, and explicit `unset` overriding a stale category.

## Limits and unrun checks

- The private local audit CLI was not run against an application database or backup. Its integration test uses only synthetic data and verifies aggregate-only output, read-only behavior, omitted-difference detection, and rejection of an extra unsupported difference key.
- The separate browser E2E command `npm run test:e2e:isolated` was not run; the full Vitest suite, including repository acceptance/isolation tests, passed.
- No independently anonymized real-run fixture was available or created. The committed golden is synthetic and does not claim that every pre-existing run can be reconstructed; legacy rows remain unavailable unless a supported snapshot was saved at run creation.
- The earlier full-suite first attempt failed from temporary-disk pressure; the final sequential suite result above is the acceptance result.
