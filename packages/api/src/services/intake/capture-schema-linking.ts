/**
 * Schema linking for a capture: which kinds the structurer may pick, across
 * EVERY space the person can see (D1, founder-approved 2026-10-12).
 *
 * The kind list used to come from the space the capture STARTED in, while the
 * landing space is chosen FROM the kind — so a kind living in another space
 * (`post` in Content, captured from Builder) could never be picked and never
 * reach its space. Now every visible kind is offered by name + one-line
 * description (cheap), and only the best-ranked few carry their full property
 * hints (the expensive part). Placement (`resolveWorkspacePlacement`) is
 * unchanged: it already lands a kind in the space that holds it.
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
 * slug, best-ranked first), descriptions for all, property hints for the top
 * {@link LINKED_KINDS_WITH_HINTS}, and the spaces that hold each.
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
  const entries = [...bySlug.values()];

  const top = entries.slice(0, LINKED_KINDS_WITH_HINTS);
  const withHints = await Promise.all(
    top.map(({ row }) =>
      args.propertyHintsFor(row, row.workspaceId ?? args.workspaceId ?? null)
    )
  );

  return entries.map(({ row, spaces }, i) => {
    const description = oneLine(descriptionOf(row));
    const propertyHints = i < top.length ? withHints[i] : undefined;
    return {
      slug: row.slug,
      displayName: row.displayName || row.slug,
      ...(description ? { description } : {}),
      ...(propertyHints ? { propertyHints } : {}),
      ...(spaces.length > 0
        ? { spaces: spaces.slice(0, KIND_SPACES_MAX) }
        : {}),
    };
  });
}
