# Issues #148 and #159: post-#157 baseline ledger

**Baseline commit:** `606750c9a070027f4ca3a1ee7ae909605cb04a85`
**Baseline branch:** `docs/refactor-148-159-baseline`
**Purpose:** Freeze current v4 behavior before PR-1 through PR-5. This ledger records code behavior at the baseline SHA; it does not change or endorse any runtime behavior.

## Scope and status

The target is the current main snapshot after #157, not the snapshot before #157. A new run with no prior formal run resolves to `erp-tag-v4`. Existing active formal versions, including v1/v2/v3, are retained by the resolver. This branch contains only synthetic characterization tests and this specification ledger.

The approved behavior delta for later implementation is narrow: the two diagnostic-only warnings `NUMERIC_POLICY_DIFFERENCE` and `RULESET_POLICY_DIFFERENCE` may disappear from **new** runs after their comparison calculations are removed. They currently do not change the formal v4 numeric outputs. The current `CONFLICTING_NOTE_SOURCE` warning and all business warnings remain. Historical runs, issue JSON, `has_issues`, `issue_counts`, and issue-code queries remain as stored.

All other in-scope numeric and persisted behavior is expected to remain equal: subject count, base discount, anqin/tutoring days and display values, applicable rates, tier comparisons, and all eight summary columns. The eight summary columns are `englishDays`, `mathDays`, `chineseDays`, `homeworkDays`, `intensiveEnglishDays`, `saturdayTutoringDays`, plus `anqinDays` and `tutoringDays`. The latter two are the formal care-day outputs rather than name-derived extras.

| Observable | Frozen post-#157 baseline | Only approved later change |
|---|---|---|
| Formal v4 numeric fields | Current values from the formal v4 calculation. | Exact value equality for subject count, base discount, care days/display, applicable rates, tier comparisons, and all eight summary columns. |
| New-run issue arrays and `issue_counts` | Can contain both policy-difference warning codes, plus business warnings. | `NUMERIC_POLICY_DIFFERENCE` and `RULESET_POLICY_DIFFERENCE` may be absent; preserve every other warning. Counts adjust only for those removed warnings. |
| New-run `has_issues` | True when a formal issue exists or a tier comparison needs review. | May change only when its only cause was one or both retired policy warnings; preserve business/tier signals. |
| Stored historical runs and issue-code queries | Old rows keep their original issue JSON, aggregate counts and queryable policy codes. | No rewrite, migration, or removal from the known query-code set. |
| Saved comparison snapshot and comparison GET | A newly created run stores `comparison-snapshot-v1`; #161 GET reads and validates saved content. | Remain snapshot based; GET must not recalculate. No additional payload change is approved by PR-0. |

## Semantic inventory and source-to-observable matrix

