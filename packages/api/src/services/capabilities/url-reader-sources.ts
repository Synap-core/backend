/**
 * The LIVE reader lists of one person + lens: the registry rows that carry a
 * reader verb and the catalog entries that declare one, loaded through the
 * caller's own visibility floor and cached briefly (`url-reader-cache.ts`).
 * Part of the one reader door (`url-readers.ts`).
 */

import type { UrlReaderOffer } from "@synap-core/types/url-read";
import type { RegistryCapability } from "./capability-registry.js";
import type { CatalogCacheEntry } from "./catalog-cache-query.js";
import { readerCacheGet, readerCacheSet } from "./url-reader-cache.js";
import { rankedFold, type RankedReader } from "./url-reader-fold.js";
import {
  catalogReaderSkills,
  rankedInstallOffers,
} from "./url-reader-offers.js";

export interface UrlReadersContext {
  userId: string;
  workspaceId: string | null;
  /** The acting agent, when the read originates from one (threaded to the gate). */
  agentUserId?: string | null;
  /**
   * Consider every reader the PERSON can see — pod-wide plus every space on
   * their access floor (the registry's `allSpaces` read, `userVisibleWhere`) —
   * and run the chosen verb in ITS OWN space. A Library item is the person's,
   * whatever space it was kept in, so a pack installed in one space reads a
   * pod-wide kept post. Absent → on for the person at POD ALTITUDE
   * (`workspaceId: null`), the lens otherwise. NEVER for an agent: an agent's
   * read keeps its own lens (`agentUserId` set ⇒ ignored), so this widens
   * nothing an agent can run.
   */
  allSpaces?: boolean;
}

/** Does this read see every space the person can see? (Never an agent's.) */
export function readsAllSpaces(ctx: UrlReadersContext): boolean {
  if (ctx.agentUserId) return false;
  return ctx.allSpaces ?? ctx.workspaceId === null;
}

interface ReaderSources {
  /** Only the registry rows that carry a reader verb — the folded subset. */
  rows: RegistryCapability[];
  /** Only the catalog entries that declare a reader skill. */
  catalog: CatalogCacheEntry[];
  installedSlugs: Set<string>;
  /** container id → its template's content hash, when stamped. */
  contentHashByContainer: Map<string, string>;
  /** Providers the broker offers; `null` = unknown (or nothing to ask about). */
  providerAvailable: Set<string> | null;
}

async function loadReaderSources(
  ctx: UrlReadersContext
): Promise<ReaderSources> {
  const allSpaces = readsAllSpaces(ctx);
  // The mode is part of the key: a person's all-spaces list must never answer
  // an agent's lensed read (or the reverse) for the same user and lens.
  const key = `${ctx.userId}\u0000${ctx.workspaceId ?? ""}\u0000${allSpaces ? "all" : "lens"}`;
  const hit = readerCacheGet<ReaderSources>(key);
  if (hit) return hit;

  const [{ listCapabilities }, { queryCatalogCache }] = await Promise.all([
    import("./capability-registry.js"),
    import("./catalog-cache-query.js"),
  ]);
  // `limit: null` — never slice before folding (see capabilitiesByIntent).
  const [rows, entries] = await Promise.all([
    listCapabilities(
      {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        ...(allSpaces ? { allSpaces: true } : {}),
      },
      { limit: null }
    ),
    queryCatalogCache({ kind: "capability" }),
  ]);

  // Installed packs = the containers the caller's registry rows belong to.
  const containerIds = [
    ...new Set(
      rows.map((r) => r.containerId).filter((id): id is string => !!id)
    ),
  ];
  const installedSlugs = new Set<string>();
  const contentHashByContainer = new Map<string, string>();
  if (containerIds.length > 0) {
    const [{ getDb, inArray }, { capabilities }] = await Promise.all([
      import("@synap/database"),
      import("@synap/database/schema"),
    ]);
    const db = await getDb();
    const containers = await db
      .select({
        id: capabilities.id,
        templateKey: capabilities.templateKey,
        metadata: capabilities.metadata,
      })
      .from(capabilities)
      .where(inArray(capabilities.id, containerIds));
    for (const c of containers) {
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const templateKey =
        c.templateKey ??
        (typeof meta.templateKey === "string" ? meta.templateKey : null);
      if (templateKey) installedSlugs.add(templateKey);
      if (typeof meta.contentHash === "string" && meta.contentHash) {
        contentHashByContainer.set(c.id, meta.contentHash);
      }
    }
  }

  const readerRows = rows.filter((r) =>
    (r.verbs ?? []).some((v) => (v.urlPatterns?.length ?? 0) > 0)
  );
  // Only a reader still waiting for its account makes the broker question
  // worth asking. A broker that does not answer → unknown (stays `connect`).
  let providerAvailable: Set<string> | null = null;
  if (
    readerRows.some((r) => r.connection?.required && !r.connection.connected)
  ) {
    const { loadProviderAvailability } =
      await import("./provider-availability.js");
    providerAvailable = await loadProviderAvailability().catch(() => null);
  }

  const sources: ReaderSources = {
    rows: readerRows,
    catalog: entries.filter(
      (e) => (catalogReaderSkills(e.definition)?.skills.length ?? 0) > 0
    ),
    installedSlugs,
    contentHashByContainer,
    providerAvailable,
  };
  readerCacheSet(key, sources);
  return sources;
}

export interface ResolvedReaders {
  ranked: RankedReader[];
  contentHashByContainer: Map<string, string>;
}

/** The PURE fold of one URL over loaded sources: installed (ranked) then to install. */
function foldSources(
  sources: ReaderSources,
  ctx: UrlReadersContext,
  url: string
): ResolvedReaders {
  const installed = rankedFold(sources.rows, url, ctx.workspaceId, {
    providerAvailable: sources.providerAvailable,
  });
  const seen = new Set(installed.map((r) => r.offer.readerId));
  const install = rankedInstallOffers(
    sources.catalog,
    url,
    sources.installedSlugs
  ).filter((r) => !seen.has(r.offer.readerId));
  return {
    ranked: [...installed, ...install],
    contentHashByContainer: sources.contentHashByContainer,
  };
}

export async function resolveReaders(
  ctx: UrlReadersContext,
  url: string
): Promise<ResolvedReaders> {
  return foldSources(await loadReaderSources(ctx), ctx, url);
}

/**
 * ONE source load for this person + lens, then a PURE fold per URL — for a
 * caller that asks about many links at once (a Library page's rows): N links
 * cost one (cached) registry + catalog read, never N. Same offers as
 * {@link listReadersForUrl} for each URL.
 *
 * @throws when the sources cannot be read (a failed lookup is not "no readers").
 */
export async function urlReaderLookup(
  ctx: UrlReadersContext
): Promise<(url: string) => UrlReaderOffer[]> {
  const sources = await loadReaderSources(ctx);
  return (url) => foldSources(sources, ctx, url).ranked.map((r) => r.offer);
}

/**
 * Every reader that could read `url` for this person, live: installed ones
 * (ready / enable / connect, ranked) then catalog ones to install. Computed
 * from a per-(user, lens) list cached a few seconds and dropped by every door
 * that turns a reader on or off (`url-reader-cache.ts`); never stored.
 *
 * @throws when the registry or the catalog cache cannot be read — a failed
 * lookup is not "no readers".
 */
export async function listReadersForUrl(
  ctx: UrlReadersContext,
  url: string
): Promise<UrlReaderOffer[]> {
  return (await resolveReaders(ctx, url)).ranked.map((r) => r.offer);
}
