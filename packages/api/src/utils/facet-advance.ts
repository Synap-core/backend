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
 * "Earlier", for a DECLARED lifecycle, is the CATEGORY, never the position
 * (L1; review arch F7 / backend F14): `open` < `active` < `done`. A booking
 * moves an open lead (or one with no status) to engaged; an active one stays
 * (it is engaged at most); `done` / `lost` are never left; `paused` is a hold
 * a person set, so a booking leaves it too. Declaration order, an appended
 * option or a reorder change nothing. For a role whose lifecycle is not
 * declared yet, "earlier" is the order of the select the op itself writes (the
 * property whose value is the op's `status`). Anything it cannot judge — no
 * order, an unknown current value — is left where it is.
 */
import {
  db,
  ProfileResolutionService,
  type LifecycleCategory,
} from "@synap/database";

/** Which categories a forward-only advance may move between, in order. */
const FORWARD_RANK: Partial<Record<LifecycleCategory, number>> = {
  open: 0,
  active: 1,
  done: 2,
};

/**
 * Strictly forward by CATEGORY? An absent `from` sits before every option;
 * `paused` and `lost` (no rank) are never left, and never entered this way.
 */
export function isForwardCategory(
  categories: Readonly<Record<string, LifecycleCategory>>,
  from: string | null | undefined,
  to: string
): boolean {
  const toRank = categories[to] ? FORWARD_RANK[categories[to]] : undefined;
  if (toRank === undefined) return false;
  if (from == null || from === "") return true;
  const fromRank = categories[from]
    ? FORWARD_RANK[categories[from]]
    : undefined;
  return fromRank !== undefined && fromRank < toRank;
}

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
): Promise<{
  order: string[];
  slug: string;
  current: string | null;
  /** Declared lifecycle only: each option's category (the forward rule). */
  categories?: Record<string, LifecycleCategory>;
} | null> {
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
      categories: Object.fromEntries(
        lifecycle.options.map((o) => [o.key, o.category])
      ),
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
  const forward = stage.categories
    ? isForwardCategory(stage.categories, stage.current, target.status)
    : isForwardStage(stage.order, stage.current, target.status);
  if (!forward) {
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
