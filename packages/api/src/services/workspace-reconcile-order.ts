/**
 * orderWorkspacesByTemplateDependencies — dependency-first ordering for the
 * boot-time workspace→template reconcile pass.
 *
 * WHY THIS EXISTS
 * ---------------
 * A template whose profiles are `scope: shared` seeds ONE pod-wide base row. The
 * template that reaches that row FIRST seeds its body; later templates only add
 * workspace OVERLAYS. So "which template applies first" decides the base.
 *
 * On the INSTALL path that order is guaranteed: `resolvePackageDependencies`
 * walks `dependencies` deps-first before materializing the consumer.
 *
 * On the BOOT path (`apps/api/src/startup/reconcile-workspaces-to-templates.ts`)
 * it was NOT. That pass selected every workspace with no ORDER BY and reconciled
 * in whatever order Postgres returned rows. On a pod holding `marketing-campaign`
 * + `ecosystem` but no pod-wide `lead` row yet, a marketing-first row order made
 * `resolveProfileForApply("lead")` find no candidate, fall to
 * `createScope: "shared"`, and seed the pod-wide `lead` base from marketing's
 * body instead of foundation's SSOT body. Every later workspace then granted onto
 * the wrong base. This function closes that gap by giving the boot loop the same
 * deps-first ordering the install resolver already has.
 *
 * AGNOSTIC BY CONSTRUCTION
 * ------------------------
 * No domain slug appears here. The edges are read from each template's OWN
 * declared `dependencies`. `foundation`, `grants`, `marketing-campaign` etc. are
 * data, not code — a template that adds or drops a dependency changes this
 * ordering with no backend edit.
 *
 * NODE IDENTITY = the RESOLVED template's `meta.slug`, never the raw subtype
 * string. `dependencies[].slug` is expressed in template-slug space, so nodes
 * must live in that same space for edges to match. Today `getWorkspaceTemplate`
 * is a plain key lookup into a map keyed BY `meta.slug`, so a successful lookup
 * necessarily returns a template whose `meta.slug` equals the string passed in —
 * the two coincide. Reading `meta.slug` is still the correct spelling: it states
 * the space the graph lives in and stays right if lookup ever gains aliasing or
 * fallbacks. (It is NOT a live trap today — see the note on `workspace.subtype`
 * below for the collision that IS real.)
 *
 * NOT this function's job: `workspace.subtype` and `meta.slug` are different
 * fields and DO collide across templates (`grants` declares `subtype: operations`;
 * `blockchain-ecosystem` declares `subtype: ecosystem`). Because the boot loop
 * looks a row's subtype up in a map keyed by meta.slug, a workspace stamped
 * `operations` resolves to the `operations` template — never to `grants`. Which
 * template a row converges to is a separate concern from the ORDER rows are
 * processed in; this function faithfully orders whatever the lookup resolves.
 */

/** Minimal structural view of a template dependency edge. */
export interface TemplateDependencyRef {
  /** Slug of the template this one depends on (template-slug space). */
  slug: string;
}

/**
 * Minimal structural view of a template, declared locally rather than imported
 * from `@synap-core/workspace-templates` so this pure module never couples to a
 * published tarball's d.ts version. `WorkspaceYaml` is structurally assignable.
 */
export interface TemplateForOrdering {
  meta: { slug: string };
  dependencies?: readonly TemplateDependencyRef[] | null;
}

/** Resolves a slug to its template, or `undefined` when there is none. */
export type TemplateLookup = (
  slug: string
) => TemplateForOrdering | undefined | null;

/** A row to be ordered. Only the resolved subtype matters to the sort. */
export interface OrderableWorkspaceRow {
  subtype?: string | null;
}

/** Rank assigned to rows that participate in no dependency edge. */
const UNORDERED_RANK = Number.MAX_SAFE_INTEGER;

