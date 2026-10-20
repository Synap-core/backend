/**
 * THE PUBLIC READ of a site — the manifest door (C1a) and the collection and
 * record doors (C1b).
 *
 *   GET /public/sites/:siteToken                                  manifest
 *   GET /public/sites/:siteToken/collections/:key                 one page
 *   GET /public/sites/:siteToken/collections/:key/:slugOrPublicId one record
 *
 * Credentialless. The site token in the path IS the capability; there is no
 * caller identity and nothing here reads one. What a stranger holding it may
 * see:
 *   - the manifest: `title` / `description` (the site row's metadata SNAPSHOT,
 *     limited to the home space's `kinds.project.public.fields`), the day it
 *     went live, and the configured collections with their sort, page size,
 *     addressing mode and the count of LIVE members;
 *   - a collection page / a record: each member's publish-time SNAPSHOT
 *     (scalars, re-filtered by the W3 projector at read), its public id, its
 *     slug, the day it was published, and — for a record — the body of its
 *     PINNED checkpoint, ids redacted.
 * Never: a project, workspace, owner, share, entity or document id; the
 * config's `publishWhen` statuses (an owner workflow, not public content).
 *
 * NARROWING IS LIVE (`site-members.ts`): a member is served only while it is
 * published, its record exists and is still filed into the site's project,
 * and its own workspace's public doors are open. Content never is: a later
 * edit is invisible until the owner publishes again.
 *
 * UNIFORM MISS. Unknown, malformed or over-long token; a row that is not a
 * site; a draft, revoked, expired or tokenless site; a deleted project; an
 * unknown or unconfigured collection (an unreadable config has none); an
 * unknown slug or public id; a member that is unpublished, revoked, deleted,
 * out of the project, in a closed space or of another site: ALL return
 * `null`, answered with the byte-identical 404. A FAILED read throws (a 5xx,
 * never a calm 404).
 *
 * ORDER. Hash the token first (one indexed lookup on the unique token-hash
 * index, whatever the token's shape), resolve every miss, THEN decide the
 * home space's public-doors switch (only what would otherwise have been
 * served learns it is closed: 403), THEN validate the query (400 — only ever
 * on a live site's real collection).
 */

import { createHash } from "node:crypto";
import { db, and, asc, desc, eq } from "@synap/database";
import { entities, projects, resourceShares } from "@synap/database/schema";
import { count, sql, type SQL } from "drizzle-orm";
import { hashToken } from "../../utils/share-token.js";
import { isPublicationLive, isSiteLive } from "./publication-live.js";
import { publicDoorsOpenFor } from "./public-doors-switch.js";
import {
  projectPublishedProperties,
  publicTitleAndProperties,
  readPinnedBody,
} from "./public-read.js";
import type { PublicShareClosed } from "./public-read.js";
import {
  PUBLIC_ID_RE,
  resolveSiteConfig,
  SITE_PUBLISHED_AT_SORT,
  SLUG_MAX_LENGTH,
  SLUG_RE,
  type SiteConfigV1,
} from "./site-config.js";
import {
  liveMemberCounts,
  liveMemberWhere,
  openMemberWorkspaces,
} from "./site-members.js";

/** A token longer than this cannot have been minted (32 bytes base64url = 43). */
const MAX_TOKEN_LENGTH = 256;

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface PublicSiteCollection {
  key: string;
  count: number;
  sort: string[];
  pageSize: number;
  addressing: "slug" | "publicId";
}

export interface PublicSiteView {
  /** Present only when the snapshot allowlisted `title`. */
  title?: string;
  /** Present only when the snapshot allowlisted `description`. */
  description?: string;
  /** Day precision (YYYY-MM-DD). */
  publishedOn: string;
  collections: PublicSiteCollection[];
}

export interface PublicRecordSummary {
  collection: string;
  /** The stable public address: `p_` + 16 random base62 chars. */
  publicId: string;
  slug: string | null;
  /** Present only when the snapshot allowlisted `title`. */
  title?: string;
  properties: Record<string, string | number | boolean>;
  /** Day precision (YYYY-MM-DD). */
  publishedOn: string;
}

export interface PublicCollectionPage {
  items: PublicRecordSummary[];
  /** Live members of the collection (after every narrowing check). */
  total: number;
  offset: number;
  limit: number;
}

export interface PublicRecordView extends PublicRecordSummary {
  body: { format: "markdown"; content: string } | null;
}

/** A read that resolved, with its weak ETag. */
export interface PublicSiteRead<T> {
  view: T;
  etag: string;
}

