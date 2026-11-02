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
  and,
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
 * CLAIM the cooldown for one connector: ONE conditional UPDATE that advances
 * `metadata.connectionHealth.<key>.lastNotifiedMs` to now only WHERE the stored
 * value is absent or older than the cooldown, RETURNING the row. True = this
 * caller won the window and must emit; false = someone already holds it.
 *
 * Why in the database and not from a metadata snapshot: the caller's snapshot
 * was read BEFORE the run, so every run that shared it passed the check before
 * any of them wrote the watermark. One Google tool row's connection sync runs
 * contact / email.thread / event for each of its connections against the SAME
 * snapshot, and each failing run nudged: 292 identical "Google needs
 * re-authorization" rows on one pod, 8 per burst, from 2026-10-18 to 11-01.
 * Concurrent claims serialize on the row lock, and Postgres re-checks the WHERE
 * against the winner's new row, so exactly one claim per window returns a row.
 *
 * A failed claim (DB error) emits nothing: a nudge that cannot record itself
 * would repeat every tick, which is the storm this exists to stop.
 */
async function claimNudgeWindow(opts: NotifyConnectorOpts): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - NUDGE_COOLDOWN_MS;
  // The connector key is a bound array element, never interpolated into SQL.
  const watermarkPath = drizzleSql`ARRAY['connectionHealth', ${opts.connectorKey}, 'lastNotifiedMs']::text[]`;
  // Nested jsonb_set ensures the parent object exists. Same expression against
  // whichever table holds the row: the two branches differ only in which
  // `metadata` column and id they bind.
  const watermarkSql = (
    column: typeof tools.metadata | typeof intelligenceServices.metadata
  ) =>
    drizzleSql`jsonb_set(
        jsonb_set(COALESCE(${column}, '{}'::jsonb), '{connectionHealth}', COALESCE(${column}#>'{connectionHealth}', '{}'::jsonb), true),
        ARRAY['connectionHealth', ${opts.connectorKey}]::text[], jsonb_build_object('lastNotifiedMs', ${now}::bigint), true)`;
  const outsideCooldown = (
    column: typeof tools.metadata | typeof intelligenceServices.metadata
  ) =>
    drizzleSql`COALESCE((${column} #>> ${watermarkPath})::numeric, 0) < ${cutoff}::bigint`;

  try {
    const claimed =
      (opts.watermarkTable ?? "tools") === "intelligence_services"
        ? await db
            .update(intelligenceServices)
            .set({
              metadata: watermarkSql(intelligenceServices.metadata),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(intelligenceServices.id, opts.watermarkToolId),
                outsideCooldown(intelligenceServices.metadata)
              )
            )
            .returning({ id: intelligenceServices.id })
        : await db
            .update(tools)
            .set({
              metadata: watermarkSql(tools.metadata),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(tools.id, opts.watermarkToolId),
                outsideCooldown(tools.metadata)
              )
            )
            .returning({ id: tools.id });
    return claimed.length > 0;
  } catch (err) {
    logger.error(
      {
        err,
        connector: opts.connectorKey,
        table: opts.watermarkTable ?? "tools",
      },
      "connection-health: cooldown claim failed — nudge NOT emitted"
    );
    return false;
  }
}

/**
 * Emit a reconnect nudge for an unhealthy connector, at most once per cooldown.
 * Never throws. Returns true if a nudge was actually emitted this call.
 */
export async function notifyConnectorUnhealthy(
  opts: NotifyConnectorOpts
): Promise<boolean> {
  // Dedup: claim the cooldown window first; only the claim's winner emits.
  // Also false when no row has `watermarkToolId`: with nowhere to record the
  // nudge it could not be deduped, so it is not sent.
  if (!(await claimNudgeWindow(opts))) return false;

  // 1. In-app notification — `connector.auth.expired` by default, or the
  //    caller's own registry type when the failure is a different thing.
  const notificationType = opts.notificationType ?? "connector.auth.expired";
  // A connector's key IS its provider — the Connected page's ACCOUNT key
  // (`account:<provider>`). An intelligence service is no account.
  const isAccount = (opts.watermarkTable ?? "tools") === "tools";
  await NotificationService.create({
    type: notificationType,
    sourceType: "connector",
    // The account the notice is about: the registry's `navigate-object`
    // action (kind `account`) and the push tap read it as the object id.
    sourceId: isAccount ? opts.connectorKey : undefined,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    // The person's notify level for that account gates it; an intelligence
    // service is no membrane connection: ungated.
    connection: isAccount
      ? { kind: "account", id: opts.connectorKey }
      : undefined,
    groupKey: `${opts.workspaceId ?? "pod"}:${notificationType}:${opts.connectorKey}`,
    data: { connectorName: opts.connectorName, ...opts.notificationData },
  }).catch((err) =>
    logger.warn({ err }, "connection-health: in-app notification failed")
  );

  // 1b. Domain-typed event alongside the notification — the generic
  //     `notification.created` wrapper NotificationService.create() always
  //     appends carries no domain-specific type, so nothing that filters or
  //     projects BY event type can recognize this occurrence. Gated on the
  //     SAME cooldown claim above (early-returned before this point), so a
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
