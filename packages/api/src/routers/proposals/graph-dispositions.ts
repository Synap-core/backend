/**
 * Per-item dispositions (Phase 2) — partial-apply a composite (graph) proposal.
 *
 * A reviewer decision on a single graph item rides in `approve`'s optional
 * `dispositions` map and is persisted verbatim into `proposals.data.dispositions`
 * (`ProposalItemDisposition`, keyed by the item's ref — `$opN`/op `ref` for an
 * entity, `$relN` for a relation). Absent map ⇒ apply-all (the whole-proposal
 * behavior, byte-identical).
 *
 * PURE / DB-FREE leaf (imports only the types package) so the cascade — the
 * riskiest Phase-2 logic — is unit-testable without the `@synap/database` chain
 * that loading `proposals.ts` would pull in.
 */

import {
  opRef,
  PRIMARY_REF,
  type CompositeProposalOperation,
  type CompositeCreateEntityOp,
  type CompositeCreateRelationOp,
  type ProposalItemDisposition,
} from "@synap-core/types/proposals";

export type GraphDispositionMap = Record<string, ProposalItemDisposition>;

/**
 * Merge reviewer edits onto a create_entity op (title/description/profileSlug
 * replace; properties merge). Only known fields are applied — an unknown edit
 * key is ignored rather than injected into the op.
 */
export function applyEntityEdits(
  op: CompositeCreateEntityOp,
  edits: Record<string, unknown>
): CompositeCreateEntityOp {
  const next: CompositeCreateEntityOp = { ...op };
  if (typeof edits.title === "string") next.title = edits.title;
  if (typeof edits.description === "string")
    next.description = edits.description;
  if (typeof edits.profileSlug === "string" && edits.profileSlug.length > 0)
    next.profileSlug = edits.profileSlug;
  if (typeof edits.content === "string") next.content = edits.content;
  if (
    edits.properties != null &&
    typeof edits.properties === "object" &&
    !Array.isArray(edits.properties)
  ) {
    next.properties = {
      ...(op.properties ?? {}),
      ...(edits.properties as Record<string, unknown>),
    };
  }
  return next;
}

/**
 * Filter a composite proposal's operations by per-item dispositions (Phase 2).
 *
 *  - entity op `status:'reject'`  → DROPPED (never materialized).
 *  - entity op `status:'edit'`    → its `edits` merged onto the op (this is the
 *    channel that fixes the edit-persistence bug — the edited title/props now
 *    reach `entityCaller.create` instead of the executors re-reading the
 *    original data).
 *  - CASCADE: any `create_relation` whose sourceRef/targetRef points at a
 *    rejected entity (matched against ALL of that entity's aliases — `$opN`,
 *    op `ref`, `$primary` for the first entity, and `existingEntityId`) is
 *    auto-dropped, so no dangling ref survives (`resolveCompositeRef` would
 *    otherwise mis-resolve an `existingEntityId` alias to a real edge).
 *  - relation op `status:'reject'` → DROPPED.
 *  - CASCADE: a facet whose `contextRef` points at a rejected entity is dropped
 *    from a KEPT entity op (else pass 1.5's `resolveCompositeRef` throws).
 *
 * Pure/DB-free. Entity/relation item refs are computed IDENTICALLY to
 * `buildProposalGraph` so a `$relN`/`$opN`/`ref` disposition maps to the same op.
 */
export function applyGraphDispositions(
  operations: CompositeProposalOperation[],
  dispositions: GraphDispositionMap
): CompositeProposalOperation[] {
  // Pass A — collect the aliases of every REJECTED entity (for cascade matching).
  const rejectedAliases = new Set<string>();
  let firstEntitySeen = false;
  operations.forEach((op, index) => {
    if (op.op !== "create_entity") return;
    const entityOp = op as CompositeCreateEntityOp;
    const itemRef = entityOp.ref ?? opRef(index);
    const isFirst = !firstEntitySeen;
    firstEntitySeen = true;
    if (dispositions[itemRef]?.status !== "reject") return;
    rejectedAliases.add(opRef(index));
    if (entityOp.ref) rejectedAliases.add(entityOp.ref);
    if (isFirst) rejectedAliases.add(PRIMARY_REF);
    if (entityOp.existingEntityId)
      rejectedAliases.add(entityOp.existingEntityId);
  });

  // Pass B — rebuild the op list applying reject/edit + cascade.
  let relOrdinal = 0;
  const filtered: CompositeProposalOperation[] = [];
  operations.forEach((op, index) => {
    if (op.op === "create_entity") {
      const entityOp = op as CompositeCreateEntityOp;
      const itemRef = entityOp.ref ?? opRef(index);
      const disp = dispositions[itemRef];
      if (disp?.status === "reject") return; // dropped
      let next =
        disp?.status === "edit" && disp.edits
          ? applyEntityEdits(entityOp, disp.edits)
          : entityOp;
      // Cascade-drop facets whose contextRef points at a rejected entity.
      if (next.facets && next.facets.length > 0) {
        const keptFacets = next.facets.filter(
          (f) => !f.contextRef || !rejectedAliases.has(f.contextRef)
        );
        if (keptFacets.length !== next.facets.length) {
          next = { ...next, facets: keptFacets };
        }
      }
      filtered.push(next);
      return;
    }
    if (op.op === "create_relation") {
      const relOp = op as CompositeCreateRelationOp;
      const itemRef = `$rel${relOrdinal}`;
      relOrdinal++;
      if (dispositions[itemRef]?.status === "reject") return; // explicit reject
      // Cascade: an endpoint that is a rejected entity → drop this relation.
      if (
        rejectedAliases.has(relOp.sourceRef) ||
        rejectedAliases.has(relOp.targetRef)
      ) {
        return;
      }
      filtered.push(relOp);
      return;
    }
    filtered.push(op);
  });

  // Invariant guard: no kept relation may still point at a rejected entity
  // alias (a cascade bug). Unreachable if pass B is correct; throws loudly
  // rather than letting a dangling ref reach materialize.
  for (const op of filtered) {
    if (op.op !== "create_relation") continue;
    const relOp = op as CompositeCreateRelationOp;
    if (
      rejectedAliases.has(relOp.sourceRef) ||
      rejectedAliases.has(relOp.targetRef)
    ) {
      throw new Error(
        "applyGraphDispositions: dangling relation endpoint survived cascade-reject"
      );
    }
  }

  return filtered;
}
