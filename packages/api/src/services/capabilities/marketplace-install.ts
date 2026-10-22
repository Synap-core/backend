/**
 * Marketplace install — the shared apply core behind the `market.install`
 * builtin verb (builtin-verbs.ts) AND the `capability.install` proposal
 * approve-executor (routers/proposals/approve-executors.ts). ONE function per
 * concern so an operator's direct install and an approved agent's install can
 * never diverge in provisioning logic (the "one door per kind" bar from
 * CAPABILITY-MARKETPLACE-PLAN (team pod) P2.1-A).
 *
 * Kind → door (never re-implemented, only routed to):
 *   capability → `createCapabilityFromDefinition` — the SAME governed applier
 *                `/packages/apply` and the manual capability-apply flow use.
 *                Idempotent by definition (name+workspace natural key).
 *   template   → `applyTemplate` (the one template apply) — the templateKey
 *                flow P2.6 describes. Idempotent via
 *                its `packageSlug`/`proposalId` key (both set to the catalog
 *                slug here), so re-installing the same template for the same
 *                user converges to the existing workspace. That door builds
 *                LAYER 1 ONLY (profiles/views/bento), so this branch then runs
 *                `applyPackagePostWorkspace` — the SAME layer-2 door the Hub
 *                `POST /packages/apply` and the `workspace/create` approve
 *                executor run — for capabilities/playbooks/automations/loops/
 *                cells/actionPlacements. Guarded by
 *                `__tripwires__/market-install-template-applies-layer-2.test.ts`.
 *   automation → `automationsRouter.create`, applied into the CALLER's acting
 *                workspace (not a new one — installing "an automation" adds it
 *                to where the caller already is). Idempotent via a name+
 *                workspace pre-check, mirroring `/packages/apply`'s own
 *                automations step (that route is out of this wave's write
 *                scope, so the check is inlined here rather than imported).
 *   cell       → `defineCell` — the SAME governed cell upsert `POST
 *                /cells/define` and MCP `synap_create_cell` use. Idempotent by
 *                (typeKey, workspaceId).
 *
 * Definition resolution: the `cp_catalog_cache` row carries the full install
 * payload inline for capability/cell (their CP list routes return it), but
 * NULL for automation/template (the CP's public package-list route omits it
 * "can be large" — see cp-catalog-sync.ts). For those two kinds, this module
 * fetches the full definition at install time from `GET
 * {source}/api/packages/:slug[/:version]` (8s timeout) — failure returns a
 * retryable error, never a half-install. When the cache row itself is MISSING
 * for automation/template (an opt-in / just-authored package the sync never
 * saw), the same by-slug endpoint is used with the configured CP base URL
 * (`resolveDefinitionByKey`) — the uniform analog of the capability by-key
 * fallback — so a cache miss re-resolves instead of dead-ending in NOT_FOUND.
 * `cell` gets the same treatment via `resolveCellDefinitionByKey`: its renderer
 * source has no by-slug packages-endpoint analogue, but the CP serves it at
 * `GET {source}/api/marketplace/cells?q=<key>` (the same live endpoint
 * `routers/cells.ts`'s `install` mutation already fetches from).
 *
 * Sources: every target names ONE catalog source — omitted
 * means the official Synap source, never "whichever source has the slug". A
 * package from a source a person added is installed only as its trust level
 * allows (`decideMarketInstall`): its definition is fetched anonymously from
 * the signed listing and digest-checked (`resolveListedDefinition`), a person
 * confirms code, network reach and existing connections explicitly, an
 * agent proposes only where that source opted in, a showcase source never
 * installs, and everything it installs is stamped `<sourceId>/<slug>` so it
 * can never converge onto — or be reconciled as — Synap's own package. Nor
 * may it overwrite anything the pod already has under the same name
 * (`assertNoTakeover`), and an approved proposal installs only the exact
 * listing it disclosed (`listingSha256`).
 * The by-key Control Plane fallbacks below are official-only, and every
 * definition the official catalog serves passes Synap's signature rule
 * (`assertOfficialDefinition`, official-catalog-trust.ts) before it applies.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  db,
  and,
  eq,
  ne,
  or,
  isNull,
  inArray,
  drizzleSql,
  getWorkspaceMembership,
  automations as automationsTable,
} from "@synap/database";
import {
  capabilities,
  cpCatalogCache,
  mcpServers,
  ProfileScope,
  playbooks as playbooksTable,
  profiles,
  propertyDefs,
  secrets,
  skills as skillsTable,
  tools as toolsTable,
  views,
  widgetDefinitions,
  workspaceMembers,
  workspaces,
} from "@synap/database/schema";
import type {
  CatalogListing,
  PackageCellRendererType,
} from "@synap/database/schema";
import type { CatalogSource } from "@synap/jobs/workers/cp-catalog-sync.js";
import {
  decideMarketInstall,
  qualifiedPackageId,
} from "@synap-core/types/marketplace-source";
import type { CatalogKind } from "@synap/jobs";
import {
  resolveComposedPlaybooks,
  type CapabilityDefinition,
  type LoopDefinition,
} from "@synap/playbooks";
import type { WorkspaceDefinitionInput } from "@synap/database";
import type { Context } from "../../context.js";
import { assertPackageTierAccess } from "../../utils/tier-check.js";
import { createPendingProposal } from "../../utils/permission-check.js";
import { openLink } from "../../utils/deep-links.js";
import {
  createCapabilityFromDefinition,
  type CreateCapabilityOptions,
  type CreateCapabilityResult,
} from "./create-from-definition.js";
import { fetchCPCapabilityTemplate } from "./cp-template-client.js";
// Type-only (erased at runtime) — the applier itself is imported dynamically at
// its call site, mirroring the approve-executors, so this module never pulls the
// post-workspace layer graph into an eager import cycle.
import type { PackagePostWorkspaceBody } from "../package-apply-post-workspace.js";
import { installCellFromDefinition } from "../cells/install-cell-from-definition.js";
import {
  buildMarketSource,
  stampMarketSource,
  readMarketSource,
} from "./market-source.js";
import {
  summarizePostWorkspaceLayers,
  installedTrackTemplates,
} from "./install-layers.js";
import {
  marketSourceGate,
  provenanceSlug,
  resolveListedDefinition,
  resolveMarketSource,
} from "./market-sources.js";
import {
  assessMarketRisks,
  missingAcknowledgements,
  riskNotices,
  type MarketAcknowledgement,
} from "./market-risk.js";
import { officialCatalogCondition } from "./catalog-cache-query.js";
import { assertOfficialDefinition } from "./official-catalog-trust.js";
import { interpolateDeep } from "../_shared/interpolate.js";
import { createLogger } from "@synap-core/core";
import {
  provisionInstalledToolWebhooks,
  type InstalledToolWebhook,
} from "../webhooks/provision-inbound-webhook.js";
import { requireUserId } from "../../utils/user-scoped.js";
import { capabilityElementOf, skillElementOf } from "./package-element.js";

const logger = createLogger({ module: "marketplace-install" });

export interface CatalogCacheRowFull {
  id: string;
  source: string;
  kind: string;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  tier: string | null;
  vendor: string | null;
  definition: Record<string, unknown> | null;
  /** Third-party rows only: the signed listing (definition URL + digest). */
  listing: CatalogListing | null;
}

/**
 * Look up ONE cache row by (source, kind, slug) — the exact target an install
 * needs. The cache is unique on all three.
 *
 * `source` omitted (or `synap`, or the official URL): the OFFICIAL source's
 * row, and only that — a bare slug never resolves to a source a person added,
 * so `acme/crm` can never stand in for Synap's `crm`. A source that is not
 * on this pod is refused (`resolveMarketSource`).
 */
export async function lookupCatalogEntry(
  kind: CatalogKind,
  slug: string,
  source?: string | null
): Promise<CatalogCacheRowFull | null> {
  const resolved = await resolveMarketSource(source);
  const [row] = await db
    .select()
    .from(cpCatalogCache)
    .where(
      and(
        eq(cpCatalogCache.source, resolved.cacheKey),
        eq(cpCatalogCache.kind, kind),
        eq(cpCatalogCache.slug, slug)
      )
    )
    .limit(1);
  // A tombstone is never an install target (the CP answers 410 for it too).
  if (row?.retiredAt) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: row.replacedBySlug
        ? `The "${slug}" template was retired and replaced by "${row.replacedBySlug}". Install "${row.replacedBySlug}" instead.`
        : `The "${slug}" template was retired and can no longer be installed.`,
      cause: { code: "TEMPLATE_RETIRED", replacedBy: row.replacedBySlug },
    });
  }
  return row ?? null;
}

/** Resolve whether a catalog entry is already installed — HONEST per kind: a
 *  cheap natural-key check for capability/cell, `undefined` (never a fabricated
 *  guess) when the check would require scanning every workspace's provenance. */
export async function resolveInstalledFlag(
  kind: CatalogKind,
  slug: string
): Promise<boolean | undefined> {
  if (kind === "capability") {
    const [row] = await db
      .select({ id: capabilities.id })
      .from(capabilities)
      .where(drizzleSql`${capabilities.metadata}->>'templateKey' = ${slug}`)
      .limit(1);
    return !!row;
  }
  if (kind === "cell") {
    // Cache slug scheme is `${packageSlug}/${cellKey}` (cp-catalog-sync.ts);
    // the installed typeKey scheme is `cell:${packageSlug}:${cellKey}` (the
    // SAME scheme POST /cells/install and defineCell use).
    if (!slug.includes("/")) return undefined;
    const [pkgSlug, cellKey] = slug.split("/");
    const [row] = await db
      .select({ id: widgetDefinitions.id })
      .from(widgetDefinitions)
      .where(eq(widgetDefinitions.typeKey, `cell:${pkgSlug}:${cellKey}`))
      .limit(1);
    return !!row;
  }
  // automation/template: no cheap natural-key check today (would require
  // scanning every workspace's provenance) — honest `undefined`, never faked.
  return undefined;
}

