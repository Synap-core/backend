/**
 * THE REQUIREMENT SOURCE of the waiting-on collector (status-first wave,
 * research bf4dc995 option B step 5): "blocked because X is missing", for any
 * kind or role, DECLARED on its lifecycle (`LifecycleOption.requires`) and
 * DERIVED live here — never a stored "blocked" flag.
 *
 * For each asked thing (a kind: its `entities.status` on the kind's
 * lifecycle; a role: the facet's status on the role's lifecycle), the option
 * it stands in may require:
 *   · `link` — at least `min` relations of a type, `out` from the thing or
 *     `in` to it, counting only the other ends the reader may read;
 *   · `property` — a property present (or one of `in`) on the thing, or for
 *     a role on the role it wears first, then on the thing.
 * Each unmet one is a `requirement` source with its `blockerKey`, its
 * `clearedBy` and its owner's ball, which `deriveThingBlocker` orders with
 * every other wait.
 *
 * BATCHED: one read of the things, one of the facets (only when a role is
 * asked), one lifecycle resolution per (profile, space), and at most one
 * link count per direction for the whole set — never one per card. A set
 * with no option that requires anything reads the things and stops.
 *
 * Floored on the reader: a thing it may not read yields nothing; a facet is
 * read only on a thing it may read. THROWS on a failed read (the caller says
 * `unavailable`, never "not blocked").
 */
import {
  and,
  db,
  drizzleSql,
  entities,
  eq,
  inArray,
  isNull,
  ProfileResolutionService,
} from "@synap/database";
import { entityFacets, profiles, relations } from "@synap/database/schema";
import {
  findLifecycleOption,
  type LifecycleOptionRequirement,
} from "@synap-core/types/lifecycle";
import type { WaitingOnSource } from "@synap-core/types/units";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { isUuid } from "@synap-core/types/property-render";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";

/** One thing whose current step's requirements count: a kind, or a role it wears. */
export interface RequirementAsk {
  entityId: string;
  /** The role's facet: its status and the role's lifecycle are read. Absent = the kind's. */
  facetId?: string | null;
}

/** The key a requirement ask's sources are filed under. */
export const requirementAskKey = (a: RequirementAsk): string =>
  `${a.entityId}:${a.facetId ?? ""}`;

type LinkRequirement = Extract<LifecycleOptionRequirement, { kind: "link" }>;

