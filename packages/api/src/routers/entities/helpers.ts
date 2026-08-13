/**
 * Entities Router — shared helpers (Wave 3 router-decomposition).
 *
 * LEAF module: visibility predicates, the entity/facet response codecs, the
 * facet side-effect emitter, and the profile-count aggregator shared by
 * `entities/read.ts`, `entities/create.ts`, `entities/facets.ts`,
 * `entities/mutate.ts`, and the `entities.ts` barrel (for `get`). Never
 * imports the router itself.
 */

import { z } from "zod";
import {
  db,
  eq,
  and,
  or,
  isNull,
  loadFacetSlugsBatch,
  loadFacetRowsBatch,
  type FacetRowAnnotation,
  type FacetVisibilityScope,
  facetVisibilityConditions,
  drizzleSql,
} from "@synap/database";
import { entities, profiles, entityFacets } from "@synap/database/schema";
import { type Entity } from "@synap-core/types";
import { entityToWire } from "../hub-protocol/rest/_codecs/entity.js";
import { emitSideEffects, type SideEffectPayload } from "@synap/events";
import { accessScopeWhere } from "../../utils/project-scope.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";

/**
 * Merge a patch into an entity's `system_data` JSONB bag.
 *
 * `system_data` is SHARED system-managed state — `viewMode`, `bentoViewId`,
 * `onboardingScaffold`, `mergedInto`, `renderer`, … A wholesale
 * `.set({ systemData: { ...patch } })` silently destroys every key the caller
 * did not happen to know about. Every writer must go through this merge.
 *
 * A `null`/`undefined` patch value DELETES the key (clearing an override must
 * not leave a `renderer: null` tombstone that readers then have to special-case).
 *
 * Exported for the merge-preservation test; not part of the tRPC surface.
 */
export function mergeSystemData(
  current: unknown,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const base: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }

  return base;
}

/**
 * SECURITY — the accepted shape for a PER-ENTITY renderer override.
 *
 * `RendererTarget` (`@synap-core/renderer-runtime`) has 7 variants, two of which
 * (`iframe-srcdoc`, `url`) carry arbitrary, attacker-controllable content into a
 * rendering surface. The PROFILE door (`profiles.setProfileRendererOverride` →
 * `RendererRefSchema`) accepts the wider union deliberately: a profile renderer
 * is a workspace-schema-level artifact, set once by a workspace admin and
 * reviewed like a schema change.
 *
 * A PER-ENTITY renderer is a different risk class: it is set per row and is
 * reachable from every entity-shaped write path (AI capture, import, MCP), so it
 * is a far cheaper injection point. This door therefore accepts ONLY a `cell`
 * ref — a registered cell key resolved through `cellRegistry`, which cannot
 * smuggle markup or a remote origin. If a per-entity `url`/`iframe-srcdoc` is
 * ever genuinely needed it must go through a cell that owns and sandboxes it.
 *
 * `.strict()` so an extra `srcdoc`/`url` field cannot ride along into JSONB.
 *
 * Exported for the narrowing test; not part of the tRPC surface.
 */
export const EntityRendererRefSchema = z
  .object({
    kind: z.literal("cell"),
    cellKey: z.string().min(1).max(200),
    props: z.record(z.string(), z.unknown()).optional(),
    title: z.string().max(500).optional(),
  })
  .strict();

// The entity user floor = the canonical DATA-table resolver (`accessScopeWhere`,
// no lens): pod-personal (NULL workspace, owner-gated) OR workspace-member access
// OR exposure membership (a PROJECT member via belongs_to_project OR a CLIENT via
// visible_to sees their anchor's exposed entities across workspaces). Delegating
// here converges entities onto the SAME resolver documents/the registry use —
// behaviour-identical to the prior hand-rolled union (proven equivalent: same
// three branches, same default EXPOSURE_RELATION_TYPES whitelist).
export function entityWriteVisibleWhere(userId: string) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
  });
}

