/**
 * CP Catalog Sync Worker
 *
 * Background refresher for the pod-local `cp_catalog_cache` — the generalized,
 * source-dimensioned successor to `capability-template-sync.ts` (which keeps
 * running unchanged; this is additive, not a replacement — see P2.4-B in
 * CAPABILITY-MARKETPLACE-PLAN.md). Fills the cache for all four marketplace
 * kinds from each configured catalog source (`catalogSources()` — the ONE
 * seam: the built-in Synap source plus the sources a pod admin added, Pod
 * Console D11). The official source is read from the Control Plane's own
 * endpoints, as below; an added source serves a signed `synap-index.json`
 * and is synced by `marketplace-source-sync.ts`:
 *
 *   - capability → GET {source}/api/marketplace/capabilities
 *   - automation → GET {source}/api/packages?category=workflow
 *   - template   → GET {source}/api/packages?category=workspace
 *   - cell       → GET {source}/api/marketplace/cells
 *
 * NOTE on the package `category`: the pod's internal marketplace `kind`
 * vocabulary (capability | automation | template | cell — what agents'
 * `market.search(kind:…)` and the cache's `kind` column speak) predates the
 * CP's `0049_package_vocabulary` migration. The CP's live `PACKAGE_TYPES` are
 * now `workspace | capability | skill | workflow | view | cell` — `template`
 * and `automation` are RETIRED and a request with `category=template` returns
 * HTTP 400. So the OUTBOUND CP query maps kind → the CP's live category
 * (automation→workflow, template→workspace); the cache still STORES
 * kind=automation|template, unchanged, so nothing downstream is orphaned.
 *
 * Runs on a schedule (every 10 minutes) AND once on startup — it is now the
 * SOLE cron catalog sync, having superseded the (retired-from-cron)
 * capability-template-sync (P2.4-B). Resilience contract:
 *   - 5xx / network error / timeout (8s) → transient: log at warn + leave that
 *     source's existing cache rows INTACT (never wipe).
 *   - 4xx → misconfiguration: the request itself is wrong (e.g. a retired
 *     category) and will NEVER self-heal on retry. Log LOUDLY at error + stamp
 *     `misconfigured` (distinct from `unreachable`) so an operator sees it;
 *     cache still left intact (never wipe).
 *   - source returns 0 entries for a kind → no-op for that (source, kind) —
 *     likely a hiccup, not an intentional empty catalog.
 *   - upsert + prune is scoped per (source, kind): a failure/empty response on
 *     one kind never touches another kind's or another source's rows.
 *
 * Inlined fetches (not imported from @synap/api) for the same reason as
 * capability-template-sync.ts: @synap/jobs cannot import @synap/api (circular
 * dependency — api → jobs).
 */

import {
  db,
  drizzleSql,
  and,
  eq,
  notInArray,
  recordCatalogSyncStamp,
  readMarketplaceSources,
  type MarketplaceSourcesSnapshot,
} from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  OFFICIAL_SOURCE_ID,
  type MarketplaceTrust,
} from "@synap-core/types/marketplace-source";
import { mergePackageSearchTags } from "./package-search-tokens.js";
import { syncThirdPartySource } from "./marketplace-source-sync.js";

const logger = createLogger({ module: "cp-catalog-sync" });

/**
 * Compare two version strings, returning >0 if a is newer, <0 if b is newer, 0 if equal.
 * Handles semantic versions (1.2.3), hash-prefixed versions (h-abc123), and empty strings.
 * Empty version is treated as older than any real version.
 */
function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  // Strip leading 'h-' from hash versions (e.g. "h-16a7f0bd5ee5" → "16a7f0bd5ee5")
  const aClean = a.startsWith("h-") ? a.slice(2) : a;
  const bClean = b.startsWith("h-") ? b.slice(2) : b;

  // Try semantic version compare first (e.g. "1.2.3" vs "1.2.4")
  const semverA = aClean.match(/^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/);
  const semverB = bClean.match(/^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/);
  if (semverA && semverB) {
    const [, aMajor, aMinor, aPatch] = semverA;
    const [, bMajor, bMinor, bPatch] = semverB;
    const majorDiff = Number(aMajor) - Number(bMajor);
    if (majorDiff !== 0) return majorDiff;
    const minorDiff = Number(aMinor) - Number(bMinor);
    if (minorDiff !== 0) return minorDiff;
    return Number(aPatch) - Number(bPatch);
  }

  // Fall back to string compare for hash versions or mixed formats
  // Lexicographic works for fixed-length hashes and ISO dates
  return aClean.localeCompare(bClean);
}