const FETCH_TIMEOUT_MS = 8000;

/**
 * Fetch the full install payload for automation/template kinds (the cache
 * omits it for these — list-view only). Never throws a half-parsed result:
 * any failure (unreachable, non-2xx, empty body) surfaces as a retryable
 * INTERNAL_SERVER_ERROR so the caller (verb/executor) never proceeds to a
 * partial provisioning step.
 */
async function fetchFullPackageDefinition(
  source: string,
  slug: string,
  version?: string | null
): Promise<Record<string, unknown>> {
  const url = version
    ? `${source}/api/packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`
    : `${source}/api/packages/${encodeURIComponent(slug)}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Marketplace source unreachable fetching "${slug}" — retry the install later (nothing was provisioned).`,
    });
  }
  // A 401/403/404 here is (almost always) a PRIVATE package: this pod fetch is
  // UNAUTHENTICATED (bare `fetch`), and the CP's `GET /:slug` is optionalAuth —
  // it serves a private package only to a requester whose identity matches the
  // author (or a pod-team member). The pod holds no CP user credential, so the
  // real fix is the pod→CP user-scoped auth identity seam (not yet wired); until
  // then, name the cause and the workaround rather than a generic 500.
  // TODO(identity-seam): authenticate this fetch AS the installing user/author
  // (pod→CP user-scoped auth) so private packages become fetchable server-side.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new TRPCError({
      code: res.status === 404 ? "NOT_FOUND" : "FORBIDDEN",
      message: `Cannot install "${slug}": its package definition isn't fetchable by this pod. Private packages require the CP identity seam (not yet wired); re-publish it public (synap market publish <file> --public) or install it from the browser. (nothing was provisioned)`,
    });
  }
  if (!res.ok) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Marketplace source returned ${res.status} fetching "${slug}" — retry the install later (nothing was provisioned).`,
    });
  }
  const body = (await res.json().catch(() => null)) as {
    package?: { definition?: Record<string, unknown> };
  } | null;
  const definition = body?.package?.definition;
  if (!definition) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Marketplace source returned no definition for "${slug}" — retry the install later (nothing was provisioned).`,
    });
  }
  return definition;
}

/** Resolve the full install payload for a cache row (inline, or fetched). */
async function resolveDefinition(
  entry: CatalogCacheRowFull,
  version?: string | null
): Promise<Record<string, unknown>> {
  if (entry.definition) return entry.definition;
  return fetchFullPackageDefinition(entry.source, entry.slug, version);
}

/**
 * Resolve the CP base URL — the by-key re-resolve source used when there is NO
 * cp_catalog_cache row. Mirrors cp-template-client's `cpUrl()`. Null when the
 * pod has no Control Plane configured (self-hosted).
 */
function cpBaseUrl(): string | null {
  const url = (
    process.env.CONTROL_PLANE_URL ??
    process.env.CP_URL ??
    ""
  ).replace(/\/$/, "");
  return url || null;
}

/**
 * BY-KEY re-resolve for automation/template when the cp_catalog_cache row is
 * MISSING — the uniform analog of the capability by-key fallback
 * (fetchCPCapabilityTemplate). An opt-in (syncByDefault:false) or just-authored
 * package never enters the cache, but the CP still serves it by slug at
 * `GET {CP}/api/packages/:slug` — so a cache miss RE-RESOLVES from the CP instead
 * of dead-ending in NOT_FOUND (the gap this wave closes). Throws a clear NOT_FOUND
 * only when no CP is configured to resolve from; a reachable-but-failing CP
 * surfaces `fetchFullPackageDefinition`'s retryable INTERNAL_SERVER_ERROR.
 */
async function resolveDefinitionByKey(
  slug: string,
  version?: string | null
): Promise<Record<string, unknown>> {
  const source = cpBaseUrl();
  if (!source) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Marketplace entry "${slug}" isn't in the catalog cache and no Control Plane is configured to re-resolve it — search first with market.search.`,
    });
  }
  return fetchFullPackageDefinition(source, slug, version);
}

/** The renderer-source shape a cell install needs, whether it came from the
 *  cache row's inline `definition`, an RC4-supplied payload, or the by-key CP
 *  fallback below — ONE shape so the `case "cell"` install body downstream
 *  never has to branch on where the definition came from. */
interface CellCatalogDef {
  key?: string;
  code?: string;
  deps?: Record<string, string>;
  defaultSize?: { w: number; h: number };
  /**
   * Minimum grid footprint. A CAST like the fields below — the value already
   * survives at runtime and `installCellFromDefinition` reads it; declaring it
   * stops the local type claiming a thinner payload than the applier consumes.
   */
  minSize?: { w: number; h: number };
  packageSlug?: string;
  /** View types this cell can render (0221) — optional in the payload. */
  viewTypes?: string[];
  /**
   * Declared frame egress (0249) — see CP `PackageCellDef.externalHosts`.
   * A CAST like `contentKind`, so the value already survives at runtime;
   * declaring it stops the local type claiming a thinner payload than
   * `installCellFromDefinition` actually reads.
   */
  externalHosts?: string[];
  /**
   * Renderer slot. Read by `installCellFromDefinition` via
   * `resolveCellContentKind`; this is a CAST, not a zod parse, so the
   * value already survived at runtime — declaring it keeps the local type
   * from claiming a narrower payload than the applier actually reads.
   */
  contentKind?: string;
  /**
   * Rendering MECHANISM. A CAST like `contentKind`/`externalHosts` — the value
   * already survives at runtime; declaring it stops the local type claiming a
   * thinner payload than `installCellFromDefinition` reads. Absent ⇒
   * `defineCell`'s `"frame"` default, which is exactly how an `iframe` HTML
   * Card used to install as an ESM React cell and fail to mount.
   */
  rendererType?: PackageCellRendererType;
}

/**
 * BY-KEY re-resolve for `cell` when the `cp_catalog_cache` row is MISSING —
 * the cell analog of `resolveDefinitionByKey` (automation/template) and
 * `fetchCPCapabilityTemplate` (capability). Cells have no by-slug
 * `/api/packages/:slug` analogue (that endpoint never serves cell source —
 * see the module docblock), but the CP DOES serve full cell source at `GET
 * {CP}/api/marketplace/cells?q=<key>` — the SAME live, uncached endpoint
 * `routers/cells.ts`'s `install` mutation already fetches for the
 * `POST /api/hub/cells/install` path. So a just-published cell the
 * background sync hasn't picked up yet still installs here instead of
 * dead-ending in NOT_FOUND — closing the one kind the module docblock still
 * called out as cache-row-only.
 *
 * `slug` is the catalog key, always `${packageSlug}/${cellKey}` (see
 * cp-catalog-sync's `slug: \`${cell.packageSlug}/${cell.key}\``); a bare key
 * with no package segment is matched on cellKey alone, same fallback
 * `cells.ts` uses.
 *
 * Throws NOT_FOUND when no CP is configured, or when the CP is reachable but
 * genuinely has no matching cell — an absent cell must never resolve to a
 * silent skip. A reachable-but-failing CP surfaces
 * `fetchFullPackageDefinition`-style retryable INTERNAL_SERVER_ERROR.
 */
async function resolveCellDefinitionByKey(slug: string): Promise<{
  packageSlug: string;
  cellKey: string;
  name: string;
  def: CellCatalogDef;
  packageVersion: string | null;
}> {
  const source = cpBaseUrl();
  if (!source) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Marketplace entry "${slug}" (cell) isn't in the catalog cache and no Control Plane is configured to re-resolve it — search first with market.search({query, kind:"cell"}).`,
    });
  }
  const [packageSlug, cellKey] = slug.includes("/")
    ? slug.split("/")
    : [undefined, slug];

  let res: Response;
  try {
    res = await fetch(
      `${source}/api/marketplace/cells?q=${encodeURIComponent(cellKey!)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
  } catch {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Marketplace source unreachable fetching cell "${slug}" — retry the install later (nothing was provisioned).`,
    });
  }
  if (!res.ok) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Marketplace source returned ${res.status} fetching cell "${slug}" — retry the install later (nothing was provisioned).`,
    });
  }
  const body = (await res.json().catch(() => null)) as {
    cells?: Array<
      CellCatalogDef & {
        key: string;
        name: string;
        packageSlug: string;
        packageVersion?: string | null;
      }
    >;
  } | null;
  const list = body?.cells ?? [];
  const match = list.find(
    (c) => c.key === cellKey && (!packageSlug || c.packageSlug === packageSlug)
  );
  if (!match) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Cell "${slug}" is not published on the marketplace — the catalog was queried directly and has no such cell. Check the slug, or that its package is public.`,
    });
  }
  return {
    packageSlug: match.packageSlug,
    cellKey: match.key,
    name: match.name,
    def: match,
    packageVersion: match.packageVersion ?? null,
  };
}

/**
 * The install payload for one catalog target, resolved EXACTLY as
 * `applyMarketInstall` resolves it: the cache row's inline definition, else a
 * by-slug fetch from the row's own source; with no row, the per-kind by-key
 * re-resolve from the configured Control Plane. ONE resolution path, so a
 * preview (`marketplace.get` / `marketplace.preflight`) describes the very
 * definition the install will apply.
 *
 * Null only where the install would also stop: a capability the CP does not
 * know, or a cached cell row that carries no renderer source.
 */
