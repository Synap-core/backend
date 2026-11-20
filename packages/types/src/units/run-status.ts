/**
 * The playbook RUN status declaration (`playbook_runs.status`), in a leaf
 * whose one runtime import is the category-set leaf. A run's status moves through
 * THE transition door (`setRunStatus`, @synap/database), which reads each
 * status's category here; the read side (`statusOf`) reads the same map. One
 * declaration, never a second category system.
 */
import type { LifecycleCategory } from "../lifecycle/option.js";
import {
  categoryOf,
  statusesInCategories,
  type StatusOfCategory,
} from "../lifecycle/category-sets.js";

/**
 * Every status a run row can carry, as stored. The DB column
 * (`schema/playbook-runs.ts`) declares this same list and its type is this
 * one, so a status added there and not here stops the build.
 */
export const PLAYBOOK_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "proposed",
  "cancelled",
  "waiting_on_you",
  "stale",
  "blocked",
] as const;
export type PlaybookRunStatusValue = (typeof PLAYBOOK_RUN_STATUSES)[number];

/**
 * THE run lifecycle (founder decision D9, 17 Nov 2026): each stored status's
 * fixed CATEGORY. Keyed by every status, so a new one stops the build until
 * it is classified.
 *
 *   open    queued (born, handed to its holder, not claimed yet);
 *   paused  proposed (a generate run waiting on the person's decision, or an
 *           agent run waiting for its approved start), waiting_on_you (the
 *           session owes the person), stale (an external agent went quiet),
 *           blocked (nobody claimed it inside its window).
 *           A move into one records a hold, like any pause: an agent's
 *           capture into it gets the door's `defaultHold`, never a refusal;
 *   active  running (its holder claimed it);
 *   done    completed;
 *   lost    failed, cancelled.
 */
export const RUN_STATUS_DECLARATION = {
  queued: { category: "open" },
  proposed: { category: "paused" },
  running: { category: "active" },
  waiting_on_you: { category: "paused" },
  stale: { category: "paused" },
  blocked: { category: "paused" },
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
  return categoryOf(RUN_STATUS_DECLARATION, status);
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
 * going?": the `open`, `active` and `paused` categories EXCEPT `proposed`, a
 * run waiting for its approved start that has not begun. `@synap/database` (`utils/live-run-status.ts`, where the full rule
 * is written down) and the external-agent cancel read this one set.
 */
export type LiveRunStatus = Exclude<
  StatusOfCategory<typeof RUN_STATUS_DECLARATION, "open" | "active" | "paused">,
  "proposed"
>;
export const LIVE_RUN_STATUSES: readonly LiveRunStatus[] = runStatusesIn([
  "open",
  "active",
  "paused",
]).filter((s): s is LiveRunStatus => s !== "proposed");

/**
 * WHO HOLDS a run or a step (`playbook_runs.holder`, `session_stage_runs.holder`,
 * 0446): the one it is handed to, and when that holder CLAIMED it. A run is
 * `running` only once `claimedAt` is set; until then it is `queued`, and a
 * holder that never claims inside its window leaves it `blocked`.
 *   synap_ai  the pod's own AI (id: the IS agent user once a turn claims it);
 *   agent     an agent user (id null: the executor routes to one);
 *   person    a person working it themselves;
 *   machine   the pod's own process (a one-shot generate call);
 *   none      nobody could take it.
 */
export const RUN_HOLDER_KINDS = [
  "synap_ai",
  "agent",
  "person",
  "machine",
  "none",
] as const;
export type RunHolderKind = (typeof RUN_HOLDER_KINDS)[number];

export interface RunHolder {
  kind: RunHolderKind;
  id: string | null;
  /** When the holder was named; the claim window counts from here. */
  assignedAt: string;
  /** When it claimed the work (ISO); null while unclaimed. */
  claimedAt: string | null;
}
