/**
 * Schema linking for a capture: which kinds the structurer may pick, across
 * EVERY space the person can see (D1, founder-approved 2026-10-12).
 *
 * The landing space is chosen FROM the kind, so the kind list cannot be the
 * starting space's: a kind living in another space (`post` in Content,
 * captured from Builder) must be pickable to reach its space. Every visible
 * kind is offered by name (cheap), the best-ranked carry a one-line
 * description, and only the top few their full property hints (the expensive
 * part). Placement (`resolveWorkspacePlacement`) lands a kind in the space
 * that holds it.
 *
 * Ranking is the catalog ranking `understandQuery` uses (`scoreProfileCatalog`),
 * plus the description words a note shares with a kind, plus a nudge for kinds
 * of the space the capture started in. Deterministic, no model call.
 */

import { COMMON_STOPWORDS } from "../retrieval/stopwords.js";
import {
  scoreProfileCatalog,
  tokenize,
  toProfileCatalogEntry,
  type ProfileCatalogEntry,
} from "../retrieval/understand-query.js";

/** The profile fields `buildAvailableProfiles` reads (capture router). */
interface AccessibleProfileLike {
  slug: string;
  displayName?: string | null;
  uiHints?: Record<string, unknown> | null;
}

/** Kinds that carry their full property hints. */
export const LINKED_KINDS_WITH_HINTS = 12;
/** Kinds that carry their description and spaces; past this, names only. */
export const LINKED_KINDS_DESCRIBED = 60;
/** Kinds offered at all (the IS refuses more: `AVAILABLE_PROFILES_MAX`). */
export const LINKED_KINDS_MAX = 200;
/** A kind's description, as the structurer reads it: one line. */
export const KIND_DESCRIPTION_MAX = 160;
/** Space names named per kind. */
export const KIND_SPACES_MAX = 4;

/** The profile row fields schema linking reads. */
export interface LinkableProfile extends AccessibleProfileLike {
  id?: string;
  plural?: string | null;
  synonyms?: string[] | null;
  workspaceId?: string | null;
}

/** One kind as the structurer receives it (`hints.availableProfiles[i]`). */
export interface LinkedProfile {
  slug: string;
  displayName: string;
  description?: string;
  propertyHints?: string;
  spaces?: string[];
  /** Where the kind's lifecycle starts — an idea for it is filed there (D3). */
  firstStatus?: { property: string; value: string };
}

/** The lifecycle fields schema linking reads (`getEffectiveLifecycles`). */
export interface LinkableLifecycle {
  propertySlug: string;
  options: ReadonlyArray<{ key: string }>;
}

/**
 * The spaces a request may route into, from its key grant: `null` = not
 * narrowed (no grant, or a scope without a space list); otherwise the union of
 * the scopes' spaces — a key granted on Content and CRM sees exactly those.
 */
export function grantedWorkspaceIdsOf(
  grant:
    | { scopes: ReadonlyArray<{ workspaceIds?: readonly string[] | null }> }
    | null
    | undefined
): ReadonlySet<string> | null {
  if (!grant) return null;
  const out = new Set<string>();
  for (const scope of grant.scopes) {
    if (!scope.workspaceIds) return null;
    for (const id of scope.workspaceIds) out.add(id);
  }
  return out;
}

/**
 * The kinds a capture may offer: a space kind only while its space is live
 * (not archived) and inside the request's grant. Pod-wide kinds (no space)
 * always pass. PURE.
 */
export function kindsWithinFloor<P extends { workspaceId?: string | null }>(
  profiles: ReadonlyArray<P>,
  floor: {
    archivedWorkspaceIds: ReadonlySet<string>;
    grantedWorkspaceIds: ReadonlySet<string> | null;
  }
): P[] {
  return profiles.filter(
    (p) =>
      !p.workspaceId ||
      (!floor.archivedWorkspaceIds.has(p.workspaceId) &&
        (floor.grantedWorkspaceIds === null ||
          floor.grantedWorkspaceIds.has(p.workspaceId)))
  );
}

function oneLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > KIND_DESCRIPTION_MAX
    ? `${line.slice(0, KIND_DESCRIPTION_MAX - 1)}…`
    : line;
}

function descriptionOf(p: AccessibleProfileLike): string | undefined {
  return (p.uiHints as Record<string, unknown> | null | undefined)
    ?.description as string | undefined;
}

/**
 * Rank kinds for a note, best first. PURE. Ties keep the input order, so an
 * unscored catalog is offered exactly as it came.
 */
