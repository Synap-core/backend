/**
 * Telegram Bot Token Resolution
 *
 * 3-tier resolution chain:
 *   1. Secrets vault (user-configured, server-encrypted) — self-hosted users
 *   2. workspace.settings.controlPlane.telegramBotToken — CP-provisioned cloud users
 *   3. process.env.TELEGRAM_BOT_TOKEN — dev / simple deployments
 *
 * Result is cached in-memory for 5 minutes to avoid repeated DB queries.
 */

import { db, eq, and, isNull, like } from "@synap/database";
import { secrets, workspaces } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  decryptServerSide,
  isServerVaultAvailable,
  type ServerEncryptedBlob,
} from "./server-vault.js";

const logger = createLogger({ module: "telegram-bot-token" });

// ---------------------------------------------------------------------------
// In-memory cache (token + timestamp)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cached: { token: string; resolvedAt: number } | null = null;

/** Clear the cache (useful after settings changes or tests). */
export function clearTelegramTokenCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Telegram bot token using the 3-tier chain:
 *   vault secret -> workspace setting -> env var.
 *
 * Returns `null` when no token is available at any tier.
 */
export async function resolveTelegramBotToken(): Promise<string | null> {
  // Return cached value if still fresh
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return cached.token;
  }

  let token: string | null = null;

  // --- Tier 1: Secrets vault (server-encrypted) ---
  token = await resolveFromVault();
  if (token) {
    logger.debug("Telegram bot token resolved from secrets vault");
    cached = { token, resolvedAt: Date.now() };
    return token;
  }

  // --- Tier 2: Workspace settings (CP-provisioned) ---
  token = await resolveFromWorkspaceSettings();
  if (token) {
    logger.debug(
      "Telegram bot token resolved from workspace.settings.controlPlane"
    );
    cached = { token, resolvedAt: Date.now() };
    return token;
  }

  // --- Tier 3: Environment variable fallback ---
  token = process.env.TELEGRAM_BOT_TOKEN ?? null;
  if (token) {
    logger.debug("Telegram bot token resolved from environment variable");
    cached = { token, resolvedAt: Date.now() };
    return token;
  }

  logger.warn("Telegram bot token not found in any tier");
  return null;
}

// ---------------------------------------------------------------------------
// Tier 1 — Secrets Vault
// ---------------------------------------------------------------------------

async function resolveFromVault(): Promise<string | null> {
  if (!isServerVaultAvailable()) {
    return null;
  }

  try {
    const rows = await db
      .select({
        encryptedData: secrets.encryptedData,
        iv: secrets.iv,
        authTag: secrets.authTag,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.category, "integrations"),
          like(secrets.name, "%telegram%bot%"),
          eq(secrets.encryptionMode, "server"),
          isNull(secrets.deletedAt)
        )
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0]!;
    const blob: ServerEncryptedBlob = {
      encryptedData: row.encryptedData,
      iv: row.iv,
      authTag: row.authTag,
    };

    const decrypted = decryptServerSide(blob);

    // The encrypted payload may be a raw token string or a JSON object
    // with a "token" / "value" / "botToken" field.
    const trimmed = decrypted.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const val =
          (parsed.token as string) ??
          (parsed.value as string) ??
          (parsed.botToken as string);
        return typeof val === "string" && val.length > 0 ? val : null;
      } catch {
        // Not valid JSON — treat as raw token
      }
    }

    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    logger.warn({ err }, "Failed to resolve Telegram bot token from vault");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Workspace Settings (controlPlane.telegramBotToken)
// ---------------------------------------------------------------------------

async function resolveFromWorkspaceSettings(): Promise<string | null> {
  try {
    const rows = await db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(isNull(workspaces.deletedAt))
      .limit(5); // pods usually have 1-2 workspaces; check a few

    for (const row of rows) {
      const settings = row.settings as Record<string, unknown> | null;
      if (!settings) continue;

      const cp = settings.controlPlane as Record<string, unknown> | undefined;
      if (!cp) continue;

      const token = cp.telegramBotToken;
      if (typeof token === "string" && token.length > 0) {
        return token;
      }
    }

    return null;
  } catch (err) {
    logger.warn(
      { err },
      "Failed to resolve Telegram bot token from workspace settings"
    );
    return null;
  }
}
