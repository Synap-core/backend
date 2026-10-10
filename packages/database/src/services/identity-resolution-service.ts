/**
 * IdentityResolutionService — the ONE identity resolver.
 *
 * Before W2 there were SIX independent "is this the same subject?" rules
 * scattered across the API + database packages (entity-resolution, capture
 * within-batch collapse, capture persisted-dedup JS scan, entity-upsert
 * cross-source match, import graph-merge). They disagreed on the load-bearing
 * question — whether `email` auto-merges — and one of them re-implemented a SQL
 * join as a fetch-5000-rows-filter-in-JS scan. This service collapses them.
 *
 * FROZEN IDENTITY POLICY (user decision, 2026-07):
 *   STRONG atoms — email, phone, url (linkedin/website), handle, external-id —
 *     are GLOBALLY UNIQUE per subject. A match on any of them AUTO-RESOLVES
 *     (link, don't create). Tracked in `entity_identity_signals` (one row owns
 *     each (type, value) pair). This makes the old "email is too risky to merge
 *     on" exclusion obsolete: email is strong EVERYWHERE now.
 *   WEAK atoms — name (+ `aliases[]`, + a person's `discord-handle` surface
 *     form) — are NOT unique. They yield candidates/suggestions ONLY, scoped
 *     per kind (`entities.type`) and to the caller's visible rows. They never
 *     auto-merge on their own.
 *
 * The strong path is a single indexed lookup; the weak path is the proven SQL
 * from `resolveEntityByName` (title ilike + indexed handle + alias JSONB),
 * lifted verbatim so "same name" means the same thing it always did.
 *
 * Lives in @synap/database so every producer (@synap/api handlers, @synap/jobs
 * import workers, EntityUpsertService) reaches the SAME door. The weak path
 * needs a user/workspace visibility predicate; callers inject it as `userScope`
 * (the api package owns `userVisibleWhere`; database can't import upward).
 */

import { and, or, eq, ilike, isNull, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  entities,
  entityIdentitySignals,
  entityPropertyIndex,
  propertyDefs,
} from "../schema/index.js";
import type * as schema from "../schema/index.js";

type Db = PostgresJsDatabase<typeof schema>;

/** Identity atoms that are globally unique per subject → auto-resolve. */
export type StrongSignalType =
  | "email"
  | "phone"
  | "telegram_phone"
  | "linkedin_url"
  | "github_username"
  | "twitter_handle"
  | "website"
  // A captured page's own address — `properties.url` on the bookmark family
  // ONLY (see URL_IDENTITY_KINDS). A namespace of its own, never `website`: a
  // bookmark of acme.com must not resolve to the company Acme.
  | "url"
  // Opaque provider-scoped id (`${provider}:${externalId}`). Registered by the
  // external-link idempotency door; read by EntityUpsertService's strong path.
  // Not derived from any property key — case must be PRESERVED (see normalize).
  | "external_id";

export interface IdentitySignal {
  type: string;
  value: string;
}

/** Minimal entity shape the resolver returns. Mirrors ResolvedEntity in api. */
export interface ResolvedIdentityEntity {
  id: string;
  title: string | null;
  /** profile slug (the `type` column). */
  type: string;
  workspaceId: string | null;
}

export interface IdentityResolution {
  /**
   * 'strong' = matched a globally-unique signal (auto-resolve / link).
   * 'weak'   = matched a same-kind name/alias/handle candidate (advisory).
   * null     = no confident match (candidates may still be present for facets).
   */
  match: "strong" | "weak" | null;
  /** The resolved row: strong→signal owner, weak→first same-kind candidate. */
  entity?: ResolvedIdentityEntity;
  /**
   * SAME-TITLE rows of a DIFFERENT kind than the requested `kindSlug`, present
   * only when nothing matched within the requested kind.
   *
   * `match: null` used to be read as "nothing exists — safe to create", which
   * green-lit a duplicate whenever the same subject already existed under
   * another kind (the `question` ↔ `research` case): the rows were sitting in
   * `candidates`, but no caller could tell them apart from noise. This field is
   * the explicit, NON-COMMITTAL signal: "do not auto-merge, but a human/agent
   * should consider linking these."
   *
   * It is deliberately NOT a match verdict. Title similarity alone must NEVER
   * merge entities — strong-signal dedup (email/phone/url/handle/external-id)
   * stays the only automatic path. Treat this as a link SUGGESTION only.
   *
   * Always present (possibly empty); a subset of `candidates`.
   */
  crossKindCandidates: ResolvedIdentityEntity[];
  /**
   * ALL weak candidates (name/handle/alias), across kinds and unfiltered by
   * `kindSlug` — so a caller doing cross-profile facet detection (person +
   * company sharing a name) can partition them itself. Empty on a strong hit
   * or when no name was provided.
   */
  candidates: ResolvedIdentityEntity[];
}