// READ variant of the entity floor — the SAME resolver as above PLUS the
// role-as-lens branch (a pod-wide entity is visible when it carries a facet in a
// workspace the caller is a member of). Used ONLY on READ paths (get/list/search/
// context); the mutation & dedup EXISTENCE gates keep `entityWriteVisibleWhere` (no
// facetLens) so that widening what a member can SEE never widens what they can
// TARGET for a write — write-targetability stays exactly as before.
export function entityReadVisibleWhere(userId: string) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    facetLens: true,
  });
}

// The read floor UNDER a workspace/pod lens. Routed through the one door so the
// 3-state lens + `includePodWide` union AND the role-as-lens widening are all
// expressed by `accessScopeWhere` params (never a hand-rolled predicate):
//   lens undefined → user-wide floor (+ role-lens)
//   lens null      → pod-personal only (owner-gated; role-lens AND-ed out)
//   lens "<id>"    → that workspace + entities role-attached there
//                    (+ pod-wide globals when includePodWide)
export function entityLensWhere(
  userId: string,
  lens?: string | null,
  opts?: { includePodWide?: boolean }
) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    workspaceLens: lens,
    facetLens: true,
    includeGlobalsInLens: opts?.includePodWide ?? false,
  });
}

/**
 * Standard entity shape for API responses.
 *
 * Uses `entityToWire` (the single canonical entity codec used by Hub Protocol REST)
 * to normalize properties / systemData / profileSlug, then layers on the file fields
 * the existing tRPC consumers expect. Keeping the wrapper preserves the long-standing
 * `Entity` shape (`type` field instead of `profileSlug`) plus the explicit null
 * file fields, while routing the source-of-truth normalization through the codec.
 */
export function toApiEntity(
  entity: any,
  facetSlugs?: string[],
  facets?: FacetRowAnnotation[]
): Entity {
  // Defer to the canonical codec for shape normalization. We then spread the
  // original DB row over the result so any tRPC-only fields (profileId, version,
  // deletedAt, etc.) that don't exist on the wire shape are preserved verbatim
  // for the Entity Zod schema.
  const wire = entityToWire(entity);
  return {
    ...entity,
    profileSlug: wire.profileSlug,
    type: wire.type,
    properties: wire.properties,
    systemData: wire.systemData ?? {},
    fileUrl: null,
    filePath: null,
    fileSize: null,
    fileType: null,
    checksum: null,
    // Kind + Facets: role "hats" the entity wears. Only attached when the caller
    // batch-resolved them (via toApiEntitiesWithFacets) and the entity has ≥1.
    ...(facetSlugs && facetSlugs.length > 0 ? { facetSlugs } : {}),
    // Rich facet rows (slug + overlay properties/status). Only attached when the
    // caller opted in (via toApiEntitiesWithFacetRows) and the entity has ≥1 —
    // so the default response shape is untouched.
    ...(facets && facets.length > 0 ? { facets } : {}),
  } as Entity;
}

/**
 * Map a page of entity rows to API entities WITH their role-facet hats
 * (`facetSlugs`), resolved in ONE batched facet load for the whole page — never
 * N+1. The lightest annotation: role slugs only, so a list/search card can chip
 * the hats (display name / color come from the profile catalog it already
 * holds). Rows wearing no role simply carry no `facetSlugs`.
 */
export async function toApiEntitiesWithFacets(
  rows: any[],
  visibility: FacetVisibilityScope
): Promise<Entity[]> {
  if (rows.length === 0) return [];
  const slugsById = await loadFacetSlugsBatch(
    db,
    rows.map((r) => r.id),
    visibility
  );
  return rows.map((r) => toApiEntity(r, slugsById.get(r.id)));
}

