/**
 * Mail Feed — capability-heavy orchestration (api-side).
 *
 * Runs on a schedule: the jobs `mail-feed-cron` worker invokes this in-process
 * via the `registerMailFeedRunner` IoC slot. For the pod's Discord tool with a
 * `metadata.discord.mailFeed` config it:
 *   1. gmail_search — fetch recent emails (metadata + snippet only, no bodies)
 *   2. watermark    — skip anything at/older than the last processed timestamp
 *   3. filter       — drop `senderDeny` matches; keep only `senderAllow` if set
 *   4. triage       — IS `mail_triage` skill scores relevance + category + summary
 *   5. post         — ONE message per relevant, non-muted email into the Synap
 *                     channel bound to Discord (auto-mirrors via the Wave-0
 *                     substrate; the mirror firewall blocks client-comms).
 *
 * Phase 1 = post summaries only (no entity creation). Lives in `@synap/api`
 * because gmail_search (executeCapability) + the IS triage call are api-side; the
 * jobs `mail-feed-cron` worker invokes it in-process via the `registerMailFeedRunner`
 * IoC slot (jobs can't import @synap/api).
 *
 * STAGED-MIGRATION HOLDOUT (backend-agnostic rule): the canonical target is the
 * config-first `mail-feed.automation.json` template composing the same verbs
 * (gmail_search → ai.triage → feed.post). This bespoke service persists ONLY
 * because `updateWatermark` + `senderAllow/Deny` filtering are not yet expressible
 * as automation nodes. Migrate the AI+post steps to the template and keep only a
 * thin watermark/filter helper once the DSL supports them; do not add new
 * feature logic here.
 */

import { db, tools, eq, drizzleSql } from "@synap/database";
import { ensureExternalChannel, insertChannelMessage } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { executeCapability } from "../capabilities/execute-capability.js";
import {
  notifyConnectorUnhealthy,
  isConnectionAuthError,
  capErrorMessage,
} from "../connection-health/notify-connector-unhealthy.js";
import { triageEmails } from "./triage.js";
import type { EmailHit, TriagedEmail } from "./triage.js";

const logger = createLogger({ module: "mail-feed" });

// ── Config + wire types ────────────────────────────────────────────────────────

export interface MailFeedConfig {
  enabled?: boolean;
  /** Discord channel id the feed posts into (bound → mirrored to Discord). */
  channelId?: string;
  /** Gmail search syntax; defaults to `newer_than:2d`. */
  gmailQuery?: string;
  /** Substring/domain fragments — an email is dropped if its `from` matches any. */
  senderDeny?: string[];
  /** If non-empty, ONLY emails whose `from` matches an entry are kept. */
  senderAllow?: string[];
  /** Categories to suppress even when triage marks them relevant. */
  mutedCategories?: string[];
  /** High-water mark — emails at/older than this (ms) are skipped. */
  lastProcessedMs?: number;
  /** Optional: pin the feed to a specific Google connection (1-of-N). Absent → the install-default connection. */
  connectionId?: string;
}

interface DiscordToolMetadata {
  discord?: { mailFeed?: MailFeedConfig } & Record<string, unknown>;
  [k: string]: unknown;
}

// EmailHit / TriagedEmail + triageEmails moved to ./triage.ts (shared with the
// `ai.triage` builtin verb). Re-exported for external importers of this module.
export type { EmailHit, TriagedEmail } from "./triage.js";

