/**
 * Seed relation REF resolution — the ONE ladder every seed loop uses.
 *
 * A template's `suggestedRelations[].sourceRef/targetRef` names a seed by one
 * of three keys, in this order of precedence:
 *   1. its explicit `refKey` (older callers);
 *   2. `${profileSlug}:${title}` (the historic entityRefMap key);
 *   3. its bare `title` — what templates actually write (the WT
 *      `seed-obligation` test enforces bare titles) — only when that title is
 *      UNIQUE among the seeds, so an ambiguous title never binds the wrong row.
 *
 * Shared by `createWorkspaceFromDefinition` (fresh create) and the api's
 * `applyDefinitionSeeds` (existing workspace). The fresh-create loop resolved
 * `kind:title` only, so every bare-title edge was dropped on a fresh install
 * (RV1 S6) while the same template's edges landed on an overlay install.
 */
export interface SeedRefShape {
  profileSlug: string;
  title: string;
  refKey?: string;
}

/** The historic `${profileSlug}:${title}` key. */
export function seedKindTitleKey(s: { profileSlug: string; title: string }) {
  return `${s.profileSlug}:${s.title}`;
}

/**
 * Build the alias function for one seed set: `aliasesFor(seed)` lists every
 * ref key that seed answers to (refKey, kind:title, unique bare title).
 */
export function seedRefAliasIndex(
  seeds: ReadonlyArray<SeedRefShape>
): (seed: SeedRefShape) => string[] {
  const titleCount = new Map<string, number>();
  for (const s of seeds) {
    titleCount.set(s.title, (titleCount.get(s.title) ?? 0) + 1);
  }
  return (s) => {
    const keys = new Set<string>();
    if (s.refKey) keys.add(s.refKey);
    keys.add(seedKindTitleKey(s));
    if (titleCount.get(s.title) === 1) keys.add(s.title);
    return [...keys];
  };
}