/**
 * Rich sibling of {@link toApiEntitiesWithFacets}: annotates a page with the
 * FULL facet rows (`facets` — slug + overlay `properties`/`status`) in ONE
 * batched load, for callers that opted in via `includeFacets: true`.
 *
 * Emits `facetSlugs` TOO, derived from the very same rows: the opt-in is purely
 * ADDITIVE, so a page that asks for the overlay still feeds the six consumers
 * that read the cheap slug annotation (role chips, graph adapters,
 * view-renderer, …). `loadFacetRowsBatch` is the same join under the same lens
 * as `loadFacetSlugsBatch`, so the derived slugs are identical to what the
 * default path would have produced — the opt-in only ADDS `facets`.
 */
export async function toApiEntitiesWithFacetRows(
  rows: any[],
  visibility: FacetVisibilityScope
): Promise<Entity[]> {
  if (rows.length === 0) return [];
  const facetsById = await loadFacetRowsBatch(
    db,
    rows.map((r) => r.id),
    visibility
  );
  return rows.map((r) => {
    const facets = facetsById.get(r.id);
    return toApiEntity(
      r,
      facets?.map((f) => f.slug),
      facets
    );
  });
}

// ── Built-in per-profile bento templates ──────────────────────────────────
// Provide richer defaults than the generic 3-widget layout for common profiles.
// Workspace settings (profileEntityBentoTemplates) override these.
export const DEFAULT_ENTITY_BENTO_TEMPLATES: Record<
  string,
  Array<Record<string, unknown>>
> = {
  event: [
    {
      id: "entity-header",
      kind: "widget",
      widgetType: "entity-header",
      pos: { x: 0, y: 0, w: 12, h: 2 },
    },
    {
      id: "entity-props",
      kind: "widget",
      widgetType: "entity-properties",
      pos: { x: 0, y: 2, w: 4, h: 6 },
    },
    {
      id: "linked-notes",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 4, y: 2, w: 4, h: 6 },
      config: { profileSlug: "note", title: "Notes" },
    },
    {
      id: "linked-tasks",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 8, y: 2, w: 4, h: 6 },
      config: { profileSlug: "task", title: "Tasks" },
    },
    {
      id: "linked-docs",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 0, y: 8, w: 6, h: 4 },
      config: { profileSlug: "file", title: "Documents" },
    },
    {
      id: "all-links",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 6, y: 8, w: 6, h: 4 },
    },
  ],
  project: [
    {
      id: "entity-header",
      kind: "widget",
      widgetType: "entity-header",
      pos: { x: 0, y: 0, w: 12, h: 2 },
    },
    {
      id: "entity-props",
      kind: "widget",
      widgetType: "entity-properties",
      pos: { x: 0, y: 2, w: 4, h: 6 },
    },
    {
      id: "linked-tasks",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 4, y: 2, w: 8, h: 6 },
      config: { profileSlug: "task", title: "Tasks" },
    },
    {
      id: "linked-notes",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 0, y: 8, w: 6, h: 4 },
      config: { profileSlug: "note", title: "Notes" },
    },
    {
      id: "linked-docs",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 6, y: 8, w: 6, h: 4 },
      config: { profileSlug: "file", title: "Documents" },
    },
  ],
};

/**
 * Source-of-action enum shared by the facet mutations. Mirrors the entity
 * create/update enums so Hub / CLI / connector provenance flows through the
 * governance gate unchanged (`source` is audit-only; it never gates auth).
 */
export const FACET_SOURCE_ENUM = z
  .enum([
    "user",
    "ai",
    "intelligence",
    "system",
    "agent",
    "openwebui-pipeline",
    "extension",
    "cli",
    "n8n",
    "raycast",
  ])
  .optional();

/**
 * Automation chain-tracking context, mirroring `SideEffectPayload["automationContext"]`.
 * Accepted as an optional input field on the facet doors so an automation-triggered
 * facet write threads its chainDepth into the cycle guard instead of restarting at 0.
 */
export const AUTOMATION_CONTEXT_INPUT = z
  .object({
    automationRunId: z.string(),
    automationId: z.string(),
    chainDepth: z.number(),
    rootRunId: z.string().optional(),
    chainAutomationIds: z.array(z.string()).optional(),
  })
  .optional();

