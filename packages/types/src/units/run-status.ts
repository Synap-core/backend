/**
 * The playbook RUN status declaration (`playbook_runs.status`), in a leaf with
 * no runtime imports, like `./track-status.ts`. A run's status moves through
 * THE transition door (`setRunStatus`, @synap/database), which reads each
 * status's category here; the read side (`statusOf`) reads the same map. One
 * declaration, never a second category system.
 */
import type { LifecycleCategory } from "../lifecycle/option.js";

/**
 * Every status a run row can carry, as stored. The DB column
 * (`schema/playbook-runs.ts`) declares this same list and its type is this
 * one, so a status added there and not here stops the build.
 */
export const PLAYBOOK_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "proposed",
  "cancelled",
  "waiting_on_you",
  "stale",
] as const;
export type PlaybookRunStatusValue = (typeof PLAYBOOK_RUN_STATUSES)[number];

/**
 * THE run lifecycle (founder decision D9, 17 Nov 2026): each stored status's
 * fixed CATEGORY. Keyed by every status, so a new one stops the build until
 * it is classified.
 *
 *   paused  proposed (a generate run waiting on the person's decision, or an
 *           agent run waiting for its approved start), waiting_on_you (the
 *           session owes the person), stale (an external agent went quiet).
 *           A move into one records a hold, like any pause: an agent's
 *           capture into it gets the door's `defaultHold`, never a refusal;
 *   active  running;
 *   done    completed;
 *   lost    failed, cancelled.
 */
export const RUN_STATUS_DECLARATION = {
  proposed: { category: "paused" },
  running: { category: "active" },
  waiting_on_you: { category: "paused" },
  stale: { category: "paused" },
  completed: { category: "done" },
  failed: { category: "lost" },
  cancelled: { category: "lost" },
} as const satisfies Record<
  PlaybookRunStatusValue,
  { category: LifecycleCategory }
>;

/** The category of a run status; `null` for a value no status declares. */
export function runStatusCategory(
  status: string | null | undefined
): LifecycleCategory | null {
  if (status == null) return null;
  return Object.hasOwn(RUN_STATUS_DECLARATION, status)
    ? RUN_STATUS_DECLARATION[status as PlaybookRunStatusValue].category
    : null;
}
