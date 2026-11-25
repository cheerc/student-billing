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
- `startInput(page, className?)` checks the class row is visible **before** returning the locator, so a
  spec parked on the wrong tab fails at the helper instead of quietly pointing at nothing.
- **What the static gate does** — `tests/unit/e2e-conventions.test.ts` is a source-string scan only, and it
  does exactly three things: (a) banned literals (`data-category-select`, `schedule-table-non-care`, and
  row-order lookups `.schedule-table tbody tr'|").nth(`) must not appear, (b) a spec that touches
  `input.input-time` / `input.input-weekday` must import a row helper and must not grab the first match with a
  page-level locator (`page.locator('input.input-time').first()`), and (c) `startInput` keeps its
  async/`classRow`/`toBeVisible` shape.
- **What it does not prove**: it never runs a browser. It cannot show a helper works, and it cannot catch a
  helper regression — mutating `startInput` back to "first slot on the page" left all 12 migrated specs green
  (PR #191 §TDD.5, M2). (c) only guards the shape of that contract, not its behaviour; E2E is what exercises
  the behaviour. Do not describe the gate as proving more than this.
- Update the gate (and `e2e-conventions-exemptions.ts`) together with any new convention. Exception entries
  are only kept while they are still needed: each one must still match its literals, or still both lack a row
  helper *and* touch a managed input, otherwise the test demands its removal.

## Changing a class's category (D61): radio for existing classes, Excel for class type

There is **no** category `<select>` any more (`[data-category-select]` is banned by the static gate).
An existing class's effective category is the projection of its **class type + 「是否有多科折扣」**:

| want | how |
|---|---|
| `math` / `english` / `care` → `none` | `setMultiDiscount(page, name, false)` |
| `none` → `math` / `english` / `care` | `setMultiDiscount(page, name, true)` |
| `other` → `math` (change the **class type**) | Excel round-trip only: `mutateExport(page, (rows) => { setRowClassType(...); setRowMultiDiscount(...) })` |

- `其他班` and `不排課` tabs have **no** multi-discount column at all (09 §3.1), so their category is
  always `none`; only the Excel path can move them out of those tabs (UX106/UX109, R-188-P2).
- When changing an `other` class to a schedulable type via Excel you must also set 「是否有多科折扣」
  to 是 — `other` exports it as 否, and `deriveEffectiveCategory(math, false)` is still `none`.
- Helpers: `selectClassTypeTab(page, type)` (park on a tab, e.g. to read `.count-summary`) and
  `ensureClassTypeTab(page, name)` (find a class wherever it lives). `setMultiDiscount` calls
  `ensureClassTypeTab` itself, so it works from the default care tab.

## Isolated runner: use your own port when another session is running E2E

`npm run test:e2e:isolated` defaults to port 3100 and **fails immediately** when the port is taken
(`http://127.0.0.1:3100 is already used`). That is often another worktree's session, not a test failure.
Pick a free port instead of killing the other run: `npm run test:e2e:isolated -- --port 3122 tests/e2e/<file>.spec.ts`.

## Settings page: wait for the edit's calculate before clicking 「確認變更」 (Issue #271)

Every draft edit schedules `POST /api/v1/settings/calculate` after a 250ms debounce; while it runs,
「確認變更」 is disabled by design (specs/09 §3). A click that lands at the enabled→disabled flip is swallowed
(no `click` event, the dialog never opens), so a plain `await expect(btn).toBeEnabled()` or a sleep is not enough.

```ts
import { awaitCalculateAfter, clickConfirmChanges, saveSettings } from './helpers/d2c-settings';

await awaitCalculateAfter(page, () => page.locator('button', { hasText: '暫存同步' }).click()); // request-scoped wait, registered BEFORE the edit
await clickConfirmChanges(page);                                                                  // toBeEnabled, then click
// or, to confirm + save in one go (no re-click inside): after the edit above
await saveSettings(page);
```

- `awaitCalculateAfter` anchors on the **request** (`waitForRequest`, which only matches requests issued after it is registered) and then
  awaits that request's response. A calculate that was already in flight before the edit (the page-mount one, the one `cancelEdits()` triggers)
  can therefore never satisfy it; waiting on "any calculate response" would, and the edit's own debounced POST (~250ms later) would
  then reopen the race.
- Wrap **each** step that changes the draft (a step that only selects a target or opens a panel triggers no calculate).
  An edit that changes nothing sends no calculate and the wait times out: that means the edit did not take effect, not "retry".
- `saveSettings(page)` and `clickConfirmChanges(page)` do **not** wait for calculate by themselves; the caller wraps its last edit.
  `saveSettings` no longer re-clicks in a poll.
- Never re-click in a poll, add `waitForTimeout`, or raise a timeout to get past a lost click.
- Exempt: specs that freeze the page clock (`page.clock.install/pauseAt`, e.g. `d2d-impact-dialog-focus*.spec.ts`) — the debounce cannot fire
  until the test advances it, so no calculate is sent and `awaitCalculateAfter` would hang; the click is deterministic there.
- `flipCalculateOnConfirmHover(page)` (`helpers/hold-calculate.ts`) forces the flip at the moment the button is pressed;
  `settings-preview-apply.spec.ts` uses it for the helper test, for a control showing the naive click is lost, and (with `holdCalculate`)
  for the stale-in-flight-calculate test.

## Browser locale: UTF-8 is set by the configs (Issue #269)

Containers without `LANG`/`LC_*` make Chromium run in the POSIX locale, which renames non-ASCII download
names (e.g. `課表.xlsx`) to `download`. `playwright.config.ts`, `playwright.isolated.config.ts` and
`playwright.perf.config.ts` therefore pass `use.launchOptions.env = utf8BrowserEnv()`
(`scripts/e2e-browser-env.ts`): an already-UTF-8 locale is kept, anything else gets `LC_ALL=C.UTF-8`.
Do not export `LANG` in the shell or workflow to make a spec pass, and do not add a second launch-env path;
the browser-only env keeps local, cloud and nightly identical. Guarded by `tests/unit/e2e-browser-locale.test.ts`.

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