/**
 * Bounded-concurrency guard for the fire-and-forget `registerIdentitySignals`
 * calls below. entities.create/update never await signal registration (it
 * must not add latency to the normal single-capture path), but a bulk import
 * fans out one entities.create call per row via createCaller — with nothing
 * capping it, N rows means N concurrent inserts piling onto the pool at once.
 * Cap in-flight signal writes; anything past the cap queues instead of firing
 * immediately, so single-capture latency (well under the cap) is unaffected.
 */
const MAX_INFLIGHT_SIGNAL_WRITES = 25;
let inFlightSignalWrites = 0;
const signalWriteQueue: Array<() => void> = [];

export function runSignalWrite(task: () => Promise<void>): void {
  const start = () => {
    inFlightSignalWrites++;
    // Promise.resolve().then(task): a synchronous throw from task() would
    // otherwise skip .finally() and leak the counter — 25 leaks and every
    // future signal write queues forever.
    Promise.resolve()
      .then(task)
      .catch(() => {})
      .finally(() => {
        inFlightSignalWrites--;
        signalWriteQueue.shift()?.();
      });
  };
  if (inFlightSignalWrites < MAX_INFLIGHT_SIGNAL_WRITES) {
    start();
  } else {
    signalWriteQueue.push(start);
  }
}

/** Look up a role-profile's slug for facet emit payloads (best-effort). */
export async function resolveFacetProfileSlug(
  profileId: string
): Promise<string | undefined> {
  const row = await db.query.profiles.findFirst({
    where: eq(profiles.id, profileId),
    columns: { slug: true },
  });
  return row?.slug ?? undefined;
}

/**
 * Emit the side-effect chain for a facet write. Facet writes fire NOTHING by
 * default — the search-index/embedding reactors key on `subjectType === "entity"`
 * and the automation matcher requires a truthy workspaceId — so a bare facet
 * INSERT leaves Typesense, vectors, and automations stale. Two emits close that:
 *
 *   1. The facet event itself (`subjectType: "entity_facet"`) — drives webhook
 *      delivery and the automation-trigger matcher (when a workspace lens exists),
 *      so automations can trigger on facet attach/update/detach.
 *   2. A parent-entity `update` refresh (`subjectType: "entity"`, subjectId =
 *      parent entityId) — REUSES the existing entity reactors (search-index +
 *      entity-embedding + cross-thread-notify + automation-trigger-match) so the
 *      parent's Typesense doc + vector + entity-scoped automations reflect the
 *      facet. This is the smaller, clearer change than teaching the shared
 *      search/embedding reactors about a new 'entity_facet' subject type — it
 *      produces the SAME jobs an `entities.update` would (reactors #1 and #2).
 */
export function emitFacetSideEffects(opts: {
  action: "attach" | "update" | "detach";
  entityId: string;
  facetId: string;
  profileSlug?: string;
  status?: string | null;
  changedKeys?: string[];
  userId: string;
  workspaceId: string | null;
  sessionId?: string | null;
  /** Parent entity title — threaded through so proposal/notification cards read human-friendly text. */
  entityTitle?: string | null;
  contextEntityTitle?: string | null;
  /** Automation chain tracking — mirrors entity mutations so the cycle guard sees the true chainDepth. */
  automationContext?: SideEffectPayload["automationContext"];
}): void {
  const commonWs = opts.workspaceId;
  emitSideEffects({
    subjectType: "entity_facet",
    action: opts.action,
    subjectId: opts.facetId,
    userId: opts.userId,
    workspaceId: commonWs,
    sessionId: opts.sessionId ?? null,
    automationContext: opts.automationContext,
    data: {
      entityId: opts.entityId,
      facetId: opts.facetId,
      ...(opts.profileSlug ? { profileSlug: opts.profileSlug } : {}),
      ...(opts.status !== undefined && opts.status !== null
        ? { status: opts.status }
        : {}),
      ...(opts.changedKeys && opts.changedKeys.length > 0
        ? { changedKeys: opts.changedKeys }
        : {}),
      ...(opts.entityTitle ? { entityTitle: opts.entityTitle } : {}),
      ...(opts.contextEntityTitle
        ? { contextEntityTitle: opts.contextEntityTitle }
        : {}),
    },
  });
  // Parent-entity refresh — reuse the entity reactors (search + vector +
  // automations) so the parent reflects the facet change.
  emitSideEffects({
    subjectType: "entity",
    action: "update",
    subjectId: opts.entityId,
    userId: opts.userId,
    workspaceId: commonWs,
    sessionId: opts.sessionId ?? null,
    automationContext: opts.automationContext,
    data: {
      facetChange: true,
      facetAction: opts.action,
      facetId: opts.facetId,
      ...(opts.profileSlug ? { profileSlug: opts.profileSlug } : {}),
      ...(opts.entityTitle ? { entityTitle: opts.entityTitle } : {}),
    },
  });
}

