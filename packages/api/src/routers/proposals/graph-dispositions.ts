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
// Type-only (erased at compile) — keeps this leaf DB-free at runtime while
// letting the composite property-reconciliation wiring reuse the exact slice type.
import type { PropertyDecisionMap } from "@synap/database";

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

/**
 * Composite property reconciliation — resolve each SURVIVING (non-rejected)
 * create_entity op to its item ref and its per-entity property-decision slice.
 *
 * The ref is `op.ref ?? opRef(index)` computed on the ORIGINAL `operations`, so
 * it is IDENTICAL to the key `dispositions`, `buildProposalGraph`, and the
 * review UI use — and it recovers the ref for ref-less (`$opN`) ops after the
 * disposition filter drops their original index. The returned array is in the
 * SAME order `applyGraphDispositions` emits surviving create_entity ops, so the
 * approve site can zip it 1:1 against `operationsToMaterialize`'s entity ops.
 *
 * A refused entity is skipped entirely (never reconciled, no def created); an
 * absent `propertyDecisionsByRef[ref]` slice yields `undefined` ⇒ the reconciler
 * applies its defaults for that entity, exactly like the single-entity path.
 *
 * Pure / DB-free (the `PropertyDecisionMap` import is type-only) so the ref
 * recovery — the one genuinely-new bit of composite honoring — is unit-testable.
 */
export function survivingEntityDecisionSlices(
  operations: CompositeProposalOperation[],
  dispositions: GraphDispositionMap | undefined,
  propertyDecisionsByRef: Record<string, PropertyDecisionMap> | undefined
): Array<{ ref: string; decisions: PropertyDecisionMap | undefined }> {
  const slices: Array<{
    ref: string;
    decisions: PropertyDecisionMap | undefined;
  }> = [];
  operations.forEach((op, index) => {
    if (op.op !== "create_entity") return;
    const ref = (op as CompositeCreateEntityOp).ref ?? opRef(index);
    if (dispositions?.[ref]?.status === "reject") return;
    slices.push({ ref, decisions: propertyDecisionsByRef?.[ref] });
  });
  return slices;
}

// ---------------------------------------------------------------------------
// Approve-time FACET channel (domain-agnostic). A caller may name the facets to
// attach to the entities a proposal creates:
//   - `facetsByRef` (composite) — a per-ref facet list, keyed by the SAME entity
//     ref (`op.ref ?? opRef(index)`) `dispositions`/`propertyDecisionsByRef` use.
//   - `facets` (single) — the flat list for a single `entity/create` approval.
// This is pure "attach the facets the caller NAMED to the refs the caller
// NAMED": no kind/relation knowledge, no defaults, no eligibility. The composite
// path folds the named facets onto the surviving create_entity ops' `.facets`
// before materialize (pass 1.5 does the attach); the single executor attaches
// them directly.
// ---------------------------------------------------------------------------

/** A facet to attach — the subset of `CompositeCreateEntityOp.facets`. */
export type FacetSpec = { profileSlug: string; status?: string };

/**
 * Per SURVIVING create_entity op, the caller-named facets to ADD — in the SAME
 * order `applyGraphDispositions`/`survivingEntityDecisionSlices` emit surviving
 * entity ops, so the approve site zips it 1:1 against `reconciledOperations`'
 * create_entity ops (recovering the ref for ref-less `$opN` ops after the
 * disposition filter dropped their original index). A rejected entity yields no
 * slice. A facet slug the op already declares — or a duplicate within the
 * caller's list — is dropped so it is never attached twice. Pure / DB-free.
 */
export function survivingEntityFacetSlices(
  operations: CompositeProposalOperation[],
  dispositions: GraphDispositionMap | undefined,
  facetsByRef: Record<string, FacetSpec[]> | undefined
): Array<{ ref: string; facets: FacetSpec[] }> {
  const isRejected = (ref: string) => dispositions?.[ref]?.status === "reject";
  const slices: Array<{ ref: string; facets: FacetSpec[] }> = [];
  operations.forEach((op, index) => {
    if (op.op !== "create_entity") return;
    const e = op as CompositeCreateEntityOp;
    const ref = e.ref ?? opRef(index);
    if (isRejected(ref)) return;
    const requested = facetsByRef?.[ref] ?? [];
    const seen = new Set<string>((e.facets ?? []).map((f) => f.profileSlug));
    const add = requested.filter((f) => {
      if (seen.has(f.profileSlug)) return false;
      seen.add(f.profileSlug);
      return true;
    });
    slices.push({ ref, facets: add });
  });
  return slices;
}

/**
 * Fold caller-named facets into surviving create_entity ops — zips `slices`
 * (surviving-entity order from `survivingEntityFacetSlices`) 1:1 against
 * `operations`' create_entity ops (also surviving order), appending each slice's
 * facets to the op's `.facets`. Right before `materializeCompositeGraph` (its
 * pass 1.5 attaches them via the wired facetCaller). Pure.
 */
export function foldFacetsIntoOps(
  operations: CompositeProposalOperation[],
  slices: Array<{ ref: string; facets: FacetSpec[] }>
): CompositeProposalOperation[] {
  let entityIdx = 0;
  return operations.map((op) => {
    if (op.op !== "create_entity") return op;
    const add = slices[entityIdx++]?.facets ?? [];
    if (add.length === 0) return op;
    const e = op as CompositeCreateEntityOp;
    return { ...e, facets: [...(e.facets ?? []), ...add] };
  });
}
