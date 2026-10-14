/**
 * `statusMove` — a lifecycle move proposal (`entity.transition`) read as the
 * move ON the object: which status property, from what to what (each with the
 * kind's own label and category), on which subject.
 *
 * WHY. The stored payload is `{ entityId, role, facetId, property,
 * expectedFrom, to }` — raw option keys. A card that shows "Move · Lead Acme ·
 * Qualified → Won" needs the labels and categories the KIND declares (its
 * lifecycle), which no client can read off the row.
 *
 * SOURCE. The lifecycle comes from `resolveStatusMoveTarget` — the SAME
 * resolution the move door (`moveStatus`) governs and applies with, so the
 * card and the door can never disagree on what an option means. `from` is the
 * belief the proposal was filed against (`expectedFrom`), never the live
 * value, which on a decided row is already the `to`.
 *
 * VISIBILITY. The caller passes the subject only when the viewer may read the
 * entity under the proposal's lens; no subject ⇒ no `statusMove`.
 */

import { db, resolveStatusMoveTarget, findLifecycleOption } from "@synap/database";
import type { EffectiveLifecycle, LifecycleCategory } from "@synap/database";
import { resolveProposalAction } from "@synap-core/types/proposals";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";

export interface ProposalStatusOption {
  key: string;
  /** The option's authored label, else the vocabulary's. */
  label: string;
  /** Absent when the key is not an option of the lifecycle (a stale belief). */
  category?: LifecycleCategory;
}

export interface ProposalStatusMove {
  /** The lifecycle property's slug. */
  property: string;
  /**
   * The status the proposal believed it moved FROM. `null` = no status yet (an
   * initial status). Absent = unknown (a row filed before `expectedFrom`).
   */
  from?: ProposalStatusOption | null;
  to: ProposalStatusOption;
  /** The role slug for a facet move, else the entity's kind (profile slug). */
  subjectKind: string | null;
  subjectName: string | null;
}

export interface StatusMoveCandidate {
  proposalType: string;
  /** The stored envelope (`proposals.data`) — `resolveProposalAction` reads it. */
  envelope: unknown;
  /** The move payload (`request.data`). */
  payload: Record<string, unknown> | undefined;
  /** The entity the row targets (`request.targetId`) when the payload has none. */
  targetId: string;
  workspaceId: string | null;
  /** The subject as the viewer may read it under this row's lens; absent ⇒ skip. */
  subject?: { name: string | null };
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

function optionOf(
  lifecycle: EffectiveLifecycle,
  key: string
): ProposalStatusOption {
  const option = findLifecycleOption(lifecycle, key);
  return {
    key,
    label: str(option?.label) ?? resolveStatusLabel(key),
    ...(option ? { category: option.category } : {}),
  };
}

/** Is this row a lifecycle move? The one verb reading (`resolveProposalAction`). */
export function isStatusMoveRow(
  proposalType: string,
  envelope: unknown
): boolean {
  return (
    resolveProposalAction({
      proposalType,
      data: envelope as Record<string, unknown> | undefined,
    }) === "move"
  );
}

/** One lifecycle resolution per distinct target on the page. */
export async function resolveStatusMoves(
  candidates: StatusMoveCandidate[]
): Promise<Array<ProposalStatusMove | undefined>> {
  const plans = candidates.map((c) => {
    if (!c.subject || !isStatusMoveRow(c.proposalType, c.envelope)) return null;
    const entityId = str(c.payload?.entityId) ?? str(c.targetId);
    const to = str(c.payload?.to);
    if (!entityId || !to) return null;
    const role = str(c.payload?.role);
    const facetId = str(c.payload?.facetId);
    return {
      key: [entityId, role ?? "", facetId ?? "", c.workspaceId ?? ""].join("|"),
      target: { entityId, role, facetId, workspaceId: c.workspaceId },
      to,
      hasFrom: !!c.payload && "expectedFrom" in c.payload,
      from: str(c.payload?.expectedFrom),
      subjectName: c.subject.name,
    };
  });

  const resolved = new Map<
    string,
    Awaited<ReturnType<typeof resolveStatusMoveTarget>>
  >();
  await Promise.all(
    [...new Map(plans.flatMap((p) => (p ? [[p.key, p.target]] : []))).entries()].map(
      async ([key, target]) => {
        resolved.set(key, await resolveStatusMoveTarget(db, target));
      }
    )
  );

  return plans.map((plan) => {
    if (!plan) return undefined;
    const hit = resolved.get(plan.key);
    if (!hit?.ok) return undefined;
    const { lifecycle, role, entityType } = hit.target;
    return {
      property: lifecycle.propertySlug,
      ...(plan.hasFrom
        ? { from: plan.from ? optionOf(lifecycle, plan.from) : null }
        : {}),
      to: optionOf(lifecycle, plan.to),
      subjectKind: role ?? entityType ?? null,
      subjectName: plan.subjectName,
    };
  });
}
