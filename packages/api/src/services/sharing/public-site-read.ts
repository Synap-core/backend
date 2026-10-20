/**
 * THE PUBLIC READ of a site — the manifest door (collection door C1a).
 *
 * Credentialless. The site token in the path IS the capability; there is no
 * caller identity and nothing here reads one. What a stranger holding it may
 * see:
 *   - `title` / `description`: the site row's metadata SNAPSHOT (taken when the
 *     owner configured it or put it live, limited to the home space's
 *     `kinds.project.public.fields`, re-filtered by the W3 projector);
 *   - `publishedOn`: the day the site went live;
 *   - `collections`: the configured keys with their sort, page size and
 *     addressing mode, and the count of live members (0 until C1b publishes
 *     members).
 * Never: a project, workspace, owner, share or entity id; the config's
 * `publishWhen` statuses (an owner workflow, not public content).
 *
 * UNIFORM MISS. Unknown, malformed or over-long token; a row that is not a
 * site (a W3 publication, a link); a draft, revoked, expired or tokenless site;
 * a deleted project: ALL return `null`, answered with the byte-identical 404.
 * A FAILED read throws (a 5xx, never a calm 404).
 *
 * ORDER. Hash the token first (one indexed lookup on the unique token-hash
 * index, whatever the token's shape), resolve, and decide the home space's
 * public-doors switch LAST: only a site that would otherwise have been served
 * learns the switch is closed.
 */

import { createHash } from "node:crypto";
import { db, eq } from "@synap/database";
import { projects, resourceShares } from "@synap/database/schema";
import { hashToken } from "../../utils/share-token.js";
import { isSiteLive } from "./publication-live.js";
import { publicDoorsOpenFor } from "./public-doors-switch.js";
import { projectPublishedProperties } from "./public-read.js";
import type { PublicShareClosed } from "./public-read.js";
import { liveMemberCounts, resolveSiteConfig } from "./site-config.js";

/** A token longer than this cannot have been minted (32 bytes base64url = 43). */
const MAX_TOKEN_LENGTH = 256;

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

export interface PublicSiteRead {
  view: PublicSiteView;
  /** Weak, opaque: changes when the site is re-published or reconfigured. */
  etag: string;
}

/**
 * Resolve a site token to its manifest, `null` for every kind of miss, or
 * {@link PublicShareClosed} when the site is live but its home space's public
 * doors are off. Throws on a failed read.
 */
export async function readPublicSite(
  token: string
): Promise<PublicSiteRead | PublicShareClosed | null> {
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
    // Implied by the rule above; repeated so the type narrows for the view.
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

  if (!(await publicDoorsOpenFor(row.workspaceId))) return { closed: true };

  const config = resolveSiteConfig(row.siteConfig);
  const keys = Object.keys(config.collections).sort();
  const counts = await liveMemberCounts(row.id, keys);
  const collections: PublicSiteCollection[] = keys.map((key) => {
    const c = config.collections[key]!;
    return {
      key,
      count: counts.get(key) ?? 0,
      sort: [...c.sort],
      pageSize: c.pageSize,
      addressing: c.slugField ? "slug" : "publicId",
    };
  });

  const meta = projectPublishedProperties(row.publishedProperties);
  const view: PublicSiteView = {
    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
    ...(typeof meta.description === "string"
      ? { description: meta.description }
      : {}),
    publishedOn: row.publishedAt.toISOString().slice(0, 10),
    collections,
  };

  const etag = `W/"${createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.publishedAt.toISOString(),
        row.publishedProperties ?? null,
        config,
        collections.map((c) => [c.key, c.count]),
      ])
    )
    .digest("hex")
    .slice(0, 32)}"`;

  return { view, etag };
}