export async function resolveCatalogDefinition(
  kind: CatalogKind,
  slug: string,
  entry: CatalogCacheRowFull | null,
  version?: string | null
): Promise<Record<string, unknown> | null> {
  // A source a person added: the signed listing is the ONLY way in — never a
  // Control Plane fallback — and a showcase source is never fetched at all.
  if (entry?.listing) {
    const source = await resolveMarketSource(entry.source);
    if (source.trust === "showcase") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `"${entry.name}" is listed by ${source.name} for show only — it installs from the publisher's site, never from this pod.`,
        cause: { code: "MARKET_SHOWCASE_ONLY" },
      });
    }
    return resolveListedDefinition(entry);
  }
  if (kind === "cell") {
    // A cell's source is inline-only — the by-slug packages endpoint never
    // serves it — so a cached row is read as-is, never re-fetched.
    if (entry) {
      if (entry.definition) {
        await assertOfficialDefinition({
          kind,
          slug,
          version: entry.version,
          definition: entry.definition,
        });
      }
      return entry.definition;
    }
    const byKey = await resolveCellDefinitionByKey(slug);
    const def = byKey.def as Record<string, unknown>;
    await assertOfficialDefinition({
      kind,
      slug: `${byKey.packageSlug}/${byKey.cellKey}`,
      version: byKey.packageVersion,
      definition: def,
    });
    return def;
  }
  // A capability by key is checked inside `fetchCPCapabilityTemplate`.
  if (!entry && kind === "capability") {
    return (await fetchCPCapabilityTemplate(slug)) as unknown as Record<
      string,
      unknown
    > | null;
  }
  const definition = entry
    ? await resolveDefinition(entry, version)
    : await resolveDefinitionByKey(slug, version);
  await assertOfficialDefinition({
    kind,
    slug,
    version: version ?? entry?.version ?? null,
    definition,
  });
  return definition;
}

/** Shared install-time params schema — the ONE zod shape every capability-apply
 *  door declares for `{{param}}` substitution (tRPC `capabilities.install`,
 *  Hub `POST /capabilities/apply`, and the `market.install` verb). */
export const capabilityInstallParamsSchema = z.record(z.string(), z.unknown());

/**
 * The ONE final apply step every capability-apply door funnels into (tRPC
 * `capabilities.install`, Hub `POST /capabilities/apply`, and `market.install`'s
 * capability branch). Definition RESOLUTION stays door-specific (inline body
 * wins, else a seed templateKey or a catalog slug) — this shared step normalizes
 * the two collection fields the applier iterates unguarded and threads
 * install-time `params` into the governed `createCapabilityFromDefinition`.
 *
 * It then provisions the inbound webhook of every installed tool a provider
 * calls back (`provisionInstalledToolWebhooks`) and returns each URL with the
 * one manual step on the provider's side, so every install door shows it. Only
 * here: a reconcile or a package dependency re-applies the definition without
 * minting a URL nobody is shown.
 */
export async function applyCapabilityDefinition(
  definition: unknown,
  params: Record<string, unknown> | undefined,
  ctx: Context,
  opts: CreateCapabilityOptions = {}
): Promise<CreateCapabilityResult & { webhooks: InstalledToolWebhook[] }> {
  const result = await createCapabilityFromDefinition(
    // A CP capability PACKAGE arrives wrapped (`{capability:{…}}`): unwrap it
    // here, where every door converges (`capabilityElementOf`).
    // Inline defs are structurally validated by the door's schema (or `z.any()`);
    // `providerSpec` is passed through as opaque JSON (the applier re-casts it to
    // Record), so a boundary cast to the applier's input type is safe. The applier
    // normalizes tools/skills itself (the ONE place every door funnels into).
    capabilityElementOf(definition) as Parameters<
      typeof createCapabilityFromDefinition
    >[0],
    params ?? {},
    ctx,
    opts
  );
  const webhooks = await provisionInstalledToolWebhooks(
    result.created.tools,
    requireUserId(ctx.userId)
  );
  return { ...result, webhooks };
}

export interface ApplyMarketInstallInput {
  kind: CatalogKind;
  slug: string;
  /**
   * The catalog source id the target is listed under (`synap`, or a source a
   * pod admin added). Omitted: Synap's official catalog — never another
   * source that happens to list the same slug (see `lookupCatalogEntry`).
   */
  source?: string | null;
  version?: string | null;
  params?: Record<string, unknown>;
  userId: string;
  workspaceId: string | null;
  agentUserId?: string | null;
  /**
   * Set only when an approved `capability.install` proposal installs: the
   * listing digest disclosed when it was filed (null when it carried none).
   * The install is refused when the source now lists anything else — a
   * reviewer approves what they were shown, never what the source serves
   * later.
   */
  proposedListingSha256?: string | null;
  /** Stamp uses / seed filing onto this project. */
  projectId?: string;
  /** Human-typed engagement name — mint/reuse Project (agents must use projectId). */
  projectName?: string;
  /**
   * RC4 payload-in: the FULL package definition supplied by an
   * already-CP-authenticated client. When present it IS the resolved definition
   * and EVERY catalog lookup/fetch is skipped (no `cp_catalog_cache` row, no
   * by-slug/by-key CP fetch) — the door that installs a PRIVATE package the pod
   * cannot fetch unauthenticated. When absent, resolution is unchanged (fetch).
   */
  definition?: Record<string, unknown>;
  /**
   * A third-party definition the caller ALREADY fetched and digest-checked
   * from this very catalog row (`runMarketInstall` does, to disclose its
   * risks first). Skips the second fetch; the trust gate still runs here.
   */
  verifiedDefinition?: Record<string, unknown>;
}

type Bag = Record<string, unknown>;

function bagOf(value: unknown): Bag | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Bag)
    : null;
}

function bagsOf(value: unknown): Bag[] {
  return Array.isArray(value)
    ? value.map(bagOf).filter((b): b is Bag => b !== null)
    : [];
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Where a capability's rows land: pod-wide (null), one space, or not known yet. */
type ClaimScope = string | null | "any";

interface CapabilityClaim {
  /** As published — a literal here is the author's, not the person's. */
  raw: Bag;
  /** As the applier will see it, `{{params}}` filled in. */
  def: Bag;
  scope: ClaimScope;
}

/**
 * A definition as its applier will see it: interpolated with the definition's
 * own `name`/`key`, its declared param defaults, then the caller's params.
 */
function interpolated(raw: Bag, params: Record<string, unknown>): Bag {
  const effective: Record<string, unknown> = { name: raw.name, key: raw.key };
  for (const p of bagsOf(raw.params)) {
    const name = textOf(p.name);
    if (name && p.default !== undefined) effective[name] = p.default;
  }
  Object.assign(effective, params);
  return interpolateDeep(raw, effective);
}

/**
 * One capability a package would apply, as `createCapabilityFromDefinition`
 * will see it (`interpolated`), matched in the scope its rows land in —
 * pod-wide when every skill is pod-scoped, else the space.
 */
function capabilityClaim(
  raw: Bag,
  params: Record<string, unknown>,
  workspaceId: ClaimScope
): CapabilityClaim {
  const skillScopes = bagsOf(raw.skills).map((sk) => sk.scope ?? "pod");
  const podScoped =
    skillScopes.length > 0 && skillScopes.every((sc) => sc === "pod");
  return {
    raw,
    def: interpolated(raw, params),
    scope: podScoped ? null : workspaceId,
  };
}

/**
 * The capabilities a definition applies: the definition itself for a
 * capability package, and every inline `capabilities[].definition` a
 * template's living layer carries. A template's space is decided while it
 * installs (a new one, or one it composes onto), so its space-scoped rows are
 * checked against EVERY space — closed, never a guess.
 */
function capabilityClaims(
  kind: CatalogKind,
  definition: Bag,
  params: Record<string, unknown>,
  workspaceId: string | null
): CapabilityClaim[] {
  const claims =
    kind === "capability"
      ? [capabilityClaim(definition, params, workspaceId)]
      : [];
  for (const cap of bagsOf(definition.capabilities)) {
    const def = bagOf(cap.definition);
    if (!def) continue;
    claims.push(
      capabilityClaim(
        def,
        bagOf(cap.params) ?? {},
        kind === "template" ? "any" : workspaceId
      )
    );
  }
  return claims;
}

/** The scope condition for a `workspace_id` column; none for "any". */
function inScope(column: Parameters<typeof isNull>[0], scope: ClaimScope) {
  if (scope === "any") return undefined;
  return scope === null ? isNull(column) : eq(column, scope);
}

function refuseTakeover(
  source: CatalogSource,
  what: string,
  name: string,
  where = "already exists on this pod"
): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: `This package brings ${what} "${name}", which ${where}. A package from ${source.name} can't replace it.`,
    cause: { code: "MARKET_CAPABILITY_TAKEOVER", item: what, key: name },
  });
}

/**
 * A package from a source a person added may only ADD to this pod — never
 * overwrite what is already here. The capability applier matches existing
 * rows by natural key and re-applies onto them (credentials, code and
 * approvals included): a capability by key, an MCP server by slug, a tool by
 * credential ref (by name when it has none), a skill by name, a secret by
 * name. Any such clash in the scope the applier would write refuses the
 * install, naming the item — as does a capability key Synap's own catalog
 * uses, and a published literal `vault://` link (it would hand an existing
 * credential to the package's own tools).
 *
 * A template's automations and playbooks are matched by name in the space it
 * lands in, so a name already in one of the person's spaces is refused too
 * (`assertNoNamedClash`).
 *
 * A template's profiles reuse the pod-wide kind of the same slug; their new
 * fields land as space overlays, but a declared lifecycle, or options for a
 * field the pod-wide kind already has, would change that kind for every
 * space (`assertNoPodWideKindChange`). Refused the same way.
 */
