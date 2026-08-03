/**
 * scanBrokenAutomations — a broken automation is otherwise INVISIBLE: the system
 * flips it to `status='error'` (with an `errorMessage`), it silently stops firing,
 * and nothing tells the user. This cron finds those and pushes ONE
 * `automation.broken` notification per broken automation to the workspace members
 * (fan-out — a dead automation means the whole workspace's work isn't happening).
 *
 * Config-over-code producer (all presentation lives in the registry entry). The
 * "broken" signal is deliberately the explicit `status='error'` state ONLY — NOT
 * the `nextRunAt IS NULL` heuristic, which false-positives on healthy crons (a
 * known bug class). Deduped by a 24h cooldown so a persistently-broken automation
 * is not re-notified every tick.
 */

import {
  db,
  automations,
  notifications,
  eq,
  and,
  gte,
  isNotNull,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { NotificationService } from "../../notifications/NotificationService.js";

const logger = createLogger({ module: "scan-broken-automations" });

/** Don't re-notify the same broken automation more than once per this window. */
const RENOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

export async function scanBrokenAutomations(): Promise<{
  scanned: number;
  notified: number;
}> {
  // Explicitly-errored automations bound to a concrete workspace (pod-wide = null,
  // no members to fan out to).
  const broken = await db
    .select({
      id: automations.id,
      workspaceId: automations.workspaceId,
      name: automations.name,
      errorMessage: automations.errorMessage,
    })
    .from(automations)
    .where(
      and(eq(automations.status, "error"), isNotNull(automations.workspaceId))
    );

  let notified = 0;
  const cooldownFloor = new Date(Date.now() - RENOTIFY_COOLDOWN_MS);

  for (const a of broken) {
    if (!a.workspaceId) continue;

    // Cooldown: skip if we already alerted for this automation within the window.
    const [recent] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, "automation.broken"),
          eq(notifications.sourceId, a.id),
          gte(notifications.createdAt, cooldownFloor)
        )
      )
      .limit(1);
    if (recent) continue;

    await NotificationService.createForWorkspace({
      type: "automation.broken",
      sourceType: "system",
      sourceId: a.id,
      workspaceId: a.workspaceId,
      data: {
        automationId: a.id,
        automationName: a.name,
        errorMessage: a.errorMessage ?? "The automation stopped with an error.",
      },
    }).catch((err) =>
      logger.warn(
        { err, automationId: a.id },
        "automation.broken notify failed"
      )
    );
    notified++;
  }

  if (notified > 0) {
    logger.info(
      { scanned: broken.length, notified },
      "broken-automation scan complete"
    );
  }
  return { scanned: broken.length, notified };
}
