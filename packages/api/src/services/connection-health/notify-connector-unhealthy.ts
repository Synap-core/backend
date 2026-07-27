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
  eq,
  drizzleSql,
  ensureExternalChannel,
  insertChannelMessage,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { NotificationService } from "../../notifications/NotificationService.js";

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

interface NotifyConnectorOpts {
  /** Stable key for dedup + the metadata watermark, e.g. "google" | "cal_com". */
  connectorKey: string;
  /** Human display name, e.g. "Google Workspace". */
  connectorName: string;
  /** One-line action for the operator (how to reconnect). */
  reconnectHint: string;
  userId: string;
  workspaceId: string | null;
  /** Tool row holding the dedup watermark (metadata.connectionHealth.<key>). */
  watermarkToolId: string;
  watermarkMetadata: Record<string, unknown> | null | undefined;
  /** Optional Discord team channel (external id) to also post the nudge into. */
  discordTeamChannelId?: string;
  errorMessage?: string;
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

  // 1. In-app notification — reuse the existing connector.auth.expired template.
  await NotificationService.create({
    type: "connector.auth.expired",
    sourceType: "connector",
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    groupKey: `${opts.workspaceId ?? "pod"}:connector.auth.expired:${opts.connectorKey}`,
    data: { connectorName: opts.connectorName },
  }).catch((err) =>
    logger.warn({ err }, "connection-health: in-app notification failed")
  );

  // 2. Discord team-channel nudge (firewall-safe — branchPurpose 'team' only),
  //    best-effort, only when the caller knows an internal channel to post to.
  if (opts.discordTeamChannelId) {
    try {
      const { channelId } = await ensureExternalChannel({
        provider: "discord",
        externalId: opts.discordTeamChannelId,
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        title: "Notices",
        branchPurpose: "team",
      });
      await insertChannelMessage({
        channelId,
        content: `⚠️ **${opts.connectorName} connection needs reconnect** — syncing is paused until it's restored.\n${opts.reconnectHint}`,
        userId: opts.userId,
        metadata: { connectionHealth: true, connector: opts.connectorKey },
      });
    } catch (err) {
      logger.warn({ err }, "connection-health: Discord nudge failed");
    }
  }

  // 3. Advance the watermark (nested jsonb_set ensures the parent object exists;
  //    the connector key is a bound array element, never interpolated into SQL).
  await db
    .update(tools)
    .set({
      metadata: drizzleSql`jsonb_set(
        jsonb_set(COALESCE(${tools.metadata}, '{}'::jsonb), '{connectionHealth}', COALESCE(${tools.metadata}#>'{connectionHealth}', '{}'::jsonb), true),
        ARRAY['connectionHealth', ${opts.connectorKey}]::text[], jsonb_build_object('lastNotifiedMs', ${Date.now()}::bigint), true)`,
      updatedAt: new Date(),
    })
    .where(eq(tools.id, opts.watermarkToolId))
    .catch((err) =>
      logger.warn({ err }, "connection-health: watermark persist failed")
    );

  logger.info(
    { connector: opts.connectorKey },
    "connection-health: reconnect nudge emitted"
  );
  return true;
}