async function assertNoTakeover(
  source: CatalogSource,
  kind: CatalogKind,
  definition: Record<string, unknown>,
  target: {
    params: Record<string, unknown>;
    workspaceId: string | null;
    userId: string;
    /** What this install is stamped as (`<source>/<slug>`). */
    packageSlug: string;
  }
): Promise<void> {
  const claims = capabilityClaims(
    kind,
    definition,
    target.params,
    target.workspaceId
  );

  // Capability keys: installed on this pod, or used by Synap's catalog. A
  // capability package may also nest its definition under `capability`.
  const keys = [
    ...new Set(
      [
        ...claims.map((c) => c.def),
        ...(kind === "capability" ? [bagOf(definition.capability)] : []),
      ].flatMap((d) => textOf(d?.key) ?? [])
    ),
  ];
  if (keys.length > 0) {
    const [installed] = await db
      .select({
        key: drizzleSql<string>`${capabilities.metadata}->>'templateKey'`,
      })
      .from(capabilities)
      .where(
        inArray(
          drizzleSql<string>`${capabilities.metadata}->>'templateKey'`,
          keys
        )
      )
      .limit(1);
    if (installed) refuseTakeover(source, "a capability called", installed.key);
    const [official] = await db
      .select({ key: cpCatalogCache.slug })
      .from(cpCatalogCache)
      .where(
        and(
          officialCatalogCondition(),
          eq(cpCatalogCache.kind, "capability"),
          inArray(cpCatalogCache.slug, keys)
        )
      )
      .limit(1);
    if (official) {
      refuseTakeover(
        source,
        "a capability called",
        official.key,
        "Synap's catalog uses"
      );
    }
  }

  for (const { raw, def, scope } of claims) {
    // A literal link in the PUBLISHED definition. A person's own pick arrives
    // through a `{{param}}`, which the raw definition does not hold.
    for (const v of bagsOf(raw.vault)) {
      if (textOf(v.value)?.trim().startsWith("vault://")) {
        refuseTakeover(
          source,
          "a link to the secret",
          textOf(v.name) ?? textOf(v.ref) ?? "unnamed",
          "is already in this pod's vault"
        );
      }
    }
    const vaultDefs = bagsOf(def.vault);
    const secretNames = vaultDefs.flatMap((v) => textOf(v.name) ?? []);
    if (secretNames.length > 0) {
      const [hit] = await db
        .select({ name: secrets.name })
        .from(secrets)
        .where(
          and(
            eq(secrets.userId, target.userId),
            inArray(secrets.name, secretNames),
            inScope(secrets.workspaceId, scope),
            isNull(secrets.deletedAt)
          )
        )
        .limit(1);
      if (hit) refuseTakeover(source, "a secret called", hit.name);
    }

    const mcpSlugs = bagsOf(def.mcpServers).flatMap(
      (m) => textOf(m.slug) ?? []
    );
    if (mcpSlugs.length > 0) {
      const [hit] = await db
        .select({ slug: mcpServers.slug })
        .from(mcpServers)
        .where(
          and(
            inArray(mcpServers.slug, mcpSlugs),
            inScope(mcpServers.workspaceId, scope)
          )
        )
        .limit(1);
      if (hit) refuseTakeover(source, "an MCP server called", hit.slug);
    }

    // A tool whose credential is one of the package's OWN secrets gets that
    // new secret (a reused one was refused above), so it cannot match.
    const ownRefs = new Set(vaultDefs.flatMap((v) => textOf(v.ref) ?? []));
    const toolRefs: string[] = [];
    const toolNames: string[] = [];
    for (const t of bagsOf(def.tools)) {
      const ref = textOf(t.credentialRef);
      const name = textOf(t.name);
      if (ref) {
        if (!ownRefs.has(ref)) toolRefs.push(ref);
      } else if (name) {
        toolNames.push(name);
      }
    }
    if (toolRefs.length > 0) {
      const [hit] = await db
        .select({ name: toolsTable.name })
        .from(toolsTable)
        .where(
          and(
            inArray(toolsTable.credentialRef, toolRefs),
            inScope(toolsTable.workspaceId, scope)
          )
        )
        .limit(1);
      if (hit)
        refuseTakeover(source, "a tool using the same connection as", hit.name);
    }
    if (toolNames.length > 0) {
      const [hit] = await db
        .select({ name: toolsTable.name })
        .from(toolsTable)
        .where(
          and(
            inArray(toolsTable.name, toolNames),
            inScope(toolsTable.workspaceId, scope)
          )
        )
        .limit(1);
      if (hit) refuseTakeover(source, "a tool called", hit.name);
    }

    const skillNames = bagsOf(def.skills).flatMap(
      (sk) => textOf(sk.name) ?? []
    );
    if (skillNames.length > 0) {
      const [hit] = await db
        .select({ name: skillsTable.name })
        .from(skillsTable)
        .where(
          and(
            inArray(skillsTable.name, skillNames),
            inScope(skillsTable.workspaceId, scope)
          )
        )
        .limit(1);
      if (hit) refuseTakeover(source, "a skill called", hit.name);
    }
  }

  if (kind === "template") {
    await assertNoNamedClash(source, definition, target);
    await assertNoPodWideKindChange(source, definition);
  }
}

/**
 * The playbook names a template's inline loops create — or, by the same
 * case-insensitive name, REUSE (granting the loop's tools to the existing
 * playbook and pointing its triggers at it). Composed from `basePlaybooks`
 * exactly as the loop applier does; a loop it cannot compose is read as
 * written (it then fails to apply, so reading more never under-refuses).
 */
function loopPlaybookNames(definition: Bag): string[] {
  return bagsOf(definition.loops).flatMap((loop) => {
    const raw = bagOf(loop.definition);
    if (!raw) return [];
    const def = interpolated(raw, bagOf(loop.params) ?? {});
    let playbooks: unknown[];
    try {
      playbooks = resolveComposedPlaybooks(def as unknown as LoopDefinition);
    } catch {
      playbooks = bagsOf(def.playbooks);
    }
    return bagsOf(playbooks).flatMap((pb) => textOf(pb.name) ?? []);
  });
}

/**
 * See `assertNoTakeover`: a template's automations and playbooks land in the
 * space it builds or composes onto, where the applier matches them BY NAME,
 * case-insensitively (an automation also by its `key`), and rewrites the
 * match — an automation's whole graph, a playbook's untouched fields plus its
 * source link and grants.
 * Which space that is gets decided while the template installs, so the check
 * runs against every live space the installing person belongs to (closed,
 * never a guess), except the space this same package already holds
 * (`package_slug`, its own earlier install). A playbook or automation this
 * package itself installed elsewhere — a pack composes onto its base space —
 * is its own: the playbook's `marketSource.packageSlug`, the automation's
 * `installedByPackage` (stamped at install), compared exactly.
 */
async function assertNoNamedClash(
  source: CatalogSource,
  definition: Bag,
  target: { userId: string; packageSlug: string }
): Promise<void> {
  const autos = bagsOf(definition.automations);
  const autoNames = [
    ...new Set(autos.flatMap((a) => textOf(a.name)?.toLowerCase() ?? [])),
  ];
  const autoKeys = autos.flatMap((a) => textOf(a.key) ?? []);
  const playbookNames = [
    ...new Set(
      [
        ...bagsOf(definition.playbooks).flatMap((p) => textOf(p.name) ?? []),
        ...loopPlaybookNames(definition),
      ].map((n) => n.toLowerCase())
    ),
  ];
  if (autoNames.length + autoKeys.length + playbookNames.length === 0) return;

  const notThisPackage = and(
    eq(workspaceMembers.userId, target.userId),
    isNull(workspaces.archivedAt),
    drizzleSql`${workspaces.packageSlug} is distinct from ${target.packageSlug}`
  );

  if (autoNames.length + autoKeys.length > 0) {
    const [hit] = await db
      .select({ name: automationsTable.name })
      .from(automationsTable)
      .innerJoin(workspaces, eq(workspaces.id, automationsTable.workspaceId))
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.workspaceId, automationsTable.workspaceId)
      )
      .where(
        and(
          or(
            autoNames.length > 0
              ? inArray(
                  drizzleSql<string>`lower(${automationsTable.name})`,
                  autoNames
                )
              : undefined,
            autoKeys.length > 0
              ? inArray(
                  drizzleSql<string>`${automationsTable.metadata}->>'templateKey'`,
                  autoKeys
                )
              : undefined
          ),
          drizzleSql`${automationsTable.metadata}->>'installedByPackage' is distinct from ${target.packageSlug}`,
          notThisPackage
        )
      )
      .limit(1);
    if (hit) {
      refuseTakeover(
        source,
        "an automation called",
        hit.name,
        "is already in one of your spaces"
      );
    }
  }

  if (playbookNames.length > 0) {
    const [hit] = await db
      .select({ name: playbooksTable.name })
      .from(playbooksTable)
      .innerJoin(workspaces, eq(workspaces.id, playbooksTable.workspaceId))
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.workspaceId, playbooksTable.workspaceId)
      )
      .where(
        and(
          inArray(
            drizzleSql<string>`lower(${playbooksTable.name})`,
            playbookNames
          ),
          ne(playbooksTable.status, "archived"),
          drizzleSql`${playbooksTable.metadata}->'marketSource'->>'packageSlug' is distinct from ${target.packageSlug}`,
          notThisPackage
        )
      )
      .limit(1);
    if (hit) {
      refuseTakeover(
        source,
        "a playbook called",
        hit.name,
        "is already in one of your spaces"
      );
    }
  }
}

