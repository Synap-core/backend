/**
 * Connection-health nudge — turn a SILENT connector death into a visible signal.
 *
 * The Google/Cal.com crons (mail-feed, event-sync, cal-backfill) all used to
 * `warn + skip` when a capability failed, so a dead OAuth connection (refresh
 * token expired) stopped every dependent feature with ZERO user signal. Now that
 * the dispatch layer surfaces a real `kind:"error"` (the masking fix), the crons
 * can detect it and call this: it fires the existing `connector.auth.expired`
 * in-app notification AND — where a Discord team channel is known — posts a
 * firewall-safe "reconnect" nudge, deduped so it doesn't spam every cron tick.
 */

import {
  db,
  tools,
  intelligenceServices,
  eq,
  drizzleSql,
  ensureExternalChannel,
  insertChannelMessage,
  eventRepository,
} from "@synap/database";
import { randomUUID } from "crypto";
import { recordChannelOrigin } from "../channels/channel-origin.js";
import { createLogger } from "@synap-core/core";
import { NotificationService } from "../../notifications/NotificationService.js";
import {
  NOTIFICATION_EVENT_TYPE_MAP,
  NOTIFICATION_EVENT_SOURCE,
} from "../../notifications/notification-event-map.js";

const logger = createLogger({ module: "connection-health" });

// Don't re-nudge for the same connector more than once per this window — a dead
// connection stays dead across many cron ticks; the operator needs one signal,
// not one every 30 min.
const NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Heuristic: does a capability failure mean the CONNECTION is dead (needs a
 * reconnect) vs a transient/other error? Post-masking-fix these arrive as
 * `kind:"error"` carrying the provider's real message (e.g. Nango's
 * "refresh the access token" / "connection_refresh_backoff", Google's
 * "invalid_grant"). Conservative — only known auth/credential signals match.
 */
export function isConnectionAuthError(message: string | undefined): boolean {
  if (!message) return false;
  // Auth/refresh failures (expired token) AND the "enabled but never connected"
  // state ("No connection found … Connect it via Settings") — both mean the
  // operator must (re)connect for the feature to work.
  return /refresh|credential|reconnect|invalid_grant|unauthor|expired|access token|backoff|no connection found|connect it via/i.test(
    message
  );
}

/**
 * Extract an error message from an `executeCapability` result. Provider failures
 * come back as `{ kind:"run", result: <dispatch envelope> }` where the envelope is
 * `{ success:false, errorCode, error }` (executeProviderVerb returns the envelope
 * as-is on error — execute-provider-verb.ts:367). deny/not_found carry their own
 * reason/message. Returns undefined when the call actually succeeded.
 */
export function capErrorMessage(cap: {
  kind: string;
  result?: unknown;
  message?: string;
  reason?: string;
}): string | undefined {
  // A failed run now surfaces as the dedicated `kind:"error"` channel — its
  // message is the failure text directly (no envelope to dig through).
  if (cap.kind === "error") return cap.message;
  if (cap.kind === "not_found") return cap.message;
  if (cap.kind === "deny") return cap.reason;
  if (cap.kind !== "run") return undefined; // dry-run / proposed — not errors
  const r = cap.result as Record<string, unknown> | undefined;
  if (r && typeof r === "object" && (r.success === false || r.errorCode)) {
    return typeof r.error === "string"
      ? r.error
      : `provider error (${String(r.errorCode ?? r.status ?? "unknown")})`;
  }
  return undefined;
}

/**
 * Resolve WHERE a SYSTEM notice (connector-health alert, error nudge) should post.
 *
 * System notices belong in ONE operator-chosen channel — the `feedbackChannel`
 * (`/setup` labels it "digests & notices land here") — not scattered into whichever
 * feature happened to fail. Previously each caller passed its own feature channel
 * (event-sync → `announceChannelId` = the user's `#important`, mail-feed →
 * `mailFeed.channelId`), so a Google reconnect nudge surfaced in the events channel.
 * This routes it to the configured feedback channel, falling back to the feature's
 * channel only when the operator hasn't picked one yet.
 */
export function resolveNoticeChannelId(
  toolMetadata: Record<string, unknown> | null | undefined,
  fallbackChannelId: string | undefined
): string | undefined {
  const discord = (toolMetadata?.discord ?? null) as {
    feedbackChannel?: unknown;
  } | null;
  const fb = discord?.feedbackChannel;
  return typeof fb === "string" && fb.trim() ? fb : fallbackChannelId;
}

