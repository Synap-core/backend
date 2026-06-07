/**
 * AI Provider Credentials Router
 *
 * Per-workspace and per-user API key overrides for AI providers.
 * Resolution order: user-level > workspace-level > pod-wide.
 *
 * Keys are stored server-side encrypted (encryptServiceKey) so the backend
 * can decrypt and forward them to the IS at request time.
 */

import { z } from "zod";
import { router, podProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, isNull, inArray } from "@synap/database";
import {
  aiProviderCredentials,
  aiProviders,
  workspaceMembers,
} from "@synap/database/schema";
import {
  encryptServiceKey,
  decryptServiceKey,
  isEncryptedServiceKey,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "ai-provider-credentials" });

function getUserId(ctx: unknown): string | undefined {
  return (ctx as { userId?: string }).userId;
}

function decrypt(encrypted: string): string {
  return isEncryptedServiceKey(encrypted)
    ? decryptServiceKey(encrypted)
    : encrypted;
}

/** Strip the encrypted key from a credential row, exposing only its presence. */
function toPublicCredential<T extends { encryptedApiKey: string }>(
  row: T
): Omit<T, "encryptedApiKey"> & { hasApiKey: true } {
  const { encryptedApiKey: _k, ...rest } = row;
  return { ...rest, hasApiKey: true };
}

