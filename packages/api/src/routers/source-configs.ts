/**
 * Source Configs Router (tRPC)
 *
 * Pod-admin-gated management surface for the pluggable feed source system.
 * Every mutation runs through `podAdminProcedure` — the same gate used for
 * other Pod-administration tooling (raw DB, tool execution, event injection).
 *
 * Procedures:
 *   list             — all source_configs owned by this user
 *   listProviders    — metadata for every registered ISourceProvider
 *   create           — insert a new source_config
 *   update           — patch an existing source_config
 *   delete           — remove + cascade subscriptions + purge its secrets
 *   testConnection   — live-probe the config, persist lastTested*
 *
 * Vault contract (Phase 1 keep-simple):
 *   This router expects `vault://<uuid>/<field>` references to already exist
 *   in `input.config`. The caller (UI / CLI / CP) creates the secret through
 *   the secrets-vault router first and passes the resulting reference here.
 *   A future phase may accept inline secrets and create them transparently.
 */

import { z } from "zod";
import {
  db,
  eq,
  and,
  isNull,
  inArray,
  like,
  sql as drizzleSql,
} from "@synap/database";
import { sourceConfigs, secrets } from "@synap/database/schema";
import { router, podAdminProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  sourceProviderRegistry,
  type SourceProviderMeta,
} from "@synap/feed-service";
import { resolveVaultReferences } from "../utils/vault-resolver.js";

const logger = createLogger({ module: "source-configs-router" });

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Collect every string leaf in `config`, flatten to a `Record<string, string>`
 * keyed by JSON path, run the vault resolver, then rebuild the original shape
 * with plaintext leaves swapped in. Mirrors the helper in
 * jobs/feed-source-executor.ts — kept here so the router can probe configs
 * synchronously without having to re-implement on the executor side.
 */
async function resolveConfigVault(
  config: Record<string, unknown>,
  userId: string
): Promise<Record<string, unknown>> {
  const flat: Record<string, string> = {};
  const paths: Array<string[]> = [];

  function walk(node: unknown, path: string[]): void {
    if (typeof node === "string") {
      const key = path.join(".");
      flat[key] = node;
      paths.push(path);
    } else if (Array.isArray(node)) {
      node.forEach((child, idx) => walk(child, [...path, String(idx)]));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, [...path, k]);
      }
    }
  }
  walk(config, []);

  const resolved = await resolveVaultReferences(flat, userId);

  const out = structuredClone(config) as Record<string, unknown>;
  for (const path of paths) {
    const key = path.join(".");
    setByPath(out, path, resolved[key]);
  }
  return out;
}

function setByPath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  if (path.length === 0) return;
  let node: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (node == null) return;
    if (Array.isArray(node)) {
      node = node[Number.parseInt(path[i], 10)];
    } else if (typeof node === "object") {
      node = (node as Record<string, unknown>)[path[i]];
    }
  }
  const tail = path[path.length - 1];
  if (Array.isArray(node)) {
    node[Number.parseInt(tail, 10)] = value;
  } else if (node && typeof node === "object") {
    (node as Record<string, unknown>)[tail] = value;
  }
}

function toProviderMeta(meta: SourceProviderMeta) {
  return {
    type: meta.type,
    displayName: meta.displayName,
    description: meta.description,
    capabilities: meta.capabilities,
    // Zod schemas don't serialise cleanly over the wire — expose only the
    // high-level capability flags here. UI can fetch richer descriptors via
    // a follow-up RPC (e.g. JSON-Schema generation) in a later phase.
  };
}

// ── Input schemas ────────────────────────────────────────────────────────────

const configJsonSchema = z.record(z.string(), z.unknown());

const createInputSchema = z.object({
  providerType: z.string().min(1),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  config: configJsonSchema,
  workspaceId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
});

const updateInputSchema = z.object({
  id: z.string().uuid(),
  patch: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    config: configJsonSchema.optional(),
    enabled: z.boolean().optional(),
  }),
});

// ── Router ───────────────────────────────────────────────────────────────────