export const CP_CATALOG_SYNC_QUEUE = "cp-catalog-sync";
/** Cron schedule for this worker (every 10 minutes) — mirrors capability-template-sync. */
export const CP_CATALOG_SYNC_CRON = "*/10 * * * *";

// TODO(control-plane-types): adopt MarketplaceCatalogKind/MarketplaceCatalogEntry
// from @synap-core/control-plane-types@1.1.0 once published — this inline shape
// duplicates that contract (P2.10.3) and must not drift from it.
export type CatalogKind =
  "capability" | "automation" | "template" | "cell" | "skill" | "view";
export const CATALOG_KINDS: readonly CatalogKind[] = [
  "capability",
  "automation",
  "template",
  "cell",
  "skill",
  "view",
];

interface CatalogEntry {
  slug: string;
  name: string;
  description?: string | null;
  version?: string | null;
  tier?: string | null;
  vendor?: string | null;
  tags?: string[] | null;
  contentHash?: string | null;
  /** Full install payload, when the source route returns it inline. */
  definition?: Record<string, unknown> | null;
  /** Tombstone fields (template kind only — see fetchPackages `includeRetired`). */
  retiredAt?: Date | null;
  replacedBySlug?: string | null;
  retiredReason?: string | null;
}

/** The CP package DTO's `retired` field (TEMPLATE-LIFECYCLE Contract A). */
interface RetiredDto {
  at?: string | null;
  replacedBy?: string | null;
  reason?: string | null;
}

/**
 * Map the CP `retired` DTO onto the cache's three tombstone columns. Anything
 * that is not a well-formed tombstone (absent — an older CP —, null, or an
 * unparseable `at`) maps to "not retired", which is exactly today's behaviour.
 */
export function mapRetired(retired: RetiredDto | null | undefined): {
  retiredAt: Date | null;
  replacedBySlug: string | null;
  retiredReason: string | null;
} {
  const at = retired?.at ? new Date(retired.at) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return { retiredAt: null, replacedBySlug: null, retiredReason: null };
  }
  return {
    retiredAt: at,
    replacedBySlug: retired?.replacedBy || null,
    retiredReason: retired?.reason || null,
  };
}

/**
 * Synap's public catalog — read anonymously, so a pod that is not attached
 * to a Control Plane still sees the official marketplace (the console used to
 * fetch it itself with this same default).
 */
export const DEFAULT_CATALOG_SOURCE = "https://api.synap.live";

/** The person-facing name of the built-in source. */
export const OFFICIAL_SOURCE_NAME = "Synap";

/**
 * Synap's catalog signing key (raw ed25519, base64), compiled in. NULL today:
 * the Control Plane does not serve a signed `synap-index.json` yet, so the
 * official source is trusted the way it always was — it IS the configured
 * Control Plane URL, over TLS. When the CP signs its index, this constant gets
 * the key and the official source moves to the same verified format as every
 * other source (docs/marketplace-source.md).
 */
export const SYNAP_CATALOG_PUBLIC_KEY: string | null = null;

/**
 * The official catalog's base URL — the pod's Control Plane when set, else
 * Synap's public catalog. It is also the official rows' cache key, so it is
 * resolved even while the catalog is switched off (the rows stay readable).
 */
export function officialCatalogUrl(): string {
  return (
    process.env.CONTROL_PLANE_URL ||
    process.env.CP_URL ||
    DEFAULT_CATALOG_SOURCE
  ).replace(/\/$/, "");
}

/** `SYNAP_CATALOG_SOURCE=off`: a pod that must make no outbound catalog calls. */
export function officialCatalogEnvOff(): boolean {
  return process.env.SYNAP_CATALOG_SOURCE === "off";
}