/** A live site's real collection asked an invalid query (400). */
export interface PublicSiteInvalidQuery {
  invalid: string;
}

const weakEtag = (parts: unknown) =>
  `W/"${createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32)}"`;

const day = (d: Date) => d.toISOString().slice(0, 10);

// ── The site ────────────────────────────────────────────────────────────────

interface ResolvedSite {
  id: string;
  projectId: string;
  homeWorkspaceId: string | null;
  config: SiteConfigV1;
  publishedAt: Date;
  publishedProperties: unknown;
}

/**
 * A token → its LIVE site, or null for every kind of miss. The switch is NOT
 * decided here: each door decides it after its own misses.
 */
async function resolveSite(token: string): Promise<ResolvedSite | null> {
  // Hash FIRST, always; the indexed lookup runs for every shape of token.
  const tokenHash = hashToken(typeof token === "string" ? token : "");
  const [row] = await db
    .select({
      id: resourceShares.id,
      workspaceId: resourceShares.workspaceId,
      resourceType: resourceShares.resourceType,
      resourceId: resourceShares.resourceId,
      audience: resourceShares.audience,
      state: resourceShares.state,
      siteShareId: resourceShares.siteShareId,
      siteConfig: resourceShares.siteConfig,
      revokedAt: resourceShares.revokedAt,
      expiresAt: resourceShares.expiresAt,
      publishedAt: resourceShares.publishedAt,
      publishedProperties: resourceShares.publishedProperties,
    })
    .from(resourceShares)
    .where(eq(resourceShares.tokenHash, tokenHash))
    .limit(1);

  if (
    !row ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    // Found by its token hash, so a url exists.
    !isSiteLive({ ...row, hasToken: true }) ||
    // Implied by the rule above; repeated so the type narrows.
    !row.publishedAt
  ) {
    return null;
  }

  // Narrowing is live: a deleted project takes its site down at once.
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, row.resourceId))
    .limit(1);
  if (!project) return null;

  return {
    id: row.id,
    projectId: row.resourceId,
    homeWorkspaceId: row.workspaceId,
    config: resolveSiteConfig(row.siteConfig),
    publishedAt: row.publishedAt,
    publishedProperties: row.publishedProperties,
  };
}

const siteRef = (site: ResolvedSite) => ({
  id: site.id,
  projectId: site.projectId,
});

// ── Manifest ─────────────────────────────────────────────────────────────────

/**
 * Resolve a site token to its manifest, `null` for every kind of miss, or
 * {@link PublicShareClosed} when the site is live but its home space's public
 * doors are off. Throws on a failed read.
 */
export async function readPublicSite(
  token: string
): Promise<PublicSiteRead<PublicSiteView> | PublicShareClosed | null> {
  const site = await resolveSite(token);
  if (!site) return null;
  if (!(await publicDoorsOpenFor(site.homeWorkspaceId))) {
    return { closed: true };
  }

  const keys = Object.keys(site.config.collections).sort();
  const counts = await liveMemberCounts(siteRef(site), keys);
  const collections: PublicSiteCollection[] = keys.map((key) => {
    const c = site.config.collections[key]!;
    return {
      key,
      count: counts.get(key) ?? 0,
      sort: [...c.sort],
      pageSize: c.pageSize,
      addressing: c.slugField ? "slug" : "publicId",
    };
  });

  const meta = projectPublishedProperties(site.publishedProperties);
  const view: PublicSiteView = {
    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
    ...(typeof meta.description === "string"
      ? { description: meta.description }
      : {}),
    publishedOn: day(site.publishedAt),
    collections,
  };

  const etag = weakEtag([
    site.id,
    site.publishedAt.toISOString(),
    site.publishedProperties ?? null,
    site.config,
    collections.map((c) => [c.key, c.count]),
  ]);

  return { view, etag };
}

// ── Collection query (T10: every knob bounded and allowlisted) ──────────────

export const SITE_MAX_OFFSET = 10_000;
export const SITE_MAX_LIMIT = 100;
export const SITE_MAX_SORT_KEYS = 3;

export interface CollectionQuery {
  offset: number;
  limit: number;
  sort: Array<{ key: string; desc: boolean }>;
}

const DIGITS = /^\d{1,9}$/;
const SORT_TERM = /^(-?)([A-Za-z][A-Za-z0-9_]{0,63})$/;

/**
 * Parse a collection page's query against the collection's config — pure.
 * `limit` clamps to 1..100 (default the page size); `offset` is 0..10 000;
 * `sort` is ≤ 3 keys out of EXACTLY the configured sort keys ∪ `publishedAt`
 * (default the configured sort, else `-publishedAt`). `ref[…]` filters and
 * `embed` are not available yet (C1c): asked, they are refused rather than
 * silently ignored. A repeated knob is refused. Other params are ignored.
 */
