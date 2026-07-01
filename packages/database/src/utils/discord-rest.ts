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
  const res = await fetch(
    `${DISCORD_API_BASE}/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "Synap-Discord-Mirror (https://synap, v0)",
      },
      body: JSON.stringify({ content }),
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
