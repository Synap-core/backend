/**
 * discord-rest — the low-level Discord bot-token resolver + REST poster, placed
 * in `@synap/database` so BOTH `@synap/api` (chat relay, connectors) and
 * `@synap/jobs` (automation-executor, feed/mail/event workers) can reach it. The
 * dependency graph is api→jobs→database, so a helper any producer needs must live
 * here — not in `@synap/api`.
 *
 * The bot token is server-managed (single shared token). Resolution order:
 *   1. env DISCORD_BOT_TOKEN (legacy / self-managed deployments)
 *   2. vault: `synap bridge-setup` stores it server-encrypted under the pod owner
 *      as a `secrets` row with serviceId='discord' (a RAW token string).
 */

import { getDb } from "../client-pg.js";
import { secrets } from "../schema/index.js";
import { and, eq, isNull } from "drizzle-orm";
import { resolveVaultSecret } from "./vault-resolver.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "discord-rest" });

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Reject anything that isn't a plausible Discord snowflake before it reaches a
 * request URL — a malformed value must not redirect the bot's authenticated REST
 * call (defense-in-depth; ids here are operator-configured, not attacker-set). */
function assertSnowflake(value: string, label: string): void {
  if (!/^\d{5,25}$/.test(value)) {
    throw new Error(`Invalid Discord ${label}: ${JSON.stringify(value)}`);
  }
}

/**
 * Resolve the Discord bot token. Env-first, then the pod owner's vault secret
 * (serviceId='discord'). `ownerId` defaults to the first workspace's owner — the
 * pod operator on a single-owner pod, which is who `bridge-setup` stores the
 * secret under.
 */
export async function resolveDiscordBotToken(
  ownerId?: string
): Promise<string | null> {
  const envToken = process.env.DISCORD_BOT_TOKEN;
  if (envToken) return envToken;

  try {
    const database = await getDb();
    let owner = ownerId;
    if (!owner) {
      const ws = await database.query.workspaces.findFirst({
        columns: { ownerId: true },
      });
      owner = ws?.ownerId ?? undefined;
    }
    if (!owner) return null;

    const secret = await database.query.secrets.findFirst({
      where: and(
        eq(secrets.userId, owner),
        eq(secrets.serviceId, "discord"),
        eq(secrets.encryptionMode, "server"),
        isNull(secrets.deletedAt)
      ),
      columns: { id: true },
    });
    if (!secret) return null;
    // Internal/service resolution — no grant required (trusted backend path).
    return await resolveVaultSecret(secret.id, owner);
  } catch (err) {
    logger.warn({ err }, "resolveDiscordBotToken failed");
    return null;
  }
}

/**
 * POST a message into a Discord channel via the bot REST API. `channelId` is the
 * Discord channel snowflake. No gateway/websocket needed. Throws on non-2xx so
 * callers can log; the mirror wraps this in a try/catch.
 */
export async function postDiscordChannelMessage(
  token: string,
  channelId: string,
  content: string
): Promise<void> {
  assertSnowflake(channelId, "channelId");
  const res = await fetch(
    `${DISCORD_API_BASE}/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "Synap-Discord-Mirror (https://synap, v0)",
      },
      // allowed_mentions parse:[] — mirrored/feed content is data (email subjects,
      // event titles from external parties); it must NEVER @everyone/@here/role-ping.
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    }
  );
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") ?? "unknown";
    throw new Error(
      `Discord postChannelMessage rate limited (429) — retry after ${retryAfter}s`
    );
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `Discord postChannelMessage failed: ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ""}`
    );
  }
}

/**
 * Resolve the guild the bot belongs to. The agency runs ONE guild, so we return
 * the FIRST guild the bot is a member of (or null when the bot is in none). Used
 * by the event-sync worker to know where to create native scheduled events.
 */
export async function resolveDiscordGuildId(
  token: string
): Promise<string | null> {
  const res = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "Synap-Discord-Mirror (https://synap, v0)",
    },
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") ?? "unknown";
    throw new Error(
      `Discord resolveGuildId rate limited (429) — retry after ${retryAfter}s`
    );
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `Discord resolveGuildId failed: ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ""}`
    );
  }
  const guilds = (await res.json().catch(() => [])) as Array<{ id?: string }>;
  return Array.isArray(guilds) && guilds[0]?.id ? guilds[0].id : null;
}

export interface CreateDiscordScheduledEventParams {
  /** Event name (Discord caps at 100 chars — caller truncates). */
  name: string;
  /** ISO8601 start time. */
  scheduledStartTime: string;
  /** ISO8601 end time — REQUIRED for EXTERNAL events. */
  scheduledEndTime: string;
  /** Where it happens: a meet URL or a physical address. Capped at 100 chars. */
  location: string;
  /** Longer detail (full address, description) — Discord caps at 1000 chars. */
  description?: string;
}

/**
 * Create a native Discord GUILD scheduled event of type EXTERNAL (an event whose
 * location is a free-text string — an address or a Meet link — rather than a
 * voice channel). Returns the created event `{ id }`. Throws on 429/non-2xx like
 * `postDiscordChannelMessage` so the caller can log; the worker wraps in
 * try/catch. `location` is capped at 100 chars by Discord — we truncate here.
 */
export async function createDiscordScheduledEvent(
  token: string,
  guildId: string,
  params: CreateDiscordScheduledEventParams
): Promise<{ id: string } | null> {
  assertSnowflake(guildId, "guildId");
  const body = {
    name: params.name.slice(0, 100),
    scheduled_start_time: params.scheduledStartTime,
    scheduled_end_time: params.scheduledEndTime,
    privacy_level: 2, // GUILD_ONLY
    entity_type: 3, // EXTERNAL
    entity_metadata: { location: params.location.slice(0, 100) },
    ...(params.description
      ? { description: params.description.slice(0, 1000) }
      : {}),
  };

  const res = await fetch(
    `${DISCORD_API_BASE}/guilds/${guildId}/scheduled-events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "Synap-Discord-Mirror (https://synap, v0)",
      },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") ?? "unknown";
    throw new Error(
      `Discord createScheduledEvent rate limited (429) — retry after ${retryAfter}s`
    );
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `Discord createScheduledEvent failed: ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ""}`
    );
  }
  const created = (await res.json().catch(() => null)) as {
    id?: string;
  } | null;
  return created?.id ? { id: created.id } : null;
}