/** One catalog source as every reader sees it. */
export interface CatalogSource {
  /** `synap` for the built-in source, else the source's own id. */
  id: string;
  /** What its `cp_catalog_cache` rows are keyed by: the URL (official) or the id. */
  cacheKey: string;
  url: string;
  name: string;
  trust: MarketplaceTrust;
  official: boolean;
  /** Synced, listed and installable (subject to its status). */
  enabled: boolean;
  /** Official only: switched off by `SYNAP_CATALOG_SOURCE=off` — the console cannot turn it on. */
  lockedOff: boolean;
  /** The pinned signing key; null for the official source today and an unsigned showcase. */
  publicKey: string | null;
  keyFingerprint: string | null;
  /** Trusted only: agents may propose installs from it. */
  agentsMayPropose: boolean;
  addedBy: string | null;
  addedAt: string | null;
}

/**
 * THE seam: every catalog source this pod knows — the built-in Synap source
 * first, then the sources a pod admin added, enabled or not. Pure over a
 * settings snapshot (null = the settings could not be read: the official
 * source still answers, from the environment alone).
 */
export function describeCatalogSources(
  snapshot: Pick<MarketplaceSourcesSnapshot, "sources" | "official"> | null
): CatalogSource[] {
  const envOff = officialCatalogEnvOff();
  const url = officialCatalogUrl();
  const official: CatalogSource = {
    id: OFFICIAL_SOURCE_ID,
    cacheKey: url,
    url,
    name: OFFICIAL_SOURCE_NAME,
    trust: "official",
    official: true,
    enabled: !envOff && (snapshot?.official?.enabled ?? true),
    lockedOff: envOff,
    publicKey: SYNAP_CATALOG_PUBLIC_KEY,
    keyFingerprint: null,
    agentsMayPropose: true,
    addedBy: null,
    addedAt: null,
  };
  const added = (snapshot?.sources ?? []).map((s): CatalogSource => ({
    id: s.id,
    cacheKey: s.id,
    url: s.url,
    name: s.name,
    trust: s.trust,
    official: false,
    enabled: s.enabled,
    lockedOff: false,
    publicKey: s.publicKey,
    keyFingerprint: s.keyFingerprint,
    agentsMayPropose: s.trust === "trusted" && s.agentsMayPropose === true,
    addedBy: s.addedBy,
    addedAt: s.addedAt,
  }));
  return [official, ...added];
}

/** Every catalog source, read from the pod settings. Throws when they cannot be read. */
export async function catalogSources(): Promise<CatalogSource[]> {
  return describeCatalogSources(await readMarketplaceSources());
}

/**
 * Outcome of one source fetch. The two failure variants are split on purpose:
 *   - `transient` (5xx / network / timeout) → the source may recover; leave the
 *     cache intact quietly.
 *   - `clientError` (4xx) → the REQUEST is wrong and will never succeed on
 *     retry (e.g. a retired `category`); surface it loudly.
 * A silent `null` for both — the old shape — let a permanent 400 masquerade as
 * a temporary outage for the cache's whole life, which is exactly the bug that
 * kept `market.search(kind:'template')` returning "nothing" since 0049.
 */
type SourceFetch<T> =
  | { ok: true; data: T }
  | { ok: false; clientError: false }
  | {
      ok: false;
      clientError: true;
      status: number;
      /** The 4xx body's `code` / `error`, when it sent JSON (CP convention). */
      code?: string;
      message?: string;
    };

/**
 * List endpoints are limit/offset-paginated with a max page of 100 (see the CP
 * `/api/packages` and `/api/marketplace/cells` validators). We page at the max
 * and loop until the server's `total` is reached.
 */
const PAGE_SIZE = 100;
/**
 * Safety cap on pages per (source, kind) — bounds a run at PAGE_SIZE*MAX_PAGES
 * (10 000) entries so a pathological/looping source response can't spin forever.
 * Hitting it is treated as an INCOMPLETE fetch (prune skipped), never as a full
 * set to prune against.
 */
const MAX_PAGES = 100;