| Input or setting | Current source and rule | Observable output / storage | Characterization or limit |
|---|---|---|---|
| Raw enrollment token | `web/src/domain/students/token-parser.ts:3-9,31-112` retains raw token, extracts year prefix, base name, first bracket as group flag, remaining modifiers and withdrawal date. Regular-care applicability still uses class-name text at `:14-21`. Known tiers are 3, 3.5, 4, 4.5 and 5; an unknown modifier is unavailable / `needs_review`; a non-care-looking name has no tier. | Parsed token feeds billing, comparisons, diagnostics and run trace. | Synthetic parser assertions cover `[4_5]`, unknown suffix, and a non-care-looking tier token. Keep lexical parsing as a separate concern from future eligibility classification. |
| Alias | `web/src/domain/classification/class-category.ts:116-145`; billing session lookup also resolves alias in `web/src/domain/billing/billing-calculator.ts:108-154`. Alias is applied to parsed base name before settings/schedule lookup. | Resolved base name selects class setting and schedule; original raw token/base name remains available in enrollment and trace. | Synthetic assertion checks raw-name → alias → setting. |
| `classType` | `web/src/domain/classification/class-attributes.ts:69-92`; settings conversion in `web/src/contracts/settings.ts:230-260`. Defaults use explicit saved value, then seed/history fallback. It is class/schedule UI structure (care classes output no sessions), independent of billing category. | Settings draft and schedule/UI capability; effective class attribute snapshot. | Synthetic assertion verifies explicit `care` can coexist with category `none`. |
| `category` and `categorySource` | `web/src/domain/classification/class-category.ts:87-105,116-145`. Manual value wins; explicit `unset` stays unset; saved seed or known seed name provides seed category; otherwise unset. Aliases are resolved before settings lookup. `none` is explicit and distinct from `unset`; both are excluded from v3 subject count. | V4 `calculateSubjectCountV3` and billing category selection (`web/src/domain/billing/billing-calculator.ts:207-222`); run class-category snapshot. | Synthetic assertions cover seed, explicit unset, unset for unrecognized name, alias/manual category, and zero count for none/unset. No keyword category inference is part of this path. |
| `fixedFiveDays` | Explicit boolean, defaults false: `web/src/domain/classification/class-attributes.ts:70-92`; class enrollment resolution at `web/src/domain/classification/class-category.ts:108-145`. V4 uses it as the care-day floor input (`web/src/domain/billing/billing-calculator.ts:463-487`); v4 capability also decouples it from course discount overwrite (`web/src/domain/billing/discount-rules.ts:176-206`). | Anqin/tutoring days; applicable rate. V4 can have a five-day floor and retain the category-derived rate. | Synthetic row SYNTH_02 locks the five-day floor with 9500 bps tutoring rate. |
| `skipDeduction` | It is per session, not a class setting, per `web/src/contracts/settings.ts:69-80,190-200`; session mapping and filtering in `web/src/domain/billing/billing-calculator.ts:26-48,108-155,157-189`. A skipped session is omitted from overlap deduction. | The associated session does not reduce care days; settings snapshot records its flag. | Synthetic row SYNTH_01 includes a skipped 120-minute English session and locks the resulting care-day output. |
| `subject` | UI/edit metadata is initially derived from class-name tokens by `deriveSubject` in `web/src/domain/schedules/seed-manifest.ts:61-79` and settings conversion at `web/src/contracts/settings.ts:230-234`. It is not the v4 billing `category`. Student query `subject` currently filters enrollment `base_name` or `raw_token` text (`web/src/application/student-query-predicates.ts:82-85`). | Display/edit metadata and raw-name substring query. | Record the separation: a derived/display subject is not an independent billing classification or a query against the category field. |
| Eight summary columns | `web/src/application/calculate-run.ts:235-286`. Care days come from formal calculation. English/math/chinese/homework/intensive-English/Saturday fields still use name-token tests; English/math additionally use the selected candidate's seed session count or fallback 2. | Persisted `student_calculations` columns (`web/src/adapters/sqlite/runs-repository.ts:157-199`) and active-run UI. | Synthetic row SYNTH_01 locks all eight values. SYNTH_03 explicitly documents current limitation: a custom-named class with category `math` can bill as math while `mathDays` remains null because the summary projection still gates on `國小數學` in the name. This is not changed in PR-0. |
| Tier comparison | Lexical parse from token parser; computed tier uses grade-specific formal care days in `web/src/domain/billing/billing-calculator.ts:513-530`, then issue detection/comparison. | `tier_mismatch`, `tier_comparisons`, mismatch/review flags and query facets. | Synthetic parser fixtures cover syntax/applicability. They do not assert the complete mismatch policy for every grade or alias case. |
| Rule selection and dual calculations | `web/src/application/rule-set-resolver.ts:21-40`: retain active formal v1/v2/v3/v4; otherwise use target v4. `web/src/application/calculate-run.ts:178-232`: every new run computes formal and compat; v4 also computes shadow v2 to classify old policy warnings. | Formal result is persisted; diagnostics compare formal and compat; prechange formal issues include numeric/ruleset warnings where applicable. | Synthetic assertions lock current warning codes/counts and numeric results. No baseline claim is made for old active DB distributions. |
| Persisted new-run paths | `web/src/application/activate-import.ts:92-128` and `web/src/application/apply-settings.ts:180-192` call `executeCalculationRun` and `saveCalculationRun`. The latter writes run/results/category snapshot/diagnostic payload in one transaction (`web/src/adapters/sqlite/runs-repository.ts:135-252`). | Run row, student columns, issue JSON, `has_issues`, category snapshot, diagnostic snapshot. | PR-0 tests the pure application run against an in-memory SQLite database and saves the synthetic run. It does not execute production activation or settings APIs. |
| Historical issue visibility | `web/src/contracts/student-query.ts:21-25,70-72` retains both policy codes in `KNOWN_ISSUE_CODES`; query predicates inspect stored `issues` and `has_issues` (`web/src/application/student-query-predicates.ts:44-46,86-99`). | Old runs remain queryable by original issue code; raw issue data is independent of future display projection. | Preserve historical issue-code query compatibility. The later allowed warning removal applies to new run creation only. |
| Comparison GET after #161 | Route `web/src/app/api/v1/runs/[runId]/comparison/route.ts:8-10,32-60` calls `readRunDiagnostics`; repository `web/src/adapters/sqlite/run-diagnostics-repository.ts:22-140` is SELECT-only and validates the persisted version, hashes, formal projection, and sorted differences. | Returns saved `comparison-snapshot-v1` data or unavailable/corrupted status; does not recalculate. | PR-0 persists and reads a synthetic snapshot. Existing `web/tests/integration/issue-161-diagnostics-versioning.test.ts:226-227` explicitly fails if comparison GET calls `calculateStudentBilling`. |

