/**
 * Marketplace — the pod's OWN catalog door for human surfaces (Pod Console
 * first). The pod owns the catalog: every read here is the pod-local
 * `cp_catalog_cache` (synced from each configured source every 10 minutes by
 * `cp-catalog-sync`), and every install is the ONE install core the
 * `market.search` / `market.install` builtin verbs already run. Nothing here
 * talks to a source on the browse path, so the catalog stays readable while a
 * source is down (the last synced copy) and a source failure can never look
 * like a sign-out.
 *
 *   list       — browse/search the cache, with each source and when it last synced
 *   get        — one entry plus its definition, resolved on demand exactly as
 *                the install resolves it (package rows cache `definition: null`)
 *   preflight  — what the install would change, before anything is written
 *   install    — `runMarketInstall`: a person installs directly; an agent's
 *                call files the same `capability.install` proposal
 *                `market.install` files. Any other key is refused.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  db,
  catalogSyncStampKey,
  getCatalogSyncStamps,
  getWorkspaceMembership,
  preflightWorkspaceFromDefinition,
  type CatalogSyncStamp,
  type WorkspaceDefinitionInput,
  type WorkspacePreflightReport,
} from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import { CATALOG_KINDS, catalogSources, type CatalogKind } from "@synap/jobs";
import { router, protectedProcedure } from "../trpc.js";
import { queryCatalogCache } from "../services/capabilities/catalog-cache-query.js";
import {
  lookupCatalogEntry,
  resolveCatalogDefinition,
  runMarketInstall,
  type MarketInstallOutcome,
} from "../services/capabilities/marketplace-install.js";
import {
  summarizeMarketInstall,
  type MarketInstallSummary,
} from "../services/capabilities/market-preflight.js";
import { resolvePreflightComposeTarget } from "../services/preflight-compose-target.js";
import { assertPackageTierAccess } from "../utils/tier-check.js";

const kindSchema = z.enum(
  CATALOG_KINDS as unknown as [CatalogKind, ...CatalogKind[]]
);

/**
 * The registry kind (`@synap-core/types/vocabulary`) that names each catalog
 * kind to a person. The cache keeps the sync's own tokens; a `template` IS a
 * space package, so a surface draws it with the `workspace` noun and icon.
 */
const OBJECT_KIND: Record<CatalogKind, string> = {
  capability: "capability",
  automation: "automation",
  template: "workspace",
  cell: "cell",
  skill: "skill",
  view: "view",
};

const targetSchema = z.object({
  kind: kindSchema,
  slug: z.string().min(1).max(200),
  /** The catalog source; required only when several sources carry the slug. */
  source: z.string().min(1).max(500).optional(),
});

export interface MarketplaceSource {
  /** The provider base URL rows are keyed by. */
  source: string;
  name: string;
  /** Configured on this pod now (vs rows left from a source since removed). */
  configured: boolean;
  /** Newest sync attempt across kinds; null when it never synced. */
  lastSyncAt: string | null;
  /** True when every kind's latest attempt could not reach the source. */
  unreachable: boolean;
}

/**
 * A person-facing name for a source. Every configured source today is the
 * Synap Control Plane (`catalogSources`); anything else is named by its host,
 * never dressed up as an identity the pod cannot verify.
 */
function sourceName(source: string, configured: boolean): string {
  if (configured) return "Synap";
  try {
    return new URL(source).host || source;
  } catch {
    return source;
  }
}

async function listSources(): Promise<MarketplaceSource[]> {
  const configured = catalogSources();
  const [cached, stamps] = await Promise.all([
    db.selectDistinct({ source: cpCatalogCache.source }).from(cpCatalogCache),
    // A stamp read that fails is "never synced", not an error page.
    getCatalogSyncStamps().catch((): Record<string, CatalogSyncStamp> => ({})),
  ]);
  const all = [
    ...new Set([...configured, ...cached.map((r) => r.source)]),
  ].sort();
  return all.map((source) => {
    const own = CATALOG_KINDS.flatMap((kind) => {
      const stamp = stamps[catalogSyncStampKey(source, kind)];
      return stamp ? [stamp] : [];
    });
    const lastSyncAt =
      own
        .map((s) => s.lastSyncAt)
        .sort()
        .at(-1) ?? null;
    const isConfigured = configured.includes(source);
    return {
      source,
      name: sourceName(source, isConfigured),
      configured: isConfigured,
      lastSyncAt,
      unreachable:
        own.length > 0 && own.every((s) => s.lastStatus === "unreachable"),
    };
  });
}

/** The caller's own membership, or a refusal — never an install into a stranger's space. */
async function assertMember(workspaceId: string, userId: string) {
  const membership = await getWorkspaceMembership(db, workspaceId, userId);
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of that space.",
    });
  }
}

export interface MarketplacePreflight extends MarketInstallSummary {
  kind: CatalogKind;
  slug: string;
  source: string | null;
  name: string;
  version: string | null;
  /** False when something below must change before the install can run. */
  ok: boolean;
  /** Plain sentences naming what stops the install. */
  blockers: string[];
  /** Template only: the write-free workspace plan (profiles, links, views). */
  report: WorkspacePreflightReport | null;
}