/**
 * The `isEnabled` predicate for `resolveTool("discord", …)` calls whose only
 * question is "which row knows WHERE system notices go?".
 *
 * This pod has TWO `discord` tool rows and `discord.feedbackChannel` is set on
 * only one of them. Passing `() => false` (or any unrelated sub-feature flag)
 * makes `resolveTool` fall through to its oldest-by-`createdAt` tie-break — so
 * whether the alarm reaches Discord depends on which row happened to be created
 * first, not on which row is configured. Set the channel on the newer row
 * instead and the nudge goes silent, with no error, because the in-app
 * notification still fires and covers for it.
 *
 * Same rule as the event-sync / mail-feed predicates: the predicate must match
 * the question being asked. The question here is about `feedbackChannel`, so
 * that is what it tests. Every notice-channel caller passes THIS one — do not
 * re-inline the check at a call site.
 */
export function hasDiscordFeedbackChannel(metadata: unknown): boolean {
  return Boolean(
    resolveNoticeChannelId(
      (metadata ?? null) as Record<string, unknown> | null,
      undefined
    )
  );
}

/**
 * WHERE the 6h dedup watermark lives. It was always a `tools` row, because
 * every caller was a connector. An intelligence-service outage has no tool row
 * — its own `intelligence_services` row is the natural home — so the watermark
 * target is now named rather than assumed. Both tables carry a jsonb
 * `metadata`, and the SAME `connectionHealth.<key>.lastNotifiedMs` shape is
 * written to either, so there is still ONE dedup rule.
 */
export type HealthWatermarkTable = "tools" | "intelligence_services";

interface NotifyConnectorOpts {
  /** Stable key for dedup + the metadata watermark, e.g. "google" | "cal_com". */
  connectorKey: string;
  /** Human display name, e.g. "Google Workspace". */
  connectorName: string;
  /** One-line action for the operator (how to reconnect). */
  reconnectHint: string;
  userId: string;
  workspaceId: string | null;
  /** Row holding the dedup watermark (metadata.connectionHealth.<key>). */
  watermarkToolId: string;
  /**
   * Table the watermark row lives in. Defaults to `tools` so every existing
   * connector caller keeps working unchanged.
   */
  watermarkTable?: HealthWatermarkTable;
  watermarkMetadata: Record<string, unknown> | null | undefined;
  /** Optional Discord team channel (external id) to also post the nudge into. */
  discordTeamChannelId?: string;
  errorMessage?: string;
  /**
   * Notification type from the registry. Defaults to `connector.auth.expired`
   * — the only shape this helper could emit before. A caller whose failure is
   * NOT an expired credential must pass its own type rather than borrow that
   * one, or the notification asserts a cause nobody verified.
   */
  notificationType?: string;
  /** Extra template variables merged over `{ connectorName }`. */
  notificationData?: Record<string, unknown>;
  /**
   * Body of the Discord notice. Defaults to the reconnect wording. Same rule
   * as above: say what actually happened, not what usually happens.
   */
  noticeMessage?: string;
}

/**
 * Emit a reconnect nudge for an unhealthy connector, at most once per cooldown.
 * Never throws. Returns true if a nudge was actually emitted this call.
 */