export function parseCollectionQuery(
  queries: Record<string, string[] | undefined>,
  collection: { sort: readonly string[]; pageSize: number }
): CollectionQuery | PublicSiteInvalidQuery {
  const one = (name: string): string | undefined | null => {
    const v = queries[name];
    if (!v || v.length === 0) return undefined;
    return v.length === 1 ? v[0]! : null;
  };
  for (const name of Object.keys(queries)) {
    if (name === "embed") return { invalid: "embed is not available" };
    if (name === "ref" || name.startsWith("ref[")) {
      return { invalid: "ref filter is not available" };
    }
  }

  const rawOffset = one("offset");
  if (rawOffset === null) return { invalid: "invalid offset" };
  let offset = 0;
  if (rawOffset !== undefined) {
    if (!DIGITS.test(rawOffset)) return { invalid: "invalid offset" };
    offset = Number(rawOffset);
    if (offset > SITE_MAX_OFFSET) return { invalid: "offset too large" };
  }

  const rawLimit = one("limit");
  if (rawLimit === null) return { invalid: "invalid limit" };
  let limit = collection.pageSize;
  if (rawLimit !== undefined) {
    if (!DIGITS.test(rawLimit)) return { invalid: "invalid limit" };
    limit = Number(rawLimit);
  }
  limit = Math.min(SITE_MAX_LIMIT, Math.max(1, limit));

  const allowed = new Set([
    SITE_PUBLISHED_AT_SORT,
    ...collection.sort.map((s) => s.replace(/^-/, "")),
  ]);
  const rawSort = one("sort");
  if (rawSort === null) return { invalid: "invalid sort" };
  const terms =
    rawSort !== undefined
      ? rawSort.split(",")
      : collection.sort.length > 0
        ? [...collection.sort]
        : [`-${SITE_PUBLISHED_AT_SORT}`];
  if (terms.length > SITE_MAX_SORT_KEYS) return { invalid: "invalid sort" };
  const sort: CollectionQuery["sort"] = [];
  for (const term of terms) {
    const m = SORT_TERM.exec(term);
    if (!m || !allowed.has(m[2]!) || sort.some((s) => s.key === m[2])) {
      return { invalid: "invalid sort" };
    }
    sort.push({ key: m[2]!, desc: m[1] === "-" });
  }
  return { offset, limit, sort };
}

/** ORDER BY for a parsed sort; `published_at DESC, id` always last (stable pages). */
function orderByFor(sort: CollectionQuery["sort"]): SQL[] {
  const out: SQL[] = sort.map(({ key, desc: d }) => {
    if (key === SITE_PUBLISHED_AT_SORT) {
      return d
        ? desc(resourceShares.publishedAt)
        : asc(resourceShares.publishedAt);
    }
    // jsonb ordering: numbers numerically, strings lexically, per type. The
    // key is allowlisted and bound as a parameter, never spliced.
    const value = sql`(${resourceShares.publishedProperties} -> ${key})`;
    return d ? sql`${value} desc nulls last` : sql`${value} asc nulls last`;
  });
  out.push(desc(resourceShares.publishedAt), asc(resourceShares.id));
  return out;
}

const MEMBER_COLUMNS = {
  id: resourceShares.id,
  resourceId: resourceShares.resourceId,
  publicId: resourceShares.publicId,
  publicSlug: resourceShares.publicSlug,
  publishedProperties: resourceShares.publishedProperties,
  publishedAt: resourceShares.publishedAt,
} as const;

function summaryOf(
  collection: string,
  row: {
    publicId: string | null;
    publicSlug: string | null;
    publishedProperties: unknown;
    publishedAt: Date | null;
  }
): PublicRecordSummary {
  const { title, properties } = publicTitleAndProperties(
    row.publishedProperties
  );
  return {
    collection,
    publicId: row.publicId!,
    slug: row.publicSlug ?? null,
    ...(title !== undefined ? { title } : {}),
    properties,
    publishedOn: day(row.publishedAt!),
  };
}

// ── Collection page ──────────────────────────────────────────────────────────

/**
 * One page of a site collection's LIVE members, `null` for every kind of
 * miss, {@link PublicShareClosed} behind a closed home switch, or
 * {@link PublicSiteInvalidQuery} (400) for a bad query on a live site's real
 * collection. Throws on a failed read.
 */
