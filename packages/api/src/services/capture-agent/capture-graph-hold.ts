/**
 * capture-graph-hold — an item whose kind is not available where it would
 * land is HELD for review; its siblings still file (founder decision D2, plan
 * "proposal failures you can resolve" §A4, 2 Nov 2026).
 *
 * WHY. Live 2026-10-22 (proposal e8fc00d6): a 5-entity capture into Foundation
 * named the kind `trend`, which exists only in Ecosystem. Filing noted the
 * unknown kind and carried on, governance scored the item by its slug and let
 * the whole graph auto-apply, and the materializer then stopped at that item
 * — 3 pain points landed, the trend and its links did not, and nothing asked
 * anyone. The create door looks the kind up in the item's LANDING space
 * (`targetWorkspaceId ?? ctx.workspaceId`, routers/entities/create.ts); this
 * module is that same rule applied at filing time.
 *
 * HOW (the mechanism, and why not another). A capture graph is atomic: the
 * auto-apply terminal materializes ALL its ops under one `auto_approved`
 * receipt, and a receipt is not in anyone's review queue. There is no
 * per-item hold inside one proposal. So a held item (plus the relations that
 * touch it) is filed as its OWN pending `import.graph`, linked both ways to the
 * receipt (`data.heldFromProposalId` on the held proposal, `data.heldItems[]`
 * on the receipt). The pending proposal reuses everything a pending capture
 * already has: the review queue, revisions (an agent can fix the kind and the
 * revision is re-decided), approve/reject, the per-item editor.
 *
 * When the siblings would not auto-apply anyway (any member proposes, a plan,
 * a binding, a possible duplicate), the graph is filed pending as ONE
 * proposal, exactly as before, with `heldItems[]` naming what cannot file as
 * it stands. Splitting a graph that waits for a person anyway helps nobody.
 *
 * Pure: no database import (the lookups live in the submit core).
 */

import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { PRIMARY_REF } from "@synap-core/types/proposals";
import {
  kindMissingSentence,
  type KindMissingDetail,
} from "../../utils/kind-missing.js";
import { hasComposedSteps } from "./capture-plan.js";

type CreateEntityOp = Extract<
  CompositeProposalOperation,
  { op: "create_entity" }
>;
type CreateRelationOp = Extract<
  CompositeProposalOperation,
  { op: "create_relation" }
>;

/** The space a `create_entity` op lands in: the create door's own lens. */
export function landingWorkspaceOf(
  op: { targetWorkspaceId?: string },
  graphWorkspaceId: string | null
): string | null {
  return op.targetWorkspaceId ?? graphWorkspaceId ?? null;
}

/** A suggestion a caller can act on at once. */
export type HeldItemSuggestion = {
  action: "file_in_workspace";
  workspaceId: string;
  /** The space's name. */
  name: string;
};

/** One item held for review because its kind is not available where it lands. */
export interface HeldCaptureItem {
  /** The item's op ref in the graph. */
  ref: string;
  /** Its title (or ref). */
  label: string;
  profileSlug: string;
  /** Where it would have landed (the create door's lens). */
  workspaceId: string | null;
  /** Where the kind DOES exist, among spaces the caller can read. */
  kindMissing: KindMissingDetail;
  /** What the caller can do about it, best first. */
  suggestions: HeldItemSuggestion[];
  /** One plain sentence: what happened and what to do. */
  message: string;
  /** The pending proposal the item was filed in, when it was filed alone. */
  proposalId?: string;
  reviewUrl?: string;
  /**
   * Set when the item could NOT be filed for review (the agent's pending cap,
   * or the insert failed). The siblings still landed; resend the item.
   */
  notFiled?: string;
  /** Relations that touched the item and could not be carried with it. */
  droppedRelations?: Array<{
    sourceRef: string;
    targetRef: string;
    type: string;
  }>;
}

/**
 * The suggestions for a held item: the same kind in another space first
 * (nothing new is created). TODO(wave 2): rank further options — synonyms,
 * field overlap, title similarity — through `resolve-kind-rank.ts` once
 * `proposals.resolveOptions` is on main, so the capture reply and the review
 * page offer the same list.
 */
