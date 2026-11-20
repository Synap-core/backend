/**
 * The playbook RUN status declaration (`playbook_runs.status`), in a leaf
 * whose one runtime import is the category-set leaf. A run's status moves through
 * THE transition door (`setRunStatus`, @synap/database), which reads each
 * status's category here; the read side (`statusOf`) reads the same map. One
 * declaration, never a second category system.
 */
import type { LifecycleCategory } from "../lifecycle/option.js";
import {
  statusesInCategories,
  type StatusOfCategory,
} from "../lifecycle/category-sets.js";

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

/**
 * The run statuses whose category is one of `categories` — the one way a
 * reader names a set of run statuses (`lifecycle/category-sets.ts`).
 */
export function runStatusesIn<C extends LifecycleCategory>(
  categories: readonly C[]
): StatusOfCategory<typeof RUN_STATUS_DECLARATION, C>[] {
  return statusesInCategories(RUN_STATUS_DECLARATION, categories);
}

/**
 * LIVE run statuses — the ONE answer to "is this playbook/automation run still
 * going?": the `active` and `paused` categories (running, waiting_on_you,
 * stale) EXCEPT `proposed`, a run waiting for its approved start that has not
 * begun. `@synap/database` (`utils/live-run-status.ts`, where the full rule
 * is written down) and the external-agent cancel read this one set.
 */
export type LiveRunStatus = Exclude<
  StatusOfCategory<typeof RUN_STATUS_DECLARATION, "active" | "paused">,
  "proposed"
>;
export const LIVE_RUN_STATUSES: readonly LiveRunStatus[] = runStatusesIn([
  "active",
  "paused",
]).filter((s): s is LiveRunStatus => s !== "proposed");