## Synthetic baseline matrix

The test `web/tests/unit/issue-148-159-baseline.test.ts` creates a fresh `better-sqlite3` `:memory:` database, runs migrations, stores five wholly synthetic students, and calculates a new v4 run. Identifiers and names use the `SYNTH_` prefix or invented class names. No imported roster or local database is read.

| Fixture | Purpose | Frozen baseline observation |
|---|---|---|
| `SYNTH_01` | Seven independently seeded/name-token summary classes, category count, and one skipped 120-minute session | `subjectCount=3`, `baseDiscountBps=9000`, `anqinDays=null`, `tutoringDays=4.5`, `englishDays=2`, `mathDays=2`, `chineseDays=1`, `homeworkDays=5`, `intensiveEnglishDays=2`, `saturdayTutoringDays=1`, `applicableTutoringBps=9000`. |
| `SYNTH_02` | Category-based math plus explicitly fixed-five-day care class | `subjectCount=2`, `baseDiscountBps=9500`, `tutoringDays=5`, `applicableTutoringBps=9500` under v4. |
| `SYNTH_03` | Nonstandard math name with explicit math category | Billing count/rate reflect category; current `mathDays=null` summary limitation remains; baseline includes `RULESET_POLICY_DIFFERENCE`. |
| `SYNTH_04` | 45-minute math overlap at the D24 0.3 boundary | V4 `tutoringDays=5`; baseline includes `NUMERIC_POLICY_DIFFERENCE` against compat. |
| `SYNTH_05` | Empty enrollment and synthetic note/tag source conflict | `CONFLICTING_NOTE_SOURCE` is retained. |

Aggregated synthetic run issue counts are `RULESET_POLICY_DIFFERENCE: 2`, `NUMERIC_POLICY_DIFFERENCE: 1`, and `CONFLICTING_NOTE_SOURCE: 1`. The two policy counts are the prechange characterization that later work may retire from newly created runs; the business warning is not on that allowlist.

The test saves the run and verifies `readRunDiagnostics` returns `supported` for its persisted `comparison-snapshot-v1` payload. This checks the application reader on stored content. It does not independently exercise the HTTP route; the existing #161 integration guard is the route-level no-recalculation evidence.

## RED and mutation sensitivity

The D24 fixture is designed to detect a threshold mutation. Its single synthetic 45-minute overlap is `45 / 180 = 0.25` days. Baseline `zeroBelow = 0.3` yields no deduction and `tutoringDays=5`. Temporarily changing the D24 `zeroBelow` default to `0.2` makes the same fraction deduct 0.5 day and violates the golden. The mutation is an experiment only; production source is restored before commit.

Captured experiment result for this branch:

- Baseline targeted test: **PASS** (2 tests).
- Mutation: `web/src/domain/schedules/overlap-calculator.ts`, default `zeroBelow` changed from `0.3` to `0.2` for one test run.
- Observed RED: the targeted test failed at the `SYNTH_04` assertion. Actual `tutoringDays` was 4.5 (expected 5), and the mutation also removed the expected `NUMERIC_POLICY_DIFFERENCE`.
- The production source was restored byte-for-byte; baseline and #161 tests reran green afterward.

This demonstrates sensitivity to a material D24 calculation change. It is not proof of coverage for every rule, class-name alias, historical run, UI rendering, API boundary, or imported workbook.

## Evidence and limitations

- Baseline code inventory was read at `606750c9a070027f4ca3a1ee7ae909605cb04a85`; source paths above are relative to `web/`.
- Verification command: from `web/`, `npm test -- tests/unit/issue-148-159-baseline.test.ts tests/integration/issue-161-diagnostics-versioning.test.ts` → 2 files and 7 tests passed. The #161 suite also emits a synthetic timing line; no performance conclusion is drawn from it.
- Current v4 formal output, current diagnostic warning composition, category/setting semantics, summary projection, and #161 persisted reader are characterized with synthetic fixtures and existing tests.
- Real local 477-row sample comparison remains **UNVERIFIED** in this PR. It is separate private-data work and must not be used as a test fixture or copied into source/docs. `data/app.sqlite` was not accessed.
- No performance conclusions are drawn. The current code visibly computes formal plus compat for each new-run student and adds a shadow-v2 calculation for v4; this is an inventory only, with no timing claim.
- Existing active formal v1/v2/v3 inheritance is documented from resolver behavior, not exercised in the new synthetic run.
- This ledger does not implement PR-1 through PR-5 or claim all semantics are free of existing name gates. The name-gated `mathDays` limitation above is deliberately preserved as baseline evidence.

