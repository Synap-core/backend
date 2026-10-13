/**
 * Marketplace — the pod's OWN catalog door for human surfaces (Pod Console
 * first). The pod owns the catalog: every read here is the pod-local
 * `cp_catalog_cache` (synced from each enabled source every 10 minutes by
 * `cp-catalog-sync`), and every install is the ONE install core the
 * `market.search` / `market.install` builtin verbs already run. Nothing here
 * talks to a source on the browse path, so the catalog stays readable while a
 * source is down (the last verified copy) and a source failure can never look
 * like a sign-out.
 *
 *   list       — browse/search the cache across the sources that may serve now
 *   get        — one entry plus its definition, resolved on demand exactly as
 *                the install resolves it (never fetched for a showcase source)
 *   preflight  — what the install would change, and what it brings (code,
 *                network reach, connectors), before anything is written
 *   install    — `runMarketInstall`: the source's trust level decides; a person
 *                installs (confirming code / network reach from a trusted
 *                source), an agent proposes where allowed. Any other key is
 *                refused.
 *   sources.*  — where the catalog comes from (Pod Console D11). Reading is for
 *                pod admins; CHANGING a source (add, trust, key re-approval,
 *                switch, remove) is for a signed-in PERSON who administers the
 *                pod — never an agent, never a key.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  db,
  drizzleSql,
  isNull,
  catalogSyncStampKey,
  getCatalogSyncStamps,
  getWorkspaceMembership,
  preflightWorkspaceFromDefinition,
  updateMarketplaceSources,
  clearMarketplaceSourceStatus,
  recordMarketplaceSourceStatus,
  type CatalogSyncStamp,
  type MarketplaceSourceSetting,
  type WorkspaceDefinitionInput,
  type WorkspacePreflightReport,
} from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import {
  CATALOG_KINDS,
  deleteSourceRows,
  fetchSourceIndex,
  syncCatalogSourceNow,
  verifyIndex,
  type CatalogKind,
} from "@synap/jobs";
import {
  ADDABLE_TRUST_LEVELS,
  OFFICIAL_SOURCE_ID,
  decideMarketInstall,
  normalizeKeyFingerprint,
  qualifiedPackageId,
  type MarketplaceTrust,
} from "@synap-core/types/marketplace-source";
import { router, protectedProcedure, podAdminProcedure } from "../trpc.js";
import { queryCatalogCache } from "../services/capabilities/catalog-cache-query.js";
import {
  lookupCatalogEntry,
  resolveCatalogDefinition,
  runMarketInstall,
  type MarketInstallOutcome,
} from "../services/capabilities/marketplace-install.js";
import {
  listMarketSources,
  type MarketSourceView,
} from "../services/capabilities/market-sources.js";
import {
  summarizeMarketInstall,
  type MarketInstallSummary,
} from "../services/capabilities/market-preflight.js";
import {
  assessMarketRisks,
  requiredAcknowledgements,
  type MarketRisks,
} from "../services/capabilities/market-risk.js";
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

/** A source by id (`synap`, `acme`); the official URL is still read for older links. */
const sourceRefSchema = z.string().min(1).max(500);

const targetSchema = z.object({
  kind: kindSchema,
  slug: z.string().min(1).max(200),
  /** The catalog source id. Omitted: Synap's catalog. */
  source: sourceRefSchema.optional(),
});

/** Where a source stands, in one token the console can draw. */
export type MarketplaceSourceState =
  | "ok"
  | "pending"
  | "unreachable"
  | "invalid"
  | "bad_signature"
  | "expired"
  | "key_changed"
  | "off";

