/**
 * Forward-only role stage advance — a composite op's
 * `facets[].advanceExisting` (W15: a Cal.com booking moves a lead to
 * `engaged`).
 *
 * A re-attach of a role the entity already wears returns the existing facet
 * UNCHANGED (`FacetRepository.attach`), so a lead at `qualified` stays
 * `qualified` by construction. This module covers the other half: a role found
 * at an EARLIER stage moves forward to the op's `status` through the ONE facet
 * door (`entities.updateFacet`, which routes a declared lifecycle through
 * `moveStatus` with `expectedStatus` as its compare-and-set). Never backwards,
 * never out of a later option (a `disqualified` lead is not resurrected).
 *
 * "Earlier" is the option order of the role's lifecycle; for a role whose
 * lifecycle is not declared yet, the order of the select the op itself writes
 * (the property whose value is the op's `status`). Anything it cannot judge —
 * no order, an unknown current value — is left where it is.
 */
import { db, ProfileResolutionService } from "@synap/database";

/** Strictly later in `order`? An absent `from` sits before every option. */
export function isForwardStage(
  order: readonly string[],
  from: string | null | undefined,
  to: string
): boolean {
  const toIdx = order.indexOf(to);
  if (toIdx < 0) return false;
  if (from == null || from === "") return true;
  const fromIdx = order.indexOf(from);
  return fromIdx >= 0 && fromIdx < toIdx;
}

export interface AdvanceableFacet {
  id: string;
  profileId: string;
  workspaceId?: string | null;
  status?: string | null;
  properties?: Record<string, unknown> | null;
}

export interface FacetAdvanceSpec {
  status: string;
  properties?: Record<string, unknown>;
}

/** The role's stage order, the slug that carries it, and where the facet stands. */
export async function readRoleStage(
  facet: AdvanceableFacet,
  target: FacetAdvanceSpec
): Promise<{ order: string[]; slug: string; current: string | null } | null> {
  const resolver = new ProfileResolutionService(db);
  const props = facet.properties ?? {};
  const lifecycle = await resolver.getEffectiveLifecycle(
    facet.profileId,
    facet.workspaceId ?? null
  );
  if (lifecycle) {
    const slug = lifecycle.propertySlug;
    const fromProps = props[slug];
    return {
      order: lifecycle.options.map((o) => o.key),
      slug,
      current:
        facet.status ?? (typeof fromProps === "string" ? fromProps : null),
    };
  }
  const defs = await resolver.getEffectiveProperties(
    facet.profileId,
    facet.workspaceId ?? null
  );
  for (const [slug, value] of Object.entries(target.properties ?? {})) {
    if (value !== target.status) continue;
    const def = defs.find((d) => d.slug === slug);
    const order = (def?.constraints as { enum?: unknown } | null)?.enum;
    if (!Array.isArray(order) || !order.includes(target.status)) continue;
    const fromProps = props[slug];
    return {
      order: order.filter((k): k is string => typeof k === "string"),
      slug,
      // Undeclared: the select is the truth the readers use, the column a copy.
      current:
        typeof fromProps === "string" ? fromProps : (facet.status ?? null),
    };
  }
  return null;
}

export type FacetUpdateCaller = {
  updateFacet: (input: any) => Promise<any>;
};

/**
 * Move `facet` forward to `target.status` when it sits earlier; otherwise do
 * nothing. Returns what happened so the caller can report it.
 */
export async function advanceExistingFacet(
  caller: FacetUpdateCaller,
  facet: AdvanceableFacet,
  target: FacetAdvanceSpec,
  source?: string
): Promise<"advanced" | "proposed" | "kept" | "unjudged"> {
  const stage = await readRoleStage(facet, target);
  if (!stage) return "unjudged";
  if (!isForwardStage(stage.order, stage.current, target.status)) {
    return "kept";
  }
  const result = await caller.updateFacet({
    facetId: facet.id,
    status: target.status,
    expectedStatus: stage.current,
    properties: { [stage.slug]: target.status },
    ...(source ? { source } : {}),
  });
  return (result as { status?: string } | undefined)?.status === "proposed"
    ? "proposed"
    : "advanced";
}