/** Shared 8s-timeout GET. Distinguishes a 4xx (permanent) from a transient failure. */
async function safeFetchJson(url: string): Promise<SourceFetch<unknown>> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      // 4xx = the request is malformed/unacceptable — will never self-heal.
      // 5xx (and anything else non-2xx) = server-side, treat as transient.
      if (res.status >= 400 && res.status < 500) {
        const body = (await res.json().catch(() => null)) as {
          code?: unknown;
          error?: unknown;
        } | null;
        return {
          ok: false,
          clientError: true,
          status: res.status,
          ...(typeof body?.code === "string" ? { code: body.code } : {}),
          ...(typeof body?.error === "string" ? { message: body.error } : {}),
        };
      }
      return { ok: false, clientError: false };
    }
    return { ok: true, data: await res.json() };
  } catch {
    // Network error / timeout / abort — transient, leave cache intact.
    return { ok: false, clientError: false };
  }
}

/**
 * A fully-resolved fetch for one (source, kind): the mapped entries plus whether
 * the set is PROVABLY complete. `complete` is the invariant the prune gates on —
 * an incomplete set (a page failed mid-loop, the source reported more rows than
 * it served, or the safety cap was hit) is upserted but MUST NEVER be pruned
 * against, or the pod would silently delete live catalog entries it never saw.
 */
interface CatalogFetch {
  entries: CatalogEntry[];
  complete: boolean;
  /**
   * The source could not report retired rows (an older CP refused
   * `includeRetired`). `complete` then covers LIVE rows only; the stamp says
   * so, and template health never claims `unlisted` from it.
   */
  retirementsUnreported?: true;
}

/** One page of a limit/offset list endpoint: mapped rows + the whole-filter total. */
interface CatalogPage {
  entries: CatalogEntry[];
  /** The server's row count for the WHOLE filter, not just this page. */
  total: number;
}

/**
 * Page through a limit/offset list endpoint until the server's `total` is
 * retrieved, returning a `CatalogFetch`. Completeness rules:
 *   - first page fails with nothing collected → propagate the failure (keeps the
 *     caller's 4xx-vs-transient stamp; cache left intact);
 *   - a LATER page fails → return what we have as `complete:false` (upsert, no prune);
 *   - source reports more rows than it serves (empty page before `total`) →
 *     `complete:false`;
 *   - the MAX_PAGES safety cap is hit before `total` → `complete:false`.
 * Only a run that reaches `total` returns `complete:true`.
 */
async function fetchAllPages(
  fetchPage: (
    limit: number,
    offset: number
  ) => Promise<SourceFetch<CatalogPage>>
): Promise<SourceFetch<CatalogFetch>> {
  const entries: CatalogEntry[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchPage(PAGE_SIZE, offset);
    if (!res.ok) {
      // First page failed with nothing collected → propagate so the caller
      // keeps the 4xx (misconfigured) vs transient (unreachable) distinction.
      if (entries.length === 0) return res;
      // A later page failed → we hold a PARTIAL set. Upsert it, never prune.
      return { ok: true, data: { entries, complete: false } };
    }
    entries.push(...res.data.entries);
    if (entries.length >= res.data.total) {
      return { ok: true, data: { entries, complete: true } };
    }
    if (res.data.entries.length === 0) {
      // Source signalled more rows (`total` > collected) yet served an empty
      // page — an inconsistency we cannot reconcile. Treat as INCOMPLETE.
      return { ok: true, data: { entries, complete: false } };
    }
    offset += PAGE_SIZE;
  }
  // Safety cap hit before reaching `total` → INCOMPLETE, never prune.
  return { ok: true, data: { entries, complete: false } };
}

/**
 * GET {source}/api/marketplace/capabilities. This route is UNPAGINATED — it
 * returns the whole capability set in one response — so a successful fetch is
 * always complete.
 */
async function fetchCapabilities(
  source: string
): Promise<SourceFetch<CatalogFetch>> {
  const result = await safeFetchJson(`${source}/api/marketplace/capabilities`);
  if (!result.ok) return result;
  const body = result.data as {
    capabilities?: Array<{
      key: string;
      name: string;
      description?: string | null;
      version?: string;
      definition?: Record<string, unknown>;
    }>;
  } | null;
  const list = Array.isArray(body?.capabilities) ? body.capabilities : [];
  return {
    ok: true,
    data: {
      entries: list.map((c) => ({
        slug: c.key,
        name: c.name,
        description: c.description ?? null,
        version: c.version ?? null,
        definition: c.definition ?? null,
      })),
      complete: true,
    },
  };
}