export function heldItemSuggestions(
  detail: KindMissingDetail
): HeldItemSuggestion[] {
  return detail.foundIn.map((f) => ({
    action: "file_in_workspace" as const,
    workspaceId: f.workspaceId,
    name: f.name,
  }));
}

/** The reply sentence for a held item, in plain words. */
export function heldItemMessage(
  label: string,
  detail: KindMissingDetail
): string {
  const why = kindMissingSentence(detail).replace(
    /^Couldn't file it — /,
    `"${label}" is held for review: `
  );
  const space = detail.workspaceName ?? "this space";
  const fix =
    detail.foundIn.length > 0
      ? ` To file it, set targetWorkspaceId to ${detail.foundIn[0]!.name} (${detail.foundIn[0]!.workspaceId}), or use a kind that exists in ${space}.`
      : ` To file it, use a kind that exists in ${space}, or define this kind there first.`;
  return `${why}${fix}`;
}

export function buildHeldCaptureItem(args: {
  ref: string;
  label: string;
  profileSlug: string;
  workspaceId: string | null;
  kindMissing: KindMissingDetail;
}): HeldCaptureItem {
  return {
    ...args,
    suggestions: heldItemSuggestions(args.kindMissing),
    message: heldItemMessage(args.label, args.kindMissing),
  };
}

/**
 * Which `create_entity` op index a ref denotes — the materializer's own
 * registration (`registerEntityRef`): the op's `ref`, its positional `$opN`
 * (N = its index in the ops array), or `$primary` (the first entity op).
 * `null` for a real entity UUID or an unknown ref.
 */
function entityOpIndexOf(
  operations: CompositeProposalOperation[],
  ref: string
): number | null {
  const byRef = operations.findIndex(
    (op) => op.op === "create_entity" && op.ref === ref
  );
  if (byRef >= 0) return byRef;
  const positional = /^\$op(\d+)$/.exec(ref);
  if (positional) {
    const i = Number(positional[1]);
    return operations[i]?.op === "create_entity" ? i : null;
  }
  if (ref === PRIMARY_REF) {
    const first = operations.findIndex((op) => op.op === "create_entity");
    return first >= 0 ? first : null;
  }
  return null;
}

export type HeldSplit =
  | {
      splittable: true;
      /** The ops that file now: every op not touching a held item. */
      applyOps: CompositeProposalOperation[];
      /** The held `create_entity` ops, unchanged. */
      heldEntityOps: CreateEntityOp[];
      /** Relations touching a held item, refs written as op refs. */
      heldRelations: CreateRelationOp[];
    }
  | { splittable: false; reason: string };

/**
 * Split a graph into what files now and what is held. Refs are rewritten to
 * each op's own `ref` first, because removing ops shifts every positional
 * `$opN`. Not splittable (the whole graph then waits as one proposal) when:
 * it carries plan or config steps (they reference entity refs in many
 * shapes), a sibling's role facet points at a held item, an entity op has no
 * `ref`, or nothing would be left to file.
 */