/** See `assertNoTakeover`: a template may not change a pod-wide kind. */
async function assertNoPodWideKindChange(
  source: CatalogSource,
  definition: Record<string, unknown>
): Promise<void> {
  const withLifecycle = new Set<string>();
  const withOptions = new Map<string, string[]>();
  for (const p of bagsOf(definition.profiles)) {
    const slug = textOf(p.slug);
    if (!slug) continue;
    if (p.lifecycle) withLifecycle.add(slug);
    const fields = [
      ...bagsOf(p.properties).filter(
        (f) =>
          (Array.isArray(f.enumValues) && f.enumValues.length > 0) ||
          (Array.isArray(f.enumOptions) && f.enumOptions.length > 0)
      ),
      ...bagsOf(p.propertyDefs).filter((f) => {
        const options = bagOf(f.constraints)?.enum;
        return Array.isArray(options) && options.length > 0;
      }),
    ].flatMap((f) => textOf(f.slug) ?? []);
    if (fields.length > 0) withOptions.set(slug, fields);
  }
  const slugs = [...new Set([...withLifecycle, ...withOptions.keys()])];
  if (slugs.length === 0) return;
  const podWide = await db
    .select({ id: profiles.id, slug: profiles.slug })
    .from(profiles)
    .where(
      and(
        inArray(profiles.slug, slugs),
        inArray(profiles.scope, [ProfileScope.SYSTEM, ProfileScope.SHARED])
      )
    )
    .limit(slugs.length);
  for (const shared of podWide) {
    if (withLifecycle.has(shared.slug)) {
      refuseTakeover(
        source,
        "a lifecycle for the kind",
        shared.slug,
        "every space on this pod shares"
      );
    }
    const fields = withOptions.get(shared.slug);
    if (!fields?.length) continue;
    const [field] = await db
      .select({ slug: propertyDefs.slug })
      .from(propertyDefs)
      .where(
        and(
          eq(propertyDefs.profileId, shared.id),
          isNull(propertyDefs.workspaceId),
          inArray(propertyDefs.slug, fields)
        )
      )
      .limit(1);
    if (field) {
      refuseTakeover(
        source,
        `new options for "${field.slug}" on the kind`,
        shared.slug,
        "every space on this pod shares"
      );
    }
  }
}

/**
 * The ONE apply function per kind. Called by BOTH the direct-operator path
 * (market.install builtin verb, no agent involved) and the `capability.install`
 * approve-executor (post-approval re-entry) — never re-implemented twice.
 */