export async function readSiteCollection(
  token: string,
  key: string,
  queries: Record<string, string[] | undefined>
): Promise<
  | PublicSiteRead<PublicCollectionPage>
  | PublicShareClosed
  | PublicSiteInvalidQuery
  | null
> {
  const site = await resolveSite(token);
  if (!site) return null;
  const collection = Object.hasOwn(site.config.collections, key)
    ? site.config.collections[key]
    : undefined;
  if (!collection) return null;
  if (!(await publicDoorsOpenFor(site.homeWorkspaceId))) {
    return { closed: true };
  }
  const query = parseCollectionQuery(queries, collection);
  if ("invalid" in query) return query;

  const open = await openMemberWorkspaces(site.id);
  const where = and(
    liveMemberWhere(siteRef(site), open),
    eq(resourceShares.publishedCollection, key)
  );
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(resourceShares)
    .where(where);
  const rows = await db
    .select(MEMBER_COLUMNS)
    .from(resourceShares)
    .where(where)
    .orderBy(...orderByFor(query.sort))
    .limit(query.limit)
    .offset(query.offset);

  const view: PublicCollectionPage = {
    items: rows.map((r) => summaryOf(key, r)),
    total,
    offset: query.offset,
    limit: query.limit,
  };
  const etag = weakEtag([
    key,
    query,
    rows.map((r) => [r.id, r.publishedAt?.toISOString() ?? null]),
    total,
  ]);
  return { view, etag };
}

// ── Record ───────────────────────────────────────────────────────────────────

/**
 * One LIVE member of a site collection, addressed by its public id (`p_…`)
 * or its slug; `null` for every kind of miss, {@link PublicShareClosed}
 * behind a closed home switch, {@link PublicSiteInvalidQuery} for an `embed`
 * (not available yet). Throws on a failed read.
 */
export async function readSiteRecord(
  token: string,
  key: string,
  slugOrPublicId: string,
  queries: Record<string, string[] | undefined> = {}
): Promise<
  | PublicSiteRead<PublicRecordView>
  | PublicShareClosed
  | PublicSiteInvalidQuery
  | null
> {
  const site = await resolveSite(token);
  if (!site) return null;
  if (!Object.hasOwn(site.config.collections, key)) return null;

  const byPublicId = PUBLIC_ID_RE.test(slugOrPublicId);
  if (
    !byPublicId &&
    !(slugOrPublicId.length <= SLUG_MAX_LENGTH && SLUG_RE.test(slugOrPublicId))
  ) {
    return null;
  }
  // A member of a CLOSED other space is a miss (404). The home space is
  // counted open HERE so a member of it reaches the home switch below, the
  // one switch that answers 403 — like the list and the manifest.
  const open = await openMemberWorkspaces(site.id);
  if (site.homeWorkspaceId && !open.includes(site.homeWorkspaceId)) {
    open.push(site.homeWorkspaceId);
  }
  const [row] = await db
    .select({
      ...MEMBER_COLUMNS,
      pin: resourceShares.publishedDocumentVersionId,
      audience: resourceShares.audience,
      resourceType: resourceShares.resourceType,
      state: resourceShares.state,
      revokedAt: resourceShares.revokedAt,
      expiresAt: resourceShares.expiresAt,
      siteShareId: resourceShares.siteShareId,
    })
    .from(resourceShares)
    .where(
      and(
        liveMemberWhere(siteRef(site), open),
        eq(resourceShares.publishedCollection, key),
        byPublicId
          ? eq(resourceShares.publicId, slugOrPublicId)
          : eq(resourceShares.publicSlug, slugOrPublicId)
      )
    )
    .limit(1);
  // The SQL already narrowed; the one liveness rule decides as well.
  if (
    !row ||
    !isPublicationLive({ ...row, hasToken: false }, { via: "site" })
  ) {
    return null;
  }

  const [entity] = await db
    .select({ documentId: entities.documentId })
    .from(entities)
    .where(eq(entities.id, row.resourceId))
    .limit(1);
  if (!entity) return null;
  const pinned = await readPinnedBody(row.pin, entity.documentId ?? null);
  if (!pinned.ok) return null;

  if (!(await publicDoorsOpenFor(site.homeWorkspaceId))) {
    return { closed: true };
  }
  // `?embed=` arrives with C1c: refused, never silently ignored.
  if (queries.embed) return { invalid: "embed is not available" };

  const view: PublicRecordView = { ...summaryOf(key, row), body: pinned.body };
  const etag = weakEtag([
    row.id,
    row.pin,
    row.publishedAt?.toISOString() ?? null,
    row.publishedProperties ?? null,
  ]);
  return { view, etag };
}