/** Query params that only say WHERE a link was clicked, never WHAT it is. */
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid)$/i;

/**
 * Canonical form of a URL identity atom: host lowercased and `www.` dropped,
 * `#fragment` dropped, tracking params (`utm_*`, `fbclid`, `gclid`) dropped,
 * trailing slash stripped. Every OTHER query param is kept, byte for byte and
 * in order — it can be identity (YouTube `?v=`). Path and query keep their
 * case. A value that does not parse as an http(s) URL is only trimmed and
 * slash-stripped (the previous behaviour), never rejected.
 */
export function canonicalizeUrl(value: string): string {
  const v = value.trim();
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return v.replace(/\/+$/, "");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return v.replace(/\/+$/, "");
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const port = u.port ? `:${u.port}` : "";
  const path = u.pathname.replace(/\/+$/, "");
  const kept = u.search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => {
      if (!pair) return false;
      const rawKey = pair.split("=")[0];
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        /* malformed escape — judge the raw key */
      }
      return !TRACKING_PARAM.test(key);
    });
  const query = kept.length > 0 ? `?${kept.join("&")}` : "";
  return `${u.protocol}//${host}${port}${path}${query}`;
}

/**
 * The form `linkedin_url` / `website` atoms were stored in BEFORE
 * `canonicalizeUrl` (lowercase + one trailing slash stripped). Rows written
 * then are never rewritten, so `resolveIdentity` also looks this form up —
 * otherwise a `www.` LinkedIn URL registered last month would stop matching
 * the same URL today and mint a duplicate person.
 */
function legacyUrlSignalValue(value: string): string {
  return value.trim().toLowerCase().replace(/\/$/, "");
}

/**
 * Normalize a strong signal value to its canonical stored form — the SINGLE
 * door for signal normalization, so a lookup and a write agree byte-for-byte.
 * (EntityUpsertService delegates here.)
 */
export function normalizeIdentitySignal(type: string, value: string): string {
  const v = value.trim();
  switch (type) {
    case "email":
      return v.toLowerCase();

    case "phone":
    case "telegram_phone": {
      // Keep the + prefix, strip everything else (spaces, dashes, parens, dots)
      const digits = v.replace(/[^\d+]/g, "").replace(/^\+?/, "+");
      // Remove any duplicate leading +
      return digits.startsWith("++") ? digits.slice(1) : digits;
    }

    case "linkedin_url":
    case "website":
      // Same canonical URL, then fully case-folded — these two atoms were
      // always case-insensitive (a LinkedIn slug, a company's domain).
      return canonicalizeUrl(v).toLowerCase();

    case "url":
      // A page address: path and query case is significant (`?v=dQw4…`).
      return canonicalizeUrl(v);

    case "github_username":
    case "twitter_handle":
      return v.toLowerCase().replace(/^@/, "");

    case "external_id":
      // Opaque provider id — case is significant (e.g. a base64/hash segment).
      // Trim only; never lowercase, or the read wouldn't match the write.
      return v;

    default:
      return v.toLowerCase();
  }
}

/**
 * Property keys that carry a value for each strong signal type — the write-door
 * counterpart to `extractIdentitySignals` below. Mirrors the base property defs
 * seeded in `ensure-system-profiles.ts` (email/phone/linkedinUrl/website/
 * twitterHandle/githubUsername). Callers use this to check whether a changed
 * property key is signal-relevant before re-registering.
 */
export const IDENTITY_SIGNAL_PROPERTY_KEYS: Record<StrongSignalType, string[]> =
  {
    email: ["email"],
    phone: ["phone"],
    telegram_phone: ["telegramPhone"],
    linkedin_url: ["linkedinUrl", "linkedin-url"],
    website: ["website"],
    twitter_handle: ["twitterHandle", "twitter-handle"],
    github_username: ["githubUsername", "github-username"],
    // EMPTY on purpose: `properties.url` is identity only on a
    // URL_IDENTITY_KINDS entity, and this map is read KIND-BLIND (guest forms'
    // `planCarriesSignal` would refuse every note answer carrying a `url`).
    // Consequence: an entity UPDATE that changes a bookmark's url does not
    // re-register (mutate.ts gates on this map). Creates always register.
    url: [],
    // No property key maps to external_id — it's derived from (provider,
    // externalId), so a property change never re-registers it.
    external_id: [],
  };