/**
 * Orders workspace rows so that a workspace whose template another template
 * depends on reconciles FIRST.
 *
 * Guarantees:
 *  - EVERY input row appears in the output EXACTLY once — including rows with no
 *    subtype, rows whose subtype has no template, and rows caught in a cycle.
 *  - A dependency declared by a template but with no workspace on this pod is
 *    simply absent from the graph — not an error.
 *  - Multiple workspaces sharing a subtype all sort together, keeping their
 *    original relative order.
 *  - CYCLES terminate (an ancestor-path guard breaks the back-edge) and never
 *    drop a row.
 *  - DETERMINISTIC: same input ⇒ same output. Slugs are visited in order of
 *    first appearance in `rows`, dependencies in declaration order, and ties are
 *    broken by original index.
 */
export function orderWorkspacesByTemplateDependencies<
  T extends OrderableWorkspaceRow,
>(rows: readonly T[], lookupTemplate: TemplateLookup): T[] {
  // 1. Resolve each row to its node identity (the resolved template's meta.slug),
  //    KEEPING the resolved template. `undefined` = this row is not on the graph.
  //
  //    The template is cached by identity rather than re-looked-up during the DFS
  //    on purpose: the lookup is keyed by whatever string the row carries
  //    (`subtype`), which is not necessarily the template's own `meta.slug`.
  //    Re-querying `lookupTemplate(meta.slug)` would return `undefined` for any
  //    template reachable only under a different key, silently dropping its
  //    dependency edges and leaving the rows unordered. Resolving once and
  //    remembering the result keeps the graph correct in `meta.slug` space no
  //    matter which key the row was resolved under.
  const templateBySlug = new Map<string, TemplateForOrdering>();
  const identityOf: Array<string | undefined> = rows.map((row) => {
    const subtype = row.subtype;
    if (!subtype) return undefined;
    const template = lookupTemplate(subtype);
    const slug = template?.meta?.slug;
    if (!template || !slug) return undefined;
    if (!templateBySlug.has(slug)) templateBySlug.set(slug, template);
    return slug;
  });

  // 2. The set of template slugs actually PRESENT on this pod, in order of first
  //    appearance — this seeds a deterministic DFS root order.
  const presentSlugs: string[] = [];
  const present = new Set<string>();
  for (const slug of identityOf) {
    if (slug !== undefined && !present.has(slug)) {
      present.add(slug);
      presentSlugs.push(slug);
    }
  }

  // 3. DFS post-order over declared dependencies, restricted to present slugs.
  //    Post-order emits a dependency BEFORE its dependents — exactly the order
  //    the reconcile loop needs.
  const topoOrder: string[] = [];
  const visited = new Set<string>(); // fully processed → emitted exactly once
  const onPath = new Set<string>(); // current DFS ancestor chain → cycle guard

  const visit = (slug: string): void => {
    // A true cycle: `slug` is an ANCESTOR of itself on this path. Break the back
    // edge and return — the node is still emitted by the frame that owns it, so
    // a cycle degrades to an arbitrary-but-deterministic order, never a hang and
    // never a dropped row.
    if (onPath.has(slug)) return;
    // Already emitted (or a legitimate diamond re-reached from another parent).
    if (visited.has(slug)) return;

    onPath.add(slug);
    // Both `compose` (overlay onto the base) and `require` (base must exist)
    // mean the SAME thing for ordering: the dependency goes first. Dependency
    // `kind` is not filtered — a `capability`/`automation` dep simply never
    // matches a workspace node, so the presence check below drops it.
    for (const dep of templateBySlug.get(slug)?.dependencies ?? []) {
      // A dependency with no workspace on this pod is absent from the sort, not
      // an error — nothing to order against.
      if (present.has(dep.slug)) visit(dep.slug);
    }
    onPath.delete(slug);

    visited.add(slug);
    topoOrder.push(slug);
  };

  for (const slug of presentSlugs) visit(slug);

  // 4. Rank each slug by its topological position; rows off the graph sort last.
  const rankOf = new Map<string, number>();
  topoOrder.forEach((slug, i) => rankOf.set(slug, i));

  // 5. Stable sort by (rank, originalIndex). The explicit index tiebreak makes
  //    determinism a property of THIS code rather than of engine sort stability.
  return rows
    .map((row, index) => {
      const slug = identityOf[index];
      const rank =
        slug === undefined ? UNORDERED_RANK : (rankOf.get(slug) ?? UNORDERED_RANK);
      return { row, index, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.row);
}