export function rankKindsForNote(
  note: string,
  kinds: ReadonlyArray<LinkableProfile>,
  currentWorkspaceId?: string | null
): LinkableProfile[] {
  const catalog = kinds
    .map((k) =>
      toProfileCatalogEntry({
        slug: k.slug,
        displayName: k.displayName ?? k.slug,
        plural: k.plural ?? null,
        synonyms: k.synonyms ?? null,
      })
    )
    .filter((e): e is ProfileCatalogEntry => e !== null);
  const { scored } = scoreProfileCatalog(note, catalog);
  const words = new Set(
    tokenize(note).filter((w) => w.length > 3 && !COMMON_STOPWORDS.has(w))
  );
  const score = (k: LinkableProfile): number => {
    let s = scored.get(k.slug) ?? 0;
    const described = new Set(tokenize(descriptionOf(k) ?? ""));
    let shared = 0;
    for (const w of words) if (described.has(w)) shared++;
    s += Math.min(shared, 2);
    if (currentWorkspaceId && k.workspaceId === currentWorkspaceId) s += 1;
    return s;
  };
  return kinds
    .map((k, i) => ({ k, i, s: score(k) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ k }) => k);
}

/**
 * The kinds a capture offers the structurer: every visible kind (deduped by
 * slug, best-ranked first, at most {@link LINKED_KINDS_MAX}), property hints
 * for the top {@link LINKED_KINDS_WITH_HINTS}, description + spaces for the top
 * {@link LINKED_KINDS_DESCRIBED}, names only past that — and, for EVERY kind,
 * the first status of its lifecycle, so a low-ranked kind can still take an
 * idea at its first status.
 */
export async function buildLinkedProfiles(args: {
  /** Every profile the person can see, in every space. */
  profiles: ReadonlyArray<LinkableProfile>;
  /** The property hints of one kind (`buildAvailableProfiles`' string). */
  propertyHintsFor: (
    row: LinkableProfile,
    workspaceId: string | null
  ) => Promise<string | undefined>;
  note: string;
  /** The space the capture started in — a ranking nudge, not a filter. */
  workspaceId?: string | null;
  workspaceNames: ReadonlyMap<string, string>;
  /** Lifecycles by profile id (`getEffectiveLifecycles`); absent = none sent. */
  lifecyclesFor?: (
    profileIds: string[]
  ) => Promise<ReadonlyMap<string, LinkableLifecycle>>;
  /**
   * The lifecycle read failed. It is optional enrichment: the kinds go out
   * without `firstStatus` (absent = not said) and the failure is reported
   * here, never swallowed.
   */
  onLifecyclesFailed?: (err: unknown) => void;
}): Promise<LinkedProfile[]> {
  const creatable = args.profiles.filter(
    (p) =>
      p.slug &&
      !(p.uiHints as Record<string, unknown> | null | undefined)?.hideFromCreate
  );
  const ranked = rankKindsForNote(args.note, creatable, args.workspaceId);

  // One entry per slug: the best-ranked row speaks for it; every row that
  // shares the slug adds its space.
  const bySlug = new Map<string, { row: LinkableProfile; spaces: string[] }>();
  for (const row of ranked) {
    const entry = bySlug.get(row.slug) ?? { row, spaces: [] };
    const name = row.workspaceId
      ? args.workspaceNames.get(row.workspaceId)
      : undefined;
    if (name && !entry.spaces.includes(name)) entry.spaces.push(name);
    bySlug.set(row.slug, entry);
  }
  const entries = [...bySlug.values()].slice(0, LINKED_KINDS_MAX);

  const top = entries.slice(0, LINKED_KINDS_WITH_HINTS);
  const ids = entries.flatMap(({ row }) => (row.id ? [row.id] : []));
  const [withHints, lifecycles] = await Promise.all([
    Promise.all(
      top.map(({ row }) =>
        args.propertyHintsFor(row, row.workspaceId ?? args.workspaceId ?? null)
      )
    ),
    args.lifecyclesFor && ids.length > 0
      ? Promise.resolve()
          .then(() => args.lifecyclesFor!(ids))
          .catch((err: unknown) => {
            args.onLifecyclesFailed?.(err);
            return new Map<string, LinkableLifecycle>();
          })
      : Promise.resolve(new Map<string, LinkableLifecycle>()),
  ]);

  return entries.map(({ row, spaces }, i) => {
    const described = i < LINKED_KINDS_DESCRIBED;
    const description = described ? oneLine(descriptionOf(row)) : undefined;
    const propertyHints = i < top.length ? withHints[i] : undefined;
    const lifecycle = row.id ? lifecycles.get(row.id) : undefined;
    const first = lifecycle?.options[0]?.key;
    return {
      slug: row.slug,
      displayName: row.displayName || row.slug,
      ...(description ? { description } : {}),
      ...(propertyHints ? { propertyHints } : {}),
      ...(described && spaces.length > 0
        ? { spaces: spaces.slice(0, KIND_SPACES_MAX) }
        : {}),
      ...(lifecycle && first
        ? { firstStatus: { property: lifecycle.propertySlug, value: first } }
        : {}),
    };
  });
}
