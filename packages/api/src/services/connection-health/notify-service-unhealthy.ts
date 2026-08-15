/**
 * Intelligence-service health nudge — the SAME door connectors use.
 *
 * `intelligence-health-check` (packages/jobs) has pinged every active IS every
 * 2 minutes for a long time and classified degraded/unhealthy correctly. It
 * then called `logger.warn` and stopped. That log line is why an 8-day agent
 * outage went unnoticed: the verdict was computed and thrown away.
 *
 * This is deliberately NOT a second alerting system. It resolves the recipient
 * and the notice channel, then hands off to `notifyConnectorUnhealthy` — same
 * in-app + Discord fan-out, same 6h dedup watermark. The only generalisations
 * that needed making there were the notification type and which table holds
 * the watermark row (an IS has no `tools` row; its own row does the job).
 *
 * Lives in @synap/api because it needs NotificationService and the tool
 * resolver; the worker reaches it through an IoC slot, since @synap/jobs
 * cannot import @synap/api (circular dep) — the same pattern as
 * `registerSignalRouter` / `registerMailFeedRunner`.
 */

import {
  notifyConnectorUnhealthy,
  resolveNoticeChannelId,
  hasDiscordFeedbackChannel,
} from "./notify-connector-unhealthy.js";
import { resolveTool } from "../tools/resolve-tool.js";
import { resolvePodOwnerUserId } from "../capabilities/pod-owner.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "connection-health" });

export interface NotifyIntelligenceServiceUnhealthyInput {
  /** `intelligence_services.id` — also the row holding the dedup watermark. */
  serviceRowId: string;
  /** `intelligence_services.service_id` — the stable dedup key. */
  serviceId: string;
  /** Display name for the notification. */
  serviceName: string;
  /** The verdict the worker computed: "degraded" | "unhealthy". */
  healthStatus: string;
  /** Existing `metadata` on the IS row (carries the watermark). */
  metadata: Record<string, unknown> | null | undefined;
  /** Whatever detail the /health payload gave us. May be absent. */
  detail?: string;
}

/**
 * Emit an operator nudge for a degraded/unhealthy intelligence service, at
 * most once per the shared 6h cooldown. Never throws — a health-check tick
 * must not fail because alerting did.
 */
export async function notifyIntelligenceServiceUnhealthy(
  input: NotifyIntelligenceServiceUnhealthyInput
): Promise<boolean> {
  try {
    const userId = await resolvePodOwnerUserId();
    if (!userId) {
      // Pre-bootstrap pod — nobody to tell yet.
      logger.warn(
        { serviceId: input.serviceId },
        "intelligence health: no pod owner to notify"
      );
      return false;
    }

    // The Discord half is OPTIONAL and config-gated: it only posts when the
    // operator has set `discord.feedbackChannel` on a `discord` tool row.
    // Without it the in-app notification still fires.
    // Prefer a row that actually HAS a notice channel over creation order —
    // via the shared predicate, so this and the connector-health nudge can
    // never drift apart (this call site used to inline its own copy).
    const discordTool = await resolveTool("discord", hasDiscordFeedbackChannel);
    const noticeChannelId = resolveNoticeChannelId(
      (discordTool?.metadata ?? null) as Record<string, unknown> | null,
      undefined
    );

    // Say what /health actually reported. When it reported nothing, say THAT
    // — never dress an unexplained outage up as a known cause.
    const detail =
      input.detail?.trim() ||
      `The service reported ${input.healthStatus} with no further detail.`;

    return await notifyConnectorUnhealthy({
      connectorKey: `intelligence:${input.serviceId}`,
      connectorName: input.serviceName,
      // Not a reconnect — this is the operator action that can actually help.
      reconnectHint:
        "Check the intelligence service logs and provider account (credit, credentials, deploy state).",
      userId,
      workspaceId: discordTool?.workspaceId ?? null,
      watermarkToolId: input.serviceRowId,
      watermarkTable: "intelligence_services",
      watermarkMetadata: input.metadata,
      discordTeamChannelId: noticeChannelId,
      errorMessage: detail,
      notificationType: "system.intelligence_degraded",
      notificationData: {
        healthStatus: input.healthStatus,
        errorMessage: detail,
      },
      noticeMessage: `⚠️ **AI service ${input.healthStatus}: ${input.serviceName}** — agent turns may be failing.\n${detail}`,
    });
  } catch (err) {
    logger.warn(
      { err, serviceId: input.serviceId },
      "intelligence health: nudge failed"
    );
    return false;
  }
}
