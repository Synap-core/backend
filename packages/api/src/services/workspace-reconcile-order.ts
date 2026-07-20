/**
 * orderWorkspacesByTemplateDependencies — dependency-first ordering for the
 * boot-time workspace→template reconcile pass.
 *
 * WHY THIS EXISTS
 * ---------------
 * A template whose profiles are `scope: shared` seeds ONE base row, reachable
 * from other workspaces only through `profile_workspace_access` grants. (NOTE:
 * `shared` is NOT pod-wide — that is `scope: system`. See ProfileScope in
 * `@synap/database`.) The template that reaches that row FIRST seeds its body;
 * later templates only add workspace OVERLAYS. So "which template applies first"
 * decides the base.
 *
 * On the INSTALL path that order is guaranteed: `resolvePackageDependencies`
 * walks `dependencies` deps-first before materializing the consumer.
 *
 * On the BOOT path (`apps/api/src/startup/reconcile-workspaces-to-templates.ts`)
 * it was NOT: that pass selected every workspace with no ORDER BY and reconciled
 * in whatever order Postgres returned rows. Given a pod that holds BOTH
 * `foundation` and `marketing-campaign` workspaces, a marketing-first row order
 * made `resolveProfileForApply("lead")` find no candidate, fall to
 * `createScope: "shared"`, and seed the `lead` base from marketing's body instead
 * of foundation's SSOT body. This function closes that gap by giving the boot
 * loop the same deps-first ordering the install resolver already has.
 *
 * WHAT THIS DOES **NOT** FIX — read before relying on it
 * -----------------------------------------------------
 * This orders only what is PRESENT. `visit()` walks a dependency edge solely
 * when the dependency has a workspace ON THIS POD (`present.has(dep.slug)`), and
 * that is deliberate: this pass reconciles existing workspaces, it must never
 * conjure one.
 *
 * So on a pod holding `marketing-campaign` and NO `foundation` workspace, this
 * function is a NO-OP and marketing still seeds the `lead` base. The root cause
 * there is ABSENCE, not order, and ordering cannot fix absence. That is the live
 * state of at least one production pod, and an earlier version of this comment
 * (and the commit that introduced it, 66cabcaa) wrongly claimed this function
 * closed it.
 *
 * The remedies for absence are elsewhere and are NOT interchangeable with this:
 *   - NEW installs: `require: foundation` makes the install resolver materialize
 *     the dependency first. Correct by construction, but only going forward.
 *   - EXISTING drifted pods: a data conversion (install the owner template, or a
 *     ConvertToFacetOp-style migration). Nothing in this file helps them.
 *
 * Consequently `template-shared-role-ssot`'s rule (b)/(c) relaxation rests on the
 * INSTALL path's ordering, not on this one. Do not cite this function as the
 * guarantee for a pod that predates the dependency edges.
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

import { layerTemplateGraph } from "@synap-core/workspace-templates";

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
 *  - CYCLES terminate (the shared composition engine's ancestor-path guard
 *    breaks the back-edge) and never drop a row.
 *  - DETERMINISTIC: same input ⇒ same output. Slugs are visited in order of
 *    first appearance in `rows`, dependencies in declaration order, and ties are
 *    broken by original index.
 *
 * IMPLEMENTATION: delegates the actual layering to `layerTemplateGraph`
 * (`@synap-core/workspace-templates`) — the same longest-path composition
 * engine the CLI/browser/backend all share for template dependency graphs.
 * This function supplies only what's specific to the boot-reconcile use
 * case: resolving each row to its template's node identity, restricting
 * edges to templates PRESENT on this pod (a caller-side predicate, not an
 * engine default — see the "WHAT THIS DOES NOT FIX" section above), and
 * translating the engine's layers back into this function's row order.
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

  // 3. PRESENT-ONLY edge predicate — the caller-side filter that keeps this
  //    pass "reconcile what's here", never "conjure what's missing" (see the
  //    doc comment above). This is deliberately NOT folded into the engine:
  //    `layerTemplateGraph`'s default `bundledEdgesOf` has no notion of "on
  //    this pod", so the filter has to live here, on every call. Both
  //    `compose` (overlay onto the base) and `require` (base must exist) mean
  //    the SAME thing for ordering: the dependency goes first — `dep.kind` is
  //    not filtered here either, a `capability`/`automation` dep simply never
  //    matches a present workspace slug, so the presence check drops it.
  const edgesOfPresent = (slug: string): TemplateDependencyRef[] =>
    (templateBySlug.get(slug)?.dependencies ?? []).filter((dep) =>
      present.has(dep.slug)
    );

  // 4. Root selection for the engine. `layerTemplateGraph` pins every slug in
  //    `roots` to layer 0 regardless of what depends on it, so passing every
  //    present slug as a root would wrongly flatten dependencies (e.g.
  //    `foundation`) to the top layer instead of the bedrock. A slug only
  //    belongs in `roots` when no OTHER present slug reaches it first —
  //    everything else is discovered as a dependency during the engine's own
  //    walk. A pure cycle (no slug in the component has an outside root)
  //    still needs a representative, so this walks `presentSlugs` in order
  //    and adds whichever slug isn't already reachable from an earlier root —
  //    the same coverage the old DFS's `visited` set guaranteed, computed
  //    once here instead of inside a hand-rolled traversal.
  const roots: string[] = [];
  const reachableFromRoots = new Set<string>();
  const markReachable = (start: string): void => {
    const stack = [start];
    while (stack.length > 0) {
      const slug = stack.pop();
      if (slug === undefined || reachableFromRoots.has(slug)) continue;
      reachableFromRoots.add(slug);
      for (const dep of edgesOfPresent(slug)) stack.push(dep.slug);
    }
  };
  for (const slug of presentSlugs) {
    if (reachableFromRoots.has(slug)) continue;
    roots.push(slug);
    markReachable(slug);
  }

  // 5. Delegate the actual layering to the shared composition engine — same
  //    graph (`dependencies[]`, present-filtered), same guarantees (every
  //    reachable node exactly once, cycles broken not dropped, deterministic).
  //    `TemplateDependencyRef` carries no `relation` field, so every edge
  //    reaching the engine defaults to `"require"` — which is exactly the old
  //    DFS's compose-and-require-are-the-same behaviour (see step 3), not an
  //    approximation of it: the engine's compose-only node exclusion (a
  //    `compose` source is never its own layer node) can never trigger here.
  const graph = layerTemplateGraph({ roots, edgesOf: edgesOfPresent });

  // 6. `layers[0]` = roots, `layers[n]` = bedrock (engine convention). This
  //    function's contract is the OPPOSITE direction — a dependency
  //    reconciles BEFORE its dependent — so rank a node by distance from
  //    bedrock: `maxLayer - node.layer` gives the bedrock layer rank 0.
  //    Rows off the graph keep the old `UNORDERED_RANK` (sort last).
  const maxLayer = Math.max(
    0,
    ...[...graph.nodes.values()].map((node) => node.layer)
  );
  const rankOf = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    rankOf.set(node.slug, maxLayer - node.layer);
  }

  // 7. Stable sort by (rank, originalIndex) — unchanged from the old DFS's
  //    final step. The explicit index tiebreak makes determinism a property
  //    of THIS code, and it's also what keeps two rows at the same rank (e.g.
  //    sibling consumers of the same base) in their ORIGINAL relative order
  //    instead of the engine's internal alphabetical layer ordering.
  return rows
    .map((row, index) => {
      const slug = identityOf[index];
      const rank =
        slug === undefined
          ? UNORDERED_RANK
          : (rankOf.get(slug) ?? UNORDERED_RANK);
      return { row, index, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.row);
}