/**
 * GET {source}/api/packages?category={category}&limit=&offset= — paginated list
 * view (no `definition`). `category` is the CP's LIVE `PACKAGE_TYPES` vocabulary
 * (`workspace` / `workflow`), NOT the pod's internal cache `kind` — see fetchKind
 * for the mapping and the header note. Pages until the response `total` is
 * retrieved so the cache is NEVER truncated to the first page. Keep the paging
 * regardless of how the CP orders: as of 2026-09-05 it orders by `createdAt
 * DESC` (it used to be `installCount DESC` — dropped because that counter is
 * bumped by an anonymous, non-idempotent POST), and under EITHER order a
 * first-page-only fetch silently prunes part of the catalog. The paging is not
 * a workaround for one sort key; it is what makes the cache complete.
 */
async function fetchPackages(
  source: string,
  category: "workspace" | "workflow" | "skill" | "view",
  /**
   * Ask for retired (tombstoned) rows too — the template kind only, so template
   * health can say "retired, replaced by X". The `total` the CP reports covers
   * the same filter, so completeness still holds. An older CP does NOT ignore
   * the param: its strict query schema answers 400 `UNKNOWN_QUERY_PARAM`
   * naming `includeRetired`. On exactly that we fetch again without it
   * (today's behaviour) and mark the result `retirementsUnreported`.
   */
  includeRetired = false
): Promise<SourceFetch<CatalogFetch>> {
  if (includeRetired) {
    const res = await fetchPackagesPages(source, category, true);
    if (!res.ok && res.clientError && isIncludeRetiredRefusal(res)) {
      logger.warn(
        { source, category },
        "Catalog source predates retired templates (400 UNKNOWN_QUERY_PARAM includeRetired) — syncing live rows only; retirements are unreported"
      );
      const live = await fetchPackagesPages(source, category, false);
      return live.ok
        ? { ok: true, data: { ...live.data, retirementsUnreported: true } }
        : live;
    }
    return res;
  }
  return fetchPackagesPages(source, category, false);
}

/**
 * The older-CP answer to `includeRetired` — and ONLY that: a 400 whose code is
 * `UNKNOWN_QUERY_PARAM` and whose message names the param. Any other 4xx stays
 * `misconfigured` (the request vocabulary is wrong and will not self-heal).
 */
function isIncludeRetiredRefusal(res: {
  status: number;
  code?: string;
  message?: string;
}): boolean {
  return (
    res.status === 400 &&
    res.code === "UNKNOWN_QUERY_PARAM" &&
    (res.message ?? "").includes("includeRetired")
  );
}

async function fetchPackagesPages(
  source: string,
  category: "workspace" | "workflow" | "skill" | "view",
  includeRetired: boolean
): Promise<SourceFetch<CatalogFetch>> {
  return fetchAllPages(async (limit, offset) => {
    const result = await safeFetchJson(
      `${source}/api/packages?category=${category}&limit=${limit}&offset=${offset}${includeRetired ? "&includeRetired=true" : ""}`
    );
    if (!result.ok) return result;
    const body = result.data as {
      packages?: Array<{
        slug: string;
        displayName: string;
        description?: string | null;
        version?: string;
        requiredTier?: string | null;
        vendorId?: string | null;
        tags?: string[];
        retired?: RetiredDto | null;
      }>;
      total?: number;
    } | null;
    const list = Array.isArray(body?.packages) ? body.packages : [];
    const total = typeof body?.total === "number" ? body.total : list.length;
    return {
      ok: true,
      data: {
        entries: list.map((p) => ({
          slug: p.slug,
          name: p.displayName,
          description: p.description ?? null,
          version: p.version ?? null,
          tier: p.requiredTier ?? null,
          vendor: p.vendorId ?? null,
          tags: p.tags ?? null,
          // List view omits the definition body by design — null here means a
          // per-slug GET /api/packages/:slug/:version fetch is required at
          // install time (Wave 3b's concern).
          definition: null,
          ...(includeRetired
            ? mapRetired(p.retired)
            : { retiredAt: null, replacedBySlug: null, retiredReason: null }),
        })),
        total,
      },
    };
  });
}

