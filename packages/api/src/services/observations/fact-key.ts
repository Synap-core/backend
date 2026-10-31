/**
 * The ONE dedupe key of an observed fact (pipeline-health plan 12d8dab9 W1,
 * findings a32021b9, 66e1e526).
 *
 * The same dev-loop fact reaches the pod from several producers — the org
 * webhook's automation (`source: github-webhook`), the backend workflow
 * (`github-actions`), the devbox gap-filler — and from one producer twice (a
 * redelivery, a re-run job). Without a key each copy is a new event, and the
 * bridge (which dedupes by event id) wakes the session once per copy. The key
 * names the fact in the WORLD, from fields every producer reads off GitHub the
 * same way, never from who sent it or when the pod heard it:
 *
 *   dev.pr_merged  repo#n                       a PR merges once
 *   dev.pr_opened  repo#n @ occurredAt          opened (created_at) and each
 *   dev.pr_closed  repo#n @ occurredAt            reopen / close (updated_at,
 *                                                 closed_at) is its own fact
 *   dev.merge_queued repo#n @ occurredAt        each entry into the queue
 *   ci.finished    repo@sha · run · status      run = the run url, else the
 *                                                 workflow name
 *   ci.started     repo@sha · run @ occurredAt  a re-run attempt of one run
 *                                                 (same url) starts again
 *
 * `null` = no key: the fact is recorded as it comes (a snapshot, where the
 * newest wins; `dev.deployed`, where the same sha deployed again after a
 * rollback is a new fact; every free-form type).
 *
 * What it cannot see, stated: a producer that omits `occurredAt` (or the run
 * url) keys the fact differently from one that sends it, so those two copies
 * are both recorded. Every producer named above sends both.
 */
import { DEV_LOOP_EVENT_TYPES } from "@synap-core/types";

export function observationFactKey(
  type: string,
  data: Record<string, unknown>,
  occurredAt?: Date
): string | null {
  const repo = typeof data.repo === "string" ? data.repo.toLowerCase() : null;
  if (!repo) return null;
  switch (type) {
    case DEV_LOOP_EVENT_TYPES.prMerged:
    case DEV_LOOP_EVENT_TYPES.prOpened:
    case DEV_LOOP_EVENT_TYPES.prClosed:
    case DEV_LOOP_EVENT_TYPES.mergeQueued: {
      const number = Number(data.number);
      if (!Number.isSafeInteger(number) || number <= 0) return null;
      const pr = `${type}:${repo}#${number}`;
      if (type === DEV_LOOP_EVENT_TYPES.prMerged) return pr;
      return occurredAt ? `${pr}@${occurredAt.toISOString()}` : pr;
    }
    case DEV_LOOP_EVENT_TYPES.ciFinished:
    case DEV_LOOP_EVENT_TYPES.ciStarted: {
      const sha = typeof data.sha === "string" ? data.sha.toLowerCase() : null;
      if (!sha) return null;
      const run =
        typeof data.url === "string" && data.url
          ? data.url
          : typeof data.workflow === "string"
            ? data.workflow
            : "";
      if (type === DEV_LOOP_EVENT_TYPES.ciStarted) {
        const start = `${type}:${repo}@${sha}:${run}`;
        return occurredAt ? `${start}@${occurredAt.toISOString()}` : start;
      }
      const status = typeof data.status === "string" ? data.status : null;
      if (!status) return null;
      return `${type}:${repo}@${sha}:${run}:${status}`;
    }
    default:
      return null;
  }
}
