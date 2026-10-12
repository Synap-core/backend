/**
 * Lifecycle transition sweeper (review D8).
 *
 * A status move writes the event it owes into `lifecycle_transition_outbox`
 * in the same transaction as the compare-and-set, then dispatches it inline.
 * When that delivery fails (queue down, log append error, a process dying
 * mid-dispatch), the row stays owed with a backoff. This cron delivers every
 * owed row whose backoff has lapsed — so history, triggers and goals never
 * miss a move. The state machine and the delivery live in
 * `@synap/database` (transition-outbox.ts) and `@synap/events`
 * (`dispatchDueLifecycleTransitions`); this is only the clock.
 */
import { dispatchDueLifecycleTransitions } from "@synap/events";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "lifecycle-transition-sweeper" });

export const LIFECYCLE_TRANSITION_SWEEPER_QUEUE =
  "lifecycle-transition-sweeper";
/** Every minute: an owed event waits at most its backoff plus a minute. */
export const LIFECYCLE_TRANSITION_SWEEPER_CRON = "* * * * *";

export async function handleLifecycleTransitionSweeper(): Promise<void> {
  const { due, delivered } = await dispatchDueLifecycleTransitions();
  if (due > 0) {
    logger.info({ due, delivered }, "Swept owed lifecycle transitions");
  }
}