/** GET {source}/api/marketplace/cells?limit=&offset= — paginated, same contract as packages. */
async function fetchCells(source: string): Promise<SourceFetch<CatalogFetch>> {
  return fetchAllPages(async (limit, offset) => {
    const result = await safeFetchJson(
      `${source}/api/marketplace/cells?limit=${limit}&offset=${offset}`
    );
    if (!result.ok) return result;
    const body = result.data as {
      // Only the four fields the CACHE ROW itself is built from are named here.
      // Everything else a cell carries is INSTALL PAYLOAD and is forwarded
      // verbatim (see the spread below), so this type can never again decide
      // which payload fields survive the hop.
      cells?: Array<
        Record<string, unknown> & {
          key: string;
          name: string;
          packageSlug: string;
          author?: string;
          packageVersion?: string | null;
        }
      >;
      total?: number;
    } | null;
    const list = Array.isArray(body?.cells) ? body.cells : [];
    const total = typeof body?.total === "number" ? body.total : list.length;
    return {
      ok: true,
      data: {
        entries: list.map((cell) => ({
          // Cells aren't independently versioned/sluggable in the CP today —
          // scope the cache slug to the owning package so two packages' same-
          // named cell never collides under the (source, kind, slug) index.
          slug: `${cell.packageSlug}/${cell.key}`,
          name: cell.name,
          vendor: cell.author ?? null,
          // The owning package's version (CP `packageVersion`) — the cache row's
          // own column, so a pod can tell a newer cell was published.
          version: cell.packageVersion ?? null,
          // WHOLESALE forward — NEVER a field-by-field rebuild.
          //
          // This is the last hop before `installCellFromDefinition` reads the
          // payload, and it used to name each field it copied. Anything not
          // named was silently dropped, which is not a hypothetical: `viewTypes`
          // was dropped and made every marketplace-installed renderer
          // unselectable; `contentKind` was dropped and defaulted every cached
          // install to the `widget` slot; `externalHosts` was dropped and made a
          // cell's declared egress arrive contained. A comment warning about the
          // rebuild sat in this very block while the second and third drops
          // shipped — so the rebuild itself is gone, not annotated.
          //
          // The cache `definition` is an OPAQUE install payload (jsonb, read by
          // cast-and-pick consumers), exactly like the wholesale
          // `c.definition ?? null` every other kind above forwards. Unknown CP
          // keys landing here are inert by construction and are the point: a
          // field the Control Plane adds reaches the installer with no change
          // required on this side.
          definition: { ...cell },
        })),
        total,
      },
    };
  });
}

async function fetchKind(
  source: string,
  kind: CatalogKind
): Promise<SourceFetch<CatalogFetch>> {
  switch (kind) {
    case "capability":
      return fetchCapabilities(source);
    // Map the pod's internal cache `kind` → the CP's LIVE `category`
    // (PACKAGE_TYPES after migration 0049). The cache still stores
    // kind=automation|template — only the outbound CP query is translated.
    case "automation":
      return fetchPackages(source, "workflow");
    case "template":
      return fetchPackages(source, "workspace", true);
    // skill/view are FIRST-CLASS CP categories (PACKAGE_TYPES after migration
    // 0049: workspace|capability|skill|workflow|view|cell) — the pod `kind` IS
    // the CP `category` (no alias, unlike automation→workflow / template→
    // workspace). Same paginated `/api/packages?category=` list route + list-
    // view shape as workspace/workflow packages; the `definition` body is
    // omitted from the list (fetched per-slug at install time — see
    // marketplace-install.ts), exactly like automation/template.
    case "skill":
      return fetchPackages(source, "skill");
    case "view":
      return fetchPackages(source, "view");
    case "cell":
      return fetchCells(source);
  }
}