export function splitHeldItems(
  operations: CompositeProposalOperation[],
  heldRefs: ReadonlySet<string>
): HeldSplit {
  if (heldRefs.size === 0) {
    return { splittable: false, reason: "nothing is held" };
  }
  if (hasComposedSteps(operations)) {
    return { splittable: false, reason: "the graph carries plan steps" };
  }
  const entityOps = operations.filter(
    (op): op is CreateEntityOp => op.op === "create_entity"
  );
  if (entityOps.some((op) => !op.ref)) {
    return { splittable: false, reason: "an item has no ref" };
  }
  const heldIdx = new Set<number>();
  operations.forEach((op, i) => {
    if (op.op === "create_entity" && op.ref && heldRefs.has(op.ref)) {
      heldIdx.add(i);
    }
  });
  if (heldIdx.size === 0) {
    return { splittable: false, reason: "no held item is in the graph" };
  }
  if (heldIdx.size === entityOps.length) {
    return { splittable: false, reason: "every item is held" };
  }
  // Canonical ref: the op's own ref when the ref names an entity op of this
  // graph, else the literal (a real entity UUID).
  const canonical = (ref: string): { ref: string; idx: number | null } => {
    const idx = entityOpIndexOf(operations, ref);
    if (idx === null) return { ref, idx };
    return { ref: (operations[idx] as CreateEntityOp).ref!, idx };
  };

  const applyOps: CompositeProposalOperation[] = [];
  const heldEntityOps: CreateEntityOp[] = [];
  const heldRelations: CreateRelationOp[] = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    if (op.op === "create_entity") {
      if (heldIdx.has(i)) {
        heldEntityOps.push(op);
        continue;
      }
      const facetOnHeld = (op.facets ?? []).some((f) => {
        if (!f.contextRef) return false;
        const c = canonical(f.contextRef);
        return c.idx !== null && heldIdx.has(c.idx);
      });
      if (facetOnHeld) {
        return {
          splittable: false,
          reason: "a sibling's role points at a held item",
        };
      }
      applyOps.push({
        ...op,
        ...(op.facets
          ? {
              facets: op.facets.map((f) =>
                f.contextRef
                  ? { ...f, contextRef: canonical(f.contextRef).ref }
                  : f
              ),
            }
          : {}),
      });
      continue;
    }
    if (op.op === "create_relation") {
      const s = canonical(op.sourceRef);
      const t = canonical(op.targetRef);
      const rewritten = { ...op, sourceRef: s.ref, targetRef: t.ref };
      const touchesHeld =
        (s.idx !== null && heldIdx.has(s.idx)) ||
        (t.idx !== null && heldIdx.has(t.idx));
      (touchesHeld ? heldRelations : applyOps).push(rewritten);
      continue;
    }
    applyOps.push(op);
  }
  return { splittable: true, applyOps, heldEntityOps, heldRelations };
}

/**
 * The ops of the held proposal: the held items as they were sent, and their
 * relations with every endpoint that already landed written as its real id
 * (a relation ref may be a real entity UUID, so approving the held proposal
 * links to the rows the receipt created — nothing is created twice). A
 * relation whose landed endpoint has no id (it did not materialize) cannot
 * be carried and is returned in `dropped`.
 */
export function buildHeldProposalOperations(
  split: Extract<HeldSplit, { splittable: true }>,
  createdIdByRef: ReadonlyMap<string, string>
): {
  operations: CompositeProposalOperation[];
  dropped: CreateRelationOp[];
} {
  const heldRefs = new Set(split.heldEntityOps.map((op) => op.ref!));
  const siblingRefs = new Set(
    split.applyOps
      .filter((op): op is CreateEntityOp => op.op === "create_entity")
      .map((op) => op.ref!)
  );
  const relations: CreateRelationOp[] = [];
  const dropped: CreateRelationOp[] = [];
  for (const rel of split.heldRelations) {
    const endpoint = (ref: string): string | null => {
      if (heldRefs.has(ref)) return ref;
      if (siblingRefs.has(ref)) return createdIdByRef.get(ref) ?? null;
      return ref; // a real entity id, passed through
    };
    const sourceRef = endpoint(rel.sourceRef);
    const targetRef = endpoint(rel.targetRef);
    if (!sourceRef || !targetRef) {
      dropped.push(rel);
      continue;
    }
    relations.push({ ...rel, sourceRef, targetRef });
  }
  return { operations: [...split.heldEntityOps, ...relations], dropped };
}

/**
 * THE invariant (tripwire, A4): no op set handed to the auto-apply
 * materializer creates an item whose kind is unresolved where it lands.
 * Throws rather than filing a graph that is known to stop part-way.
 */
export function assertNoHeldItemAutoApplies(
  operations: CompositeProposalOperation[],
  heldRefs: ReadonlySet<string>
): void {
  for (const op of operations) {
    if (
      op.op === "create_entity" &&
      !op.existingEntityId &&
      op.ref &&
      heldRefs.has(op.ref)
    ) {
      throw new Error(
        `capture auto-apply: item "${op.ref}" (${op.profileSlug}) has a kind that does not resolve where it lands, and must be held for review, not applied`
      );
    }
  }
}
