/** Types for pod-observation.mjs — see that file for the event → type map. */

export interface PodObservation {
  type:
    | "dev.pr_opened"
    | "dev.pr_merged"
    | "dev.pr_closed"
    | "dev.merge_queued"
    | "ci.started"
    | "ci.finished";
  /** `owner/name#n` for a PR, `owner/name@sha` for a CI run. */
  subjectId: string;
  subjectType: "pull_request" | "ci_run";
  occurredAt?: string;
  /** The dev-loop contract's payload (packages/types/src/events/dev-loop.ts), plus extra fields. */
  data: Record<string, unknown> & {
    repo: string;
    source: string;
    sessionId?: string;
  };
}

export interface RequiredChecks {
  verdict: "green" | "pending" | "red" | "no_ci";
  failing?: string[];
  pending?: string[];
}

/** Copy of REQUIRED_CHECK_NAMES (packages/types/src/events/dev-loop.ts), pinned equal by the tripwire. */
export const REQUIRED_CHECK_NAMES: string[];

/** The only workflow whose runs are "the PR's checks". */
export const CI_WORKFLOW: string;

/** The verdict of a PR head's required checks, from its check runs and mergeable_state. */
export function requiredChecksVerdict(input: {
  checkRuns: Array<{
    id?: number;
    name: string;
    status: string;
    conclusion?: string | null;
  }>;
  mergeableState?: string | null;
}): RequiredChecks;

/** Copy of POD_SESSION_LINE_RE (packages/types/src/events/dev-loop.ts), pinned equal by the tripwire. */
export const POD_SESSION_LINE_RE: RegExp;

/** The pod session a PR body names (`Pod session: <id>`), or null. */
export function podSessionFromBody(body: unknown): string | null;

/** Where a failed run broke: ciFailureSchema (packages/types/src/events/dev-loop.ts). */
export interface CiFailure {
  steps: Array<{ job: string; step?: string; tail?: string }>;
}

/** The observation for one GitHub event, or null when it is not reported. */
export function observationFromEvent(
  eventName: string,
  payload: unknown,
  options?: {
    sessionId?: string | null;
    requiredChecks?: RequiredChecks | null;
    /** The run's PR is a draft (null = unknown). */
    draft?: boolean | null;
    /** Kept only for a failed run that is not a draft's. */
    failure?: CiFailure | null;
  }
): PodObservation | null;

/** All `failure` tails together stay under this many bytes. */
export const FAILURE_TAIL_BYTES: number;

/** Text without ANSI escape sequences. */
export function stripAnsi(text: unknown): string;

/** One log line without ANSI, control, bidi or zero-width characters. */
export function cleanLine(text: unknown): string;

/** A job or step name on one line: invisibles removed, whitespace collapsed, capped. */
export function cleanName(text: unknown): string;

/** Text with token-like strings and this run's secret values replaced by `[redacted]` (best-effort). */
export function redactSecrets(text: unknown): string;

/** The tail of one step's lines in a GitHub job log: stripped, redacted, capped. */
export function stepLogTail(
  log: unknown,
  step: { started_at?: string | null; completed_at?: string | null } | null,
  maxBytes?: number
): string;

/** Per failed job, its first failed step; root steps before cascade ones. */
export function failedSteps(
  jobs:
    | Array<{
        id?: number;
        name?: string;
        conclusion?: string | null;
        steps?: Array<{
          name: string;
          conclusion?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
        }>;
      }>
    | null
    | undefined
): Array<{
  job: { id?: number; name?: string };
  step: { name: string } | null;
}>;

/** The `failure` of a failed CI run read from GitHub, or null (never throws). */
export function runFailureFacts(
  payload: unknown,
  token: string | null | undefined,
  options?: { draft?: boolean | null }
): Promise<CiFailure | null>;

/** POST one observation; the error text, or null when it was recorded. */
export function postObservation(
  podUrl: string,
  key: string,
  observation: PodObservation
): Promise<string | null>;

/** Is this refusal about the key (a grant without event.create, HTTP 401/403), not the observation? */
export function isKeyRefusal(error: string | null | undefined): boolean;