/** Sync one (source, kind) pair: upsert fetched rows, prune stale ones. Never throws. */
async function syncOne(source: string, kind: CatalogKind): Promise<void> {
  const result = await fetchKind(source, kind);

  if (!result.ok) {
    if (result.clientError) {
      // 4xx: the pod is asking for a category/kind the source no longer
      // accepts (e.g. a retired `category`). This will NEVER self-heal on
      // retry — surface it loudly and stamp it distinctly so `/health` and an
      // operator can tell it apart from a transient outage. Cache left intact.
      logger.error(
        { source, kind, status: result.status },
        "Catalog source REJECTED the request (4xx) — the pod asked for a category/kind the Control Plane no longer accepts. This will NOT self-heal; fix the request vocabulary in cp-catalog-sync.ts. Cache left intact."
      );
      await recordCatalogSyncStamp(source, kind, "misconfigured", 0);
      return;
    }
    logger.warn(
      { source, kind },
      "Catalog source unreachable — leaving cache intact"
    );
    await recordCatalogSyncStamp(source, kind, "unreachable", 0);
    return;
  }
  const { entries, complete } = result.data;
  if (entries.length === 0) {
    logger.info(
      { source, kind },
      "Catalog source returned 0 entries — leaving cache intact"
    );
    await recordCatalogSyncStamp(source, kind, "empty", 0);
    return;
  }

  const now = new Date();
  const rows = entries.map((e) => ({
    source,
    kind,
    slug: e.slug,
    name: e.name,
    description: e.description ?? null,
    version: e.version ?? null,
    tier: e.tier ?? null,
    vendor: e.vendor ?? null,
    // Fold derived tokens into tags when this hop has a definition (capabilities
    // / cells). Packages list omits definition — derived-at-publish tags copy
    // through as-is. Never write definition onto a list row that arrived null.
    tags: e.definition
      ? mergePackageSearchTags(e.tags, e.definition)
      : (e.tags ?? null),
    contentHash: e.contentHash ?? null,
    definition: e.definition ?? null,
    retiredAt: e.retiredAt ?? null,
    replacedBySlug: e.replacedBySlug ?? null,
    retiredReason: e.retiredReason ?? null,
    syncedAt: now,
  }));

  // ── DEFENCE IN DEPTH ──
  // A single duplicate slug in the CP catalog (e.g. two `fireflies` rows with
  // different versions) would make the whole multi-row upsert fail with:
  // "ON CONFLICT DO UPDATE command cannot affect row a second time".
  // Dedupe by (source, kind, slug) keeping the newest version, so ONE bad
  // upstream row cannot starve the entire pod's catalog. This is the same
  // discipline as "an empty result and a failed read are different facts".
  const deduped = new Map<string, (typeof rows)[0]>();
  for (const row of rows) {
    const key = `${row.source}|${row.kind}|${row.slug}`;
    const existing = deduped.get(key);
    // A capability's version is a content hash, so "newest" is meaningless and
    // an imposter row could win it. The CP serves the owning (official) row
    // first for a key: keep the first occurrence. Other kinds keep newest.
    const replace =
      !existing ||
      (row.kind !== "capability" &&
        compareVersions(row.version ?? "", existing.version ?? "") > 0);
    if (replace) {
      deduped.set(key, row);
    }
  }
  const dedupedRows = Array.from(deduped.values());

  if (dedupedRows.length !== rows.length) {
    logger.warn(
      { source, kind, before: rows.length, after: dedupedRows.length },
      "Catalog sync deduped duplicate slugs — keeping newest version per (source, kind, slug). Upstream CP catalog has duplicates."
    );
  }

  try {
    await db
      .insert(cpCatalogCache)
      .values(dedupedRows)
      .onConflictDoUpdate({
        target: [
          cpCatalogCache.source,
          cpCatalogCache.kind,
          cpCatalogCache.slug,
        ],
        set: {
          name: drizzleSql.raw("excluded.name"),
          description: drizzleSql.raw("excluded.description"),
          version: drizzleSql.raw("excluded.version"),
          tier: drizzleSql.raw("excluded.tier"),
          vendor: drizzleSql.raw("excluded.vendor"),
          tags: drizzleSql.raw("excluded.tags"),
          contentHash: drizzleSql.raw("excluded.content_hash"),
          definition: drizzleSql.raw("excluded.definition"),
          // Un-retiring on the CP clears these (excluded.* is NULL then).
          retiredAt: drizzleSql.raw("excluded.retired_at"),
          replacedBySlug: drizzleSql.raw("excluded.replaced_by_slug"),
          retiredReason: drizzleSql.raw("excluded.retired_reason"),
          syncedAt: now,
        },
      });

    // PRUNE GUARD — the invariant that matters most. Delete only when the fetch
    // was PROVABLY complete. On an incomplete fetch (a page failed mid-loop, the
    // source reported more rows than it served, or the safety cap was hit) we
    // keep the upserted superset and skip the prune: pruning against a truncated
    // set would silently delete live catalog entries the pod never saw — exactly
    // the top-100 ceiling that pruned every new author's template first.
    if (!complete) {
      logger.warn(
        { source, kind, upserted: dedupedRows.length },
        "Catalog fetch INCOMPLETE — upserted the retrieved page(s) but SKIPPED prune to avoid deleting entries the pod never saw. Cache left as a superset until the next full sync."
      );
      await recordCatalogSyncStamp(source, kind, "partial", dedupedRows.length);
      return;
    }

    const fetchedSlugs = rows.map((r) => r.slug);
    const pruned = await db
      .delete(cpCatalogCache)
      .where(
        and(
          eq(cpCatalogCache.source, source),
          eq(cpCatalogCache.kind, kind),
          notInArray(cpCatalogCache.slug, fetchedSlugs)
        )
      )
      .returning({ slug: cpCatalogCache.slug });

    logger.info(
      { source, kind, upserted: dedupedRows.length, pruned: pruned.length },
      "Synced cp_catalog_cache"
    );
    if (result.data.retirementsUnreported) {
      // Complete for LIVE rows only — template health must not read an absent
      // slug as `unlisted` from this stamp.
      await recordCatalogSyncStamp(source, kind, "ok", dedupedRows.length, {
        retirementsUnreported: true,
      });
    } else {
      await recordCatalogSyncStamp(source, kind, "ok", dedupedRows.length);
    }
  } catch (err) {
    logger.error(
      { err, source, kind },
      "Failed to upsert/prune cp_catalog_cache"
    );
    throw err; // Let pg-boss retry; the cache is left as-is.
  }
}