/**
 * Kinds whose `properties.url` IS the subject's identity: the system capture
 * hierarchy `bookmark` → `website` / `article` / `signal_item` (every profile
 * seeded with `parentSlug: "bookmark"` in `ensure-system-profiles.ts`; the
 * `url-identity-kinds` test derives that set from the seeder and fails if the
 * two drift). A person's or a task's `url` is just a link the subject mentions,
 * so it is NOT an identity atom there.
 *
 * Does not cover user-defined kinds parented under `bookmark` — the extractor
 * is pure and has no profile tree to walk.
 */
export const URL_IDENTITY_KINDS: ReadonlySet<string> = new Set([
  "bookmark",
  "website",
  "article",
  "signal_item",
]);

/**
 * Extract ALL strong identity signals from an entity's property bag — the ONE
 * mapping from property values to `entity_identity_signals` rows, used by every
 * write door (entities.create/update, import) AND by capture's lookup-only
 * dedup path. The single extractor: LinkedIn detection is domain-anchored
 * (isLinkedinUrl) so lookalike hosts don't leak in.
 *
 * `discord-handle` is intentionally EXCLUDED: the FROZEN IDENTITY POLICY (see
 * module doc) classifies it as a WEAK surface form — advisory-only, scoped per
 * kind — not a globally-unique atom. Registering it here would silently
 * promote it to auto-merge, which the policy explicitly forbids.
 *
 * @param opts.aliases When true, also scans `properties.aliases[]` entries and
 *   registers any that look like an email or URL (best-effort — aliases carry
 *   no explicit type).
 * @param opts.kind The entity's kind (profile slug). Required for the `url`
 *   atom: `properties.url` is identity only on a URL_IDENTITY_KINDS kind.
 *   Omitted ⇒ no `url` atom (the pre-2026-10 behaviour).
 */
export function extractIdentitySignals(
  properties: Record<string, unknown> | undefined,
  opts?: { aliases?: boolean; kind?: string | null }
): IdentitySignal[] {
  if (!properties) return [];
  const signals: IdentitySignal[] = [];

  const email = properties.email;
  if (typeof email === "string" && email.includes("@")) {
    signals.push({ type: "email", value: email });
  }

  const phone = properties.phone;
  if (typeof phone === "string" && phone.replace(/[^\d]/g, "").length >= 7) {
    signals.push({ type: "phone", value: phone });
  }

  const linkedin = properties.linkedinUrl ?? properties["linkedin-url"];
  if (typeof linkedin === "string" && isLinkedinUrl(linkedin)) {
    signals.push({ type: "linkedin_url", value: linkedin });
  }

  const website = properties.website;
  if (typeof website === "string" && /^https?:\/\//.test(website)) {
    signals.push({ type: "website", value: website });
  }

  const url = properties.url;
  if (
    opts?.kind &&
    URL_IDENTITY_KINDS.has(opts.kind) &&
    typeof url === "string" &&
    /^https?:\/\//i.test(url.trim())
  ) {
    signals.push({ type: "url", value: url });
  }

  const twitter = properties.twitterHandle ?? properties["twitter-handle"];
  if (typeof twitter === "string" && twitter.trim().length > 0) {
    signals.push({ type: "twitter_handle", value: twitter });
  }

  const github = properties.githubUsername ?? properties["github-username"];
  if (typeof github === "string" && github.trim().length > 0) {
    signals.push({ type: "github_username", value: github });
  }

  if (opts?.aliases && Array.isArray(properties.aliases)) {
    for (const raw of properties.aliases) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const v = raw.trim();
      if (v.includes("@") && v.includes(".") && !v.includes(" ")) {
        signals.push({ type: "email", value: v });
      } else if (/^https?:\/\//.test(v)) {
        signals.push({
          type: isLinkedinUrl(v) ? "linkedin_url" : "website",
          value: v,
        });
      }
    }
  }

  return signals;
}

/**
 * Domain-anchored LinkedIn URL check. A plain `.includes("linkedin.com")`
 * false-positives on lookalike domains (e.g. `not-linkedin.com`) — this
 * requires "linkedin.com" to be the actual host, not a substring anywhere.
 */
export function isLinkedinUrl(value: string): boolean {
  return /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com(\/|$)/i.test(value);
}