/** Look up a provider by id, throwing NOT_FOUND if it doesn't exist. */
async function assertProviderExists(providerId: string): Promise<void> {
  const provider = await db.query.aiProviders.findFirst({
    where: eq(aiProviders.providerId, providerId),
  });
  if (!provider) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Provider not found: ${providerId}`,
    });
  }
}

// ── Credential resolution ─────────────────────────────────────────────────

/**
 * Resolve the best API key for a single provider given the request context.
 * Returns the plaintext key or null if no override exists.
 * Order: per-user > per-workspace > null (caller falls back to pod-wide)
 */
export async function resolveProviderCredential(
  providerId: string,
  workspaceId?: string,
  userId?: string
): Promise<string | null> {
  if (userId) {
    const userCred = await db.query.aiProviderCredentials.findFirst({
      where: and(
        eq(aiProviderCredentials.providerId, providerId),
        eq(aiProviderCredentials.userId, userId),
        eq(aiProviderCredentials.enabled, true)
      ),
    });
    if (userCred) return decrypt(userCred.encryptedApiKey);
  }

  if (workspaceId) {
    const wsCred = await db.query.aiProviderCredentials.findFirst({
      where: and(
        eq(aiProviderCredentials.providerId, providerId),
        eq(aiProviderCredentials.workspaceId, workspaceId as any),
        isNull(aiProviderCredentials.userId),
        eq(aiProviderCredentials.enabled, true)
      ),
    });
    if (wsCred) return decrypt(wsCred.encryptedApiKey);
  }

  return null;
}

/**
 * Batch variant of resolveProviderCredential — 2 queries total regardless of
 * how many providers are in the list (vs 2×N with the single-provider version).
 * Returns a map of providerId → decrypted key (null = no override, fall back to pod-wide).
 */
export async function resolveProviderCredentialsBatch(
  providerIds: string[],
  workspaceId?: string,
  userId?: string
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>(
    providerIds.map((id) => [id, null])
  );
  if (providerIds.length === 0) return result;

  if (userId) {
    const userCreds = await db
      .select({
        providerId: aiProviderCredentials.providerId,
        encryptedApiKey: aiProviderCredentials.encryptedApiKey,
      })
      .from(aiProviderCredentials)
      .where(
        and(
          inArray(aiProviderCredentials.providerId, providerIds),
          eq(aiProviderCredentials.userId, userId),
          eq(aiProviderCredentials.enabled, true)
        )
      );
    for (const c of userCreds) {
      result.set(c.providerId, decrypt(c.encryptedApiKey));
    }
  }

  const needsWorkspace = providerIds.filter((id) => result.get(id) === null);
  if (workspaceId && needsWorkspace.length > 0) {
    const wsCreds = await db
      .select({
        providerId: aiProviderCredentials.providerId,
        encryptedApiKey: aiProviderCredentials.encryptedApiKey,
      })
      .from(aiProviderCredentials)
      .where(
        and(
          inArray(aiProviderCredentials.providerId, needsWorkspace),
          eq(aiProviderCredentials.workspaceId, workspaceId as any),
          isNull(aiProviderCredentials.userId),
          eq(aiProviderCredentials.enabled, true)
        )
      );
    for (const c of wsCreds) {
      result.set(c.providerId, decrypt(c.encryptedApiKey));
    }
  }

  return result;
}

// ── Input schemas ─────────────────────────────────────────────────────────

const SetCredentialSchema = z.object({
  providerId: z.string().min(1),
  apiKey: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).default(10),
});

// ── Auth helpers ──────────────────────────────────────────────────────────

async function assertWorkspaceMember(
  userId: string,
  workspaceId: string
): Promise<void> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId as any),
      eq(workspaceMembers.userId, userId)
    ),
  });
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Not a member of this workspace",
    });
  }
}

async function assertWorkspaceAdmin(
  userId: string,
  workspaceId: string
): Promise<void> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId as any),
      eq(workspaceMembers.userId, userId),
      inArray(workspaceMembers.role, ["admin", "owner"])
    ),
  });
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Workspace admin role required",
    });
  }
}

// ── Router ────────────────────────────────────────────────────────────────

export const aiProviderCredentialsRouter = router({
  // ── Workspace-level ────────────────────────────────────────────────────

  listForWorkspace: podProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });
      await assertWorkspaceMember(userId, input.workspaceId);

      const rows = await db.query.aiProviderCredentials.findMany({
        where: and(
          eq(aiProviderCredentials.workspaceId, input.workspaceId as any),
          isNull(aiProviderCredentials.userId)
        ),
        orderBy: (t, { asc }) => [asc(t.priority)],
      });
      return rows.map(toPublicCredential);
    }),

  upsertForWorkspace: podProcedure
    .input(SetCredentialSchema.extend({ workspaceId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });
      await assertWorkspaceAdmin(userId, input.workspaceId);
      await assertProviderExists(input.providerId);

      const encryptedApiKey = encryptServiceKey(input.apiKey);
      const now = new Date();

      const existing = await db.query.aiProviderCredentials.findFirst({
        where: and(
          eq(aiProviderCredentials.providerId, input.providerId),
          eq(aiProviderCredentials.workspaceId, input.workspaceId as any),
          isNull(aiProviderCredentials.userId)
        ),
      });

      if (existing) {
        await db
          .update(aiProviderCredentials)
          .set({
            encryptedApiKey,
            enabled: input.enabled,
            priority: input.priority,
            updatedAt: now,
          })
          .where(eq(aiProviderCredentials.id, existing.id));
        logger.info(
          { providerId: input.providerId, workspaceId: input.workspaceId },
          "Workspace credential updated"
        );
      } else {
        await db.insert(aiProviderCredentials).values({
          providerId: input.providerId,
          workspaceId: input.workspaceId as any,
          userId: null,
          encryptedApiKey,
          enabled: input.enabled,
          priority: input.priority,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        });
        logger.info(
          { providerId: input.providerId, workspaceId: input.workspaceId },
          "Workspace credential created"
        );
      }

      return { ok: true };
    }),

  removeForWorkspace: podProcedure
    .input(z.object({ workspaceId: z.string().uuid(), providerId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });
      await assertWorkspaceAdmin(userId, input.workspaceId);

      await db
        .delete(aiProviderCredentials)
        .where(
          and(
            eq(aiProviderCredentials.providerId, input.providerId),
            eq(aiProviderCredentials.workspaceId, input.workspaceId as any),
            isNull(aiProviderCredentials.userId)
          )
        );
      logger.info(
        { providerId: input.providerId, workspaceId: input.workspaceId },
        "Workspace credential removed"
      );
      return { ok: true };
    }),

  // ── User-level ─────────────────────────────────────────────────────────

  listForUser: podProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);
    if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });

    const rows = await db.query.aiProviderCredentials.findMany({
      where: eq(aiProviderCredentials.userId, userId),
      orderBy: (t, { asc }) => [asc(t.priority)],
    });
    return rows.map(toPublicCredential);
  }),

  upsertForUser: podProcedure
    .input(
      SetCredentialSchema.extend({ workspaceId: z.string().uuid().optional() })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });
      await assertProviderExists(input.providerId);

      const encryptedApiKey = encryptServiceKey(input.apiKey);
      const now = new Date();

      const existing = await db.query.aiProviderCredentials.findFirst({
        where: and(
          eq(aiProviderCredentials.providerId, input.providerId),
          eq(aiProviderCredentials.userId, userId)
        ),
      });

      if (existing) {
        await db
          .update(aiProviderCredentials)
          .set({
            encryptedApiKey,
            enabled: input.enabled,
            priority: input.priority,
            updatedAt: now,
          })
          .where(eq(aiProviderCredentials.id, existing.id));
        logger.info(
          { providerId: input.providerId, userId },
          "User credential updated"
        );
      } else {
        await db.insert(aiProviderCredentials).values({
          providerId: input.providerId,
          workspaceId: (input.workspaceId as any) ?? null,
          userId,
          encryptedApiKey,
          enabled: input.enabled,
          priority: input.priority,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        });
        logger.info(
          { providerId: input.providerId, userId },
          "User credential created"
        );
      }

      return { ok: true };
    }),

  removeForUser: podProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      if (!userId) throw new TRPCError({ code: "UNAUTHORIZED" });

      await db
        .delete(aiProviderCredentials)
        .where(
          and(
            eq(aiProviderCredentials.providerId, input.providerId),
            eq(aiProviderCredentials.userId, userId)
          )
        );
      logger.info(
        { providerId: input.providerId, userId },
        "User credential removed"
      );
      return { ok: true };
    }),
});
