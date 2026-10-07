/**
 * External agent status poll (cron: every 2 min).
 *
 * Thin scheduler: on a tick it invokes the api-side poller
 * (`pollExternalAgentRuns`, services/agent-dispatch), which calls each live
 * dispatched run's binding `status` verb and posts what changed in the room.
 * Idempotent per state change on the api side (claimed fingerprint).
 *
 * Runs IN the backend (apps/api) process; @synap/jobs cannot import @synap/api
 * (circular dep), so apps/api fills this slot at boot via
 * `registerExternalAgentPoller()` — the same IoC pattern as `event-end-cron`.
 * Unregistered, a tick is logged and skipped (a poll is a read of status;
 * skipping it loses nothing that the next registered tick will not see).
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "external-agent-poll" });

export const EXTERNAL_AGENT_POLL_QUEUE = "external-agent-poll";
export const EXTERNAL_AGENT_POLL_CRON = "*/2 * * * *";

type ExternalAgentPoller = () => Promise<unknown>;

let poller: ExternalAgentPoller | null = null;

export function registerExternalAgentPoller(fn: ExternalAgentPoller): void {
  poller = fn;
}

export async function handleExternalAgentPoll(
  _job?: PgBoss.Job
): Promise<void> {
  if (!poller) {
    logger.warn("external-agent poller not registered — skipping tick");
    return;
  }
  try {
    const result = await poller();
    logger.info({ result }, "external-agent poll complete");
  } catch (err) {
    logger.error({ err }, "external-agent poll failed");
  }
}