/**
 * Count entities grouped by profile slug, under the caller's floor.
 *
 * ONE implementation behind BOTH altitudes (`countByProfile`, workspace-scoped,
 * and `countByProfileAll`, pod-capable) so a badge can never tell two stories:
 *
 *  - FLOOR (always applied): the canonical entity floor `entityWriteVisibleWhere`
 *    (`accessScopeWhere`, no lens) — a NULL-workspace row is OWNER-private, a
 *    workspace row needs membership/exposure. Plain `userVisibleWhere` is
 *    owner-BLIND on the NULL branch and would leak other users' pod-personal
 *    rows at pod altitude; that is why this never hand-rolls a predicate.
 *  - LENS (`workspaceId`): NARROWS the floor to that workspace + pod-wide
 *    (NULL-workspace) rows. It is ANDed with the floor, so an unverified
 *    caller-supplied workspaceId can never widen what the caller already sees.
 *    Omitted ⇒ the whole floor (every visible workspace + globals).
 *
 * The facet pass exists because a profile converted from a primary kind into an
 * attachable role no longer matches `entities.type` — its entities now carry it
 * as a live facet, so the kind count is 0 for that slug. Counting DISTINCT
 * entities per role-profile slug under the SAME lens keeps a role profile's
 * badge truthful after conversion. That pass goes through
 * `resolveFacetVisibilityScope` (which INTERSECTS an explicit lens with the
 * caller's access) + `facetVisibilityConditions`, the shared facet-read
 * predicate — `facetVisibilityConditions` does no membership check of its own.
 */
export async function countEntitiesByProfile(opts: {
  userId: string;
  workspaceId: string | null;
}): Promise<Record<string, number>> {
  const { userId, workspaceId } = opts;

  const entityFloor = entityWriteVisibleWhere(userId);
  const entityScope = workspaceId
    ? and(
        entityFloor,
        or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId))
      )
    : entityFloor;

  const rows = await db
    .select({
      profileSlug: entities.type,
      count: drizzleSql<number>`cast(count(*) as integer)`,
    })
    .from(entities)
    .where(and(entityScope, isNull(entities.deletedAt)))
    .groupBy(entities.type);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.profileSlug) {
      counts[row.profileSlug] = row.count;
    }
  }

  const facetVisibilityScope = await resolveFacetVisibilityScope(
    userId,
    workspaceId ?? undefined
  );

  const facetRows = await db
    .select({
      profileSlug: profiles.slug,
      count: drizzleSql<number>`cast(count(distinct ${entityFacets.entityId}) as integer)`,
    })
    .from(entityFacets)
    .innerJoin(profiles, eq(entityFacets.profileId, profiles.id))
    .where(
      and(
        isNull(entityFacets.deletedAt),
        ...facetVisibilityConditions(facetVisibilityScope)
      )
    )
    .groupBy(profiles.slug);

  for (const row of facetRows) {
    if (row.profileSlug) {
      counts[row.profileSlug] = (counts[row.profileSlug] ?? 0) + row.count;
    }
  }

  return counts;
}