export interface RunMailFeedResult {
  skipped?: boolean;
  reason?: string;
  processed?: number;
  posted?: number;
  skippedMuted?: number;
  deniedDropped?: number;
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────────

/** Case-insensitive substring match of `needle` inside an email `from` header. */
export function senderMatches(from: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  return from.toLowerCase().includes(n);
}

/**
 * Allow/deny gate. Deny wins: an email matching any `senderDeny` entry is
 * dropped. If `senderAllow` is non-empty, only emails matching an allow entry
 * survive. Empty lists = pass-through.
 */
export function passesSenderFilters(
  from: string,
  allow: string[] = [],
  deny: string[] = []
): boolean {
  if (deny.some((d) => senderMatches(from, d))) return false;
  if (allow.length > 0) return allow.some((a) => senderMatches(from, a));
  return true;
}

/** Parse an email `Date` header to epoch-ms, or null when absent/unparseable. */
export function emailTimestampMs(dateHeader?: string): number | null {
  if (!dateHeader) return null;
  const ms = Date.parse(dateHeader);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Watermark predicate — true if the email should be processed (newer than the
 * mark). Emails with no parseable date are kept (fail-open: better a possible
 * repost than silently dropping a real email).
 */
export function isNewerThanWatermark(
  dateHeader: string | undefined,
  watermarkMs: number | undefined
): boolean {
  if (!watermarkMs) return true;
  const ms = emailTimestampMs(dateHeader);
  if (ms === null) return true;
  return ms > watermarkMs;
}

/**
 * Mute suggestion heuristic — if a SINGLE category dominates a run (>= minCount
 * AND >= minShare of processed emails), return it so the caller can suggest
 * muting. Never auto-mutes. Returns null when no category qualifies.
 */
export function suggestMuteCategory(
  categories: string[],
  minCount = 5,
  minShare = 0.6
): string | null {
  const total = categories.length;
  if (total < minCount) return null;
  const counts = new Map<string, number>();
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const [cat, n] of counts) {
    if (n >= minCount && n / total >= minShare) return cat;
  }
  return null;
}

/** Compact one-message-per-email body posted into the feed channel. */
export function buildMailMessage(
  email: EmailHit,
  triage: TriagedEmail
): string {
  const subject = email.subject?.trim() || "(no subject)";
  const from = email.from?.trim() || "unknown sender";
  const link = `https://mail.google.com/mail/u/0/#all/${email.id}`;
  const lines = [
    `**${subject}**`,
    `From: ${from} · _${triage.category}_`,
    triage.summary,
  ];
  if (triage.suggestedAction) lines.push(`→ ${triage.suggestedAction}`);
  lines.push(`[Open in Gmail](${link})`);
  return lines.join("\n");
}

// ── Watermark persistence (ATOMIC single-leaf write) ──────────────────────────
// A targeted jsonb_set on `{discord,mailFeed,lastProcessedMs}` only — NOT a full
// metadata overwrite. This avoids lost updates when the event-sync cron or an
// operator slash-command writes a DIFFERENT sub-key of the same tool metadata
// concurrently (they touch other leaves; this touches only ours). runMailFeed
// only runs when metadata.discord.mailFeed exists, so the path is present.

async function updateWatermark(
  toolId: string,
  lastProcessedMs: number
): Promise<void> {
  await db
    .update(tools)
    .set({
      metadata: drizzleSql`jsonb_set(COALESCE(${tools.metadata}, '{}'::jsonb), '{discord,mailFeed,lastProcessedMs}', to_jsonb(${lastProcessedMs}::bigint), true)`,
      updatedAt: new Date(),
    })
    .where(eq(tools.id, toolId));
}

// ── Main ────────────────────────────────────────────────────────────────────────

export async function runMailFeed(): Promise<RunMailFeedResult> {
  // Resolve the pod's Discord tool + its mail-feed config.
  const discordTool = await db.query.tools.findFirst({
    where: eq(tools.name, "discord"),
    columns: {
      id: true,
      createdBy: true,
      workspaceId: true,
      metadata: true,
    },
  });

  if (!discordTool) {
    return { skipped: true, reason: "no_discord_tool" };
  }

  const metadata = (discordTool.metadata ?? {}) as DiscordToolMetadata;
  const mailFeed = metadata.discord?.mailFeed;

  if (!mailFeed?.enabled || !mailFeed.channelId) {
    return { skipped: true, reason: "mail_feed_disabled" };
  }

  const owner = discordTool.createdBy;
  const workspaceId = discordTool.workspaceId ?? null;
  const mutedCategories = mailFeed.mutedCategories ?? [];

  // 1. gmail_search — metadata + snippet only.
  const cap = await executeCapability({
    verbId: "gmail_search",
    parameters: {
      query: mailFeed.gmailQuery || "newer_than:2d",
      maxResults: 25,
    },
    userId: owner,
    workspaceId,
    connectionSelector: mailFeed.connectionId
      ? { connectionId: mailFeed.connectionId }
      : undefined,
  });

  // Dead Google connection (refresh token expired) surfaces as an error envelope
  // inside a kind:"run" result — detect it and nudge the operator to reconnect
  // instead of silently posting nothing every 2h.
  const capErr = capErrorMessage(cap);
  if (capErr && isConnectionAuthError(capErr)) {
    await notifyConnectorUnhealthy({
      connectorKey: "google",
      connectorName: "Google Workspace",
      reconnectHint:
        "Reconnect it in the app (Settings → Connectors) or run `/connect provider:google` in Discord.",
      userId: owner,
      workspaceId,
      watermarkToolId: discordTool.id,
      watermarkMetadata: metadata,
      discordTeamChannelId: mailFeed.channelId,
      errorMessage: capErr,
    });
    return { skipped: true, reason: "google_connection_unhealthy" };
  }

  if (cap.kind !== "run") {
    logger.warn({ capKind: cap.kind }, "gmail_search did not run — skipping");
    return { skipped: true, reason: `gmail_search_${cap.kind}` };
  }

  const gmailResult = cap.result as { results?: EmailHit[] } | undefined;
  const allEmails = Array.isArray(gmailResult?.results)
    ? gmailResult!.results
    : [];

  // 2. watermark — drop anything at/older than last processed.
  const afterWatermark = allEmails.filter((e) =>
    isNewerThanWatermark(e.date, mailFeed.lastProcessedMs)
  );

  // 3. sender allow/deny filter.
  const denyBefore = afterWatermark.length;
  const surviving = afterWatermark.filter((e) =>
    passesSenderFilters(
      e.from ?? "",
      mailFeed.senderAllow ?? [],
      mailFeed.senderDeny ?? []
    )
  );
  const deniedDropped = denyBefore - surviving.length;

  if (surviving.length === 0) {
    // Still advance the watermark past what we saw so a later run doesn't
    // re-examine the same (all-filtered) batch.
    const maxSeen = maxTimestamp(afterWatermark);
    if (maxSeen !== null) {
      await updateWatermark(discordTool.id, maxSeen).catch((err) =>
        logger.warn({ err }, "watermark update failed (no survivors)")
      );
    }
    return {
      processed: 0,
      posted: 0,
      skippedMuted: 0,
      deniedDropped,
    };
  }

  // 4. triage via IS.
  const triaged = await triageEmails(surviving, mutedCategories);
  const triageById = new Map(triaged.map((t) => [t.id, t]));

  // Resolve the Discord-bound feed channel ONCE (find-or-create), reused for
  // every post below. `branchPurpose:'team'` is what the mirror's fail-closed
  // allowlist requires; ensureExternalChannel upgrades a null-purpose row to team.
  const { channelId: feedChannelId } = await ensureExternalChannel({
    provider: "discord",
    externalId: mailFeed.channelId,
    userId: owner,
    workspaceId,
    title: "Mail feed",
    branchPurpose: "team",
  });

  // 5. post one message per relevant, non-muted email.
  let posted = 0;
  let skippedMuted = 0;
  const processedCategories: string[] = [];

  for (const email of surviving) {
    const t = triageById.get(email.id);
    if (!t) continue; // triage dropped it — treat as not-actionable
    processedCategories.push(t.category);

    if (!t.relevant) continue;
    if (mutedCategories.includes(t.category)) {
      skippedMuted += 1;
      continue;
    }

    await insertChannelMessage({
      channelId: feedChannelId,
      content: buildMailMessage(email, t),
      userId: owner,
      // authorType defaults to BOT in insertChannelMessage.
      metadata: { mailFeed: true, gmailId: email.id, category: t.category },
    });
    posted += 1;
  }

  // Advance watermark past everything we processed this run.
  const maxSeen = maxTimestamp(surviving);
  if (maxSeen !== null) {
    await updateWatermark(discordTool.id, maxSeen).catch((err) =>
      logger.warn({ err }, "watermark update failed")
    );
  }

  // Optional: suggest muting a dominant category (never auto-mute).
  const suggestion = suggestMuteCategory(processedCategories);
  if (suggestion && !mutedCategories.includes(suggestion)) {
    await insertChannelMessage({
      channelId: feedChannelId,
      content: `Most of this batch was **${suggestion}**. Mute it with \`/mail-feed mute:${suggestion}\` if it's noise.`,
      userId: owner,
      metadata: { mailFeed: true, muteSuggestion: suggestion },
    }).catch((err) => logger.warn({ err }, "mute-suggestion post failed"));
  }

  logger.info(
    { processed: surviving.length, posted, skippedMuted, deniedDropped },
    "mail feed run complete"
  );

  return {
    processed: surviving.length,
    posted,
    skippedMuted,
    deniedDropped,
  };
}

/** Largest parseable email timestamp in a batch, or null. */
function maxTimestamp(emails: EmailHit[]): number | null {
  let max: number | null = null;
  for (const e of emails) {
    const ms = emailTimestampMs(e.date);
    if (ms !== null && (max === null || ms > max)) max = ms;
  }
  return max;
}