export const sourceConfigsRouter = router({
  /**
   * List every source_config owned by the caller. Admin-scope only.
   */
  list: podAdminProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select()
      .from(sourceConfigs)
      .where(eq(sourceConfigs.userId, ctx.userId));
    return rows;
  }),

  /**
   * Return metadata for every provider registered in the
   * SourceProviderRegistry. UI uses this to build the "new source" form.
   */
  listProviders: podAdminProcedure.query(() => {
    return sourceProviderRegistry.list().map(toProviderMeta);
  }),

  create: podAdminProcedure
    .input(createInputSchema)
    .mutation(async ({ input, ctx }) => {
      const provider = sourceProviderRegistry.get(input.providerType);
      if (!provider) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown providerType "${input.providerType}". Call listProviders to see supported types.`,
        });
      }

      // Validate the static shape of `config` against the provider's own
      // Zod schema. vault:// references are allowed as string leaves —
      // they'll be resolved at fetch time.
      const configParse = provider.meta.configSchema.safeParse(
        // For validation we need to swap vault:// strings for placeholder
        // strings that satisfy shape checks (otherwise .url() etc. would
        // reject "vault://..."). We only check structure here.
        replaceVaultRefsWithPlaceholders(input.config)
      );
      if (!configParse.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Config does not match provider schema: ${configParse.error.message}`,
        });
      }

      const [row] = await db
        .insert(sourceConfigs)
        .values({
          userId: ctx.userId,
          workspaceId: input.workspaceId ?? null,
          providerType: input.providerType,
          name: input.name,
          description: input.description,
          config: input.config,
          enabled: input.enabled ?? true,
        })
        .returning();

      logger.info(
        { sourceConfigId: row.id, providerType: input.providerType },
        "Source config created"
      );
      return row;
    }),

  update: podAdminProcedure
    .input(updateInputSchema)
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.sourceConfigs.findFirst({
        where: and(
          eq(sourceConfigs.id, input.id),
          eq(sourceConfigs.userId, ctx.userId)
        ),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Source config not found",
        });
      }

      // Re-validate config against the provider's schema if the caller
      // is changing it.
      if (input.patch.config) {
        const provider = sourceProviderRegistry.get(existing.providerType);
        if (provider) {
          const configParse = provider.meta.configSchema.safeParse(
            replaceVaultRefsWithPlaceholders(input.patch.config)
          );
          if (!configParse.success) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Config does not match provider schema: ${configParse.error.message}`,
            });
          }
        }
      }

      const [row] = await db
        .update(sourceConfigs)
        .set({
          name: input.patch.name ?? existing.name,
          description:
            input.patch.description === undefined
              ? existing.description
              : input.patch.description,
          config: input.patch.config ?? existing.config,
          enabled: input.patch.enabled ?? existing.enabled,
          updatedAt: new Date(),
        })
        .where(eq(sourceConfigs.id, input.id))
        .returning();
      return row;
    }),

  delete: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.sourceConfigs.findFirst({
        where: and(
          eq(sourceConfigs.id, input.id),
          eq(sourceConfigs.userId, ctx.userId)
        ),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Source config not found",
        });
      }

      // Cascade: source_subscriptions drop via FK CASCADE. Also purge any
      // secrets this source_config owns (they live under serviceId
      // "source:<id>" — the admin REST endpoint tags them this way).
      await db
        .delete(secrets)
        .where(eq(secrets.serviceId, `source:${input.id}`));

      await db.delete(sourceConfigs).where(eq(sourceConfigs.id, input.id));

      logger.info(
        { sourceConfigId: input.id },
        "Source config deleted (+ cascade)"
      );
      return { ok: true };
    }),

  testConnection: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.sourceConfigs.findFirst({
        where: and(
          eq(sourceConfigs.id, input.id),
          eq(sourceConfigs.userId, ctx.userId)
        ),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Source config not found",
        });
      }

      const provider = sourceProviderRegistry.get(existing.providerType);
      if (!provider) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `No provider registered for type "${existing.providerType}"`,
        });
      }

      let result: { ok: boolean; error?: string; sampleCount?: number };
      try {
        const resolved = await resolveConfigVault(
          existing.config as Record<string, unknown>,
          ctx.userId
        );
        result = await provider.testConnection(resolved);
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      await db
        .update(sourceConfigs)
        .set({
          lastTestedAt: new Date(),
          lastTestStatus: result.ok ? "ok" : "error",
          lastTestError: result.ok ? null : (result.error ?? "unknown error"),
          updatedAt: new Date(),
        })
        .where(eq(sourceConfigs.id, input.id));

      return result;
    }),
});

// ── Internal helpers — kept out of the exported surface ─────────────────────

/**
 * Replace every `vault://...` string leaf with a placeholder `"__vault__"`
 * before running a Zod schema check. Provider config schemas typically use
 * `.url()` or similar stricter rules that would reject the literal
 * `vault://<uuid>` reference even though it's meant to be resolved later.
 */
function replaceVaultRefsWithPlaceholders(
  config: Record<string, unknown>
): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.startsWith("vault://") ? "https://placeholder.vault" : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(config) as Record<string, unknown>;
}

// Dead-import guards used above (keep tree-shakers from dropping these if
// unused in a specific path). `inArray`, `isNull`, `like`, and `drizzleSql`
// are imported for potential future filters; mark them used here.
void inArray;
void isNull;
void like;
void drizzleSql;