export const marketplaceRouter = router({
  /**
   * Browse the pod's catalog. Ranked by the shared term matcher when `query`
   * is set, alphabetical otherwise; offset-paged by `cursor`.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          query: z.string().max(200).optional(),
          kind: kindSchema.optional(),
          source: z.string().min(1).max(500).optional(),
          limit: z.number().int().min(1).max(100).default(60),
          cursor: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 60;
      const offset = input?.cursor ?? 0;
      const query = input?.query?.trim() || undefined;
      const [matches, sources] = await Promise.all([
        queryCatalogCache({
          query,
          kind: input?.kind,
          source: input?.source,
          // Every match: the page is cut below, after the total is known.
          limit: query ? Number.POSITIVE_INFINITY : undefined,
        }),
        listSources(),
      ]);
      const ordered = query
        ? matches
        : [...matches].sort(
            (a, b) =>
              a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)
          );
      const names = new Map(sources.map((s) => [s.source, s.name]));
      const page = ordered.slice(offset, offset + limit);
      return {
        entries: page.map((e) => ({
          source: e.source,
          sourceName: names.get(e.source) ?? e.source,
          kind: e.kind,
          objectKind: OBJECT_KIND[e.kind],
          slug: e.slug,
          name: e.name,
          description: e.description,
          version: e.version,
          tier: e.tier,
          vendor: e.vendor,
          tags: e.tags,
        })),
        total: ordered.length,
        nextCursor:
          offset + page.length < ordered.length ? offset + page.length : null,
        kinds: CATALOG_KINDS.map((kind) => ({
          kind,
          objectKind: OBJECT_KIND[kind],
        })),
        sources,
      };
    }),

  /**
   * One entry and its definition. A definition the source cannot serve right
   * now is reported in `definitionError` beside the cached row, so the page
   * still shows what the pod knows.
   */
  get: protectedProcedure.input(targetSchema).query(async ({ input }) => {
    const entry = await lookupCatalogEntry(
      input.kind,
      input.slug,
      input.source
    );
    if (!entry) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `"${input.slug}" is not in this pod's catalog.`,
      });
    }
    let definition: Record<string, unknown> | null = null;
    let definitionError: string | null = null;
    try {
      definition = await resolveCatalogDefinition(
        input.kind,
        input.slug,
        entry
      );
    } catch (err) {
      definitionError =
        err instanceof Error ? err.message : "The definition is unavailable.";
    }
    const [sources, installed] = await Promise.all([
      listSources(),
      import("../services/capabilities/builtin-verbs.js").then((m) =>
        m.resolveInstalledFlag(input.kind, input.slug)
      ),
    ]);
    const source = sources.find((s) => s.source === entry.source) ?? null;
    return {
      source: entry.source,
      sourceName: source?.name ?? entry.source,
      sourceConfigured: source?.configured ?? false,
      kind: input.kind,
      objectKind: OBJECT_KIND[input.kind],
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      tier: entry.tier,
      vendor: entry.vendor,
      /** `undefined` when the pod cannot tell cheaply — never a guess. */
      installed: installed ?? null,
      definition,
      definitionError,
    };
  }),

  /**
   * What installing this entry would change — read-only. A template runs the
   * workspace preflight core (`preflightWorkspaceFromDefinition`, the same one
   * `workspaces.preflightFromDefinition` wraps); every kind gets the facts the
   * install reads from its definition (`summarizeMarketInstall`).
   */
  preflight: protectedProcedure
    .input(targetSchema.extend({ workspaceId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }): Promise<MarketplacePreflight> => {
      const entry = await lookupCatalogEntry(
        input.kind,
        input.slug,
        input.source
      );
      const definition = await resolveCatalogDefinition(
        input.kind,
        input.slug,
        entry
      );
      if (!definition) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `"${input.slug}" has no installable definition in the catalog right now.`,
        });
      }

      const summary = summarizeMarketInstall(input.kind, definition);
      const blockers: string[] = [];
      try {
        await assertPackageTierAccess(ctx.userId, input.slug);
      } catch (err) {
        if (!(err instanceof TRPCError) || err.code !== "FORBIDDEN") throw err;
        blockers.push(err.message);
      }
      if (input.workspaceId) {
        await assertMember(input.workspaceId, ctx.userId);
      } else if (summary.workspace === "required") {
        blockers.push("Choose the space to add it to.");
      }
      // Required `params` are not blockers: the confirm step collects them.

      let report: WorkspacePreflightReport | null = null;
      if (input.kind === "template") {
        report = await preflightWorkspaceFromDefinition({
          definition: definition as unknown as WorkspaceDefinitionInput,
          userId: ctx.userId,
          composeTarget: await resolvePreflightComposeTarget({
            definition: definition as {
              dependencies?: Array<{
                slug: string;
                kind?: string;
                relation?: string;
              }>;
            },
            userId: ctx.userId,
          }),
        });
        if (!report.ok) {
          blockers.push(
            "This package would not apply cleanly to your pod — see the conflicts below."
          );
        }
      }

      return {
        ...summary,
        kind: input.kind,
        slug: input.slug,
        source: entry?.source ?? input.source ?? null,
        name: entry?.name ?? input.slug,
        version: entry?.version ?? null,
        ok: blockers.length === 0,
        blockers,
        report,
      };
    }),

  /**
   * Install. A person (a signed-in session, no key) installs directly through
   * `runMarketInstall`; an agent's call files the `capability.install`
   * proposal exactly as `market.install` does (`status: "proposed"`). Any
   * other key — an app or service key — is refused: installing is a person's
   * decision or a reviewable proposal, never a silent key action.
   */
  install: protectedProcedure
    .input(
      targetSchema.extend({
        workspaceId: z.string().uuid().optional(),
        version: z.string().max(100).optional(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }): Promise<MarketInstallOutcome> => {
      const agentUserId = ctx.agentUserId ?? null;
      if (!agentUserId && (!ctx.session || ctx.keyType || ctx.isHubProtocol)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Install from the marketplace while signed in.",
        });
      }
      if (input.workspaceId) await assertMember(input.workspaceId, ctx.userId);
      return runMarketInstall({
        kind: input.kind,
        slug: input.slug,
        source: input.source,
        version: input.version,
        params: input.params,
        userId: ctx.userId,
        workspaceId: input.workspaceId ?? null,
        agentUserId,
      });
    }),
});
