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