export async function applyMarketInstall(
  input: ApplyMarketInstallInput
): Promise<Record<string, unknown>> {
  // RC4 payload-in: when the caller supplies the definition, it IS the resolved
  // definition — skip lookupCatalogEntry AND every resolve/fetch path below (so
  // a PRIVATE package the pod can't fetch unauthenticated still installs). With
  // `entry` left null, each kind branch's existing `entry ? … : …` fetch is
  // bypassed in favour of `supplied`, while the `entry?.name`/`entry?.version`
  // display fallbacks degrade harmlessly (same as the by-key re-resolve path).
  const source = await resolveMarketSource(input.source);
  if (input.definition && !source.official) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A supplied definition installs only as a Synap package — a package from another source installs from its own signed listing.",
    });
  }
  const entry = input.definition
    ? null
    : await lookupCatalogEntry(input.kind, input.slug, source.cacheKey);
  // The identity everything this install creates is stamped with.
  const pslug = provenanceSlug(source, input.slug);

  // An approved proposal installs exactly the listing its reviewer was shown.
  if (
    input.proposedListingSha256 !== undefined &&
    (input.proposedListingSha256 ?? null) !== (entry?.listing?.sha256 ?? null)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The package "${entry?.name ?? input.slug}" changed since it was proposed, so nothing was installed — propose it again.`,
      cause: { code: "MARKET_LISTING_CHANGED" },
    });
  }

  // A source a person added: the trust gate runs HERE too, so an approved
  // proposal re-checks it (a source blocked or turned showcase since the
  // proposal was filed installs nothing). The approver is a person.
  let listed: Record<string, unknown> | null = null;
  if (!source.official) {
    if (!entry) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `"${input.slug}" is not in the ${source.name} catalog on this pod.`,
      });
    }
    const decision = decideMarketInstall(
      await marketSourceGate(source),
      "person"
    );
    if (decision.allow === "open_site") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `${source.name} is a showcase source — "${entry.name}" installs from the publisher's site, never from this pod.`,
        cause: { code: "MARKET_SHOWCASE_ONLY" },
      });
    }
    if (decision.allow === "refuse") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: decision.reason,
        cause: { code: "MARKET_SOURCE_REFUSED" },
      });
    }
    listed = input.verifiedDefinition ?? (await resolveListedDefinition(entry));
    await assertNoTakeover(source, input.kind, listed, {
      params: input.params ?? {},
      workspaceId: input.workspaceId,
      userId: input.userId,
      packageSlug: pslug,
    });
  }
  const supplied = input.definition ?? listed;

  // A CAPABILITY is resolvable WITHOUT a cache row. Opt-in capabilities
  // (syncByDefault:false, e.g. unipile-linkedin, arch-backend) never enter
  // cp_catalog_cache, but the CP serves them by key — the exact door `cap add`
  // uses (fetchCPCapabilityTemplate: pod cache → CP default-list → CP by-key).
  // Requiring a cache row here is why `market.install` NOT_FOUND/500s on every
  // opt-in cap while `cap add` installs it fine — two doors, divergent results.
  // Every other kind still requires the cache row (cell needs its inline source;
  // automation/template fetch by slug but need the row's `source`).
  // Capability is handled BEFORE the cache-row requirement because it resolves
  // by key, cache-row or not.
  if (input.kind === "capability") {
    const definition = (supplied ??
      (await resolveCatalogDefinition(
        "capability",
        input.slug,
        entry,
        input.version
      ))) as unknown as CapabilityDefinition | null;
    if (!definition) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Capability "${input.slug}" isn't in the Control Plane catalog — check the slug, or reseed the CP if it was just authored.`,
      });
    }
    const workspaceRole = input.workspaceId
      ? (await getWorkspaceMembership(db, input.workspaceId, input.userId))
          ?.role
      : "owner";
    const ctx = {
      db,
      authenticated: true as const,
      userId: input.userId,
      workspaceId: input.workspaceId,
      workspaceRole,
    } as unknown as Context;
    const result = await applyCapabilityDefinition(
      definition,
      input.params,
      ctx,
      // Only Synap's own catalog may ship a reader for more than one domain.
      { officialSource: source.official }
    );
    return {
      kind: "capability",
      key: result.capabilityKey,
      created: result.created,
      webhooks: result.webhooks,
    };
  }

  // CELL used to REQUIRE a cache row (its renderer source is inline-only — the
  // by-slug packages endpoint never serves cell source). It now re-resolves by
  // key below when the row is missing, mirroring the capability/automation/
  // template by-key fallbacks above — so an opt-in / just-authored cell the
  // background sync hasn't picked up yet installs instead of dead-ending in
  // NOT_FOUND. `resolveCellDefinitionByKey` itself throws NOT_FOUND when the CP
  // is unconfigured or genuinely has no matching cell.
  const cellByKey =
    !entry && !supplied && input.kind === "cell"
      ? await resolveCellDefinitionByKey(input.slug)
      : null;

  switch (input.kind) {
    case "cell": {
      // RC4 payload → cache row's inline definition → by-key CP fallback.
      const def = (supplied ??
        entry?.definition ??
        cellByKey?.def) as CellCatalogDef | null;
      // What the catalog served (not a caller's payload) passes Synap's
      // signature rule first.
      if (!supplied && def) {
        await assertOfficialDefinition({
          kind: "cell",
          slug: cellByKey
            ? `${cellByKey.packageSlug}/${cellByKey.cellKey}`
            : input.slug,
          version: entry?.version ?? cellByKey?.packageVersion ?? null,
          definition: def as Record<string, unknown>,
        });
      }
      if (!def?.code) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Cell "${input.slug}" is missing its renderer source in the catalog cache — wait for the next sync and retry.`,
        });
      }
      // Identity, same rule the other kinds use: the PACKAGE being installed
      // is `input.slug`. A payload that names its own owner wins; otherwise the
      // installed package IS the owner. The old `?? "unknown"` fallback made
      // every source-less cell share one namespace, so two unrelated cells with
      // the same `key` minted the SAME `cell:unknown:<key>` and the second
      // install died on `widget_def_type_key_workspace_uniq`.
      const [ownPackage, slugCellKey] = input.slug.includes("/")
        ? input.slug.split("/")
        : [
            def.packageSlug ?? cellByKey?.packageSlug ?? input.slug,
            def.key ?? cellByKey?.cellKey ?? input.slug,
          ];
      // From an added source the package segment is qualified
      // (`cell:acme/charts:bar`), so it can never overwrite Synap's cell.
      const slugPackage = source.official
        ? ownPackage
        : qualifiedPackageId(source.id, ownPackage as string);
      // Shared with the packages/apply inline-`cells[]` applier so the typeKey
      // derivation and the view-renderer affinity threading cannot drift
      // between the two install doors. See `install-cell-from-definition.ts`.
      const result = await installCellFromDefinition({
        definition: def,
        name: entry?.name ?? cellByKey?.name ?? input.slug,
        packageSlug: slugPackage as string,
        cellKey: slugCellKey as string,
        workspaceId: input.workspaceId,
        // B3 — the version was resolved here and DISCARDED. Cells were the only
        // kind with no version at all, so `market installed` could never say a
        // cell was behind its package. Same precedence the other five kinds use
        // (catalog row → by-key CP fallback → explicit request → unknown). The
        // by-key hop reads `packageVersion` off the marketplace/cells row.
        packageVersion:
          entry?.version ?? cellByKey?.packageVersion ?? input.version ?? null,
        userId: input.userId,
      });
      return {
        kind: "cell",
        typeKey: result.typeKey,
        changeType: result.changeType,
        packageSlug: slugPackage as string,
        packageVersion:
          entry?.version ?? cellByKey?.packageVersion ?? input.version ?? null,
      };
    }

    case "template": {
      // Supplied payload (RC4) → use directly; else cache row present → resolve
      // inline/by-slug; row MISSING → by-key re-resolve from the CP (opt-in /
      // just-authored template).
      const definition = (supplied ??
        (await resolveCatalogDefinition(
          "template",
          input.slug,
          entry,
          input.version
        ))) as unknown as WorkspaceDefinitionInput & {
        workspaceName?: string;
      };
      // PARSED, not cast, BEFORE anything is applied: the Hub door's schema
      // applies DEFAULTS the appliers' own routers do not (`automations[]` /
      // `playbooks[]` status → "active"; the routers default to "draft"). A CP
      // package carries `defaultStatus` and leaves `status` absent, so a raw
      // cast installed every automation and playbook DRAFT while the same
      // package through the Hub door went live. Dynamic import: this module
      // never pulls a router (and its Hono/DB graph) into an eager import.
      const { PackageApplySchema } =
        await import("../../routers/hub-protocol/rest/packages.js");
      const parsed = PackageApplySchema.safeParse(definition);
      if (!parsed.success) {
        logger.error(
          { slug: input.slug, issues: parsed.error.issues },
          "Package definition failed validation"
        );
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Package "${input.slug}" has an invalid definition (capabilities/automations/playbooks). Nothing was applied.`,
        });
      }
      const postBody = parsed.data as unknown as PackagePostWorkspaceBody & {
        projectId?: string;
        projectName?: string;
        projectSurface?: unknown;
      } & Record<string, unknown>;
      // From an added source the namespace is FORCED to its qualified id —
      // never the definition's own `_meta.slug` (`applyTemplate` keeps a slug
      // the body already carries, so this is what it stamps).
      if (!source.official) postBody._meta = { ...postBody._meta, slug: pslug };

      // THE ONE template apply (the Hub `/packages/apply` and approve doors
      // run it too): resolves `dependencies`, layers an overlay (`compose`) or
      // a PACK (D8 — never its own workspace) onto its base, else finds the
      // space holding the slug (or creates it), plans, builds / re-syncs
      // layer 1, applies layer 2 from the same source, and stamps the version
      // only on convergence. The catalog slug (source-qualified when it is not
      // the official catalog's) is the idempotency key.
      //
      // No `agentUserId`: an agent-initiated market.install ALWAYS proposes
      // (runMarketInstall), so every path that reaches here acts on a human's
      // authority — the operator's own call, or the approver's.
      const { applyTemplate } = await import("../template-apply/index.js");
      const applied = await applyTemplate({
        definition,
        layerTwoBody: postBody,
        actor: { userId: input.userId, scopes: [] },
        source: "market.install",
        // A body the pod resolved from a catalog carries that catalog's
        // version — an added source's verified listing included (its bytes
        // were checked against the listed sha256 and content version). Only a
        // body the CALLER sent (RC4) is versioned by the hash of what it sent
        // (`applyTemplate`).
        ...(input.definition
          ? { sentDefinition: input.definition }
          : { catalogVersion: entry?.version ?? input.version ?? undefined }),
        identity: {
          packageSlug: pslug,
          ...(input.definition && input.version
            ? { packageVersion: input.version }
            : {}),
          proposalId: pslug,
          workspaceName: definition.workspaceName,
          templateId: pslug,
          templateName: entry?.name ?? input.slug,
        },
        // Engagement project (named install): resolved once the space exists,
        // before layer 2, so uses-edges and seed filing stamp onto it.
        beforeLayerTwo: async (homeWorkspaceId) => {
          if (!input.projectId && !input.projectName) return;
          const { resolveProjectForPackInstall, ProjectResolveError } =
            await import("../resolve-project-for-pack-install.js");
          const resolved = await resolveProjectForPackInstall({
            userId: input.userId,
            agentUserId: input.agentUserId ?? undefined,
            projectId: input.projectId,
            projectName: input.projectName,
            packageSlug: pslug,
            homeWorkspaceId,
          });
          if ("error" in resolved)
            throw new ProjectResolveError(resolved.error);
          if (
            postBody.projectSurface &&
            typeof postBody.projectSurface === "object"
          ) {
            const {
              getDb,
              sql,
              projects,
              eq,
              ProjectRepository,
              EventRepository,
            } = await import("@synap/database");
            const dbConn = await getDb();
            const [existing] = await dbConn
              .select({ settings: projects.settings })
              .from(projects)
              .where(eq(projects.id, resolved.projectId))
              .limit(1);
            const prev = (existing?.settings ?? {}) as Record<string, unknown>;
            const projectRepo = new ProjectRepository(
              dbConn,
              new EventRepository(sql)
            );
            await projectRepo.update(
              resolved.projectId,
              { settings: { ...prev, layout: postBody.projectSurface } },
              input.userId
            );
          }
          return { projectId: resolved.projectId };
        },
      });

      // ONE SHAPE ACROSS THE INSTALL DOORS: `layers[]` is the same
      // `InstallLayerReport` `createFromDefinition` emits. Per-item errors in
      // the layer-2 bag become a `failed` layer; a whole-layer failure is
      // recorded on the space (`failed`, layer 2) and reported here — never
      // thrown, the space is in place and `synap templates update` finishes it.
      const postWorkspace =
        applied.layer2.status === "applied" ? applied.layer2.post : undefined;
      // The raw cause is logged by `applyTemplate` (operator log only — it
      // can carry DB/connector internals); the caller gets a fixed sentence.
      // The engagement project's own refusal (the step before layer 2) is
      // written for the caller, so it leads the sentence.
      const projectRefusal =
        applied.layer2.status === "failed" &&
        applied.layer2.error instanceof
          (await import("../resolve-project-for-pack-install.js"))
            .ProjectResolveError
          ? `${(applied.layer2.error as Error).message} `
          : "";
      const layers =
        applied.layer2.status === "failed"
          ? [
              {
                layer: "post-workspace" as const,
                status: "failed" as const,
                message: `${projectRefusal}${(await import("../template-health.js")).layerTwoFailedSentence(input.slug)}`,
              },
            ]
          : summarizePostWorkspaceLayers(postWorkspace);
      return {
        kind: "template",
        workspaceId: applied.workspaceId,
        created: applied.layerOne?.created ?? false,
        // Additive only — `kind`/`workspaceId`/`created` are unchanged for the
        // two existing consumers (builtin-verbs' passthrough result and the
        // `capability.install` executor, which stores the object opaquely).
        ...(postWorkspace ? { postWorkspace } : {}),
        ...(layers.length > 0 ? { layers } : {}),
        ...(applied.warning ? { templateApplyWarning: applied.warning } : {}),
        // W3b: the project-scope playbooks this install made startable, read
        // through the same pure derivation `createFromDefinition` uses. A
        // caller may OFFER to start one on a project; never auto-started.
        trackTemplates: installedTrackTemplates(postWorkspace),
      };
    }

    case "automation": {
      // Installing "an automation" adds it to the caller's ACTING workspace —
      // it does not provision a new one (that's the template kind's job).
      if (!input.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "market.install for kind:automation requires an acting workspace (workspaceId) to add it to.",
        });
      }
      const membership = await getWorkspaceMembership(
        db,
        input.workspaceId,
        input.userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No access to the acting workspace.",
        });
      }
      // Supplied payload (RC4) → use directly; else cache row present → resolve
      // inline/by-slug; row MISSING → by-key re-resolve from the CP (opt-in /
      // just-authored automation package).
      const definition = (supplied ??
        (await resolveCatalogDefinition(
          "automation",
          input.slug,
          entry,
          input.version
        ))) as {
        automations?: Array<{
          name: string;
          description?: string;
          triggerType: "event" | "cron" | "webhook" | "manual";
          triggerConfig?: Record<string, unknown>;
          flowDefinition?: {
            nodes: Record<string, unknown>[];
            edges: Record<string, unknown>[];
          };
          status?: "draft" | "active" | "paused";
          metadata?: Record<string, unknown>;
        }>;
      };
      const autos = definition.automations ?? [];
      if (autos.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Marketplace entry "${input.slug}" carries no automations[] in its definition — nothing to install.`,
        });
      }
      const { automationsRouter } =
        await import("../../routers/automations.js");
      const caller = automationsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);

      const results: unknown[] = [];
      for (const a of autos) {
        // Per-item isolation: one automation that fails to create must NOT abort
        // the rest of the market.install — the failed one is reported as
        // {status:"error"} in `results` and downstream automations still run.
        // Mirrors the per-item try/catch in createCapabilityFromDefinition and
        // applyPackagePostWorkspace (the reference partial-install pattern).
        try {
          // Idempotent reuse keyed on name+workspace — mirrors /packages/apply's
          // own automations step (out of this wave's write scope to import).
          const [existing] = await db
            .select({ id: automationsTable.id })
            .from(automationsTable)
            .where(
              and(
                eq(automationsTable.name, a.name),
                eq(automationsTable.workspaceId, input.workspaceId)
              )
            )
            .limit(1);
          if (existing) {
            results.push({ name: a.name, status: "reused", id: existing.id });
            continue;
          }
          // W4a source-link: stamp the reconcilable fields AS INSTALLED (the base
          // of every future 3-way merge) so a published fix can self-heal this
          // automation and a re-install can't silently duplicate it. `fields`
          // MUST equal exactly the values passed to create() for the baseline to
          // be an honest merge base — reuse the same vars below.
          const triggerConfig = a.triggerConfig ?? {};
          const flowDefinition = a.flowDefinition ?? { nodes: [], edges: [] };
          const fields = {
            name: a.name,
            description: a.description,
            triggerType: a.triggerType,
            triggerConfig,
            flowDefinition,
          };
          const stamp = buildMarketSource(fields, {
            packageSlug: pslug,
            packageVersion: entry?.version ?? input.version ?? null,
            installedAt: new Date().toISOString(),
          });
          // Merge author metadata (e.g. `metadata.kind: "calibration-recommender"`,
          // the marker the browser CalibrationRecommenderSeam matches on) UNDER the
          // system `marketSource` stamp: `stampMarketSource` spreads the base first,
          // then writes MARKET_SOURCE_KEY last, so the author's keys survive and the
          // system provenance can never be clobbered. Mirrors the author-metadata
          // merge in package-apply-post-workspace.ts. The W4a `fields`/baseline above
          // is unaffected — metadata is not a reconcilable field.
          const metadata = stampMarketSource(a.metadata, stamp);
          const r = await caller.create({
            workspaceId: input.workspaceId,
            name: a.name,
            description: a.description,
            triggerType: a.triggerType,
            triggerConfig,
            flowDefinition,
            status: a.status ?? "active",
            metadata,
            source: "intelligence",
          });
          results.push({
            name: a.name,
            status: "created",
            id: (r as { id?: string }).id,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, slug: input.slug, automation: a.name },
            "market.install automation create failed (isolated — install continues)"
          );
          results.push({ name: a.name, status: "error", message });
        }
      }
      return { kind: "automation", automations: results };
    }

    case "skill": {
      // A standalone `skill` package installs into the caller's context via the
      // SAME governed door the direct create + MCP `synap_create_skill` use —
      // `skillsRouter.create` (its checkPermissionOrPropose gate handles
      // approval; a `code` skill is born unapproved, an `instruction` skill
      // born approved). Supplied payload (RC4) → use directly; else cache row
      // present → resolve inline/by-slug; row MISSING → by-key re-resolve from
      // the CP (opt-in / just-authored skill package), mirroring the
      // automation/template kinds. workspaceId is optional (a skill is pod-wide
      // when the caller has no acting workspace).
      // The PUBLISHED definition NESTS the skill under `skill`, exactly as
      // `capability` nests under `capability` and views under `views[]` — so
      // unwrap it before reading the flat field names below. WITHOUT this unwrap
      // every field reads `undefined`, and the create door then refuses ("A skill
      // needs documentation or code"): the publish succeeds, the catalog row
      // looks correct, and only the INSTALL fails — a shape mismatch no
      // key-diff catches. Falls back to the resolved object itself, so a legacy
      // flat definition (e.g. the `content-extraction-pack` command pack, which
      // carries no `skill` slot at all) behaves exactly as it did before.
      const resolved =
        supplied ??
        (await resolveCatalogDefinition(
          "skill",
          input.slug,
          entry,
          input.version
        ));
      const definition = skillElementOf(
        resolved as Record<string, unknown>
      ) as {
        /** The skill's own `load_skill` ref — see `skillFields.slug` below. */
        slug?: string;
        name?: string;
        displayName?: string;
        description?: string;
        kind?: "instruction" | "code" | "declarative" | "builtin";
        scope?: "pod" | "user" | "workspace";
        agentTypes?: string[];
        body?: string;
        code?: string;
        providerSpec?: Record<string, unknown>;
        parameters?: Record<string, unknown>;
        category?: string;
        executionMode?: "sync" | "async";
        timeoutSeconds?: number;
      };
      const workspaceRole = input.workspaceId
        ? (await getWorkspaceMembership(db, input.workspaceId, input.userId))
            ?.role
        : "owner";
      const ctx = {
        db,
        authenticated: true as const,
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole,
      } as unknown as Context;
      const { skillsRouter } = await import("../../routers/skills.js");
      // W4a source-link: `skillFields` = the resolved values written from the
      // definition; they become the merge baseline, so `fields` MUST equal what
      // create() receives (spread below) for the 3-way merge to be honest.
      const skillFields = {
        name:
          definition.name ??
          definition.displayName ??
          entry?.name ??
          input.slug,
        description: definition.description ?? entry?.description ?? undefined,
        kind: definition.kind,
        scope: definition.scope ?? "pod",
        agentTypes: definition.agentTypes,
        body: definition.body,
        code: definition.code,
        providerSpec: definition.providerSpec,
        parameters: definition.parameters,
        category: definition.category,
        executionMode: definition.executionMode ?? "sync",
        timeoutSeconds: definition.timeoutSeconds ?? 30,
      };
      const stamp = buildMarketSource(skillFields, {
        packageSlug: pslug,
        packageVersion: entry?.version ?? input.version ?? null,
        installedAt: new Date().toISOString(),
      });
      const metadata = stampMarketSource(undefined, stamp);
      const result = await skillsRouter.createCaller(ctx).create({
        workspaceId: input.workspaceId ?? undefined,
        ...skillFields,
        /**
         * The skill's OWN ref (`load_skill` slug). WITHOUT this the row lands
         * with `slug = NULL` and can never be linked: a space's declared skills
         * are resolved BY SLUG (`services/skills/template-skills.ts` matches
         * `skills.slug`), so a package-installed skill would install cleanly and
         * stay invisible to the space that depends on it. Falls back to the
         * package slug, which for a standalone skill package IS its ref.
         *
         * Deliberately NOT part of `skillFields`: that object is the reconcile's
         * merge BASELINE, and every baseline key must be writable by
         * `skillsRouter.update` — which does not accept `slug` (identity is not
         * an updating field). A baseline key the update door cannot write is
         * silently stripped while the merge records it as applied — a durable
         * lie. `marketplace-install.baseline-writability.tripwire.test.ts`
         * enforces exactly this split.
         */
        // From an added source the ref is qualified, so it can never shadow
        // a Synap skill a space already loads by slug.
        slug: source.official
          ? (definition.slug ?? input.slug)
          : qualifiedPackageId(source.id, definition.slug ?? input.slug),
        metadata,
      });
      return { kind: "skill", ...result };
    }

    case "view": {
      // A `view` package bundles ONE OR MORE views (e.g. task-views-pack ships a
      // Kanban board, priority matrix, calendar and table). The CP shape is
      // `{ views: PackageViewDefinition[], profiles?, … }` — each view carries
      // its render `type` + `config`, and its scope as profile SLUGS
      // (`scopeProfileSlugs`), NOT the per-pod profile UUIDs `viewsRouter.create`
      // needs. So: normalize to a list of views → resolve each view's scope slugs
      // to THIS pod's profile ids → create each through the SAME governed door
      // the direct create + MCP `synap_create_view` use. Supplied payload (RC4)
      // → use directly; else cache row present → resolve inline/by-slug; row
      // MISSING → by-key re-resolve from the CP.
      const definition = (supplied ??
        (await resolveCatalogDefinition(
          "view",
          input.slug,
          entry,
          input.version
        ))) as {
        name?: string;
        displayName?: string;
        views?: Array<{
          slug?: string;
          name?: string;
          displayName?: string;
          description?: string;
          type?: string;
          config?: Record<string, unknown>;
          query?: Record<string, unknown>;
          metadata?: Record<string, unknown>;
          scopeProfileSlugs?: string[];
          scopeProfileIds?: string[];
        }>;
        // Legacy single-view shape (top-level view fields).
        slug?: string;
        description?: string;
        type?: string;
        config?: Record<string, unknown>;
        query?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
        scopeProfileSlugs?: string[];
        scopeProfileIds?: string[];
      };

      // Multi-view package `views[]`, else a single top-level view.
      const viewDefs =
        definition.views && definition.views.length > 0
          ? definition.views
          : definition.type
            ? [definition]
            : [];
      if (viewDefs.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `View package "${input.slug}" declares no views (no \`views[]\` and no top-level \`type\`) — nothing to install.`,
        });
      }
      if (!input.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Installing the view package "${input.slug}" requires an acting workspace (workspaceId) to place its views in.`,
        });
      }

      // Resolve scope profile SLUGS → this pod's profile UUIDs. Views ship slugs
      // (portable across pods); the create door needs ids. Match pod-wide (system)
      // profiles or ones in the acting workspace, preferring the workspace-scoped
      // row for a slug that exists at both levels.
      const scopeSlugs = Array.from(
        new Set(viewDefs.flatMap((v) => v.scopeProfileSlugs ?? []))
      );
      const slugToProfileId = new Map<string, string>();
      if (scopeSlugs.length > 0) {
        const profileRows = await db
          .select({
            id: profiles.id,
            slug: profiles.slug,
            workspaceId: profiles.workspaceId,
          })
          .from(profiles)
          .where(
            and(
              inArray(profiles.slug, scopeSlugs),
              or(
                isNull(profiles.workspaceId),
                eq(profiles.workspaceId, input.workspaceId)
              )
            )
          );
        for (const r of profileRows) {
          if (
            !slugToProfileId.has(r.slug) ||
            r.workspaceId === input.workspaceId
          ) {
            slugToProfileId.set(r.slug, r.id);
          }
        }
      }

      const workspaceRole =
        (await getWorkspaceMembership(db, input.workspaceId, input.userId))
          ?.role ?? "owner";
      const ctx = {
        db,
        authenticated: true as const,
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole,
      } as unknown as Context;
      const { viewsRouter } = await import("../../routers/views.js");
      const viewCaller = viewsRouter.createCaller(ctx);

      // W4d dedup: a re-install must not clone views. Load the workspace's views
      // already source-linked to THIS package (metadata.marketSource.packageSlug)
      // and index them by name — the install identity for a view. A matching
      // (slug, name) row is UPDATED through the governed views door instead of
      // creating a duplicate.
      const existingViews = await db
        .select({
          id: views.id,
          name: views.name,
          metadata: views.metadata,
        })
        .from(views)
        .where(eq(views.workspaceId, input.workspaceId));
      const linkedByName = new Map<string, string>();
      for (const ev of existingViews) {
        if (
          readMarketSource(ev.metadata as Record<string, unknown> | null)
            ?.packageSlug === pslug
        ) {
          linkedByName.set(ev.name, ev.id);
        }
      }

      const created: string[] = [];
      const updated: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      // The ids of the views this install wrote (created or updated, in order),
      // so the installer can open what it installed. A create that was only
      // PROPOSED has no view yet and adds none.
      const viewIds: string[] = [];
      for (const v of viewDefs) {
        const name =
          v.name ?? v.displayName ?? v.slug ?? entry?.name ?? input.slug;
        const scopeProfileIds =
          v.scopeProfileIds && v.scopeProfileIds.length > 0
            ? v.scopeProfileIds
            : (v.scopeProfileSlugs ?? [])
                .map((s) => slugToProfileId.get(s))
                .filter((id): id is string => Boolean(id));
        // W4a source-link: `fields` = the reconcilable values written from the
        // definition (the merge baseline). The invariant is `fields` ⊆ the
        // UPDATE door's write-set: the reconcile derives its desired set from
        // exactly these keys and replays them through views.update, so a key the
        // update input cannot write is stripped, yet the baseline advances as if
        // applied — a permanent false "user-edited" classification. (It is NOT
        // "equal to create()": create also writes `description` and
        // `scopeProfileIds`, which are deliberately unmanaged here.)
        const fields = {
          name,
          type: v.type,
          query: v.query,
          config: v.config,
        };
        const stamp = buildMarketSource(fields, {
          packageSlug: pslug,
          packageVersion: entry?.version ?? input.version ?? null,
          installedAt: new Date().toISOString(),
        });
        const metadata = stampMarketSource(v.metadata, stamp);
        try {
          const existingId = linkedByName.get(name);
          if (existingId) {
            // Re-install of an already-linked view → UPDATE in place through the
            // governed views door (no duplicate). `type` is runtime-validated by
            // the door's ViewTypeEnum.
            await viewCaller.update({
              id: existingId,
              name,
              type: v.type,
              query: v.query,
              config: v.config,
              metadata,
            } as Parameters<typeof viewCaller.update>[0]);
            updated.push(name);
            viewIds.push(existingId);
          } else {
            // `type` is runtime-validated by the door's ViewTypeEnum; cast to the
            // caller's input shape (an invalid type is rejected by zod there).
            const made = await viewCaller.create({
              workspaceId: input.workspaceId,
              name,
              description: v.description,
              type: v.type,
              scopeProfileIds,
              query: v.query,
              config: v.config,
              metadata,
            } as Parameters<typeof viewCaller.create>[0]);
            created.push(name);
            const madeId = (made as { view?: { id?: unknown } | null }).view?.id;
            if (typeof madeId === "string") viewIds.push(madeId);
          }
        } catch (err) {
          failed.push({
            name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // If NOTHING installed OR updated, surface why (most often: a scope profile
      // absent on this pod). A partial success returns all lists for the caller.
      if (created.length === 0 && updated.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `View package "${input.slug}" installed no views: ${failed
            .map((f) => `${f.name} (${f.error})`)
            .join("; ")}`,
        });
      }
      return { kind: "view", created, updated, failed, viewIds };
    }
  }
}

export interface RunMarketInstallInput {
  slug: string;
  kind: CatalogKind;
  /**
   * The catalog source: omitted (or `synap`) = the official source; an added
   * source's id otherwise. A bare request never reaches an added source.
   */
  source?: string | null;
  version?: string | null;
  params?: Record<string, unknown>;
  /**
   * RC4 payload-in: the FULL package definition supplied by an
   * already-CP-authenticated client (see ApplyMarketInstallInput.definition).
   * Threaded straight into the direct-execute path so an operator installs a
   * PRIVATE package the pod cannot fetch unauthenticated. Official only.
   */
  definition?: Record<string, unknown>;
  /**
   * A person's explicit confirms for a package from a TRUSTED added source
   * that runs code, reaches the network or uses a connection the pod already
   * has (the console's extra confirms).
   */
  acknowledge?: MarketAcknowledgement;
  userId: string;
  workspaceId: string | null;
  /** The acting AGENT (agent-user id), when this call originates from an agent. */
  agentUserId?: string | null;
  projectId?: string;
  projectName?: string;
}

export type MarketInstallOutcome =
  | { status: "installed"; result: Record<string, unknown> }
  | { status: "proposed"; proposalId: string; reviewUrl: string };

/**
 * Entry point for the `market.install` builtin verb and the console's
 * `marketplace.install`. The source's trust level decides first
 * (`decideMarketInstall`):
 *   - official: an agent ALWAYS proposes (P2.1-A / D3) — never auto-provisions,
 *     whatever the outer capability gate let through; a person installs.
 *   - trusted: a person installs after confirming code / network reach /
 *     existing connections; an agent proposes only where the source opted in, else it is refused.
 *   - showcase: never installs — the publisher's site does.
 */
export async function runMarketInstall(
  input: RunMarketInstallInput
): Promise<MarketInstallOutcome> {
  const source = await resolveMarketSource(input.source);
  const entry = await lookupCatalogEntry(
    input.kind,
    input.slug,
    source.cacheKey
  );
  // Capability resolves by key even without a cache row — opt-in caps
  // (syncByDefault:false) never enter cp_catalog_cache but the CP serves them by
  // key (applyMarketInstall re-resolves via fetchCPCapabilityTemplate). The same
  // now holds for automation/template (resolveDefinitionByKey) AND cell
  // (resolveCellDefinitionByKey, `GET {CP}/api/marketplace/cells?q=`) — an
  // opt-in / just-authored package the cache never saw re-resolves by key from
  // the CP instead of dead-ending here. Official source only: an added source
  // serves nothing it did not sign.
  const actor = input.agentUserId ? "agent" : "person";
  const decision = decideMarketInstall(await marketSourceGate(source), actor);
  if (decision.allow === "open_site") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${source.name} is a showcase source — "${entry?.name ?? input.slug}" installs from the publisher's site, never from this pod.`,
      cause: {
        code: "MARKET_SHOWCASE_ONLY",
        url: entry?.listing?.installUrl ?? entry?.listing?.homepageUrl ?? null,
      },
    });
  }
  if (decision.allow === "refuse") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: decision.reason,
      cause: { code: "MARKET_SOURCE_REFUSED", source: source.id },
    });
  }

  // An added source: fetch + verify once, and disclose what it brings BEFORE
  // a proposal is filed or anything is written. A person must have confirmed
  // code, network reach and the use of existing connections explicitly.
  let verifiedDefinition: Record<string, unknown> | undefined;
  let notices: string[] = [];
  if (!source.official) {
    if (!entry) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `"${input.slug}" is not in the ${source.name} catalog on this pod.`,
      });
    }
    if (input.definition) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "A supplied definition installs only as a Synap package — a package from another source installs from its own signed listing.",
      });
    }
    verifiedDefinition = await resolveListedDefinition(entry);
    const risks = assessMarketRisks(verifiedDefinition);
    if (actor === "person") {
      const missing = missingAcknowledgements(risks, input.acknowledge);
      if (missing.length > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: missing.join(" "),
          cause: { code: "MARKET_ACK_REQUIRED", missing },
        });
      }
    }
    notices = riskNotices(risks);
  } else {
    // Tier pre-check — fail early, before any proposal or provisioning.
    // Tiers are Synap's plans; an added source's `requiredTier` is its own.
    await assertPackageTierAccess(input.userId, input.slug);
  }

  if (decision.allow === "propose") {
    const from = source.official
      ? "the marketplace"
      : `${source.name} (${source.id})`;
    const proposal = await createPendingProposal({
      userId: input.userId,
      workspaceId: input.workspaceId,
      targetType: "capability",
      targetId: `market:${input.kind}:${provenanceSlug(source, input.slug)}`,
      proposalType: "capability.install",
      agentUserId: input.agentUserId ?? undefined,
      data: {
        slug: input.slug,
        kind: input.kind,
        // `entry` is null for any by-key re-resolve (opt-in capability, or an
        // automation/template with no cache row); the approve-executor re-resolves
        // the definition via applyMarketInstall, so version here is informational.
        version: input.version ?? entry?.version ?? null,
        // The source the approval installs from (re-checked then), and the
        // exact listing disclosed here: approval refuses any other.
        source: source.id,
        listingSha256: entry?.listing?.sha256 ?? null,
        params: input.params ?? {},
        ...(notices.length > 0 ? { risks: notices } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.projectName ? { projectName: input.projectName } : {}),
      },
      notificationDescription: `Install "${entry?.name ?? input.slug}" (${input.kind}) v${entry?.version ?? "latest"} from ${from}${notices.length > 0 ? ` — ${notices.join(" ")}` : ""}`,
    });
    return {
      status: "proposed",
      proposalId: proposal.id,
      reviewUrl: openLink(proposal.id),
    };
  }

  const result = await applyMarketInstall({
    kind: input.kind,
    slug: input.slug,
    source: source.id,
    version: input.version,
    params: input.params,
    definition: input.definition,
    verifiedDefinition,
    userId: input.userId,
    workspaceId: input.workspaceId,
    agentUserId: input.agentUserId,
    projectId: input.projectId,
    projectName: input.projectName,
  });
  return { status: "installed", result };
}