/**
 * Map an EXPLICIT signals object (the identity pre-check request shape shared
 * by the Hub REST /identity/resolve route and the MCP synap_resolve_identity
 * tool) to typed identity atoms — the ONE mapper, so a bare `url` is
 * classified linkedin-vs-website by the same domain-anchored check everywhere
 * and the pre-check always agrees with a real write.
 */
export function signalsFromExplicit(
  signals:
    | {
        email?: string;
        phone?: string;
        url?: string;
        twitter?: string;
        github?: string;
        externalId?: string;
      }
    | undefined
): IdentitySignal[] {
  if (!signals) return [];
  const out: IdentitySignal[] = [];
  if (signals.email) out.push({ type: "email", value: signals.email });
  if (signals.phone) out.push({ type: "phone", value: signals.phone });
  if (signals.url) {
    out.push({
      type: isLinkedinUrl(signals.url) ? "linkedin_url" : "website",
      value: signals.url,
    });
  }
  if (signals.twitter)
    out.push({ type: "twitter_handle", value: signals.twitter });
  if (signals.github)
    out.push({ type: "github_username", value: signals.github });
  if (signals.externalId)
    out.push({ type: "external_id", value: signals.externalId });
  return out;
}

/**
 * Resolve an entity by identity — strong signals first (auto-resolve), then a
 * weak name/handle/alias candidate search (advisory, kind-scoped).
 *
 * @param db        Database handle (schema-typed).
 * @param userId    The acting user (provenance; weak scope is via `userScope`).
 * @param kindSlug  When set, a weak match must be the SAME kind (entities.type)
 *                  to become `match:'weak'` / `entity`; `candidates` still
 *                  carries cross-kind rows for facet detection, and
 *                  `crossKindCandidates` names them explicitly when nothing of
 *                  the requested kind matched (advisory — never auto-merge).
 * @param name      The name/title to weak-match (=== title). Blank → no weak.
 * @param signals   Strong identity atoms to look up (email/phone/url/…).
 * @param userScope A Drizzle predicate limiting the weak search to rows the
 *                  caller may see. Use `ownerPrivateVisibleWhere(
 *                  entities.workspaceId, entities.userId, userId)` — `entities`
 *                  is an ownerPrivate table, so the bare owner-blind
 *                  `userVisibleWhere` (which this line used to recommend) would
 *                  admit every user's pod-personal rows as weak-match
 *                  candidates. REQUIRED for the weak path — omit it and only the
 *                  strong (globally-unique) path runs, so no scoped read leaks.
 * @param limit     Cap on candidate/handle rows scanned (default 25).
 *
 * Strong matches short-circuit: `candidates` is empty and no weak query runs.
 */
