/**
 * Inbound delivery sweeper (pipeline-health plan 12d8dab9 W1).
 *
 * The inbound webhook door stores each delivery in `inbound_deliveries`
 * before it answers 200, then dispatches it inline. When that dispatch fails
 * (queue down, a reactor that threw, a process dying mid-request), the row
 * stays owed with a backoff. This cron delivers every owed row whose backoff
 * has lapsed — the sender already heard 200 and will never resend — and drops
 * delivered rows past retention. The state machine and the delivery live in
 * `@synap/database` (inbound-delivery-outbox.ts) and `@synap/events`
 * (`dispatchDueInboundDeliveries`); this is only the clock.
 */
import { dispatchDueInboundDeliveries } from "@synap/events";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "inbound-delivery-sweeper" });

export const INBOUND_DELIVERY_SWEEPER_QUEUE = "inbound-delivery-sweeper";
/** Every minute: an owed delivery waits at most its backoff plus a minute. */
export const INBOUND_DELIVERY_SWEEPER_CRON = "* * * * *";

export async function handleInboundDeliverySweeper(): Promise<void> {
  const { due, delivered, pruned } = await dispatchDueInboundDeliveries();
  if (due > 0 || pruned > 0) {
    logger.info({ due, delivered, pruned }, "Swept owed inbound deliveries");
  }
}
