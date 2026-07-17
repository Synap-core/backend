/**
 * AI Providers Router
 *
 * Pod-level CRUD for AI model provider configurations.
 * Source of truth lives in the `ai_providers` table — decoupled from workspaces
 * and IntelligenceSystems. Every write syncs the full config to the active IS
 * via its admin HTTP API so the IS hot-reloads without a restart.
 *
 * API keys are stored server-side encrypted (encryptServiceKey) and sent to
 * the IS inline (provider.apiKey field) — the IS uses the inline key when
 * present instead of reading from its own env.
 */

import { z } from "zod";
import { router, podProcedure, podAdminProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, drizzleSql } from "@synap/database";
import { aiProviders } from "@synap/database/schema";
import { encryptServiceKey } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  pushProvidersToIS,
  resolveISAdminEndpoint,
} from "../utils/push-providers-to-is.js";

const logger = createLogger({ module: "ai-providers" });

// ── IS admin push ─────────────────────────────────────────────────────────
// Payload construction + endpoint/key resolution live in the shared
// pushProvidersToIS() door. The CRUD mutations treat the sync as best-effort:
// the DB write has already committed, so an IS that is down must not fail the
// request — log and move on.

async function syncToIS(): Promise<void> {
  try {
    await pushProvidersToIS();
  } catch (err) {
    logger.warn({ err }, "IS provider sync failed (IS may be down)");
  }
}

// ── Input schemas ─────────────────────────────────────────────────────────

const ModelEntrySchema = z.object({
  id: z.string(),
  tier: z.enum(["free", "balanced", "advanced", "complex"]).optional(),
  contextWindow: z.number().optional(),
  supportsTools: z.boolean().optional(),
  supportsJson: z.boolean().optional(),
  costPer1MInput: z.number().optional(),
  costPer1MOutput: z.number().optional(),
});

const UpsertSchema = z.object({
  providerId: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  baseUrl: z.string().url(),
  apiKeyEnvVar: z.string().min(1),
  /** Plaintext API key — encrypted before storage, never returned */
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).default(10),
  tags: z.array(z.string()).default([]),
  models: z.array(ModelEntrySchema).default([]),
  rateLimit: z
    .object({ rpm: z.number(), rpd: z.number().optional() })
    .optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  systemPromptPrefix: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

// ── Router ────────────────────────────────────────────────────────────────

export const aiProvidersRouter = router({
  /**
   * List all providers. API keys are never returned.
   */
  list: podProcedure.query(async () => {
    const rows = await db.query.aiProviders.findMany({
      orderBy: (t, { asc }) => [asc(t.priority)],
    });
    return rows.map(({ encryptedApiKey: _k, ...p }) => ({
      ...p,
      hasApiKey: !!_k,
    }));
  }),

  /**
   * Create or update a provider (upsert by providerId).
   * Encrypts the API key and syncs the full config to the IS.
   */
  upsert: podAdminProcedure.input(UpsertSchema).mutation(async ({ input }) => {
    const { apiKey, ...rest } = input;

    const existing = await db.query.aiProviders.findFirst({
      where: eq(aiProviders.providerId, input.providerId),
    });

    const encryptedApiKey = apiKey
      ? encryptServiceKey(apiKey)
      : (existing?.encryptedApiKey ?? null);

    const now = new Date();

    if (existing) {
      await db
        .update(aiProviders)
        .set({ ...rest, encryptedApiKey, updatedAt: now })
        .where(eq(aiProviders.providerId, input.providerId));
      logger.info({ providerId: input.providerId }, "Provider updated");
    } else {
      await db.insert(aiProviders).values({
        ...rest,
        encryptedApiKey,
        createdAt: now,
        updatedAt: now,
      });
      logger.info({ providerId: input.providerId }, "Provider created");
    }

    await syncToIS();

    const row = await db.query.aiProviders.findFirst({
      where: eq(aiProviders.providerId, input.providerId),
    });
    const { encryptedApiKey: _k, ...safe } = row!;
    return { ...safe, hasApiKey: !!_k };
  }),

  /**
   * Enable a provider and sync to IS.
   */
  enable: podAdminProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ input }) => {
      const existing = await db.query.aiProviders.findFirst({
        where: eq(aiProviders.providerId, input.providerId),
      });
      if (!existing)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Provider not found: ${input.providerId}`,
        });

      await db
        .update(aiProviders)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(aiProviders.providerId, input.providerId));

      await syncToIS();
      return { ok: true };
    }),

  /**
   * Disable a provider and sync to IS.
   */
  disable: podAdminProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ input }) => {
      const existing = await db.query.aiProviders.findFirst({
        where: eq(aiProviders.providerId, input.providerId),
      });
      if (!existing)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Provider not found: ${input.providerId}`,
        });

      await db
        .update(aiProviders)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(aiProviders.providerId, input.providerId));

      await syncToIS();
      return { ok: true };
    }),

  /**
   * Remove a provider and sync to IS.
   */
  remove: podAdminProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(aiProviders)
        .where(eq(aiProviders.providerId, input.providerId));

      await syncToIS();
      return { ok: true };
    }),

  /**
   * Probe a provider via the IS admin API (live connectivity test).
   * Returns latency + discovered model list.
   */
  probe: podProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ input }) => {
      const { endpoint, adminKey } = await resolveISAdminEndpoint();
      if (!adminKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "IS not configured",
        });
      }

      const res = await fetch(
        `${endpoint}/admin/providers/${input.providerId}/test`,
        {
          method: "POST",
          headers: { "X-Admin-Key": adminKey },
          signal: AbortSignal.timeout(15_000),
        }
      ).catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: String(err),
        });
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `IS probe failed: ${res.status} ${text}`,
        });
      }

      return res.json() as Promise<{
        ok: boolean;
        models: string[];
        latencyMs: number;
        error?: string;
      }>;
    }),

  /**
   * Re-push all providers to the IS (idempotent, safe after IS redeploy).
   */
  sync: podAdminProcedure.mutation(async () => {
    await syncToIS();
    const [{ count }] = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(aiProviders);
    return { ok: true, count };
  }),
});