export async function resolveIdentity(
  db: Db,
  params: {
    userId: string;
    kindSlug?: string;
    name?: string | null;
    signals?: IdentitySignal[];
    userScope?: SQL;
    limit?: number;
  }
): Promise<IdentityResolution> {
  const limit = params.limit ?? 25;

  // ── STRONG: globally-unique identity signals ──────────────────────────────
  const normalizedSignals = (params.signals ?? [])
    .filter((s) => s && s.type && typeof s.value === "string" && s.value.trim())
    .flatMap((s) => {
      const value = normalizeIdentitySignal(s.type, s.value);
      const canonical = { type: s.type, value };
      if (s.type !== "linkedin_url" && s.type !== "website") return [canonical];
      // Read-compat with rows stored before canonicalizeUrl (see
      // legacyUrlSignalValue). Writes only ever store the canonical form.
      const legacy = legacyUrlSignalValue(s.value);
      return legacy === value
        ? [canonical]
        : [canonical, { type: s.type, value: legacy }];
    });

  if (normalizedSignals.length > 0) {
    const signalMatch = await db.query.entityIdentitySignals.findFirst({
      where: or(
        ...normalizedSignals.map((s) =>
          and(
            eq(entityIdentitySignals.signalType, s.type),
            eq(entityIdentitySignals.signalValue, s.value)
          )
        )
      ),
      columns: { entityId: true },
    });

    if (signalMatch) {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, signalMatch.entityId),
          isNull(entities.deletedAt)
        ),
        columns: { id: true, title: true, type: true, workspaceId: true },
      });
      if (entity) {
        return {
          match: "strong",
          entity,
          candidates: [],
          crossKindCandidates: [],
        };
      }
      // Signal points at a deleted/missing row — ignore, fall through to weak.
    }
  }

  // ── WEAK: name / handle / alias candidates (advisory) ─────────────────────
  const name = params.name?.trim();
  if (!name || !params.userScope) {
    return { match: null, candidates: [], crossKindCandidates: [] };
  }

  // EXACT name, case-insensitive. `ilike` with no wildcards is an exact CI
  // match; escape LIKE metacharacters so % or _ in a name match literally.
  const escaped = name.replace(/([%_\\])/g, "\\$1");
  const lowerName = name.toLowerCase();

  // IDENTITY FALLBACK (surface forms): a person's indexed `discord-handle` or an
  // `aliases[]` entry can carry the name we're resolving — so "0scr" / a handle
  // resolves to the existing person instead of a duplicate. `discord-handle` is
  // a WEAK surface form here (not a strong signal) because capture-created
  // entities don't yet register it in entity_identity_signals. Base defs are
  // global (profile_id/workspace_id NULL); if unseeded the list is empty and we
  // silently fall back to title-only matching.
  const identityDefs = await db.query.propertyDefs.findMany({
    where: and(
      inArray(propertyDefs.slug, ["discord-handle"]),
      isNull(propertyDefs.profileId),
      isNull(propertyDefs.workspaceId)
    ),
    columns: { id: true },
  });
  const identityDefIds = identityDefs.map((d) => d.id);

  let identityEntityIds: string[] = [];
  if (identityDefIds.length > 0) {
    const idxRows = await db.query.entityPropertyIndex.findMany({
      where: and(
        inArray(entityPropertyIndex.propertyDefId, identityDefIds),
        sql`lower(${entityPropertyIndex.valueText}) = ${lowerName}`
      ),
      columns: { entityId: true },
      limit,
    });
    identityEntityIds = idxRows.map((r) => r.entityId);
  }

  // Match on title OR indexed handle OR an alias (JSONB containment, case-folded
  // on the source `properties.aliases`). The CASE guard keeps
  // jsonb_array_elements_text from erroring on a non-array `aliases` value.
  const matchClauses: SQL[] = [ilike(entities.title, escaped)];
  if (identityEntityIds.length > 0) {
    matchClauses.push(inArray(entities.id, identityEntityIds));
  }
  matchClauses.push(
    sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(${entities.properties} -> 'aliases') = 'array'
             THEN ${entities.properties} -> 'aliases'
             ELSE '[]'::jsonb END
      ) AS alias
      WHERE lower(alias) = ${lowerName}
    )`
  );

  const rows = await db.query.entities.findMany({
    where: and(
      isNull(entities.deletedAt),
      or(...matchClauses),
      params.userScope
    ),
    columns: { id: true, title: true, type: true, workspaceId: true },
    // Earliest-created wins → deterministic when several rows share a name.
    orderBy: (e, { asc }) => [asc(e.createdAt)],
    limit,
  });

  const candidates: ResolvedIdentityEntity[] = rows;
  // Pick the resolved entity subject to the kind filter (when given). Candidates
  // stay unfiltered so callers can do cross-profile facet partitioning.
  const entity = params.kindSlug
    ? candidates.find((c) => c.type === params.kindSlug)
    : candidates[0];

  // Cross-kind same-title rows: only meaningful when the caller asked for a
  // specific kind AND nothing of that kind matched — i.e. exactly the case that
  // used to answer a bare "no match" and green-light a duplicate. Advisory
  // only: `match` stays null (no auto-merge on a weak/title signal, ever), but
  // the caller can now say "a `research` with this title already exists" instead
  // of "safe to create".
  const crossKindCandidates =
    params.kindSlug && !entity
      ? candidates.filter((c) => c.type !== params.kindSlug)
      : [];

  return {
    match: entity ? "weak" : null,
    entity,
    candidates,
    crossKindCandidates,
  };
}

/**
 * The SINGLE write door for identity signals: normalize + insert, skipping any
 * (type, value) already owned by another entity (onConflictDoNothing). All
 * signal writes route here so the stored form always matches what
 * `resolveIdentity` looks up.
 */
export async function registerIdentitySignals(
  db: Db,
  entityId: string,
  signals: IdentitySignal[],
  source = "resolve"
): Promise<void> {
  const rows = signals
    .filter((s) => s && s.type && typeof s.value === "string" && s.value.trim())
    .map((s) => ({
      entityId,
      signalType: s.type,
      signalValue: normalizeIdentitySignal(s.type, s.value),
      source,
    }));
  if (rows.length === 0) return;
  await db.insert(entityIdentitySignals).values(rows).onConflictDoNothing();
}
