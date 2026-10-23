/** Codes retained in persisted history for compatibility, but retired from current UI attention. */
export const RETIRED_DIAGNOSTIC_ISSUE_CODES = [
  'NUMERIC_POLICY_DIFFERENCE',
  'RULESET_POLICY_DIFFERENCE',
] as const;

export type IssueWithCode = { code: string };
export type TierComparisonReview = { needsReview?: boolean | null };

const retiredCodes = new Set<string>(RETIRED_DIAGNOSTIC_ISSUE_CODES);

export function isRetiredDiagnosticIssue(code: string): boolean {
  return retiredCodes.has(code);
}

/** Project immutable raw history into the issue values that should drive today's UI. */
export function projectActionableIssues<T extends IssueWithCode>(
  issues: readonly T[] | null | undefined,
  tierComparisons: readonly TierComparisonReview[] | null | undefined
): { actionableIssues: T[]; actionableHasIssues: boolean } {
  const actionableIssues = (issues ?? []).filter((issue) => !isRetiredDiagnosticIssue(issue.code));
  const needsTierReview = (tierComparisons ?? []).some((comparison) => comparison.needsReview === true);
  return {
    actionableIssues,
    actionableHasIssues: actionableIssues.length > 0 || needsTierReview,
  };
}

/** Historical run counters stay raw in storage/API; the history UI uses this filtered display projection. */
export function projectActionableIssueCounts(issueCounts: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(issueCounts).filter(([code]) => !isRetiredDiagnosticIssue(code)));
}

export function countActionableIssues(issueCounts: Readonly<Record<string, number>>): number {
  return Object.values(projectActionableIssueCounts(issueCounts)).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

const retiredSqlValues = RETIRED_DIAGNOSTIC_ISSUE_CODES
  .map((code) => `'${code.replaceAll("'", "''")}'`)
  .join(', ');

/** SQLite predicate kept in step with projectActionableIssues for filter and page-count behavior. */
export const ACTIONABLE_HAS_ISSUES_SQL = `(
  EXISTS (
    SELECT 1 FROM json_each(sc.issues) actionable_issue
    WHERE json_extract(actionable_issue.value, '$.code') NOT IN (${retiredSqlValues})
  )
  OR EXISTS (
    SELECT 1 FROM json_each(sc.tier_comparisons) actionable_tier
    WHERE json_extract(actionable_tier.value, '$.needsReview') = 1
  )
)`;