## PR-1 implementation result: diagnostics retirement and historical UI projection

**Branch:** `refactor/159-retire-diagnostics`

**Worktree:** `/tmp/issue159-pr1`

**Base:** `db781305c49f8bc39ea859a7b470278247d4988a` (latest main when PR-1 worktree was created).
**Scope:** new runs no longer invoke compat or shadow-v2 and do not write diagnostic snapshots; comparison link/route is removed (GET 404); old schema/rows and raw issue fields/query behavior remain. A centralized actionable projection removes only `NUMERIC_POLICY_DIFFERENCE` and `RULESET_POLICY_DIFFERENCE` from UI issue badges/lists/facets/filters and history/page counts. Business issues and tier `needsReview` remain actionable. This is not the PR-2 single-v4 change.

The D1 run golden added for this PR contains only synthetic student/class fixtures and per-student SHA-256 digests; it contains no names, person codes, source workbook content, or local database rows. Its source is exact immutable PR-0 base `606750c9a070027f4ca3a1ee7ae909605cb04a85`. Normalization removes only the two retired issue entries/counts and recalculates the expected derived `hasIssues` from remaining actionable issues or tier `needsReview`; numeric/display/summary/tier/trace outputs and per-student digests remain compared. Existing direct-calculator goldens are unchanged.

### RED evidence

- Before removing extra calculations, `npx vitest run tests/unit/issue-148-159-baseline.test.ts` expected 5 formal calls for 5 synthetic students but observed 15 calls (formal + compat + shadow-v2). The zero-compat/zero-shadow assertion was RED on the PR-0 runtime and passed after PR-1.
- Before adding the historical actionable projection, `npx vitest run tests/integration/issue-159-actionable-history.test.ts` found no `actionableIssues` projection for the synthetic retired-only history row; the regression was RED, then passed with the centralized projection. Mixed business warning and tier-review rows are also covered.
- No mutation was made to production behavior to fabricate either failure. The separate PR-0 D24 mutation evidence above remains unchanged.

### Verification

- From `web/`: `npm run typecheck` → passed (`tsc --noEmit`).
- From `web/`: `npx vitest run tests/unit/issue-148-159-baseline.test.ts tests/integration/issue-159-actionable-history.test.ts tests/unit/issue-159-actionable-ui.test.ts tests/integration/issue-159-comparison-404.test.ts tests/integration/history-view.test.ts tests/integration/issue-161-diagnostics-atomicity.test.ts tests/integration/issue-161-diagnostics-audit.test.ts tests/integration/api-runs.test.ts tests/integration/d1-run-snapshot-readers.test.ts tests/unit/d1-invariance.test.ts tests/unit/d2a-diagnostics-decomposition.test.ts` → 11 files, 46 tests passed. This includes an actual Next.js request to the removed route, which returned 404, plus separate unavailable-new-run and manually inserted synthetic historical-snapshot audit cases.
- `git diff --check` → passed.
- Real local roster comparison remains separate and unverified by CI. `data/app.sqlite` was not accessed; no private source data was used.

## PR-2 implementation result: single-v4 runtime and explicit legacy upgrade

**Branch:** `refactor/159-v4-only-runtime`

**Worktree:** `/tmp/issue159-pr2`

