# E2E testing contract — student-billing (#101)

Read with root `CLAUDE.md` §8 and `web/playwright.isolated.config.ts`.

## ONE canonical FULL E2E flow (local == GitHub nightly)

```bash
cd web
npm ci                              # dependency bootstrap (only when needed)
npx playwright install chromium     # local browser bootstrap (Linux CI uses --with-deps)
npm run test:e2e:full               # EXACT command used by nightly workflow
```

- **Every developer/agent running FULL E2E MUST use `npm run test:e2e:full`.**
- `.github/workflows/nightly-e2e.yml` MUST invoke the same script, not reimplement loops, skip lists, seeded setup, `.next` cleanup, reporters or aggregation in YAML.
- The only canonical FULL contract is `web/scripts/e2e-full.mjs`, which invokes the existing isolated runner for each discovered `tests/e2e/*.spec.ts`.
- Full gate: **all spec files, each attempted once, zero unexpected skips, no retries, no fail-to-green**, merged Blob/JSON/HTML/JUnit with fail-closed inventory verification.
- Changes to test inventory, Playwright reporter or runner MUST update/test the canonical full script, verifier and this document together. CI/local results must remain equivalent at the execution-contract level.

## Targeted development checks (NOT the full gate)

```bash
cd web
npm run test:e2e:isolated -- tests/e2e/imports.spec.ts
npm run test:e2e:isolated -- tests/e2e/issue-158-discount-explanation.spec.ts
```

Targeted checks are fine while iterating; report them as targeted, not "full E2E PASS".

## Schedule grid: always enter through the tab-aware helpers (D61 / Issue #188)

D61 turned the schedule settings into **one table per class-type tab** (安親課輔班／美語班／數學班／其他班／不排課).
The default tab is **安親課輔班, which has no time-slot columns** — `input.input-time` and
`input.input-weekday` simply do not exist there. Any spec that touches a slot must therefore
navigate with a helper, never by pointing at the first match on the page:

```ts
import { classRow, openClassSchedule, openClassScheduleViaHome, startInput } from './helpers/c-batch';

const row = await openClassSchedule(page, '兒童美語-Gino'); // ?class= deep link + correct tab, returns first row
const row2 = await openClassScheduleViaHome(page, '兒童美語-Gino'); // keeps `/` in history (Back / leave guard)
const start = startInput(page); // default = 兒童美語-Gino first row (the old `tbody tr nth(3)` meaning)
row.locator('input.input-weekday').fill('八');
```

Rules:

- **Never** locate schedule rows with `">.schedule-table tbody tr').nth(n`" or with `input.input-time`/`input.input-weekday` `.first()`.
  Row order depends on the active tab and the search/weekday filters; `.first()` on the default tab matches nothing at all.
- Locate a class by its stable name: `classRow(page, name)` (first row) or `classRows(page, name)` (all slots).
  If the class is not on the current tab, `ensureClassTypeTab(page, name)` clicks `#class-type-tab-*` and waits.
- Use `openClassScheduleViaHome` whenever the test depends on browser history; `page.goto` replaces the
  current entry, so a deep link would remove the page that `goBack()` is supposed to return to.
- `tests/unit/e2e-conventions.test.ts` enforces these rules statically (49-spec inventory, no obsolete literals,
  slot-touching specs must import a row helper). Update it together with any new convention.
- Removed selectors: `data-category-select` was replaced by `YesNoRadioGroup`; `schedule-table-non-care` no longer exists.

## Isolated runner: use your own port when another session is running E2E

`npm run test:e2e:isolated` defaults to port 3100 and **fails immediately** when the port is taken
(`http://127.0.0.1:3100 is already used`). That is often another worktree's session, not a test failure.
Pick a free port instead of killing the other run: `npm run test:e2e:isolated -- --port 3122 tests/e2e/<file>.spec.ts`.

## Isolation, security, evidence

- Every spec uses `web/scripts/e2e-isolated.ts`: fresh server at `127.0.0.1:3100` + temporary SQLite under `os.tmpdir()` (not port 3000, not `data/app.sqlite`). No `--shared` for full gate.
- Full script cleans `.next` before running specs; `.next` is **not** reset between each normal file, while every spec gets its own DB and process. Local and CI share this same lifecycle.
- Full suite uses serial Chromium, `retries=0`, failure traces/screenshots; never `|| true`, blanket `test.skip`, or rerun-to-green. Existing flaky tests must remain visible and have an issue owner.
- Never use actual student Excel, local production SQLite, private fixtures, credentials or PII in GitHub-hosted tests or downloadable artifacts. Only committed synthetic/anonymized fixtures.
- Collect `web/full-e2e/summary.json`, manifest, logs, merged reports, Blob and failure traces. Record exact HEAD, Node/Playwright, spec/test counts, skips and failed test identities.
- Mac vs Ubuntu prerequisites (system libraries/binaries) can differ; **E2E test invocation and gate logic cannot differ.** A green local run does not prove hosted Ubuntu toolchain; a green hosted run proves only that exact SHA in that environment.

## Review/merge and rollout

- Per Issue #101 operator: nightly on GitHub-hosted Ubuntu, manual `workflow_dispatch`, **no per-PR full E2E gate**, do not block unrelated PRs simply because nightly has not been deployed yet.
- Reviewer must inspect exact HEAD; distinguish static/local evidence from GitHub-hosted evidence. New workflow must exist on default branch before the first standard `workflow_dispatch`.
- A nightly scheduled failure creates/updates an issue (manual dispatch does not). Never call a manual green run a successful scheduled execution.