/** A required property is met by any non-empty value, or by one of `in`. */
function propertyMet(value: unknown, allowed?: readonly string[]): boolean {
  const values = (Array.isArray(value) ? value : [value]).filter(
    (v) =>
      v !== null &&
      v !== undefined &&
      !(typeof v === "string" && v.trim() === "")
  );
  if (values.length === 0) return false;
  if (!allowed) return true;
  return values.some(
    (v) =>
      (typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean") &&
      allowed.includes(String(v).trim())
  );
}

/** Each asked thing's unmet requirements, keyed by {@link requirementAskKey}. THROWS. */
export async function readRequirementSources(
  userId: string,
  asks: readonly RequirementAsk[]
): Promise<Map<string, WaitingOnSource[]>> {
  const out = new Map<string, WaitingOnSource[]>();
  const unique = [
    ...new Map(
      asks
        .filter(
          (a) => isUuid(a.entityId) && (a.facetId == null || isUuid(a.facetId))
        )
        .map((a) => [requirementAskKey(a), a])
    ).values(),
  ];
  if (unique.length === 0) return out;

  const entityIds = [...new Set(unique.map((a) => a.entityId))];
  const facetIds = [
    ...new Set(unique.flatMap((a) => (a.facetId ? [a.facetId] : []))),
  ];
  const [things, facets] = await Promise.all([
    db
      .select({
        id: entities.id,
        status: entities.status,
        profileId: entities.profileId,
        workspaceId: entities.workspaceId,
        properties: entities.properties,
        profileSlug: profiles.slug,
      })
      .from(entities)
      .leftJoin(profiles, eq(profiles.id, entities.profileId))
      .where(
        and(
          inArray(entities.id, entityIds),
          isNull(entities.deletedAt),
          entityReadVisibleWhere(userId)
        )
      ),
    facetIds.length
      ? db
          .select({
            id: entityFacets.id,
            entityId: entityFacets.entityId,
            profileId: entityFacets.profileId,
            workspaceId: entityFacets.workspaceId,
            status: entityFacets.status,
            properties: entityFacets.properties,
          })
          .from(entityFacets)
          .where(inArray(entityFacets.id, facetIds))
      : Promise.resolve([]),
  ]);
  const thingOf = new Map(things.map((t) => [t.id, t]));
  const facetOf = new Map(facets.map((f) => [f.id, f]));

  const resolver = new ProfileResolutionService(db);
  const lifecycles = new Map<
    string,
    ReturnType<typeof resolver.getEffectiveLifecycle>
  >();
  const lifecycleOf = (profileId: string, workspaceId: string | null) => {
    const key = `${profileId}|${workspaceId ?? ""}`;
    let read = lifecycles.get(key);
    if (!read) {
      read = resolver.getEffectiveLifecycle(profileId, workspaceId);
      lifecycles.set(key, read);
    }
    return read;
  };

  // What each ask must have, and the property requirements judged at once.
  const pending: Array<{
    key: string;
    entityId: string;
    requirement: LifecycleOptionRequirement;
    met: boolean | null; // null = a link, counted below
  }> = [];
  for (const a of unique) {
    const thing = thingOf.get(a.entityId);
    if (!thing) continue; // gone, or one the reader may not read
    const facet = a.facetId ? facetOf.get(a.facetId) : undefined;
    if (a.facetId && (!facet || facet.entityId !== thing.id)) continue;
    const profileId = facet ? facet.profileId : thing.profileId;
    const status = facet ? facet.status : thing.status;
    if (!profileId || !status) continue;
    const lifecycle = await lifecycleOf(
      profileId,
      facet ? (facet.workspaceId ?? thing.workspaceId) : thing.workspaceId
    );
    const requires = lifecycle
      ? findLifecycleOption(lifecycle, status)?.requires
      : undefined;
    if (!requires?.length) continue;
    const own = (thing.properties ?? {}) as Record<string, unknown>;
    const worn = (facet?.properties ?? {}) as Record<string, unknown>;
    for (const r of requires) {
      if (
        r.forKinds &&
        !(thing.profileSlug && r.forKinds.includes(thing.profileSlug))
      )
        continue;
      // A role's own value first (it is what the role wears), else the thing's.
      const met =
        r.kind === "property"
          ? propertyMet(
              propertyMet(worn[r.property])
                ? worn[r.property]
                : own[r.property],
              r.in
            )
          : null;
      pending.push({
        key: requirementAskKey(a),
        entityId: thing.id,
        requirement: r,
        met,
      });
    }
  }

  const links = pending.filter(
    (p): p is typeof p & { requirement: LinkRequirement } =>
      p.requirement.kind === "link"
  );
  const counts = await countLinks(
    userId,
    links.map((p) => ({ entityId: p.entityId, ...p.requirement }))
  );
  for (const p of pending) {
    const r = p.requirement;
    const met =
      r.kind === "link"
        ? (counts.get(linkKey(p.entityId, r.relation, r.direction)) ?? 0) >=
          (r.min ?? 1)
        : p.met;
    if (met) continue;
    const list = out.get(p.key) ?? [];
    list.push({
      kind: "requirement",
      owner: r.owner ?? "you",
      blockerKey: r.blockerKey,
      ...(r.clearedBy ? { clearedBy: r.clearedBy } : {}),
      ref: { kind: "thing", label: r.label ?? humanizeToken(r.blockerKey) },
    });
    out.set(p.key, list);
  }
  return out;
}

const linkKey = (entityId: string, relation: string, direction: string) =>
  `${entityId}|${relation}|${direction}`;

/**
 * How many relations of each asked (thing, type, direction) exist whose
 * OTHER end is a live entity the reader may read: one grouped read per
 * direction for the whole set. THROWS.
 */
async function countLinks(
  userId: string,
  asked: ReadonlyArray<{
    entityId: string;
    relation: string;
    direction: "out" | "in";
  }>
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const reads = (["out", "in"] as const).map(async (direction) => {
    const mine = asked.filter((a) => a.direction === direction);
    if (mine.length === 0) return;
    const thingCol =
      direction === "out" ? relations.sourceEntityId : relations.targetEntityId;
    const otherCol =
      direction === "out" ? relations.targetEntityId : relations.sourceEntityId;
    const rows = await db
      .select({
        thingId: thingCol,
        type: relations.type,
        n: drizzleSql<number>`count(*)::int`,
      })
      .from(relations)
      .innerJoin(entities, eq(entities.id, otherCol))
      .where(
        and(
          eq(relations.sourceKind, "entity"),
          eq(relations.targetKind, "entity"),
          inArray(thingCol, [...new Set(mine.map((a) => a.entityId))]),
          inArray(relations.type, [...new Set(mine.map((a) => a.relation))]),
          isNull(entities.deletedAt),
          entityReadVisibleWhere(userId)
        )
      )
      .groupBy(thingCol, relations.type);
    for (const r of rows) {
      if (!r.thingId) continue;
      out.set(linkKey(r.thingId, r.type, direction), Number(r.n));
    }
  });
  await Promise.all(reads);
  return out;
}