export interface MarketplaceSource {
  id: string;
  name: string;
  /** The address the pod reads (the Control Plane for Synap). */
  url: string;
  trust: MarketplaceTrust;
  official: boolean;
  enabled: boolean;
  /** Official only: `SYNAP_CATALOG_SOURCE=off` — the console cannot turn it on. */
  lockedOff: boolean;
  /** sha256 of the pinned key, hex; null for Synap today and an unsigned showcase. */
  keyFingerprint: string | null;
  agentsMayPropose: boolean;
  addedBy: string | null;
  addedAt: string | null;
  /** Newest sync attempt; null when it never synced. */
  lastSyncAt: string | null;
  /** Listings this pod holds from it. */
  packageCount: number;
  state: MarketplaceSourceState;
  /** Why nothing installs from it right now, or null. */
  blocked: string | null;
  /** One sentence on the last sync when it did not apply. */
  message: string | null;
  /** key_changed: the fingerprint the source is signed with now. */
  pendingFingerprint: string | null;
  /** Kept for the Catalog freshness line: every recent attempt failed to connect. */
  unreachable: boolean;
}

async function packageCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      source: cpCatalogCache.source,
      count: drizzleSql<number>`count(*)::int`,
    })
    .from(cpCatalogCache)
    .where(isNull(cpCatalogCache.retiredAt))
    .groupBy(cpCatalogCache.source);
  return new Map(rows.map((r) => [r.source, Number(r.count)]));
}

function toWire(
  view: MarketSourceView,
  counts: Map<string, number>,
  stamps: Record<string, CatalogSyncStamp>
): MarketplaceSource {
  const { source, gate, status } = view;
  let lastSyncAt: string | null;
  let state: MarketplaceSourceState;
  let message: string | null = null;
  if (source.official) {
    const own = CATALOG_KINDS.flatMap((kind) => {
      const stamp = stamps[catalogSyncStampKey(source.cacheKey, kind)];
      return stamp ? [stamp] : [];
    });
    lastSyncAt =
      own
        .map((s) => s.lastSyncAt)
        .sort()
        .at(-1) ?? null;
    state =
      own.length === 0
        ? "pending"
        : own.every((s) => s.lastStatus === "unreachable")
          ? "unreachable"
          : "ok";
  } else {
    lastSyncAt = status?.lastSyncAt ?? null;
    state = status?.state ?? "pending";
    message = status?.message ?? null;
  }
  if (!source.enabled) state = "off";
  return {
    id: source.id,
    name: source.name,
    url: source.url,
    trust: source.trust,
    official: source.official,
    enabled: source.enabled,
    lockedOff: source.lockedOff,
    keyFingerprint: source.keyFingerprint,
    agentsMayPropose: source.agentsMayPropose,
    addedBy: source.addedBy,
    addedAt: source.addedAt,
    lastSyncAt,
    packageCount: counts.get(source.cacheKey) ?? 0,
    state,
    blocked: gate.blocked ?? null,
    message,
    pendingFingerprint: status?.pendingFingerprint ?? null,
    unreachable: state === "unreachable",
  };
}

async function sourcesWithViews(): Promise<{
  views: MarketSourceView[];
  wire: MarketplaceSource[];
}> {
  const [views, counts, stamps] = await Promise.all([
    listMarketSources(),
    packageCounts(),
    // A stamp read that fails is "never synced", not an error page.
    getCatalogSyncStamps().catch((): Record<string, CatalogSyncStamp> => ({})),
  ]);
  return { views, wire: views.map((v) => toWire(v, counts, stamps)) };
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

/**
 * A signed-in PERSON — not an agent, not an API key, not a Hub key. Which
 * sources this pod trusts is a person's decision, so the server refuses every
 * other principal whatever role it holds.
 */
function assertPersonSession(ctx: {
  agentUserId?: string | null;
  session?: unknown;
  keyType?: string | null;
  isHubProtocol?: boolean;
}): void {
  if (ctx.agentUserId || !ctx.session || ctx.keyType || ctx.isHubProtocol) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only a person signed in to the Pod Console can change marketplace sources — never an agent or a key.",
    });
  }
}

const personAdminProcedure = podAdminProcedure.use(async (opts) => {
  assertPersonSession(opts.ctx);
  return opts.next();
});

/** Where a showcase listing sends a person instead of installing. */
function openUrlOf(entry: {
  listing?: { installUrl?: string | null; homepageUrl?: string | null } | null;
}): string | null {
  return entry.listing?.installUrl ?? entry.listing?.homepageUrl ?? null;
}