**Base:** `99de0e7f23c57d3129bcf9c93d69db5f7069d078` (PR-1 #166 squash merge on main)
**Decision:** D57, Issue #159 PR-2. This records only v4 runtime convergence and explicit upgrade/read-model behavior; it does not implement PR-3/#148.

All paths that create a new calculation now target `erp-tag-v4`: activate/apply and direct application calls, settings preview `after`, schedule calculation preview, roster-diff before/after calculations, and the shared `executeCalculationRun` boundary. Ordinary writes against any non-v4 active run (v1/v2/v3, compat, or unknown) fail closed; an explicit v4 preview and confirmed apply authorizes upgrade. The settings UI exposes this action for all non-v4 active versions. Upgrade `before` is projected from persisted `student_calculations`; fields that were not persisted remain unavailable. Confirmed apply retains TTL, revision CAS, idempotency replay, and transaction rollback. No existing run is recalculated, backfilled, or rewritten.

Old calculator implementations and the compat float kernel were removed after synthetic persisted-v2 upgrade, idempotency, rollback, restore, and history-reader coverage was in place. History consumers use explicit read-only `historicalRuleSetMetadata`; unknown metadata is unavailable. Known v1/v2 legacy rate/name mapping, compat saved-run fixed-five-day projection, v3/v4 category snapshots, and saved schedule snapshots remain historical read paths. Legacy version strings still present in source describe persisted IDs, idempotency compatibility, raw issue/schema contracts, or read-only history; they do not select a calculator.

### Golden provenance

`web/tests/fixtures/d1-v4-current-golden.json` contains synthetic fixtures and per-student digests only; it contains no names, person codes, workbook content, or local DB rows. Its source is the exact PR-1 base above, generated in detached worktree `/tmp/issue159-pr2-base`. Only `tests/helpers/d1-invariance-snapshot.ts` was adapted to compute the v4 path in that detached worktree; application/runtime code remained at the exact base. The recorded generation command is:

```sh
cd web && npx tsx tests/helpers/generate-d1-invariance-golden.ts tests/fixtures/d1-v4-current-golden.json
```

The generator refuses to overwrite the historical legacy golden and refuses generation unless `HEAD` is the exact PR-1 base SHA. Each per-student digest keeps every current numeric, display, summary, tier, and trace field. Run-output normalization removes only `NUMERIC_POLICY_DIFFERENCE`, `RULESET_POLICY_DIFFERENCE`, their issue-count entries, and the derived `hasIssues` change; direct-calculator golden output remains fully fixed. This preserves the PR-0/PR-1 mutation-sensitive current-output characterization while retiring only the two approved diagnostics.

### RED evidence

- Before adding the direct active-version check, the PR-2 regression executed `executeCalculationRun` with `ruleSetVersion: 'erp-tag-v4'` against an active persisted v2 run and unexpectedly created a run. This was RED because caller-supplied v4 bypassed the ordinary old-active guard; the shared direct-application boundary now rejects it unless settings apply carries a valid stored v4 preview authorization.
- Before requiring a finite future preview expiry, a synthetic legacy-upgrade preview with missing/unparseable `expires_at` was accepted (`Date.parse` yielded `NaN`, for which a simple `now > expiresAt` check is false). The regression was RED; the authorization now requires a finite timestamp greater than `Date.now()`.
- Before persisted-before projection, legacy-only retired warning rows could affect preview `issueDelta` through raw `has_issues`. The synthetic regression was RED; preview now uses the same actionable issue projection as the UI and does not recalculate history.
- Historical metadata regression tests exposed a changed fixed-five-day saved-run projection for v1/v2/compat; exact-base behavior was restored and tested, with no change to new v4 calculations.
- The first final full-suite attempt found four D1 digest failures for one synthetic student (index 203) in direct and run output across seed/saved contexts. Exact-base tuple comparison isolated the only changed field as the `CONFLICTING_NOTE_SOURCE.message` string; numeric, display, summary, tier, schedule, and trace fields matched. That generic text change was outside the approved output allowlist, so the exact-base message was restored and no golden was regenerated. The focused D1/#112 regression then passed.
- A subsequent full-suite attempt ran out of `/tmp` space while the acceptance-gate tests copied synthetic worktrees (`ENOSPC`); after checking there were no active/open-file consumers, only generated `/tmp/sb130-*` and old full-E2E temp output trees were removed. The acceptance-only batch passed, then the final clean full suite passed.

### Static call-site inventory

Command from repository root: `rg -n "calculateStudentBilling\\(" web/src --glob '!**/domain/billing/billing-calculator.ts'`.

- `application/calculate-run.ts:204` is the shared calculator invocation; its version is constrained to target v4 and old active state is guarded. `activate-import.ts` and `apply-settings.ts` both reach this boundary.
- `application/settings-preview.ts:279` calculates only the `after` result using `resolveTargetRuleSetVersion`; `before` comes from stored run rows.
- `application/roster-changes.ts:567,569` computes before/after using the supplied context; absent context defaults to target v4. Its current app caller `application/import-roster-diff.ts:61` resolves target v4.
- The other current `calculateClassDeductionD24` call sites are `application/schedule-preview.ts:364` (current preview resolves v4) and `application/roster-changes.ts:236-237` (the v4 roster calculation path); `domain/billing/billing-calculator.ts` is the shared v4 calculator implementation. `schedule-deductions.ts` reads stored schedule snapshots and uses known historical metadata for read-only reconstruction; unknown saved versions fail closed.
- `application/applicable-rate.ts`, `query-student-options.ts`, `student-query-predicates.ts`, and `adapters/sqlite/runs-repository.ts` use `historicalRuleSetMetadata` only for saved run read models. `schedule-preview.ts` uses it to validate known metadata; active calculate previews resolve v4.
- `rg -n "calculateClassDeductionCompat|calculateSubjectCount|isCompat|ruleSetCapabilities|homeworkDiscountDecoupled|compatKernel" web/src` returns no matches. The removed legacy calculation selectors are absent from product source.

### Verification

Final verification from `web/` (final full suite ran after restoring the one out-of-scope warning-string change; the later ActivateOptions change was type-only and separately typechecked):

- `npm test -- --run --maxWorkers=1` → **155 files: 154 passed, 1 skipped; 1460 tests: 1459 passed, 1 skipped** (241.83 seconds). The sole skip is existing `tests/integration/schedule-seed-reader.test.ts` skip; no test failures.
- `npm test -- --run tests/unit/d1-invariance.test.ts tests/unit/issue-112-v3-invariance.test.ts tests/unit/issue-112-ruleset-v4-decoupling.test.ts` → 3 files / 21 tests passed after restoring the exact-base issue message.
- Acceptance recovery check: `npm test -- --run tests/unit/acceptance-gate.test.ts tests/integration/acceptance-env.test.ts tests/integration/acceptance-env-default-source.test.ts` → 3 files / 14 tests passed.
- Final targeted upgrade check after `ActivateOptions` excludes the apply-only `upgradePreviewId`: `npm test -- --run tests/integration/activate-run.test.ts tests/integration/d2d-upgrade-preview-versions.test.ts tests/integration/d1-legacy-apply-receipts.test.ts tests/unit/issue-159-v4-only-runtime.test.ts` → 4 files / 44 tests passed.
- `npm run typecheck` → passed after the final TypeScript contract change (`tsc --noEmit`). `npm run lint` → passed (`eslint .`). `npm run build` → passed on Next.js 16.3.6, all 13 static pages generated; build preceded only the final type-only `ActivateOptions` omit adjustment.
- `npm run test:e2e:isolated -- --seed-v2-active tests/e2e/d2d-upgrade-restore.spec.ts` → 3 passed; `npm run test:e2e:isolated -- --seed-v2-active tests/e2e/d2d-upgrade-journey.spec.ts` → 2 passed. Both started from the fixed synthetic persisted-v2 row and completed; the first command is restore, the second is upgrade journey.
- Next.js 16 route handler guidance was read at `web/node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` before route work.
- Final `git diff --check` → passed after the last documentation and type contract edits. Static scan command `rg -n "calculateStudentBilling\\(" web/src --glob '!**/domain/billing/billing-calculator.ts'` found only the four sites listed above. `rg -n "calculateClassDeductionCompat|calculateSubjectCount\\(|calculateSubjectCountV3|isCompat|ruleSetCapabilities|homeworkDiscountDecoupled|compatKernel" web/src` returned no matches. A manual current-contract scan found no remaining active PR-2 statement that new runs call a legacy calculator; older D1/#112/#161 text is explicitly marked historical/superseded. E2E worktrees and full-suite `sb130` test copies were checked for consumers and removed after their processes ended; `/tmp` returned to 3.6 GB free. No private-data comparison or performance claim is made. `data/app.sqlite` was not accessed; synthetic old-run records contain no personal information.

Specs `02`, `03`, `04`, `06` (append-only D57), `07`, `09`, `14`, and `CLAUDE.md` carry the current v4-only contract. `specs/14` §3.11 now states that `care-days.ts` was flattened to the v4-only path while preserving the v4 formula and #147 extra-deduction order; this clarifies implementation without a rule change.

The `CONFLICTING_NOTE_SOURCE` message for the note/tag conflict remains byte-for-byte at the PR-1 baseline (`正式軌 erp-tag-v1` wording) because changing user-visible issue text was outside this PR’s approved output allowlist; the exact-base golden exposed and prevented that incidental copy change. This existing copy was not validated against private data.

## PR-3 implementation result: bounded class semantics data and snapshots

**Branch:** `refactor/148-semantic-schema`

**Worktree:** `/tmp/issue148-pr3`

**Base:** `14c7856ff0885ff5b150c54e888204eda899e1de` (merged PR-2 on main)
**Scope:** Issue #148 PR-3 / D58 only. This adds bounded class-type definitions, per-class semantic settings, workbook roundtrip metadata, and immutable run snapshots. It does not change billing, report, tier, token, or summary-field consumers and does not alter v4 numeric outputs.

The registry uses the exact fields `id`, `label`, `scheduleMode`, `supportedAttributeKeys`, and `summaryRoleOptions`. The supported fields remain bounded to subject, category, fixed-five-day, per-session skip-deduction, the eight existing summary roles, and ERP tier applicability. Schema validation rejects `skipDeduction` on `care_window` types and `fixedFiveDays:true` on `timetable` types because the existing UI has no corresponding editable control in those layouts; `fixedFiveDays:false` is a neutral default and may be preserved. Old settings without a registry are read through a compatibility path that preserves existing flags without writing or clearing them. New classes require an explicit type and leave absent semantics unset; only the 49 fixed seed classes have an explicit synthetic semantic map. No non-seed class semantics were inferred or backfilled.

Settings UI exposes the declared editable fields and reports unsupported saved values with an effect. Users can clear them explicitly, or change type after a confirmation that names incompatible values. The clear action updates semantic draft values, category/fixed-day attribute state, and per-row skip-deduction state together so a hidden value cannot keep the draft unsavable. If a still-supported `summaryDayRoles` value is removed from a type's `summaryRoleOptions`, the UI reports that role as unsupported and the clear action removes only obsolete roles while retaining valid roles. XLSX hidden metadata preserves registry and semantic values without adding a ninth summary field. On rename, semantic subject, roles, tier applicability, and type definition values (including seed-sourced values) follow the renamed class; category keeps #157's existing target-name seed behavior. Merge/delete lifecycle checks and roundtrip coverage are included.

Migration `0009_run_class_semantics.sql` adds run-level snapshot presence/schema metadata and per-class semantic rows without changing old `run_class_categories` rows. New v4 saves must pass `classSemantics`; `[]` records a valid empty snapshot and `undefined` is rejected. Readers validate schema version, definition JSON/hash, referenced type ID, and semantic field values. A markerless run with orphan semantic rows is corruption. Snapshot writes share one transaction with run/result/category writes; the injected semantic-row failure regression verifies full rollback. Historic rows without markers remain unavailable (`undefined`) and are not reconstructed.

### Validation and review rework

- The first single review of `e7c2f74f84bfa9f9a703ba7f7f541e542f42af7f` was **REJECTED**. The reviewer reproduced: (1) legacy non-care settings with `fixedFiveDays:false` failed during read/calculation hydration; (2) XLSX roundtrip yielded a draft rejected by the new schema; and (3) renaming a seed class to a new name cleared its subject, summary roles, and tier applicability. No source changes were made in the review worktree.
- Rework keeps old settings without `classTypeDefinitions` on a read compatibility path and preserves their stored flags. For explicit new drafts, `fixedFiveDays:false` remains a neutral default while unsupported `true` remains invalid. UI warnings now treat only `true` as an unsupported fixed-day setting. Rename carries seed-sourced concrete subject/summary/tier values with the class; category remains on #157's established target-name behavior. Added independent regressions for all three findings and an XLSX-to-settings validation path.
- The second single review of `7f6c1fe3811215d93d848fb93eec0804853131f7` was **REJECTED** for a repeated normalization path: the server hydrates an old non-care setting with `fixedFiveDays:true`, then the editor normalizes it again and rejects it before the user can clear it. The reviewer reproduced this through actual static rendering of `SettingsEditor` and independently ran 20 files / 210 tests plus typecheck/lint.
- Rework adds `SettingsDraftReadSchema` for repeatable, read-only hydration while retaining unsupported values for the clear action; `SettingsDraftSchema` remains strict for writes. Settings preview revalidates the normalized draft so a legacy-format request cannot persist a new invalid registry. Added a regression for repeated normalization/rendering and a preview rejection test for unsupported legacy true. The prior XLSX and seed rename fixes remain covered.
- The latest focused command ran in `web/`: `npm test -- --run tests/unit/d3-class-semantics-contract.test.ts tests/unit/schedule-table-io.test.ts tests/integration/schedule-table-route.test.ts tests/integration/d3-class-semantics-snapshot.test.ts tests/integration/settings-preview-apply.test.ts tests/integration/d2d-class-lifecycle-persistence.test.ts tests/integration/d2a-run-class-categories-persistence.test.ts tests/unit/settings-schedule-grid-integrated.test.ts tests/unit/settings-schedule-grid-ui.test.ts tests/unit/d2d-merge-into-existing.test.ts tests/unit/d2c-snapshot-write-point.test.ts tests/integration/d2b-r2-affected-and-alias.test.ts tests/integration/issue-157-run-class-categories-unset.test.ts tests/integration/issue-140-not-configured-reachability.test.ts tests/integration/d1-legacy-apply-receipts.test.ts tests/integration/preview-roster-changes-class-structure.test.ts tests/unit/issue-148-159-baseline.test.ts` → **17 files / 190 tests passed**.
- `npm run typecheck` → passed after adding the read-only schema and preview revalidation. `npm run lint` → passed. `git diff --check` → passed.
- The reviewer reported an unrelated full-suite `acceptance-env.test.ts` production-build child killed with exit 137 during page-data collection; no full-suite/build/E2E success is claimed. The same reviewer is to review the corrected exact HEAD.
- Tests cover clear-action visibility and pure projection (including clearing one removed summary role while retaining a valid role), type/layout compatibility rejection, settings and Excel metadata roundtrip, lifecycle behavior, empty and immutable snapshots, corrupt metadata/orphans, and atomic rollback. `data/app.sqlite` and its sidecars were not accessed; fixtures contain synthetic data only.

## PR-4 implementation result: Run semantic consumers

**Branch:** `refactor/148-consumers`
**Worktree:** `/tmp/issue148-pr4`
**Base/HEAD before PR-4:** `22138a0725b2c6d2d884388895950d3995fd5530` (PR-3 branch HEAD; PR-4 is rebased onto current `origin/main` before publication).
**Decision:** D59, Issue #148 PR-4. The operator-approved migration path presents a PII-free, per-field recommendation table before creating the new settings draft.

V4 billing/report, tier, summary, query, roster-change, issue classification, and side-script consumers now read the Run's immutable semantic snapshot. Token parsing remains lexical; tier applicability is projected from the alias-resolved run semantic row. Category rate selection uses the selected Run's class category snapshot. Only explicit known formal v1–v3 history uses the frozen historical projection; omitted/unknown Run context, compat, missing/inconsistent expected snapshots, or v3/v4 snapshot metadata without a resolver fail closed. Summary projection maps declared roles and conditions only to the existing eight columns. `SettingsEditor` includes `summaryDayRoleConditions` in its workbook semantic export mapping; the XLSX roundtrip test verifies a Saturday condition survives hidden-sheet export/import and the imported settings still validate. The explicit operator-approved `legacy_migration` writes a new settings version; it does not alter old Runs. No formula or v4 numeric output change is authorized.

### RED and GREEN evidence

- Before the consumer rewiring, the four side-script/API focused tests were **RED: 21 failures / 117 tests**, covering syntax-only tier parsing without a semantic projection, missing v4 semantic context, and the session-report's name-based fallback. The same tests passed after the shared Run snapshot projection was wired.
- A new RED regression removed the v4 semantic marker and rows, then applied a subject filter. Before the fix, SQL matched a student from the current enrollment name despite the missing historical snapshot; after the fix, the query is unavailable/empty rather than reconstructed from current text. The classes API likewise reports an unset subject if the v4 semantic snapshot is absent.
- The migration UI now displays a read-only, per-field recommendation table with anonymous labels before the explicit action. A pure projection test verifies the table model contains no class name; a server-rendered UI test verifies the table is visible and its rows omit that name.
- Final focused command from `web/`: `npm test -- --run --maxWorkers=1 tests/unit/issue-140-roster-api-contract.test.ts tests/unit/issue-122-compare-tools-snapshot.test.ts tests/unit/compare-billing-report-parse.test.ts tests/unit/compare-session-pricing-report.test.ts tests/unit/issue-148-consumer-semantics.test.ts tests/unit/issue-148-legacy-semantic-migration.test.ts tests/unit/d3-class-semantics-contract.test.ts tests/unit/schedule-table-io.test.ts tests/integration/issue-148-import-tier-preview.test.ts tests/integration/d3-class-semantics-snapshot.test.ts tests/unit/applicable-rate-priority.test.ts tests/unit/summary-table-columns.test.ts tests/unit/summary-table-wiring.test.ts tests/unit/query-student-options-v4.test.ts tests/integration/d1-run-snapshot-readers.test.ts tests/unit/settings-editor-upgrade-v4.test.ts` → **16 files / 226 tests passed**.
- `npm run typecheck` → passed (`tsc --noEmit`). `npm run lint` → passed (`eslint .`). `git diff --check` → passed.
- Static scan found the frozen class-name heuristics only in `historicalRateCategoryOfClass` and `legacy-class-semantics.ts`; callers are limited to explicit historical read paths or the approved migration preview/action. This is not a substitute for code review of those boundaries.

### Data and verification limits

- All added test records and class names are synthetic. The local database was not opened or queried.
- **477-student full-run parity is UNVERIFIED.** Only the import snapshot is available in the current evidence; no corresponding current settings snapshot or saved Run was provided. No private student rows, class labels, or workbook contents are recorded here.
- This handoff does not claim a full Vitest run, production build, or E2E run for PR-4. Those gates remain for review/CI; the canonical full E2E remains for final #148/#159 closeout. The existing PR-3 suite evidence above is separate and not represented as PR-4 verification.
