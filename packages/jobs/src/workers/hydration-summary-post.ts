/**
 * Hydration Summary Post Worker
 *
 * Closes Gap 3 of onboarding: after the user finishes the import review,
 * the Orchestrator should have a proactive summary waiting in their personal
 * channel when they land on /home.
 *
 * Triggered by the `hydration.imported` side-effect emitted from
 * capture.executeWithSchema (see capture.ts). The side-effect emitter
 * enqueues a delayed job (~6s startAfter) so the home view has time to
 * render before the message pops.
 *
 * Fire-and-forget semantics:
 * - No retries (retryLimit: 0 in the enqueue call).
 * - All failures are logged and swallowed — the user should never see an
 *   error for a welcome message.
 *
 * Message generation is a pure function (generateHydrationSummary) so it
 * can be unit tested without a DB.
 */

import type PgBoss from "pg-boss";
import { randomUUID, createHash } from "node:crypto";
import { db, eq, and } from "@synap/database";
import {
  channels,
  messages,
  ChannelType,
  ChannelScope,
  ThreadKind,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "hydration-summary-post" });

// ── Payload types ────────────────────────────────────────────────────────────

export interface HydrationSummaryData {
  /** Count of created entities grouped by profile slug: `{ person: 312 }`. */
  entitiesByProfile: Record<string, number>;
  /** Count of input entities grouped by source: `{ linkedin: 312 }`. */
  sourcesSummary: Record<string, number>;
  /** PropertyDefs created during the import. */
  propertiesCreated: number;
  /** Entities freshly created (excludes matched/linked). */
  totalCreated: number;
  /** Entities matched/linked to pre-existing records. */
  totalMatched: number;
}

export interface HydrationSummaryJob {
  userId: string;
  workspaceId: string | null;
  data: HydrationSummaryData;
}

// ── Message generation (pure) ────────────────────────────────────────────────

/**
 * Pluralise a profile slug for human-readable output.
 * Keeps the list small and conservative — unknown slugs fall through via
 * the generic `${slug}s` branch.
 */
function pluralizeProfile(slug: string, count: number): string {
  if (count === 1) {
    // Singular form
    if (slug === "person") return "person";
    if (slug === "company") return "company";
    return slug;
  }
  // Plural form
  if (slug === "person") return "people";
  if (slug === "company") return "companies";
  return `${slug}s`;
}

/**
 * Format a source key for display. Capitalises known sources.
 */
function formatSource(source: string): string {
  const known: Record<string, string> = {
    linkedin: "LinkedIn",
    claude: "Claude",
    notion: "Notion",
    telegram: "Telegram",
    gmail: "Gmail",
    github: "GitHub",
    twitter: "Twitter",
    csv: "CSV",
    import: "your import",
  };
  return known[source.toLowerCase()] ?? source;
}

/**
 * Get the profile with the highest count — "primary" profile for phrasing.
 * Returns null if the record is empty.
 */
function primaryEntry(
  record: Record<string, number>
): { key: string; count: number } | null {
  let best: { key: string; count: number } | null = null;
  for (const [key, count] of Object.entries(record)) {
    if (count <= 0) continue;
    if (!best || count > best.count) best = { key, count };
  }
  return best;
}

/**
 * Build a short, warm welcome message describing what was just imported.
 * Pure function — no DB, no IO. Kept intentionally template-based so it's
 * predictable and fast; an IS-generated version can replace it later.
 *
 * Target shape: 2-3 sentences, one specific observation, ends with an
 * open invitation.
 */
export function generateHydrationSummary(data: HydrationSummaryData): string {
  const {
    entitiesByProfile,
    sourcesSummary,
    propertiesCreated,
    totalCreated,
    totalMatched,
  } = data;

  const primaryProfile = primaryEntry(entitiesByProfile);
  const primarySource = primaryEntry(sourcesSummary);

  // Edge case — nothing substantial came through. Keep a friendly line so
  // the channel isn't silent.
  if (!primaryProfile || totalCreated + totalMatched === 0) {
    return "Just finished reading through your import — looks light, but I've got what you sent. Ready when you are.";
  }

  // Opening clause: "N new {profile}"
  const createdLabel = `**${totalCreated} new ${pluralizeProfile(primaryProfile.key, totalCreated)}**`;
  const matchedClause =
    totalMatched > 0
      ? ` and matched ${totalMatched} to ${pluralizeProfile(primaryProfile.key, totalMatched)} I already knew about`
      : "";

  // Source clause
  const sourceKeys = Object.keys(sourcesSummary).filter(
    (k) => sourcesSummary[k] > 0
  );
  let sourceClause = "";
  if (sourceKeys.length === 0) {
    sourceClause = "";
  } else if (sourceKeys.length === 1 && primarySource) {
    sourceClause = ` Mostly from ${formatSource(primarySource.key)}.`;
  } else {
    const formatted = sourceKeys.map(formatSource);
    const joined =
      formatted.length === 2
        ? `${formatted[0]} and ${formatted[1]}`
        : `${formatted.slice(0, -1).join(", ")}, and ${formatted[formatted.length - 1]}`;
    sourceClause = ` I combined data from ${joined}.`;
  }

  // Property clause
  const propertyClause =
    propertiesCreated > 0
      ? ` I also added ${propertiesCreated} new field${propertiesCreated === 1 ? "" : "s"} to your profiles based on what was in there.`
      : "";

  return `Just finished reading through your import — ${createdLabel}${matchedClause}.${sourceClause}${propertyClause} Ready when you are.`;
}