export async function notifyConnectorUnhealthy(
  opts: NotifyConnectorOpts
): Promise<boolean> {
  // Dedup: skip if we already nudged for this connector within the cooldown.
  const health = (opts.watermarkMetadata?.connectionHealth ?? {}) as Record<
    string,
    { lastNotifiedMs?: number }
  >;
  const last = health[opts.connectorKey]?.lastNotifiedMs ?? 0;
  if (Date.now() - last < NUDGE_COOLDOWN_MS) return false;

  // 1. In-app notification — `connector.auth.expired` by default, or the
  //    caller's own registry type when the failure is a different thing.
  const notificationType = opts.notificationType ?? "connector.auth.expired";
  await NotificationService.create({
    type: notificationType,
    sourceType: "connector",
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    groupKey: `${opts.workspaceId ?? "pod"}:${notificationType}:${opts.connectorKey}`,
    data: { connectorName: opts.connectorName, ...opts.notificationData },
  }).catch((err) =>
    logger.warn({ err }, "connection-health: in-app notification failed")
  );

  // 1b. Domain-typed event alongside the notification — the generic
  //     `notification.created` wrapper NotificationService.create() always
  //     appends carries no domain-specific type, so nothing that filters or
  //     projects BY event type can recognize this occurrence. Gated on the
  //     SAME cooldown check above (early-returned before this point), so a
  //     repeated probe within the 6h window never appends a duplicate.
  const mappedEventType = NOTIFICATION_EVENT_TYPE_MAP[notificationType];
  if (mappedEventType) {
    await eventRepository
      .append({
        id: randomUUID(),
        version: "v1",
        type: mappedEventType,
        subjectType:
          (opts.watermarkTable ?? "tools") === "intelligence_services"
            ? "intelligence_service"
            : "connector",
        subjectId: opts.watermarkToolId,
        data: { connectorName: opts.connectorName, ...opts.notificationData },
        userId: opts.userId,
        source: NOTIFICATION_EVENT_SOURCE,
        timestamp: new Date(),
      })
      .catch((err) =>
        logger.warn({ err }, "connection-health: event append failed")
      );
  }

  // 2. Discord team-channel nudge (firewall-safe — branchPurpose 'team' only),
  //    best-effort, only when the caller knows an internal channel to post to.
  if (opts.discordTeamChannelId) {
    try {
      const { channelId, created } = await ensureExternalChannel({
        provider: "discord",
        externalId: opts.discordTeamChannelId,
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        title: "Notices",
        branchPurpose: "team",
      });
      // ORIGIN at birth (see run-mail-feed for why the CALLER stamps it).
      if (created) {
        await recordChannelOrigin({
          channelId,
          workspaceId: opts.workspaceId ?? null,
          origin: {
            producerType: "source",
            producerId: "connection-health",
            producerName: "Connection health",
          },
        });
      }
      await insertChannelMessage({
        channelId,
        content:
          opts.noticeMessage ??
          `⚠️ **${opts.connectorName} connection needs reconnect** — syncing is paused until it's restored.\n${opts.reconnectHint}`,
        userId: opts.userId,
        metadata: { connectionHealth: true, connector: opts.connectorKey },
      });
    } catch (err) {
      logger.warn({ err }, "connection-health: Discord nudge failed");
    }
  } else {
    // Posting nowhere is a real outcome, not a no-op: the in-app notification
    // still fires, so an unconfigured (or wrongly-resolved) notice channel
    // otherwise looks EXACTLY like a delivered alert. Say it out loud.
    logger.warn(
      {
        connector: opts.connectorKey,
        workspaceId: opts.workspaceId,
      },
      "connection-health: no Discord notice channel resolved — alert is in-app ONLY (set discord.feedbackChannel on the discord tool row)"
    );
  }

  // 3. Advance the watermark (nested jsonb_set ensures the parent object exists;
  //    the connector key is a bound array element, never interpolated into SQL).
  //    Same statement against whichever table holds the row — the two branches
  //    differ only in which `metadata` column and id they bind.
  const watermarkAt = Date.now();
  const watermarkSql = (
    column: typeof tools.metadata | typeof intelligenceServices.metadata
  ) =>
    drizzleSql`jsonb_set(
        jsonb_set(COALESCE(${column}, '{}'::jsonb), '{connectionHealth}', COALESCE(${column}#>'{connectionHealth}', '{}'::jsonb), true),
        ARRAY['connectionHealth', ${opts.connectorKey}]::text[], jsonb_build_object('lastNotifiedMs', ${watermarkAt}::bigint), true)`;

  const persistWatermark =
    (opts.watermarkTable ?? "tools") === "intelligence_services"
      ? db
          .update(intelligenceServices)
          .set({
            metadata: watermarkSql(intelligenceServices.metadata),
            updatedAt: new Date(),
          })
          .where(eq(intelligenceServices.id, opts.watermarkToolId))
      : db
          .update(tools)
          .set({
            metadata: watermarkSql(tools.metadata),
            updatedAt: new Date(),
          })
          .where(eq(tools.id, opts.watermarkToolId));

  await persistWatermark.catch((err) =>
    logger.warn({ err }, "connection-health: watermark persist failed")
  );

  logger.info(
    {
      connector: opts.connectorKey,
      // Which HALF of the fan-out actually ran — "in-app" alone is the silent
      // case operators need to be able to see in the log.
      channels: opts.discordTeamChannelId ? "in-app+discord" : "in-app",
    },
    "connection-health: reconnect nudge emitted"
  );
  return true;
}
