/**
 * A `ci.finished` payload as the change feed carries it. Pure (no database),
 * so a unit test reaches it. Finding 1bff8284: only CI and devbox gate jobs
 * are "checks"; the producer's required-checks verdict rides along.
 */
import {
  ciRunCountsAsChecks,
  ciVerdictOf,
  devboxJobOf,
  pullRequestUrl,
  requiredChecksSchema,
  type CiFinishedStatus,
  type PullRequestChecks,
  type RequiredChecks,
} from "@synap-core/types";

export type ChecksFinished = {
  repo: string;
  sha: string;
  /** What the run says: `passed` (success) or `failed` (failure, timed out). */
  result: PullRequestChecks;
  status: CiFinishedStatus;
  /** The PR the run was for; null for a devbox job tied to none. */
  pr: { number: number; url: string } | null;
  /** The devbox job (a `devbox <name>` run); null for a CI workflow. */
  job: string | null;
  workflow: string | null;
  /** The run's page, when the producer gave one. */
  url: string | null;
  /**
   * The PR head's required-checks verdict (green | pending | red | no_ci).
   * `result: passed` says one run passed; only `requiredChecks.verdict ===
   * "green"` says the PR is green. null = the producer did not compute it.
   */
  requiredChecks: RequiredChecks | null;
};

/** A `ci.finished` payload as the feed carries it; null when it settles nothing. */
export function checksOf(d: Record<string, unknown>): ChecksFinished | null {
  const status = d.status as CiFinishedStatus;
  const result = ciVerdictOf(status);
  const repo = typeof d.repo === "string" ? d.repo : null;
  const sha = typeof d.sha === "string" ? d.sha : null;
  if (!result || !repo || !sha) return null;
  // Depends-On, the merge bot and the like are not CI: their success is not
  // "checks finished" (finding 1bff8284, #584).
  if (!ciRunCountsAsChecks(d.workflow)) return null;
  const workflow = typeof d.workflow === "string" ? d.workflow : null;
  const required = requiredChecksSchema.safeParse(d.requiredChecks);
  const number = typeof d.pr === "number" ? d.pr : null;
  return {
    repo,
    sha,
    result,
    status,
    pr:
      number === null
        ? null
        : { number, url: pullRequestUrl({ repo, number }) },
    job: devboxJobOf(workflow),
    workflow,
    url: typeof d.url === "string" ? d.url : null,
    requiredChecks: required.success ? required.data : null,
  };
}