export interface MarketplacePreflight extends MarketInstallSummary {
  kind: CatalogKind;
  slug: string;
  source: string;
  sourceName: string;
  trust: MarketplaceTrust;
  name: string;
  version: string | null;
  /** False when something below must change before the install can run. */
  ok: boolean;
  /** Plain sentences naming what stops the install. */
  blockers: string[];
  /** Template only: the write-free workspace plan (profiles, links, views). */
  report: WorkspacePreflightReport | null;
  /** What the package brings: code, network reach, connectors. */
  risks: MarketRisks;
  /** The extra confirms the install will ask for (a trusted source only). */
  requires: { code: boolean; network: boolean };
}

/** Fetch, verify and describe a source's index for a person to confirm. */
async function inspectSource(
  url: string,
  opts: { expectedSourceId?: string } = {}
) {
  const fetched = await fetchSourceIndex(url);
  if (!fetched.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: fetched.message });
  }
  const verdict = verifyIndex({
    indexBytes: fetched.indexBytes,
    signature: fetched.signature,
    pinnedKey: null,
    requireSignature: false,
    expectedSourceId: opts.expectedSourceId,
    now: new Date(),
  });
  if (!verdict.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: verdict.message });
  }
  return { indexUrl: fetched.indexUrl, verdict };
}

function sameFingerprint(confirmed: string | null, actual: string | null) {
  if (!confirmed || !actual) return confirmed === actual;
  return normalizeKeyFingerprint(confirmed) === actual.toLowerCase();
}

