/** Types for pod-observation.mjs — see that file for the event → type map. */

export interface PodObservation {
  type: "dev.pr_opened" | "dev.pr_merged" | "dev.pr_closed" | "ci.finished";
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

/** The pod session a PR body names (`Pod session: <id>`), or null. */
export function podSessionFromBody(body: unknown): string | null;

/** The observation for one GitHub event, or null when it is not reported. */
export function observationFromEvent(
  eventName: string,
  payload: unknown,
  options?: { sessionId?: string | null }
): PodObservation | null;

/** POST one observation; the error text, or null when it was recorded. */
export function postObservation(
  podUrl: string,
  key: string,
  observation: PodObservation
): Promise<string | null>;