/**
 * Called by the cron scheduler (every 10 min) and once on startup. Refreshes
 * cp_catalog_cache for every configured source × every kind. Each (source,
 * kind) pair is independent: one failing never blocks the others.
 */
export async function handleCpCatalogSync(): Promise<void> {
  // A settings read that fails must not stop the official catalog: it syncs
  // from the environment alone, and added sources wait for the next run.
  let snapshot: MarketplaceSourcesSnapshot | null = null;
  try {
    snapshot = await readMarketplaceSources();
  } catch (err) {
    logger.warn(
      { err },
      "Could not read the pod's marketplace sources — syncing the official catalog only this run"
    );
  }
  const sources = describeCatalogSources(snapshot).filter((s) => s.enabled);
  if (sources.length === 0) {
    logger.info("Every catalog source is switched off — skipping");
    return;
  }

  for (const source of sources) {
    if (source.official) {
      for (const kind of CATALOG_KINDS) {
        await syncOne(source.cacheKey, kind);
      }
    } else {
      await syncThirdPartySource(source, snapshot?.status[source.id]);
    }
  }
}

/**
 * Sync ONE source now (the console's "Sync now"). The official source runs
 * the same per-kind sync as the schedule. Throws when the source is unknown
 * or switched off — a person asked, so they get a reason.
 */
export async function syncCatalogSourceNow(sourceId: string): Promise<void> {
  const snapshot = await readMarketplaceSources();
  const source = describeCatalogSources(snapshot).find(
    (s) => s.id === sourceId
  );
  if (!source) throw new Error(`No catalog source "${sourceId}" on this pod.`);
  if (!source.enabled) {
    throw new Error(`The "${source.name}" source is switched off.`);
  }
  if (source.official) {
    for (const kind of CATALOG_KINDS) await syncOne(source.cacheKey, kind);
    return;
  }
  await syncThirdPartySource(source, snapshot.status[source.id]);
}