// ── Personal channel resolution (inline) ─────────────────────────────────────

/**
 * Find (or create) the user's personal channel. Inlined here rather than
 * imported from @synap/api to avoid the jobs → api circular dependency
 * (see workers/index.ts note).
 *
 * Mirrors the shape created by ensurePersonalChannel in
 * packages/api/src/utils/personal-channel.ts. Returns the channel id.
 */
async function resolvePersonalChannelId(userId: string): Promise<string> {
  const existing = await db.query.channels.findFirst({
    where: and(
      eq(channels.userId, userId),
      eq(channels.channelType, ChannelType.THREAD),
      eq(channels.threadKind, ThreadKind.PERSONAL),
      eq(channels.status, ChannelStatus.ACTIVE)
    ),
    columns: { id: true },
  });
  if (existing) return existing.id;

  const [channel] = await db
    .insert(channels)
    .values({
      userId,
      workspaceId: null, // pod-wide
      channelType: ChannelType.THREAD,
      threadKind: ThreadKind.PERSONAL,
      scope: ChannelScope.POD,
      status: ChannelStatus.ACTIVE,
      senderAgentId: null,
    })
    .returning({ id: channels.id });
  return channel.id;
}

// ── Realtime broadcast (inline) ──────────────────────────────────────────────

/**
 * Fire-and-forget POST to the realtime bridge so connected clients update
 * immediately. Mirrors emitChatEvent from @synap/api without taking the
 * package dependency (jobs → api would be circular).
 */
function broadcastMessageCreated(options: {
  channelId: string;
  messageId: string;
  userId: string;
}): void {
  const url = `${process.env.REALTIME_URL || "http://localhost:4001"}/bridge/emit`;
  const body = JSON.stringify({
    event: "message:created",
    data: {
      channelId: options.channelId,
      messageId: options.messageId,
      userId: options.userId,
    },
    channelId: options.channelId,
    userId: options.userId,
  });

  // Don't await — realtime delivery is best-effort.
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.BRIDGE_SECRET
        ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
        : {}),
    },
    body,
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {
    // Silent — the message is already persisted; client will pick it up
    // on next fetch/polling cycle even if this POST fails.
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handleHydrationSummaryPost(
  job: PgBoss.Job<HydrationSummaryJob>
): Promise<void> {
  const { userId, data } = job.data;

  try {
    const content = generateHydrationSummary(data);
    const channelId = await resolvePersonalChannelId(userId);
    const messageId = randomUUID();
    const hash = createHash("sha256")
      .update(`${messageId}${content}`)
      .digest("hex");

    const metadata = {
      agentType: "orchestrator",
      source: "hydration-welcome",
      summary: {
        totalCreated: data.totalCreated,
        totalMatched: data.totalMatched,
        propertiesCreated: data.propertiesCreated,
      },
    };

    await db.insert(messages).values({
      id: messageId,
      channelId,
      role: MessageRole.ASSISTANT,
      authorType: MessageAuthorType.AI_AGENT,
      messageCategory: MessageCategory.CHAT,
      content,
      userId,
      previousHash: "",
      hash,
      metadata: metadata as (typeof messages.$inferInsert)["metadata"],
    });

    broadcastMessageCreated({ channelId, messageId, userId });

    logger.info(
      {
        userId,
        channelId,
        messageId,
        totalCreated: data.totalCreated,
        totalMatched: data.totalMatched,
      },
      "Hydration summary posted"
    );
  } catch (err) {
    // Best-effort worker — swallow errors so the user never sees one for
    // a welcome message.
    logger.warn(
      { err, userId },
      "hydration-summary-post failed (non-fatal, no retry)"
    );
  }
}