function findAdded(
  sources: MarketplaceSourceSetting[],
  id: string
): MarketplaceSourceSetting {
  const found = sources.find((s) => s.id === id);
  if (!found) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No source "${id}" on this pod.`,
    });
  }
  return found;
}

/** Sync right after a change; a failure is the source's status, not the person's error. */
async function syncQuietly(id: string): Promise<void> {
  await syncCatalogSourceNow(id).catch(() => undefined);
}

const sourcesRouter = router({
  /** Every source, enabled or not, with its trust, key and last sync. */
  list: podAdminProcedure.query(async () => (await sourcesWithViews()).wire),

  /**
   * Step 1–2 of adding a source: fetch its index and signature, verify the
   * signature under the key the index names, and return who signs it — the
   * name and fingerprint a person compares before trusting it. Writes nothing.
   */
  add: personAdminProcedure
    .input(z.object({ url: z.string().min(1).max(2000) }))
    .mutation(async ({ input }) => {
      const { indexUrl, verdict } = await inspectSource(input.url);
      const { views } = await sourcesWithViews();
      const taken = views.find((v) => v.source.id === verdict.index.source.id);
      return {
        url: indexUrl,
        id: verdict.index.source.id,
        name: verdict.index.source.name,
        homepage: verdict.index.source.homepage ?? null,
        packageCount: verdict.index.packages.length,
        expires: verdict.index.expires,
        signed: verdict.fingerprint !== null,
        keyFingerprint: verdict.fingerprint,
        /** Set when a source with this id is already on the pod. */
        conflict: taken
          ? `"${taken.source.name}" already uses the id "${verdict.index.source.id}".`
          : null,
      };
    }),

  /**
   * Step 3: trust it. Re-fetches and re-verifies, and pins the key ONLY if it
   * is still the one the person confirmed (`keyFingerprint`) — a key swapped
   * between the check and the confirm is refused, never pinned.
   */
  confirm: personAdminProcedure
    .input(
      z.object({
        url: z.string().min(1).max(2000),
        trust: z.enum(ADDABLE_TRUST_LEVELS),
        /** The fingerprint the person confirmed; null only for an unsigned showcase. */
        keyFingerprint: z.string().max(200).nullable(),
        agentsMayPropose: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { indexUrl, verdict } = await inspectSource(input.url);
      if (!sameFingerprint(input.keyFingerprint, verdict.fingerprint)) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "The source's signing key is not the one you confirmed. Check it again before trusting it.",
        });
      }
      if (input.trust === "trusted" && !verdict.publicKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This source is not signed, so it can only be added as a showcase.",
        });
      }
      const id = verdict.index.source.id;
      const setting: MarketplaceSourceSetting = {
        id,
        url: indexUrl,
        name: verdict.index.source.name,
        trust: input.trust,
        publicKey: verdict.publicKey,
        keyFingerprint: verdict.fingerprint,
        agentsMayPropose:
          input.trust === "trusted" && input.agentsMayPropose === true,
        addedBy: ctx.userId,
        addedAt: new Date().toISOString(),
        enabled: true,
      };
      await updateMarketplaceSources(({ sources, official }) => {
        if (id === OFFICIAL_SOURCE_ID || sources.some((s) => s.id === id)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A source with the id "${id}" is already on this pod.`,
          });
        }
        if (sources.some((s) => s.url === indexUrl)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "That source is already on this pod.",
          });
        }
        return { sources: [...sources, setting], official, result: null };
      });
      await recordMarketplaceSourceStatus(id, {
        state: "pending",
        lastSyncAt: new Date().toISOString(),
        lastOkAt: null,
        packageCount: 0,
        validUntil: null,
        message: null,
      });
      await syncQuietly(id);
      const { wire } = await sourcesWithViews();
      return wire.find((s) => s.id === id)!;
    }),

  /** Rename an added source, change its trust, or its agent opt-in. */
  update: personAdminProcedure
    .input(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(100).optional(),
        trust: z.enum(ADDABLE_TRUST_LEVELS).optional(),
        agentsMayPropose: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      if (input.id === OFFICIAL_SOURCE_ID) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Synap's source can only be turned on or off.",
        });
      }
      await updateMarketplaceSources(({ sources, official }) => {
        const current = findAdded(sources, input.id);
        const trust = input.trust ?? current.trust;
        if (trust === "trusted" && !current.publicKey) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This source is not signed, so it can only be a showcase.",
          });
        }
        const next: MarketplaceSourceSetting = {
          ...current,
          name: input.name ?? current.name,
          trust,
          agentsMayPropose:
            trust === "trusted" &&
            (input.agentsMayPropose ?? current.agentsMayPropose) === true,
        };
        return {
          sources: sources.map((s) => (s.id === input.id ? next : s)),
          official,
          result: null,
        };
      });
      return { ok: true as const };
    }),

  /** Turn a source on or off — Synap's included (it is never removed). */
  disable: personAdminProcedure
    .input(z.object({ id: z.string().min(1).max(100), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.id === OFFICIAL_SOURCE_ID) {
        const { views } = await sourcesWithViews();
        if (input.enabled && views[0]?.source.lockedOff) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Synap's catalog is switched off on this server (SYNAP_CATALOG_SOURCE=off); the console cannot turn it on.",
          });
        }
        await updateMarketplaceSources(({ sources }) => ({
          sources,
          official: {
            enabled: input.enabled,
            changedBy: ctx.userId,
            changedAt: new Date().toISOString(),
          },
          result: null,
        }));
      } else {
        await updateMarketplaceSources(({ sources, official }) => {
          findAdded(sources, input.id);
          return {
            sources: sources.map((s) =>
              s.id === input.id ? { ...s, enabled: input.enabled } : s
            ),
            official,
            result: null,
          };
        });
      }
      if (input.enabled) await syncQuietly(input.id);
      return { ok: true as const };
    }),

  /** Remove an added source and every listing the pod holds from it. */
  remove: personAdminProcedure
    .input(z.object({ id: z.string().min(1).max(100) }))
    .mutation(async ({ input }) => {
      if (input.id === OFFICIAL_SOURCE_ID) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Synap's source is built in — turn it off instead.",
        });
      }
      await updateMarketplaceSources(({ sources, official }) => {
        findAdded(sources, input.id);
        return {
          sources: sources.filter((s) => s.id !== input.id),
          official,
          result: null,
        };
      });
      await deleteSourceRows(input.id);
      await clearMarketplaceSourceStatus(input.id);
      return { ok: true as const };
    }),

  /**
   * A source now signed by a different key stays blocked until a person
   * compares the new fingerprint and re-approves it here. Pins the new key
   * only when the source is STILL signed by the one they confirmed.
   */
  approveKeyChange: personAdminProcedure
    .input(
      z.object({
        id: z.string().min(1).max(100),
        keyFingerprint: z.string().min(1).max(200),
      })
    )
    .mutation(async ({ input }) => {
      const { views } = await sourcesWithViews();
      const view = views.find((v) => v.source.id === input.id);
      if (!view || view.source.official) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No added source "${input.id}" on this pod.`,
        });
      }
      const { verdict } = await inspectSource(view.source.url, {
        expectedSourceId: input.id,
      });
      if (
        !verdict.publicKey ||
        !sameFingerprint(input.keyFingerprint, verdict.fingerprint)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "The source's signing key is not the one you confirmed. Check it again before re-approving.",
        });
      }
      await updateMarketplaceSources(({ sources, official }) => {
        findAdded(sources, input.id);
        return {
          sources: sources.map((s) =>
            s.id === input.id
              ? {
                  ...s,
                  publicKey: verdict.publicKey,
                  keyFingerprint: verdict.fingerprint,
                }
              : s
          ),
          official,
          result: null,
        };
      });
      await recordMarketplaceSourceStatus(input.id, {
        ...(view.status ?? {
          lastOkAt: null,
          packageCount: 0,
          validUntil: null,
        }),
        state: "pending",
        lastSyncAt: new Date().toISOString(),
        message: null,
        pendingPublicKey: null,
        pendingFingerprint: null,
      });
      await syncQuietly(input.id);
      return { ok: true as const };
    }),

  /** Sync one source now. */
  syncNow: podAdminProcedure
    .input(z.object({ id: z.string().min(1).max(100) }))
    .mutation(async ({ input }) => {
      try {
        await syncCatalogSourceNow(input.id);
      } catch (err) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: err instanceof Error ? err.message : "The sync failed.",
        });
      }
      const { wire } = await sourcesWithViews();
      return wire.find((s) => s.id === input.id) ?? null;
    }),
});

export const marketplaceRouter = router({
  /**
   * Browse the pod's catalog across the sources that may serve now (a source
   * that is off, awaiting a key re-approval or past its index's expiry lists
   * nothing). Ranked by the shared term matcher when `query` is set,
   * alphabetical otherwise; offset-paged by `cursor`.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          query: z.string().max(200).optional(),
          kind: kindSchema.optional(),
          source: sourceRefSchema.optional(),
          limit: z.number().int().min(1).max(100).default(60),
          cursor: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const limit = input?.limit ?? 60;
      const offset = input?.cursor ?? 0;
      const query = input?.query?.trim() || undefined;
      const { views, wire } = await sourcesWithViews();
      const serving = views.filter(
        (v) =>
          !v.gate.blocked &&
          (!input?.source ||
            v.source.id === input.source ||
            v.source.cacheKey === input.source)
      );
      const byKey = new Map(serving.map((v) => [v.source.cacheKey, v.source]));
      const matches = await queryCatalogCache({
        query,
        kind: input?.kind,
        sources: [...byKey.keys()],
        // Every match: the page is cut below, after the total is known.
        limit: query ? Number.POSITIVE_INFINITY : undefined,
      });
      const ordered = query
        ? matches
        : [...matches].sort(
            (a, b) =>
              a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)
          );
      const page = ordered.slice(offset, offset + limit);
      return {
        entries: page.map((e) => {
          const source = byKey.get(e.source)!;
          return {
            /** The source id (`synap`, `acme`). */
            source: source.id,
            sourceName: source.name,
            trust: source.trust,
            /** `<source>/<slug>` for an added source; the bare slug for Synap. */
            id: source.official
              ? e.slug
              : qualifiedPackageId(source.id, e.slug),
            kind: e.kind,
            objectKind: OBJECT_KIND[e.kind],
            slug: e.slug,
            name: e.name,
            description: e.description,
            version: e.version,
            tier: e.tier,
            vendor: e.vendor,
            tags: e.tags,
          };
        }),
        total: ordered.length,
        nextCursor:
          offset + page.length < ordered.length ? offset + page.length : null,
        kinds: CATALOG_KINDS.map((kind) => ({
          kind,
          objectKind: OBJECT_KIND[kind],
        })),
        sources: wire,
      };
    }),

  /**
   * One entry and its definition. A definition the source cannot serve right
   * now is reported in `definitionError` beside the cached row, so the page
   * still shows what the pod knows. A showcase entry is never fetched.
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
    const { views } = await sourcesWithViews();
    const view = views.find((v) => v.source.cacheKey === entry.source);
    if (!view) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `"${input.slug}" is not in this pod's catalog.`,
      });
    }
    const decision = decideMarketInstall(view.gate, "person");
    let definition: Record<string, unknown> | null = null;
    let definitionError: string | null = null;
    if (decision.allow === "install") {
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
    }
    const installed = view.source.official
      ? await import("../services/capabilities/builtin-verbs.js").then((m) =>
          m.resolveInstalledFlag(input.kind, input.slug)
        )
      : undefined;
    return {
      source: view.source.id,
      sourceName: view.source.name,
      trust: view.source.trust,
      official: view.source.official,
      id: view.source.official
        ? entry.slug
        : qualifiedPackageId(view.source.id, entry.slug),
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
      /** What a person can do with it here: install, open the publisher's site, or nothing. */
      installMode: decision.allow,
      /** Why it cannot install right now, when it cannot. */
      blocked: decision.allow === "refuse" ? decision.reason : null,
      /** Showcase: the publisher's install or home page. */
      openUrl: openUrlOf(entry),
      definition,
      definitionError,
    };
  }),

  /**
   * What installing this entry would change — read-only. A template runs the
   * workspace preflight core (`preflightWorkspaceFromDefinition`, the same one
   * `workspaces.preflightFromDefinition` wraps); every kind gets the facts the
   * install reads from its definition (`summarizeMarketInstall`) and what it
   * brings (`assessMarketRisks`). A showcase entry has no preflight.
   */
  preflight: protectedProcedure
    .input(targetSchema.extend({ workspaceId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }): Promise<MarketplacePreflight> => {
      const entry = await lookupCatalogEntry(
        input.kind,
        input.slug,
        input.source
      );
      const { views } = await sourcesWithViews();
      const view =
        views.find((v) =>
          entry ? v.source.cacheKey === entry.source : v.source.official
        ) ?? views[0]!;
      const decision = decideMarketInstall(view.gate, "person");
      if (decision.allow === "open_site") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${view.source.name} is a showcase source — this installs from the publisher's site, never from this pod.`,
        });
      }
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
      const risks = assessMarketRisks(definition);
      const blockers: string[] = [];
      if (decision.allow === "refuse") blockers.push(decision.reason);
      if (view.source.official) {
        try {
          await assertPackageTierAccess(ctx.userId, input.slug);
        } catch (err) {
          if (!(err instanceof TRPCError) || err.code !== "FORBIDDEN")
            throw err;
          blockers.push(err.message);
        }
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
        source: view.source.id,
        sourceName: view.source.name,
        trust: view.source.trust,
        name: entry?.name ?? input.slug,
        version: entry?.version ?? null,
        ok: blockers.length === 0,
        blockers,
        report,
        risks,
        // The extra confirm is the trusted-source rule; Synap's own catalog
        // discloses the same facts without asking twice.
        requires: view.source.official
          ? { code: false, network: false }
          : requiredAcknowledgements(risks),
      };
    }),

  /**
   * Install. A person (a signed-in session, no key) installs through
   * `runMarketInstall` — confirming code and network reach for a package from
   * a trusted source; an agent's call files the `capability.install` proposal
   * where its source allows (`status: "proposed"`). Any other key — an app or
   * service key — is refused: installing is a person's decision or a
   * reviewable proposal, never a silent key action.
   */
  install: protectedProcedure
    .input(
      targetSchema.extend({
        workspaceId: z.string().uuid().optional(),
        version: z.string().max(100).optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        acknowledge: z
          .object({
            code: z.boolean().optional(),
            network: z.boolean().optional(),
          })
          .optional(),
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
        // A confirm is a PERSON's: an agent's call never carries one.
        acknowledge: agentUserId ? undefined : input.acknowledge,
        userId: ctx.userId,
        workspaceId: input.workspaceId ?? null,
        agentUserId,
      });
    }),

  sources: sourcesRouter,
});
