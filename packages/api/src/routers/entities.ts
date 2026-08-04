/**
 * Entities Router - Profile-Based Entity Management
 *
 * Event-driven CRUD with audit trail:
 *   .requested → permission check → inline materialization → .completed
 * Proposal path (AI requiring review) defers to the materializer worker.
 *
 * Supports unfiled entities (workspaceId = null). A NULL-workspace entity is
 * OWNER-private by default (accessScopeWhere floors it to its creator), NOT
 * pod-wide — it becomes visible to a workspace's members only once it carries a
 * facet there (role-as-lens) or an exposure edge.
 */

import { z } from "zod";
import {
  router,
  workspaceProcedure,
  protectedProcedure,
  podProcedure,
  podAdminProcedure,
} from "../trpc.js";
import {
  db,
  eq,
  desc,
  and,
  or,
  ilike,
  isNull,
  inArray,
  getDb,
  ProfileResolutionService,
  eventRepository,
  EntityRepository,
  EntityBodyService,
  FacetRepository,
  getEffectiveFacets,
  loadFacetSlugsBatch,
  loadFacetRowsBatch,
  type FacetRowAnnotation,
  type FacetVisibilityScope,
  facetRoleExists,
  facetVisibilityConditions,
  profileSlugScopeConditionFromRows,
  drizzleSql,
  links,
  type LinkEndpointType,
  type LinkType,
  linkEntityToProject,
  stampProvenance,
  FacetProfileKindError,
  FacetKindMismatchError,
  extractIdentitySignals,
  registerIdentitySignals,
  resolveIdentity,
  IDENTITY_SIGNAL_PROPERTY_KEYS,
  resolveWorkspacePlacement,
  acceptDeterministicGraphWorkspace,
  resolveProjectPlacement,
  isDomainHomeWorkspace,
  normalizeEntityScope,
  DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE,
  shouldRejectJunkTitle,
  buildJunkTitleMessage,
  classifyWeakEntityDedup,
  buildWeakEntityDedupMessage,
  buildWeakDedupCause,
  ENTITY_JUNK_TITLE_CODE,
} from "@synap/database";
import {
  entities,
  views,
  workspaces,
  entityExternalLinks,
  profiles,
  profileWorkspaceAccess,
  entityFacets,
} from "@synap/database/schema";
import { type Entity, EntitySchema } from "@synap-core/types";
import { shouldMaterializeAsDocument } from "@synap-core/types/documents";
import { entityToWire } from "./hub-protocol/rest/_codecs/entity.js";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { assertKnownProfileSlug } from "../utils/assert-known-profile-slug.js";
import { resolveViewTrust } from "../services/view-trust-service.js";
import { auditLog } from "../utils/audit-log.js";
import { recordDomainMutation } from "../utils/domain-mutation.js";
import { emitAiCorrection } from "../utils/ai-feedback-events.js";
import { AI_KIND } from "../lib/ai-events.js";
import {
  emitSideEffects,
  getBoss,
  type SideEffectPayload,
} from "@synap/events";
import { randomUUID } from "crypto";
import { syncPropertyToRelations } from "../utils/property-relation-sync.js";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
import { dispatchWebhooksForEvent } from "../utils/webhook-delivery.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import {
  accessScopeWhere,
  projectLensWhere,
  facetInWorkspaceLensWhere,
} from "../utils/project-scope.js";
import { createLogger } from "@synap-core/core";
import { idempotencyWindowSeconds } from "../utils/write-door-idempotency.js";
import { resolveFacetVisibilityScope } from "../utils/workspace-membership.js";
import { canWriteFacet } from "../utils/facet-write-gate.js";

const logger = createLogger({ module: "entities-router" });

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
function entityWriteVisibleWhere(userId: string) {
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
function entityReadVisibleWhere(userId: string) {
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
function entityLensWhere(
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
function toApiEntity(
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
async function toApiEntitiesWithFacets(
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
async function toApiEntitiesWithFacetRows(
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
const DEFAULT_ENTITY_BENTO_TEMPLATES: Record<
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
const FACET_SOURCE_ENUM = z
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
const AUTOMATION_CONTEXT_INPUT = z
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

function runSignalWrite(task: () => Promise<void>): void {
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
async function resolveFacetProfileSlug(
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
function emitFacetSideEffects(opts: {
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

export const entitiesRouter = router({
  /**
   * Count entities grouped by profile slug.
   *
   * Returns a map of { [profileSlug]: count } for the active workspace
   * (including global entities). Useful for data-structure visualisation badges.
   */
  countByProfile: workspaceProcedure
    .output(
      z.object({
        counts: z.record(z.string(), z.number()),
      })
    )
    .query(async ({ ctx }) => {
      const rows = await db
        .select({
          profileSlug: entities.type,
          count: drizzleSql<number>`cast(count(*) as integer)`,
        })
        .from(entities)
        .where(
          and(
            // Pod-personal (workspaceId IS NULL) entities are per-user —
            // count only the caller's own globals, not all users' pod-personal rows.
            or(
              eq(entities.workspaceId, ctx.workspaceId),
              and(isNull(entities.workspaceId), eq(entities.userId, ctx.userId))
            ),
            isNull(entities.deletedAt)
          )
        )
        .groupBy(entities.type);

      const counts: Record<string, number> = {};
      for (const row of rows) {
        if (row.profileSlug) {
          counts[row.profileSlug] = row.count;
        }
      }

      // Kind + Facets: a profile converted from a primary kind into an
      // attachable role no longer matches `entities.type` — its entities now
      // carry it as a live facet, so the count above is 0 for that slug. Count
      // DISTINCT entities per role-profile slug (same workspace lens as the
      // kind counts) in ONE grouped query and merge, so a role profile keeps a
      // truthful badge instead of dropping to zero after conversion.
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
            or(
              eq(entityFacets.workspaceId, ctx.workspaceId),
              and(
                isNull(entityFacets.workspaceId),
                eq(entityFacets.userId, ctx.userId)
              )
            )
          )
        )
        .groupBy(profiles.slug);

      for (const row of facetRows) {
        if (row.profileSlug) {
          counts[row.profileSlug] = (counts[row.profileSlug] ?? 0) + row.count;
        }
      }

      return { counts };
    }),

  /**
   * Kanban aggregation for a role facet: group the entities wearing role
   * `roleSlug` by their facet `status`, returning per-status `count` + the
   * first `firstN` entity ids (newest first) — the smallest primitive a kanban
   * adapter needs to render columns without pulling every row.
   *
   * A SIBLING of `list` (not a mode on it): `list` is already overloaded
   * (polymorphic profileSlug, facet filter, project/workspace lens, pagination,
   * descendants) and returns a paginated ITEMS shape; a grouped shape would
   * fork its output type conditionally. This keeps `list`'s contract stable.
   *
   * ONE grouped query over `entity_facets ⋈ entities`, under the SAME lens as
   * the entity list: the facet visibility predicate (`facetVisibilityConditions`)
   * AND the entity floor (`entityWriteVisibleWhere`, the userVisibleWhere-based
   * access scope), plus an optional project narrow. A NULL facet status is its
   * own group (the kanban "no status" column).
   */
  groupByFacetStatus: podProcedure
    .input(
      z.object({
        roleSlug: z.string(),
        /** List lens; `undefined` → active workspace, `null` → pod-wide only. */
        workspaceId: z.string().uuid().nullable().optional(),
        /** Optional project narrow (pure narrowing, like `list`). */
        projectId: z.string().uuid().optional(),
        /** Max entity ids returned per status group (0 = counts only). */
        firstN: z.number().int().min(0).max(50).default(10),
      })
    )
    .output(
      z.object({
        roleSlug: z.string(),
        groups: z.array(
          z.object({
            status: z.string().nullable(),
            count: z.number(),
            ids: z.array(z.string()),
          })
        ),
      })
    )
    .query(async ({ input, ctx }) => {
      const lensWorkspaceId =
        input.workspaceId !== undefined ? input.workspaceId : ctx.workspaceId;
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        input.projectId ? undefined : lensWorkspaceId
      );

      // Resolve the role slug to its profile id(s) — every same-slug row (a
      // facet may sit on a system row OR a workspace-scope twin).
      //
      // FAIL CLOSED, same door as `list`/`search`/graph: a kanban mounted on a
      // slug this pod has no profile for (the `crm-lead`-against-a-`lead`-
      // workspace bug, which reproduces here verbatim) must get a typed error,
      // not empty columns indistinguishable from an empty pipeline.
      const roleProfiles = await assertKnownProfileSlug(db, input.roleSlug);
      const roleProfileIds = roleProfiles
        .filter((p) => p.profileKind === "role")
        .map((p) => p.id);
      if (roleProfileIds.length === 0) {
        // Slug EXISTS but names only primary kinds — a kind never carries
        // facets, so this grouping can never return anything. Same class of
        // caller error as an unknown slug; surface it rather than render
        // permanently empty columns.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `Profile "${input.roleSlug}" is a kind, not a role. ` +
            `groupByFacetStatus groups entities by their FACET status, so it ` +
            `only applies to role-profiles (profileKind: "role"). List the ` +
            `available roles (profiles.list) and use one of them.`,
        });
      }

      const conditions = [
        inArray(entityFacets.profileId, roleProfileIds),
        isNull(entityFacets.deletedAt),
        ...facetVisibilityConditions(facetVisibilityScope),
        isNull(entities.deletedAt),
        entityReadVisibleWhere(ctx.userId),
        ...(input.projectId
          ? [projectLensWhere(entities.id, input.projectId)]
          : []),
      ];

      // firstN is a zod-validated int (0..50) → safe to inline as an array-slice
      // literal (avoids a parameterised slice bound). array_agg newest-first,
      // sliced to firstN; 0 yields an empty slice (counts only).
      const rows = await db
        .select({
          status: entityFacets.status,
          count: drizzleSql<number>`cast(count(*) as integer)`,
          ids: drizzleSql<
            string[]
          >`(array_agg(${entities.id} ORDER BY ${entities.createdAt} DESC))[1:${drizzleSql.raw(String(input.firstN))}]`,
        })
        .from(entityFacets)
        .innerJoin(entities, eq(entities.id, entityFacets.entityId))
        .where(and(...conditions))
        .groupBy(entityFacets.status);

      return {
        roleSlug: input.roleSlug,
        groups: rows.map((r) => ({
          status: r.status ?? null,
          count: r.count,
          ids: r.ids ?? [],
        })),
      };
    }),

  /**
   * Create entity with profile-based type system
   *
   * When `global: true`, the entity is created without a workspaceId. Such a
   * NULL-workspace entity is OWNER-private by default (owner-floored by
   * accessScopeWhere), NOT visible across all workspaces — it surfaces to a
   * workspace's members only via a facet there (role-as-lens) or an exposure edge.
   */
  create: podProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(),
        profileId: z.string().uuid().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        documentId: z.string().uuid().optional(),
        content: z.string().optional(),
        /** When true, entity has no workspace — visible everywhere */
        global: z.boolean().optional().default(false),
        /** Override the target workspace for this entity (defaults to current workspace). */
        targetWorkspaceId: z.string().uuid().optional(),
        /**
         * Explicit workspace-scope request: pin this entity to the active
         * workspace, OVERRIDING a profile's pod-default `entityScope`. Set by
         * imports (and any caller that must isolate data to one workspace).
         * Normal interactive creation leaves this false so pod-default profiles
         * keep their global person/company graph un-fragmented.
         */
        workspaceScoped: z.boolean().optional().default(false),
        /**
         * Source of action for AI governance + downstream audit/event tagging.
         * Hub Protocol callers may pass connector-specific values (e.g.
         * "openwebui-pipeline", "extension") so the proposal layer
         * carries accurate provenance. Permission gating is unchanged: the
         * legacy AI gate only branches on "ai"/"intelligence"; everything else
         * falls through to the agentUserId / role-based path.
         */
        source: z
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
          .optional(),
        /** AI reasoning for proposals */
        reasoning: z.string().optional(),
        /** Agent user ID when action is performed by an AI agent */
        agentUserId: z.string().uuid().optional(),
        /**
         * Host-stamped identity of a framed view originating this write.
         *
         * SECURITY: this is the view's IDENTITY, not a trust assertion. Trust is
         * re-resolved server-side from `views.userId` / `widget_definitions.trust_level`
         * via `resolveViewTrust()`. A view that cannot be positively proven trusted
         * is routed to a proposal. Never accept a `trusted` boolean from the client.
         * Set by the React host (BrowserViewFrameCell), NOT by the sandboxed iframe.
         */
        viewContext: z
          .object({
            viewId: z.string().uuid().optional(),
            typeKey: z.string().optional(),
          })
          .optional(),
        /**
         * Stable entity ID assigned at propose-time so AI agents can reference
         * this entity in cross-write proposal graphs before its proposal is
         * approved. When set, the approval handler reuses this ID instead of
         * generating a fresh one. Ignored on the non-proposed (direct write)
         * path since a UUID is already generated inline — this input param is
         * for the proposal approval round-trip only.
         */
        proposedEntityId: z.string().uuid().optional(),
        /**
         * Active project lens (or surface override). When set, the created entity
         * is filed into this project (`belongs_to_project`) — the project mirror
         * of `workspaceId`. On the proposal path it rides `proposals.project_id`;
         * on the granted inline path it is stamped directly below.
         */
        projectId: z.string().uuid().nullish(),
        /**
         * Kind + Facets: role-profiles to attach to this entity in the SAME
         * call (mirrors the hub `createEntity` contract), so a caller can create
         * an entity WITH its roles (a person who is a client + investor) in one
         * round-trip. Each is attached AFTER the entity materializes via the
         * governed `attachFacet` door (fast-fail kind validation, proposal-gated
         * for agents). Dropped when the create itself is proposal-gated (no id to
         * attach to yet) — surfaced explicitly in the response, never silently.
         */
        facets: z
          .array(
            z.object({
              profileSlug: z.string(),
              status: z.string().optional(),
              properties: z.record(z.string(), z.unknown()).optional(),
              /** Disambiguator when the same role attaches in multiple contexts. */
              contextEntityId: z.string().uuid().nullish(),
            })
          )
          .optional(),
        /**
         * Bypass the WEAK same-name create gate (Phase 1). When true, a
         * same-profile title match still creates a new entity instead of
         * rejecting with candidates. Strong-signal auto-merge is NOT bypassed
         * — email/phone/url still collapse onto the existing subject. Prefer
         * reusing an existing id / enriching / attaching a facet; only set this
         * when the subject is genuinely distinct (e.g. two people who share a
         * name). Logged as `identity_resolve_merge` outcome `force_create`.
         */
        forceCreate: z.boolean().optional().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const entityId = input.proposedEntityId ?? randomUUID();
      const correlationId = randomUUID();
      const governanceWorkspaceId =
        input.targetWorkspaceId ?? ctx.workspaceId ?? null;

      if (input.targetWorkspaceId) {
        const { validateWorkspaceAccess } =
          await import("../utils/workspace-membership.js");
        const allowedWorkspaceIds = await validateWorkspaceAccess(ctx.userId, [
          input.targetWorkspaceId,
        ]);
        if (!allowedWorkspaceIds.includes(input.targetWorkspaceId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Access denied to target workspace",
          });
        }
      }

      // Resolve framed-view trust SERVER-SIDE (never from the request body).
      // Absent viewContext → no issuer → legacy behavior (unchanged for all
      // existing non-view callers).
      const issuer = input.viewContext
        ? await resolveViewTrust(
            input.viewContext,
            ctx.userId,
            governanceWorkspaceId
          )
        : undefined;

      // Resolve profile — capture full profile object so defaultValues are available at step 3
      let profileSlug: string | undefined;
      let earlyResolvedProfile: any = null;
      if (input.profileSlug) {
        profileSlug = input.profileSlug;
      } else if (input.profileId) {
        const database = await getDb();
        const resolutionService = new ProfileResolutionService(database);
        const profile = await resolutionService.resolveProfile(
          input.profileId,
          ctx.userId,
          governanceWorkspaceId
        );
        if (!profile) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Profile not found: ${input.profileId}`,
          });
        }
        profileSlug = profile.slug;
        earlyResolvedProfile = profile; // carry forward — avoids second DB call below
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either profileSlug or profileId must be provided",
        });
      }

      // File-is-uploaded-bytes guard (API entry). The `file` kind is ONLY for
      // real uploaded bytes reached via an upload-derived `documentId`. Reject
      // BEFORE EntityBodyService.setBody below synthesizes a documentId from
      // `content` — otherwise authored text would silently mint a ghost document
      // and slip through as a "file". A genuine upload arrives with a real
      // `documentId` and NO `content`. Backstopped in EntityRepository.create.
      if (
        profileSlug === "file" &&
        (input.content != null || input.documentId == null)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A `file` entity must be backed by an uploaded document (use the upload door — synap upload / POST /api/hub/entities/files). Authored text should be a content kind (note/article/…); its body becomes a document automatically.",
        });
      }

      // Kind + Facets: attach requested roles to a materialized entity through
      // the governed `attachFacet` door — the ONE facet write door (validation +
      // proposal gating inherited). Advisory: a single role failure is reported,
      // never rolls back the created entity.
      const attachRequestedFacets = async (
        targetEntityId: string
      ): Promise<
        Array<{
          slug: string;
          /**
           * @deprecated Carries the OPERATION OUTCOME (attached/proposed/dropped/
           * error), NOT the facet's domain status — a naming collision with the
           * REQUEST's `facets[].status` (domain). Read `outcome` instead; `status`
           * is kept only for back-compat and will be removed.
           */
          status: string;
          /** Operation outcome: attached | proposed | dropped | error. */
          outcome: string;
          facetId?: string;
          proposalId?: string;
          error?: string;
        }>
      > => {
        const out: Array<{
          slug: string;
          status: string;
          outcome: string;
          facetId?: string;
          proposalId?: string;
          error?: string;
        }> = [];
        if (!input.facets?.length) return out;
        const facetCaller = entitiesRouter.createCaller(
          ctx as unknown as Parameters<typeof entitiesRouter.createCaller>[0]
        );
        for (const f of input.facets) {
          try {
            const r = await facetCaller.attachFacet({
              entityId: targetEntityId,
              profileSlug: f.profileSlug,
              properties: f.properties,
              status: f.status,
              contextEntityId: f.contextEntityId ?? undefined,
              source: input.source,
              agentUserId: input.agentUserId,
              reasoning: input.reasoning,
            });
            out.push({
              slug: f.profileSlug,
              status: r.status,
              outcome: r.status,
              facetId: (r as { facetId?: string }).facetId,
              proposalId: (r as { proposalId?: string }).proposalId,
            });
          } catch (err) {
            out.push({
              slug: f.profileSlug,
              status: "error",
              outcome: "error",
              error: err instanceof Error ? err.message : "attachFacet failed",
            });
          }
        }
        return out;
      };

      // Junk-title gate (Phase 1) — person/company/contact never mint with a
      // placeholder name agents invent when a subject is not disclosed. Runs
      // before identity resolve so we don't waste a lookup on garbage.
      if (shouldRejectJunkTitle(profileSlug, input.title)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: buildJunkTitleMessage(profileSlug ?? "entity"),
          cause: {
            code: ENTITY_JUNK_TITLE_CODE,
            profileSlug,
            title: input.title ?? null,
          },
        });
      }

      // Resolve-then-merge (identity-first dedup — the single-entity door). A
      // STRONG identity signal (email/phone/url/handle) means this subject
      // already exists: enrich the matched entity + attach any requested roles
      // instead of creating a duplicate, and return it with `deduplicated: true`.
      // WEAK same-name (same profile) REJECTS create with candidates unless
      // `forceCreate: true` — never auto-merges (Phase 1). The enrich + facet
      // attach ride their own governed doors (update/attachFacet), so agent
      // writes stay proposal-gated. Resolver hiccup falls through to a normal
      // create (never blocks on a failed lookup).
      //
      // NOTE — capture-graph within-batch collapse still has its own weak
      // auto-link path (`_capture-graph-dedup.ts`); that asymmetry is intentional
      // for this PR (within-batch collapse ≠ persisted create gate).
      //
      // Runs on the `proposedEntityId` (proposal-approval replay) path TOO. It
      // used to be skipped there — "the approval must reuse its assigned id" —
      // which meant approving a proposed contact whose email already existed
      // CREATED A DUPLICATE, the one create door that silently skipped dedup.
      // The pre-minted id is a *preference*, not an invariant: it is honored
      // when nothing matches (below, `entityId`), and a strong match wins over
      // it. No consumer requires the returned id to equal the pre-minted one —
      // the composite materializer keys its `$opN` ref map on the id create
      // RETURNS (utils/materialize-composite.ts), and the single-op approve
      // executor reads `createdEntity.id` for every downstream write. Approving
      // a proposal that merges is reported with `deduplicated: true` so the
      // executor records it as LINKED, not created (see approve-executors.ts).
      const dedupSignals = extractIdentitySignals(input.properties ?? {});
      // Resolve when we have strong signals OR a title for the weak same-name
      // gate. Title-only creates used to skip resolve entirely (zero-friction);
      // Phase 1 runs the weak path for every profile so agents stop minting
      // "Alice" person #47.
      const needsIdentityResolve =
        dedupSignals.length > 0 || (!!profileSlug && !!input.title?.trim());
      if (needsIdentityResolve) {
        try {
          const resolveDb = await getDb();
          const identity = await resolveIdentity(resolveDb, {
            userId: ctx.userId,
            kindSlug: profileSlug,
            name: input.title ?? null,
            signals: dedupSignals,
            userScope: userVisibleWhere(entities.workspaceId, ctx.userId),
            limit: 5,
          });
          // SECURITY GATE — the strong identity index is deliberately GLOBAL
          // (frozen policy: one subject per email/phone pod-wide), so the
          // matched id may belong to an entity the CALLER cannot see
          // (another user's private workspace). Never dedupe onto something
          // the caller can't see: an invisible match falls through to a
          // normal create. Without this gate the response below would leak
          // the matched row's title/properties to an unauthorized caller
          // (the enrich/attach doors deny the writes, but the read leaked).
          // Invisible strong matches also must NOT be surfaced as weak
          // candidates below — candidates come only from the scoped weak path.
          const visibleMatch =
            identity.match === "strong" && identity.entity
              ? await resolveDb.query.entities.findFirst({
                  where: and(
                    eq(entities.id, identity.entity.id),
                    isNull(entities.deletedAt),
                    entityWriteVisibleWhere(ctx.userId)
                  ),
                })
              : undefined;
          if (identity.match === "strong" && identity.entity && !visibleMatch) {
            logger.info(
              {
                // Stable observability event (T3a) — the backend metrics
                // registry lives in @synap-core/core (no built dist, not a
                // tsconfig reference of @synap/api), so a new prom Counter there
                // would couple this router to a cross-package rebuild. This
                // structured log with a stable `event`+`outcome` is the honest
                // minimal surfacing of the resolve-then-merge decision.
                event: "identity_resolve_merge",
                outcome: "blocked_invisible",
                userId: ctx.userId,
                profileSlug,
              },
              "[entities.create] strong identity match not visible to caller — creating instead of merging"
            );
          }
          if (identity.match === "strong" && identity.entity && visibleMatch) {
            const matchedId = identity.entity.id;
            const enrichCaller = entitiesRouter.createCaller(
              ctx as unknown as Parameters<
                typeof entitiesRouter.createCaller
              >[0]
            );
            // update's source enum is narrower than create's — connector
            // sources (openwebui/cli/n8n/raycast) aren't in it.
            // Governance only branches on ai/intelligence anyway, so map the
            // non-AI connector sources to "user" (first-party write).
            const enrichSource =
              input.source === "ai" ||
              input.source === "intelligence" ||
              input.source === "agent" ||
              input.source === "system" ||
              input.source === "extension" ||
              input.source === "user"
                ? input.source
                : "user";
            const nonEmptyProperties = Object.fromEntries(
              Object.entries(input.properties ?? {}).filter(
                ([, v]) => v !== undefined && v !== null && v !== ""
              )
            );
            if (Object.keys(nonEmptyProperties).length > 0) {
              try {
                await enrichCaller.update({
                  id: matchedId,
                  properties: nonEmptyProperties,
                  source: enrichSource,
                  agentUserId: input.agentUserId,
                  reasoning: input.reasoning,
                });
              } catch (enrichErr) {
                logger.warn(
                  { enrichErr, entityId: matchedId },
                  "[entities.create] dedup enrich failed — returning matched entity unenriched"
                );
              }
            }

            // B3 FIX: a dedup used to SILENTLY DROP a long-form body carried by
            // this create. Recover it — materialize the body via the canonical
            // door (EntityBodyService) and link it onto the deduped entity — but
            // ONLY when the match has no existing body (no documentId, no inline
            // content). Appending onto an entity that ALREADY has a body needs a
            // version-onto-existing primitive the body service does not expose;
            // clobbering would lose the prior body, so that case still reports
            // the body as dropped rather than overwrite it.
            let dedupContentDropped = false;
            if (input.content && input.content.trim().length > 0) {
              const matchHasBody =
                !!(visibleMatch as { documentId?: string | null }).documentId ||
                !!(
                  (visibleMatch as { properties?: Record<string, unknown> })
                    .properties as { content?: unknown } | undefined
                )?.content;
              if (matchHasBody) {
                dedupContentDropped = true;
              } else {
                try {
                  const matchWorkspaceId =
                    (visibleMatch as { workspaceId?: string | null })
                      .workspaceId ?? null;
                  const body = await new EntityBodyService(
                    resolveDb,
                    eventRepository
                  ).setBody({
                    entityId: matchedId,
                    userId: ctx.userId,
                    workspaceId: matchWorkspaceId,
                    title: input.title || undefined,
                    provenance: {
                      createdByKind: "human",
                      createdByUserId: ctx.userId,
                    },
                    text: input.content,
                  });
                  if (body.documentId) {
                    const bodyDocId = body.documentId;
                    await enrichCaller.update({
                      id: matchedId,
                      documentId: bodyDocId,
                      source: enrichSource,
                      agentUserId: input.agentUserId,
                      reasoning: input.reasoning,
                    });
                    emitSideEffects({
                      subjectType: "document",
                      action: "create",
                      subjectId: bodyDocId,
                      userId: ctx.userId,
                      workspaceId: matchWorkspaceId ?? undefined,
                    }).catch((err) =>
                      logger.warn(
                        { err, documentId: bodyDocId },
                        "Document Typesense indexing failed (document still persisted)"
                      )
                    );
                  } else if (body.inlineContent !== undefined) {
                    await enrichCaller.update({
                      id: matchedId,
                      properties: { content: body.inlineContent },
                      source: enrichSource,
                      agentUserId: input.agentUserId,
                      reasoning: input.reasoning,
                    });
                  }
                } catch (bodyErr) {
                  dedupContentDropped = true;
                  logger.warn(
                    { bodyErr, entityId: matchedId },
                    "[entities.create] dedup body recovery failed — body not merged"
                  );
                }
              }
            }
            const dedupFacets = await attachRequestedFacets(matchedId);
            // Refetch SCOPED (same visibility gate as above) so the response
            // reflects the enrich, and an unauthorized row can never surface.
            const matched = await resolveDb.query.entities.findFirst({
              where: and(
                eq(entities.id, matchedId),
                isNull(entities.deletedAt),
                entityWriteVisibleWhere(ctx.userId)
              ),
            });
            logger.info(
              {
                // Stable observability event (T3a) — see the blocked_invisible
                // sibling above for why this is a structured log, not a counter.
                event: "identity_resolve_merge",
                outcome: "merged",
                userId: ctx.userId,
                entityId: matchedId,
                profileSlug,
              },
              "[entities.create] deduplicated onto existing entity (strong identity match)"
            );
            return {
              status: "created",
              message:
                "Entity deduplicated onto existing (strong identity match)",
              id: matchedId,
              entity: matched ? toApiEntity(matched) : null,
              // Additive: signals this create merged onto an existing entity.
              deduplicated: true,
              // B3: whether a long-form body carried by this create could NOT
              // be recovered onto the deduped entity (true only when the match
              // already had a body we won't clobber). Consumed by the composite
              // materializer's `contentDropped` diagnostic.
              contentDropped: dedupContentDropped,
              facets: dedupFacets,
            };
          }

          // ── WEAK same-name gate (Phase 1) ────────────────────────────────
          // Same profile + same title → reject with candidates. Never auto-
          // merge. forceCreate opts in to create anyway (logged). Cross-kind
          // same-title stays advisory only (not blocked). Strong invisible
          // fall-through above still proceeds; weak candidates are already
          // caller-scoped by resolveIdentity's userScope so no leak.
          if (profileSlug && identity.match !== "strong") {
            const weakGate = classifyWeakEntityDedup({
              forceCreate: input.forceCreate,
              profileSlug,
              match: identity.match,
              candidates: identity.candidates.map((c) => ({
                id: c.id,
                title: c.title,
                type: c.type,
              })),
            });
            if (weakGate.block) {
              logger.info(
                {
                  event: "identity_resolve_merge",
                  outcome: "blocked_weak",
                  userId: ctx.userId,
                  profileSlug,
                  candidateCount: weakGate.sameKindCandidates.length,
                },
                "[entities.create] weak same-name match — rejecting create with candidates"
              );
              throw new TRPCError({
                code: "CONFLICT",
                message: buildWeakEntityDedupMessage(
                  weakGate.sameKindCandidates,
                  profileSlug
                ),
                cause: buildWeakDedupCause(weakGate.sameKindCandidates),
              });
            }
            if (input.forceCreate && identity.match === "weak") {
              logger.info(
                {
                  event: "identity_resolve_merge",
                  outcome: "force_create",
                  userId: ctx.userId,
                  profileSlug,
                },
                "[entities.create] forceCreate=true — bypassing weak same-name gate"
              );
            }
          }
        } catch (resolveErr) {
          // Re-throw intentional gate rejects (junk already threw above; weak
          // CONFLICT is thrown inside the try). Only swallow resolver failures.
          if (resolveErr instanceof TRPCError) throw resolveErr;
          logger.warn(
            { resolveErr },
            "[entities.create] identity resolve failed — proceeding to create"
          );
        }
      }

      // Resolve the profile's entityScope ONCE, up-front, so workspace placement
      // is computed identically for the proposal-gated and auto-approved paths
      // (invariant I3). Reuses earlyResolvedProfile (profileId path); resolves by
      // slug otherwise. Carried forward to the materialize path below (no second
      // lookup). Fail-fast on an invalid profile — a proposal for a non-existent
      // profile can never materialize, so surfacing it here beats deferring to
      // the worker.
      if (!earlyResolvedProfile && profileSlug) {
        const database = await getDb();
        const resolutionService = new ProfileResolutionService(database);
        earlyResolvedProfile = await resolutionService.resolveProfile(
          profileSlug,
          ctx.userId,
          governanceWorkspaceId
        );
      }
      if (!earlyResolvedProfile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${profileSlug}`,
        });
      }

      // Resolve placement ONCE through the one door (I1/I3). Persisted as
      // `resolvedWorkspaceId` for the materializer (four-door bug fix).
      //
      // Kind + facet slugs feed rungs 2–4 (ontology / context / relational) so
      // agents can create a lead/client WITHOUT inventing a workspaceId —
      // placement is derived from installed profile metadata on this pod
      // (dynamic; never hard-coded CRM/Ops). Same abstain rules as graph
      // capture: multi-candidate or no signal falls through to rung 6 (pod
      // entityScope → null; workspace-scope → ambient only when present).
      const placementDb = await getDb();
      const facetSlugsForPlacement = (input.facets ?? [])
        .map((f) => f.profileSlug)
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      const entityPlacement = await resolveWorkspacePlacement(placementDb, {
        userId: ctx.userId,
        // Only an EXPLICIT target is rung-1. Omitting is undefined (not null)
        // so ontology can place; deliberate pod-wide uses global:true.
        explicitWorkspaceId: input.targetWorkspaceId
          ? input.targetWorkspaceId
          : undefined,
        globalFlag: input.global,
        workspaceScopedFlag: input.workspaceScoped === true,
        entityScope: earlyResolvedProfile.entityScope as
          "pod" | "workspace" | null | undefined,
        kindSlug:
          profileSlug ?? (earlyResolvedProfile as { slug?: string }).slug,
        ...(facetSlugsForPlacement.length
          ? { facetSlugs: facetSlugsForPlacement }
          : {}),
        // Ambient is advisory (MCP URL pin / session ctx) — never invent a
        // membership[0] ambient here. Ontology (rung 2) wins when definitive.
        ambientWorkspaceId: governanceWorkspaceId,
        ...(ctx.sessionId ? { context: { sessionId: ctx.sessionId } } : {}),
      });
      // Placement accept policy (shared pure helper with graph capture/import):
      // - Explicit pin / global / workspaceScoped → trust door result as-is
      // - Else deterministic ontology (rung ≤4, single candidate) → place
      // - Else K1: pod-scope kinds → null; workspace-scope → ambient only
      let resolvedEntityWorkspaceId: string | null;
      if (input.global || input.targetWorkspaceId || input.workspaceScoped) {
        resolvedEntityWorkspaceId = entityPlacement.workspaceId;
      } else {
        const deterministic =
          acceptDeterministicGraphWorkspace(entityPlacement);
        if (deterministic) {
          resolvedEntityWorkspaceId = deterministic;
        } else if (
          normalizeEntityScope(earlyResolvedProfile.entityScope) === "pod"
        ) {
          resolvedEntityWorkspaceId = null;
        } else {
          resolvedEntityWorkspaceId = entityPlacement.workspaceId;
        }
      }

      // Refuse domain dumps into admin/settings/agent/operational homes.
      // global:true → null (allowed). Pod-wide placement is fine; pinning or
      // ambient-resolving into a non-domain home is not — pick a domain app
      // or omit workspaceId for server placement. Hub create funnels here.
      if (resolvedEntityWorkspaceId) {
        const filingTarget = await placementDb.query.workspaces.findFirst({
          where: eq(workspaces.id, resolvedEntityWorkspaceId),
          columns: {
            workspaceType: true,
            systemSlug: true,
            settings: true,
          },
        });
        if (
          filingTarget &&
          !isDomainHomeWorkspace({
            workspaceType: filingTarget.workspaceType,
            systemSlug: filingTarget.systemSlug,
            settings: filingTarget.settings as {
              surfaceClass?: string | null;
              systemSlug?: string | null;
            } | null,
          })
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE,
          });
        }
      }

      // Project placement — the deterministic sibling door (explicit input.projectId
      // → producing session's project). Rung 1 (explicit) preserves the historical
      // inline behavior exactly; rung 2 (session) is the additive gain. An
      // AI-guessed project never routes through here — that stays a propose/advisory
      // chip, never an auto-link (belongs_to_project WIDENS cross-workspace access).
      const projectPlacement = await resolveProjectPlacement(placementDb, {
        userId: ctx.userId,
        explicitProjectId: input.projectId,
        sessionId: ctx.sessionId,
      });
      const resolvedProjectId = projectPlacement.projectId;

      // Governance home MUST follow resolved placement when ontology pins a
      // workspace (agent omit workspaceId → rung 2 place). Otherwise proposals
      // land pod-null while data materializes in CRM, and workspace AI policy
      // never runs. Ambient remains fallback when placement is pod-wide null.
      const permWorkspaceId =
        resolvedEntityWorkspaceId ?? governanceWorkspaceId;

      // 1. Emit .requested event — records intent regardless of outcome
      const requestedEvent = await auditLog({
        subjectType: "entity",
        action: "create",
        phase: "requested",
        subjectId: entityId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: permWorkspaceId,
        correlationId,
        data: {
          profileSlug,
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
          content: input.content ? "[content]" : undefined,
          global: input.global,
        },
      });

      // 2. Permission check (may create proposal with correlationId)
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: permWorkspaceId,
        subjectType: "entity",
        action: "create",
        source: input.source,
        issuer,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        sessionId: ctx.sessionId ?? undefined,
        projectId: resolvedProjectId ?? undefined,
        data: {
          id: entityId,
          profileSlug,
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
          content: input.content,
          global: input.global,
          // I3 (resolve-early-and-persist): the RESOLVED placement (may be an
          // explicit null for pod-scope kinds). The materializer reads this back
          // verbatim; a present key — including null — beats its legacy
          // `data.global ? null : workspaceId` derivation.
          resolvedWorkspaceId: resolvedEntityWorkspaceId,
          // R2: carry facets on the proposal so approve attaches them (same
          // shape as create input / composite op.facets). No longer dropped.
          ...(input.facets?.length
            ? {
                facets: input.facets.map((f) => ({
                  profileSlug: f.profileSlug,
                  ...(f.status ? { status: f.status } : {}),
                  ...(f.properties ? { properties: f.properties } : {}),
                  ...(f.contextEntityId
                    ? { contextEntityId: f.contextEntityId }
                    : {}),
                })),
              }
            : {}),
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        // PHANTOM ENVELOPE ID FIX: a "proposed" response must NOT carry a
        // top-level `id` that looks like a materialized entity id — nothing was
        // created yet, and downstream callers were treating that phantom id as a
        // real entity. Carry only `proposalId` (the reviewable handle). `entity`
        // stays null to signal "no materialized row". However, we DO expose the
        // stable `proposedEntityId` (pre-generated at the top of this handler) so
        // AI agents can reference this entity in cross-write proposal graphs.
        return {
          status: "proposed",
          message: "Entity creation proposed for review",
          entity: null as Record<string, unknown> | null,
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
          proposedEntityId: entityId,
          // Homed proposal: same as materialize target (may be null = pod-wide).
          workspaceId: resolvedEntityWorkspaceId,
          effectiveWorkspaceId: resolvedEntityWorkspaceId,
          // Facets ride the proposal payload and attach on approve (R2).
          // outcome "pending" = will attach after approval (not dropped).
          facets: (input.facets ?? []).map((f) => ({
            slug: f.profileSlug,
            // `status` deprecated (operation-outcome overload) — read `outcome`.
            status: "pending",
            outcome: "pending",
            message: "Role will attach when this create proposal is approved",
          })),
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const entityRepo = new EntityRepository(database, eventRepo);

      // Profile + placement were already resolved up-front (before the perm
      // check) so the proposal-gated and auto-approved paths land identically
      // (I3). Reuse both here — `resolvedEntityWorkspaceId` is the value the
      // proposal persisted as `data.resolvedWorkspaceId`.
      const resolvedProfile: any = earlyResolvedProfile;
      const entityWorkspaceId = resolvedEntityWorkspaceId;

      // Merge profile.defaultValues into caller-supplied properties.
      const profileDefaults =
        (resolvedProfile?.defaultValues as Record<string, unknown>) ?? {};
      const effectiveProperties: Record<string, unknown> = {
        ...profileDefaults,
        ...(input.properties ?? {}),
      };

      // RETRY-SAFE DEDUP (W3, direct/auto-approved writes — the "No approval
      // received" damage): the client's confirmation window can give up on a
      // write that already landed, the model retries, and — unlike an
      // agent-authored PROPOSAL (hash-deduped by `insertPendingProposal`) — a
      // granted/auto-approved create had NOTHING catching an identical retry,
      // so it duplicated. Scoped to agent-driven writes ONLY (`agentUserId`
      // set) — mirrors `insertPendingProposal`'s human-exemption: a person may
      // deliberately file the same note/task twice, so a human direct write is
      // NEVER deduped here. Runs BEFORE `entityBodyService.setBody` below
      // (which would otherwise mint a fresh document on every retry).
      // `shouldMaterializeAsDocument` predicts the SAME inline/document branch
      // `setBody` will take from `input.content` — long-form content that
      // routes to a document is OUT OF SCOPE here (its text lives in object
      // storage via `documents.storageKey`, not a column this lookup can
      // compare); this covers the common case (short/no content), which is
      // the bulk of agent-driven note/task creates.
      if (input.agentUserId) {
        const contentGoesToDocument =
          !!input.content && shouldMaterializeAsDocument(input.content);
        if (!contentGoesToDocument) {
          try {
            const candidates = await database
              .select({
                id: entities.id,
                properties: entities.properties,
              })
              .from(entities)
              .where(
                and(
                  eq(entities.agentUserId, input.agentUserId),
                  eq(entities.profileId, earlyResolvedProfile.id),
                  entityWorkspaceId
                    ? eq(entities.workspaceId, entityWorkspaceId)
                    : isNull(entities.workspaceId),
                  input.title
                    ? eq(entities.title, input.title)
                    : isNull(entities.title),
                  isNull(entities.deletedAt),
                  drizzleSql`${entities.createdAt} >= now() - (${idempotencyWindowSeconds()}::int * interval '1 second')`
                )
              )
              .orderBy(desc(entities.createdAt))
              .limit(5);

            const dup = candidates.find((c) => {
              const props = (c.properties ?? {}) as Record<string, unknown>;
              const sameContent = input.content
                ? props.content === input.content
                : props.content == null;
              if (!sameContent) return false;
              return Object.entries(effectiveProperties).every(
                ([k, v]) => JSON.stringify(props[k]) === JSON.stringify(v)
              );
            });

            if (dup) {
              const matched = await database.query.entities.findFirst({
                where: eq(entities.id, dup.id),
              });
              const dedupFacets = await attachRequestedFacets(dup.id);
              logger.info(
                {
                  event: "entity_create_dedup",
                  entityId: dup.id,
                  profileSlug,
                  agentUserId: input.agentUserId,
                },
                "[entities.create] retry-safe dedup: returning previously created entity, no second row written"
              );
              return {
                status: "created",
                message:
                  "Duplicate retry ignored — returning the previously created entity",
                id: dup.id,
                entity: matched ? toApiEntity(matched) : null,
                ackState: "duplicate-ignored" as const,
                facets: dedupFacets,
              };
            }
          } catch (err) {
            logger.warn(
              { err },
              "[entities.create] retry-dedup lookup failed — creating normally"
            );
          }
        }
      }

      let createdEntity: any;

      // Resolve where content lives ONCE (heuristic-gated, shared with the
      // capture paths) via the canonical body door (EntityBodyService): long-form
      // → a versioned document linked via documentId, short → inline
      // properties.content. The document is scoped to the SAME workspace as the
      // entity so a workspace purge reclaims both. The service owns Document +
      // Storage ONLY — documentId linking, properties.content, and the Typesense
      // side-effect stay caller concerns here.
      const entityBodyService = new EntityBodyService(database, eventRepo);
      let contentDocumentId: string | undefined;
      let inlineContent: string | undefined;
      if (input.content) {
        const body = await entityBodyService.setBody({
          entityId,
          userId: ctx.userId,
          workspaceId: entityWorkspaceId ?? null,
          title: input.title || undefined,
          // Behavior-preserving: the prior materializeContentDocument path stamped
          // the document with default `human` provenance (no agent/correlation).
          provenance: {
            createdByKind: "human",
            createdByUserId: ctx.userId,
          },
          text: input.content,
        });
        contentDocumentId = body.documentId;
        inlineContent = body.inlineContent;
        // Typesense index the new document (caller concern — the service is
        // side-effect-free). Fire-and-forget; indexing failure never blocks.
        if (contentDocumentId) {
          const indexedDocumentId = contentDocumentId;
          emitSideEffects({
            subjectType: "document",
            action: "create",
            subjectId: indexedDocumentId,
            userId: ctx.userId,
            workspaceId: entityWorkspaceId ?? undefined,
          }).catch((err) =>
            logger.warn(
              { err, documentId: indexedDocumentId },
              "Document Typesense indexing failed (document still persisted)"
            )
          );
        }
      }
      const documentId = contentDocumentId ?? input.documentId ?? undefined;
      const propertiesWithContent: Record<string, unknown> =
        inlineContent !== undefined
          ? { ...effectiveProperties, content: inlineContent }
          : effectiveProperties;

      try {
        createdEntity = await entityRepo.create(
          {
            workspaceId: entityWorkspaceId ?? undefined,
            userId: ctx.userId,
            title: input.title || undefined,
            preview: input.description || undefined,
            documentId,
            properties: propertiesWithContent,
            profileSlug,
            // Provenance (Wave B3): inline (granted) write. source_proposal_id
            // stays null on the inline path per decision.
            ...stampProvenance({
              userId: ctx.userId,
              agentUserId: input.agentUserId,
              correlationId,
            }),
          },
          ctx.userId
        );
      } catch (createErr) {
        // Compensate: if we materialized a document for this entity but the
        // entity create then failed, delete the now-orphaned document (nothing
        // points to it) so we don't leak storage + a stranded row. deleteBody is
        // the service's reverse-cascade — it also cleans the storage objects the
        // bare DocumentRepository.delete used to leave behind.
        if (contentDocumentId) {
          try {
            await entityBodyService.deleteBody({
              documentId: contentDocumentId,
            });
          } catch (cleanupErr) {
            logger.warn(
              { cleanupErr, documentId: contentDocumentId },
              "Failed to clean up orphaned document after entity create failure"
            );
          }
        }
        const msg =
          createErr instanceof Error ? createErr.message : String(createErr);
        logger.error(
          {
            err: createErr,
            profileSlug,
            title: input.title,
            workspaceId: entityWorkspaceId,
          },
          "Entity creation failed"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Entity creation failed: ${msg}`,
          // Preserve the original error (e.g. PropertyValidationError) so
          // callers that reuse this door (capture's retry-as-note ladder)
          // can branch on the real failure type instead of the wrapped message.
          cause: createErr,
        });
      }

      // Provenance: when this entity is created inside a focus session, record
      // `session --produced--> entity`. This is the AUTO-APPROVED (granted) inline
      // path — the default live BYOA case (`entity.create` ∈ DEFAULT_AUTO_APPROVE),
      // which never enqueues the materializer worker nor a proposal. Without this
      // emit the session room's Deliverable surface stays empty even on success.
      // The proposal-gated paths (worker + composite + single-entity approve) emit
      // the same link; together all four paths populate by construction.
      // Idempotent via the links unique-edge index.
      if (ctx.sessionId && createdEntity?.id) {
        await database
          .insert(links)
          .values({
            workspaceId: entityWorkspaceId ?? null,
            fromType: "session" as LinkEndpointType,
            fromId: ctx.sessionId,
            toType: "entity" as LinkEndpointType,
            toId: createdEntity.id,
            linkType: "produced" as LinkType,
            metadata: {},
          })
          .onConflictDoNothing();
      }

      // Membership: file the entity into the DETERMINISTICALLY resolved project
      // lens (the project mirror of workspaceId) on the granted inline path. The
      // proposal path is covered by checkPermissionOrPropose threading the same
      // resolvedProjectId → the materializer. Idempotent via
      // relations_belongs_to_project_unique.
      if (resolvedProjectId && createdEntity?.id) {
        await linkEntityToProject(database, {
          entityId: createdEntity.id,
          projectId: resolvedProjectId,
          userId: ctx.userId,
          workspaceId: entityWorkspaceId ?? null,
        });
      }

      // 3b. Auto-sync entity_id properties → relations (non-blocking)
      //
      // Use earlyResolvedProfile.id (the profile `effectiveProperties` were
      // actually validated/submitted against), NOT createdEntity.profileId —
      // when profileSlug resolved to a ROLE, EntityRepository.create's
      // adapter repoints the row onto the role's applicable KIND, so
      // createdEntity.profileId is the kind's id. Relation-typed property
      // defs (valueType=ENTITY_ID) that live on the ROLE profile would then
      // never be found by profileId lookup and silently stop syncing.
      // earlyResolvedProfile is identical to createdEntity.profileId in the
      // non-role case, so this is a no-op behavior change there.
      if (
        earlyResolvedProfile &&
        effectiveProperties &&
        Object.keys(effectiveProperties).length > 0
      ) {
        syncPropertyToRelations(
          createdEntity.id,
          earlyResolvedProfile.id,
          governanceWorkspaceId,
          ctx.userId,
          {}, // old properties = empty (new entity)
          effectiveProperties as Record<string, unknown>
        ).catch((err) => {
          logger.warn(
            { err },
            "[entities.create] Property→relation sync failed"
          );
        });
      }

      // 3c. Identity signals (email/phone/url/handle) are now registered inside
      // EntityRepository.create — the ONE create door — so every producer that
      // reaches it (imports, provisioning, automation/feed workers) feeds
      // resolveIdentity's strong path, not just this router. See
      // entity-repository.ts create() step 6.

      // 4. Emit .completed event + side-effects — ONE door (recordDomainMutation)
      // so the timeline append and the automation fan-out can never drift apart.
      // Session-stamped so the matcher resolves it → playbook → `member_of`
      // automations for entities produced in this session (e.g. import under a
      // contact-leads playbook). Null on non-session paths → workspace-wide only.
      // `logData` keeps `global` on the audit row (the fan-out never carried it).
      await recordDomainMutation({
        subjectType: "entity",
        action: "create",
        subjectId: createdEntity.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        sessionId: ctx.sessionId ?? null,
        data: { profileSlug, title: input.title },
        logData: { profileSlug, title: input.title, global: input.global },
      });

      // Dispatch entity embedding job (non-blocking — failure never blocks creation)
      try {
        await getBoss().send("entity-embedding", {
          entityId: createdEntity.id,
          title: createdEntity.title || input.title,
          preview: createdEntity.preview || input.description,
          userId: ctx.userId,
          action: "create",
        });
      } catch (err) {
        logger.warn({ err }, "[entities.create] Failed to queue embedding job");
      }

      // Dispatch AI classification for raw captures (non-blocking)
      // Upgrades profileSlug from "capture" → typed profile (note, bookmark, task…)
      if (profileSlug === "capture") {
        try {
          await getBoss().send("ai-analysis", {
            entityId: createdEntity.id,
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
          });
        } catch (err) {
          logger.warn(
            { err },
            "[entities.create] Failed to queue AI analysis job"
          );
        }
      }

      // Kind + Facets: attach any requested roles now that the entity exists,
      // through the governed door. Additive `facets` summary — always an array
      // (empty when none requested); a direct field, not a conditional spread,
      // so the union stays `.id`-narrowable for the door's many callers.
      const createdFacets = await attachRequestedFacets(createdEntity.id);

      // If profileSlug itself resolved to a ROLE, EntityRepository.create's
      // adapter silently attached it as a facet (never a second entity) — that
      // facet is invisible above (attachRequestedFacets only sees input.facets)
      // so a caller creating profileSlug:"client" would otherwise get back
      // `entity.type:"person"` + `facets:[]`, with the submitted role nowhere
      // in the response. Surface it explicitly.
      if (earlyResolvedProfile?.profileKind === "role") {
        const facetRepo = new FacetRepository(database, eventRepo);
        const liveFacets = await facetRepo.getByEntity(createdEntity.id, {
          userId: ctx.userId,
          workspaceId: governanceWorkspaceId,
        });
        const adapterFacet = liveFacets.find(
          (f) => f.profileId === earlyResolvedProfile.id
        );
        if (
          adapterFacet &&
          !createdFacets.some((f) => f.facetId === adapterFacet.id)
        ) {
          createdFacets.push({
            slug: earlyResolvedProfile.slug,
            status: "attached",
            outcome: "attached",
            facetId: adapterFacet.id,
          });
        }
      }

      return {
        status: "created",
        message: "Entity created",
        id: createdEntity.id,
        entity: toApiEntity(createdEntity),
        facets: createdFacets,
        // Advisory: property keys the caller sent that no property_def models.
        // Stored verbatim (never a failure) but surfaced on the write receipt
        // with a did-you-mean, so an agent that invents a key is TOLD instead
        // of getting a silent 200. Forwarded EXPLICITLY — it also rides along
        // inside `entity` via toApiEntity's spread, but relying on that is
        // incidental and would break silently if the spread ever changed.
        ...(createdEntity.unmodeled?.length
          ? { unmodeled: createdEntity.unmodeled }
          : {}),
      };
    }),

  /**
   * List entities (workspace-scoped + global)
   *
   * Returns entities belonging to the active workspace AND global entities (workspaceId IS NULL).
   */
  list: podProcedure
    .input(
      paginatedInput.extend({
        profileSlug: z.string().optional(),
        /** When true and profileSlug is set, also return entities of child profiles.
         *  e.g. profileSlug='person' + includeDescendants=true → returns person + contact + any custom children. */
        includeDescendants: z.boolean().optional().default(false),
        /** When true, only return global entities */
        globalOnly: z.boolean().optional().default(false),
        /**
         * PRODUCT DECISION (scoped default, 2026-06-15): when a workspace is
         * active, the list returns ONLY that workspace's entities — pod-wide
         * (workspaceId IS NULL) rows are NOT mixed in, so a focused workspace
         * lens no longer bleeds pod-wide notes/captures. Defaults to `false`;
         * an EXPLICITLY pod-scoped/global view (the CRM's pod-wide person/company
         * reads, the user-floor Hub endpoints) passes `includePodWide: true` to
         * restore the union (this workspace's rows OR pod-wide globals). No data
         * is migrated. Ignored for `globalOnly` and workspace-less callers (those
         * already return pod-wide-only / the full user floor).
         */
        includePodWide: z.boolean().optional().default(false),
        /**
         * Explicit list lens. `undefined` falls back to ctx.workspaceId for
         * backwards compatibility; `null` returns the caller's pod-wide rows.
         */
        workspaceId: z.string().uuid().nullable().optional(),
        /**
         * Project LENS (project-centric-scope) — narrow to one project's data.
         * In the INPUT (not a header) so it lands in the React Query key and the
         * cache separates per project. A lens only narrows: access is enforced by
         * the floor (`entityWriteVisibleWhere`, which already grants project members);
         * a forged id can never widen.
         */
        projectId: z.string().uuid().optional(),
        /** Filter to entities materialized from a specific proposal (provenance). */
        sourceProposalId: z.string().uuid().optional(),
        /**
         * Facet filter (Kind + Facets): only return entities carrying a live
         * facet of this role-profile. Resolved to `facetProfileId` via slug
         * lookup when only the slug is given; `facetProfileId` wins if both
         * are provided.
         */
        facetSlug: z.string().optional(),
        facetProfileId: z.string().uuid().optional(),
        /**
         * Kind + Facets, opt-in rich annotation. Default `false` keeps the
         * response byte-identical to today's: `facetSlugs` only. Set `true` to
         * ALSO get `facets` — each live facet's overlay `properties`/`status`
         * beside its slug — for a list page that must read a facet property
         * (e.g. the CRM's `leadStage: "prospect"`, invisible in a slug alone).
         * Costs the same ONE batched query under the SAME visibility lens; it
         * only widens the projection, so it is never an N+1.
         */
        includeFacets: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      // Scoped-by-default: with an active workspace and includePodWide=false,
      // return ONLY that workspace's rows. includePodWide=true restores the
      // legacy "workspace OR pod-wide globals" union. globalOnly / workspace-less
      // callers are unaffected (they already resolve to pod-wide-only below).
      //
      // Role-as-lens (Phase 2): when filtering by facetSlug/facetProfileId,
      // masters are often pod-wide (entityScope pod) with a role hat. Default
      // includePodWide=true so "list leads in CRM" returns pod-wide persons
      // wearing `lead`, not an empty page. Explicit includePodWide:false still
      // wins for callers that want workspace-only rows.
      const includePodWideEffective =
        input.includePodWide === true ||
        (input.includePodWide !== false &&
          Boolean(input.facetSlug || input.facetProfileId));
      const lensWorkspaceId =
        input.workspaceId !== undefined ? input.workspaceId : ctx.workspaceId;
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        input.projectId ? undefined : lensWorkspaceId
      );
      // The scope rule (unified, floor-first):
      //   • PROJECT lens → the full user floor (incl. the project-membership
      //     branch, so a member sees the project ACROSS workspaces); the
      //     `projectLensWhere` narrow below restricts to that project.
      //   • EXPLICIT globals-only (`globalOnly`, or an explicit `workspaceId:
      //     null`) → pod-wide globals only.
      //   • a SPECIFIC workspace (input or the active-ws header) → that workspace.
      //   • NO lens at all (no input workspaceId AND no header) → the USER FLOOR
      //     (all the user's workspaces + globals), NOT globals-only. This is the
      //     "no lens = everything you can access" rule and makes `.list` with no
      //     lens a strict superset of (and the replacement for) `.listAll`.
      let workspaceScopeCondition;
      if (input.projectId) {
        workspaceScopeCondition = entityReadVisibleWhere(ctx.userId);
      } else if (input.globalOnly || input.workspaceId === null) {
        workspaceScopeCondition = entityLensWhere(ctx.userId, null);
      } else if (lensWorkspaceId) {
        workspaceScopeCondition = entityLensWhere(ctx.userId, lensWorkspaceId, {
          includePodWide: includePodWideEffective,
        });
      } else {
        workspaceScopeCondition = entityReadVisibleWhere(ctx.userId);
      }
      // Visibility is enforced at QUERY level — `list` is a `podProcedure`, so there
      // is NO procedure-level workspace gate. `workspaceScopeCondition` delegates to
      // `entityLensWhere`/`entityWriteVisibleWhere`, which restrict rows to the user floor
      // (workspace membership + pod-personal + project membership). `userId` is a
      // security predicate there, not mere attribution.
      const conditions: any[] = [isNull(entities.deletedAt)];

      if (input.sourceProposalId) {
        conditions.push(eq(entities.sourceProposalId, input.sourceProposalId));
      }

      if (input.profileSlug) {
        const database = await getDb();

        // Kind + Facets: a profileSlug can now name either a primary `kind`
        // (entities carry it as their `type`/profileId) or an attachable
        // `role` (entities carry it as a live facet). `convertToFacet` flips
        // profile_kind in place — same slug — so a slug that filtered by
        // `entities.type` before conversion must resolve to the SAME entities
        // via the facet-EXISTS after. Resolve ALL rows for the slug (a slug
        // can be carried by a system row AND a workspace-scope twin — the
        // legacy text match was row-blind, so the role routing must OR every
        // role row's id or entities faceted on the twin vanish).
        //
        // Resolved through the ONE slug lookup (`profileSlugRows`) the scope
        // predicate uses, then asserted non-empty: a slug naming no profile at
        // all would otherwise fall through to the row-blind `entities.type`
        // match, return `[]`, and be indistinguishable from a genuinely empty
        // list (the `crm-lead`-against-a-`lead`-workspace bug).
        const slugProfiles = await assertKnownProfileSlug(
          database,
          input.profileSlug
        );
        const roleProfileIds = slugProfiles
          .filter((p) => p.profileKind === "role")
          .map((p) => p.id);
        // The old `slugProfiles.length === 0 ||` disjunct is gone: the assert
        // above guarantees at least one row, so the zero-row fallback here is
        // unreachable. A slug carrying ONLY role rows now correctly yields no
        // kind branch instead of an `entities.type` match that never hits.
        const hasKindRow = slugProfiles.some((p) => p.profileKind !== "role");

        const slugBranches: any[] = [];
        if (roleProfileIds.length > 0) {
          // Role rows: match entities carrying a live facet, via the same
          // one-door EXISTS the `facetSlug` filter uses.
          slugBranches.push(
            facetRoleExists(database, roleProfileIds, facetVisibilityScope)
          );
        }
        if (hasKindRow) {
          // Kind rows (default / unconverted): match by primary type, with
          // optional descendant expansion over the kind hierarchy.
          const profileService = new ProfileResolutionService(database);
          let profileSlugs = [input.profileSlug];
          if (input.includeDescendants) {
            const descendants = await profileService.getDescendantSlugs(
              input.profileSlug,
              ctx.workspaceId ?? undefined
            );
            profileSlugs = [input.profileSlug, ...descendants];
          }

          // Use inArray for multiple slugs, eq for single (simpler query plan)
          if (profileSlugs.length === 1) {
            slugBranches.push(eq(entities.type, profileSlugs[0]));
          } else {
            slugBranches.push(inArray(entities.type, profileSlugs));
          }
        }
        conditions.push(
          slugBranches.length === 1 ? slugBranches[0] : or(...slugBranches)
        );

        // Pod-default and workspace-scoped profiles share the same read filter
        // (workspaceScopeCondition, computed above): workspace-only by default,
        // or workspace OR pod-wide globals when includePodWide is set.
        conditions.push(workspaceScopeCondition);
      } else {
        // No profile filter — same workspace scoping.
        conditions.push(workspaceScopeCondition);
      }

      // Project lens (project-centric-scope): narrow to the selected project's
      // data on top of the workspace scope. ANDed with the floor above, so it
      // can only narrow — never widen. Omitted when no project is selected.
      if (input.projectId) {
        conditions.push(projectLensWhere(entities.id, input.projectId));
      }

      // Facet filter (Kind + Facets): narrow to entities carrying a live
      // facet of the given role-profile, visible under the same lens as the
      // entity list itself.
      if (input.facetSlug || input.facetProfileId) {
        // Same multi-row rule as the profileSlug branch above: one slug can
        // be carried by several profile rows (system + workspace twins), and
        // a facet may sit on ANY of them — match every row's id, never a
        // findFirst pick.
        //
        // FAIL CLOSED on an unknown `facetSlug` — same door as the
        // `profileSlug` branch above. This used to push `false` and return an
        // empty page, which is exactly the silent-empty this workstream
        // exists to kill: "this pod has no such role" read as "no rows".
        const facetProfileIds = input.facetProfileId
          ? [input.facetProfileId]
          : (await assertKnownProfileSlug(db, input.facetSlug!)).map(
              (p) => p.id
            );
        conditions.push(
          facetRoleExists(db, facetProfileIds, facetVisibilityScope)
        );
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit + 1,
        offset: input.offset,
      });

      const totalRow = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(entities)
        .where(and(...conditions));
      const total = totalRow[0]?.count ?? 0;

      // Kind + Facets annotation. The opt-in branch loads the rich rows (slug +
      // overlay) instead of slugs-only — same single batched query, same lens.
      // Unset/false takes the untouched default path.
      const annotated = input.includeFacets
        ? await toApiEntitiesWithFacetRows(results, facetVisibilityScope)
        : await toApiEntitiesWithFacets(results, facetVisibilityScope);

      const { items, pagination } = buildPaginatedResponse(
        annotated,
        input,
        total
      );

      return {
        items,
        pagination,
        total,
        /** @deprecated Use `items` instead */
        entities: items,
        /** @deprecated Use `pagination.hasMore` instead */
        hasMore: pagination.hasMore,
      };
    }),

  /**
   * List global entities (no workspace required)
   *
   * Returns only entities where workspaceId IS NULL.
   * Uses protectedProcedure — works even without an active workspace.
   */
  listGlobal: protectedProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [
        eq(entities.userId, ctx.userId),
        isNull(entities.workspaceId),
      ];

      if (input.profileSlug) {
        // Polymorphic (Kind + Facets); pod-personal list → pod-wide facet
        // lens (workspaceId: null) + owner floor. Fail closed first on a slug
        // that names no profile at all — otherwise the predicate's row-blind
        // kind branch returns `[]` and "no such vocabulary" reads as "empty".
        const database = await getDb();
        const slugRows = await assertKnownProfileSlug(
          database,
          input.profileSlug
        );
        conditions.push(
          profileSlugScopeConditionFromRows(
            database,
            input.profileSlug,
            slugRows,
            { userId: ctx.userId, workspaceId: null }
          )
        );
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return {
        entities: await toApiEntitiesWithFacets(results, {
          userId: ctx.userId,
          workspaceId: null,
        }),
      };
    }),

  /**
   * List entities across multiple workspaces the user has access to.
   *
   * Unlike `list` (which is workspace-scoped via header), this endpoint
   * accepts an explicit `workspaceIds` array and is callable without an
   * active workspace header. Useful for cross-workspace dashboards and
   * global search aggregation.
   *
   * Security: `workspaceIds` is silently filtered to workspaces the caller
   * is actually a member of — unknown or inaccessible IDs are ignored.
   * Omitting `workspaceIds` returns entities from ALL user's workspaces.
   */
  listMulti: protectedProcedure
    .input(
      z.object({
        workspaceIds: z.array(z.string().uuid()).optional(),
        profileSlug: z.string().optional(),
        includeGlobal: z.boolean().default(false),
        limit: z.number().min(1).max(200).default(50),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const { validateWorkspaceAccess } =
        await import("../utils/workspace-membership.js");

      const validatedIds = await validateWorkspaceAccess(
        ctx.userId,
        input.workspaceIds
      );

      const db2 = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const entityRepo = new EntityRepository(db2, eventRepo);

      const results = await entityRepo.listForWorkspaces(
        validatedIds,
        ctx.userId,
        {
          profileSlug: input.profileSlug,
          limit: input.limit,
          includeGlobal: input.includeGlobal,
        }
      );

      return {
        entities: await toApiEntitiesWithFacets(results, {
          userId: ctx.userId,
          allowedWorkspaceIds: validatedIds,
        }),
      };
    }),

  /**
   * List all entities in this workspace that have a URL property.
   * Used by the browser's URL index to know which pages have been saved,
   * powering the bookmark ⭐ state and duplicate detection.
   * Returns a slim payload — no full property values, just what the index needs.
   */
  listSavedUrls: podProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
        })
        .optional()
    )
    .output(
      z.array(
        z.object({
          id: z.string(),
          url: z.string(),
          title: z.string(),
          profileSlug: z.string(),
          createdAt: z.string(),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      const lensWorkspaceId = input?.workspaceId ?? ctx.workspaceId ?? null;
      const workspaceFilter = lensWorkspaceId
        ? entityLensWhere(ctx.userId, lensWorkspaceId, { includePodWide: true })
        : entityReadVisibleWhere(ctx.userId);
      const rows = await db
        .select({
          id: entities.id,
          title: entities.title,
          type: entities.type,
          createdAt: entities.createdAt,
          url: drizzleSql<string>`${entities.properties}->>'url'`,
        })
        .from(entities)
        .where(
          and(
            workspaceFilter,
            drizzleSql`${entities.properties}->>'url' IS NOT NULL`,
            drizzleSql`${entities.properties}->>'url' != ''`
          )
        )
        .orderBy(desc(entities.createdAt));

      return rows.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title ?? r.url,
        profileSlug: r.type ?? "bookmark",
        createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
      }));
    }),

  /**
   * Search entities (vector + text)
   */
  search: workspaceProcedure
    .input(
      z.object({
        query: z.string(),
        profileSlug: z.string().optional(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        ctx.workspaceId
      );
      // Floor: every search result must belong to the caller. This prevents
      // pod-personal entities (workspaceId IS NULL) that belong to OTHER users
      // from leaking through — both the pod-scoped-profile branch (which
      // previously skipped the workspace filter) and the workspace branch
      // (which had no per-user guard on the NULL case).
      const conditions: any[] = [entityReadVisibleWhere(ctx.userId)];

      // The advertised contract: input.query MATCHES. (This was silently
      // ignored for months — every caller got recent entities regardless of
      // text.) Lexical title match here; richer ranking belongs to the
      // Typesense/SRE doors.
      const trimmedQuery = input.query.trim();
      if (trimmedQuery.length > 0) {
        conditions.push(ilike(entities.title, `%${trimmedQuery}%`));
      }

      // Workspace narrow for search: the active workspace + pod-wide globals,
      // PLUS entities role-attached to the active workspace (facet-aware — mirrors
      // entities.list's lens, so search and list agree). It is ANDed with the
      // floor above, so it can only surface a row the floor already admits; a
      // forged workspace can't widen. Globals-only when there is no active
      // workspace (facet branch needs a concrete workspace to key on).
      const searchWorkspaceNarrow = ctx.workspaceId
        ? or(
            eq(entities.workspaceId, ctx.workspaceId),
            isNull(entities.workspaceId),
            facetInWorkspaceLensWhere(entities.id, ctx.userId, ctx.workspaceId)
          )!
        : or(
            eq(entities.workspaceId, ctx.workspaceId),
            isNull(entities.workspaceId)
          )!;

      if (input.profileSlug) {
        // Polymorphic (Kind + Facets): a role slug matches via the facet
        // EXISTS, a kind slug via entities.type — same routing as
        // entities.list, through the shared one-door helper. Fail closed on an
        // unknown slug before building the predicate (see assertKnownProfileSlug).
        const database = await getDb();
        const slugRows = await assertKnownProfileSlug(
          database,
          input.profileSlug
        );
        conditions.push(
          profileSlugScopeConditionFromRows(
            database,
            input.profileSlug,
            slugRows,
            facetVisibilityScope
          )
        );

        // For workspace-scoped profiles, also narrow to the active workspace
        // (plus pod-wide globals already covered by the floor above).
        const profileService = new ProfileResolutionService(database);
        const entityScope = await profileService.getEntityScope(
          input.profileSlug,
          ctx.workspaceId
        );

        if (entityScope !== "pod") {
          conditions.push(searchWorkspaceNarrow);
        }
      } else {
        conditions.push(searchWorkspaceNarrow);
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return {
        entities: await toApiEntitiesWithFacets(results, facetVisibilityScope),
      };
    }),

  /**
   * Get entity by document ID (reverse lookup)
   */
  getByDocumentId: podProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .output(z.object({ entity: z.any().nullable() }))
    .query(async ({ input, ctx }) => {
      // Single-object read: visibility from the user floor alone, never the
      // ambient lens. Uses the same predicate as entities.get so a cross-
      // workspace lookup (entity in a workspace the user belongs to, just not
      // the active one) resolves instead of returning null.
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.documentId, input.documentId),
          isNull(entities.deletedAt),
          entityReadVisibleWhere(ctx.userId)
        ),
      });

      if (!entity) return { entity: null };

      return { entity: toApiEntity(entity) };
    }),

  /**
   * Get entity by ID
   */
  get: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        includeProfile: z.boolean().optional().default(false),
        /**
         * @deprecated Kept for wire compatibility only. Single-object reads
         * are identity-wide and never vary by a workspace lens.
         */
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .output(
      z.object({
        entity: z.any(),
        profile: z.any().optional(),
        effectiveProperties: z.array(z.any()).optional(),
        /** Stable kind-property overlays keyed by every workspace in the user floor. */
        effectivePropertiesByWorkspace: z
          .record(z.string(), z.array(z.any()))
          .optional(),
        /**
         * Every live role the user may see, independent of the active
         * workspace lens. Additive/optional — present only on the
         * `includeProfile` path. Kind + Roles.
         *
         * SHIPPED CONTRACT — the browser host reads `entities.get.facets`
         * (ProfileEntityDetailCell), so the field name is `facets` and must stay
         * `facets`. Per-facet row: the resolver's `{ facet, profile,
         * effectiveProperties }` — `facet` (entity_facets row: id, status,
         * workspaceId, contextEntityId, properties), `profile` (role-profile:
         * slug, displayName, …), `effectiveProperties` (role-scoped property
         * DEFS). The browser host flattens this to its `AttachedFacet` prop.
         */
        facets: z
          .array(
            z.object({
              facet: z.record(z.string(), z.unknown()),
              profile: z.record(z.string(), z.unknown()),
              effectiveProperties: z.array(z.record(z.string(), z.unknown())),
            })
          )
          .optional(),
        /** Tracks where this entity was imported from (empty for user-created entities). */
        externalLinks: z
          .array(
            z.object({
              provider: z.string(),
              externalId: z.string(),
              createdAt: z.string(),
            })
          )
          .optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          isNull(entities.deletedAt),
          entityReadVisibleWhere(ctx.userId)
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const typedEntity = toApiEntity(entity);

      // Provenance: always include externalLinks (possibly empty) to keep
      // client types predictable. Single-row entity ⇒ single cheap join.
      const linkRows = await db.query.entityExternalLinks.findMany({
        where: eq(entityExternalLinks.entityId, entity.id),
      });
      const externalLinks = linkRows.map((l) => ({
        provider: l.provider,
        externalId: l.externalId,
        createdAt:
          l.createdAt instanceof Date
            ? l.createdAt.toISOString()
            : new Date(l.createdAt as unknown as string).toISOString(),
      }));

      if (!input.includeProfile) {
        return { entity: typedEntity, externalLinks };
      }

      const database = await getDb();
      const resolutionService = new ProfileResolutionService(database);
      const { validateWorkspaceAccess } =
        await import("../utils/workspace-membership.js");
      // A single-object query has one stable cache identity. Its kind schema is
      // resolved from the object's own scope, never from request/header state.
      const entityWorkspaceId = entity.workspaceId ?? null;
      const [allowedWorkspaceIds, profile] = await Promise.all([
        validateWorkspaceAccess(ctx.userId),
        resolutionService.resolveProfile(
          entity.type,
          ctx.userId,
          entityWorkspaceId
        ),
      ]);
      const stableAllowedWorkspaceIds = [...allowedWorkspaceIds].sort();

      // Keep the identity response lens-free while preserving every accessible
      // kind overlay. All overlay and role resolutions run concurrently; the
      // active Browser surface selects from the stable envelope client-side.
      const [effectiveProperties, workspacePropertyEntries, facets] =
        await Promise.all([
          profile
            ? resolutionService.getEffectiveProperties(
                profile.id,
                entityWorkspaceId
              )
            : Promise.resolve(undefined),
          profile
            ? Promise.all(
                stableAllowedWorkspaceIds.map(
                  async (workspaceId) =>
                    [
                      workspaceId,
                      await resolutionService.getEffectiveProperties(
                        profile.id,
                        workspaceId
                      ),
                    ] as const
                )
              )
            : Promise.resolve([]),
          getEffectiveFacets(database, entity.id, {
            userId: ctx.userId,
            allowedWorkspaceIds: stableAllowedWorkspaceIds,
          }),
        ]);
      const effectivePropertiesByWorkspace = Object.fromEntries(
        workspacePropertyEntries
      );

      return {
        entity: typedEntity,
        ...(profile
          ? { profile, effectiveProperties, effectivePropertiesByWorkspace }
          : {}),
        // Spread into anonymous objects: interfaces lack index signatures, so
        // EntityFacet/Profile aren't assignable to the Record-typed output
        // schema directly. Field name is `facets` — the shipped browser-host
        // contract (see the output schema note).
        facets: facets.map((f) => ({
          facet: { ...f.facet },
          profile: { ...f.profile },
          effectiveProperties: f.effectiveProperties.map((p) => ({ ...p })),
        })),
        externalLinks,
      };
    }),

  /**
   * Update entity
   */
  update: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().optional(),
        description: z.string().optional(),
        documentId: z.string().uuid().nullable().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        /** Keys to delete from the entity's properties object. Applied before `properties` merge. */
        deleteProperties: z.array(z.string()).optional(),
        /** Change entity's profile type by slug (e.g. 'person' → 'contact') */
        profileSlug: z.string().optional(),
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent", "extension"])
          .optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        /**
         * Caller-requested review: force this update through the proposal path
         * even when it would otherwise auto-approve. For machine-sourced writes
         * where a human clicked the trigger but did not author the DATA — data
         * enrichment being the first case: the operator reviews the diff on the
         * entity's proposal panel before it lands. Never DOWNGRADES governance;
         * it is OR-ed with the checks that already force a proposal.
         */
        forcePropose: z.boolean().optional(),
        /** When true, removes workspace scoping — entity becomes pod-wide (visible in all workspaces). */
        global: z.boolean().optional(),
        /** Workspace used for permission, audit, overlays, and side effects. */
        targetWorkspaceId: z.string().uuid().optional(),
        /**
         * Host-stamped framed-view identity (NOT a trust assertion). Trust is
         * re-resolved server-side via `resolveViewTrust()`. See `create`'s
         * `viewContext` for the full security contract. Absent → legacy behavior.
         */
        viewContext: z
          .object({
            viewId: z.string().uuid().optional(),
            typeKey: z.string().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();

      // PROPOSE-TIME VALIDATION: reject an update against a NONEXISTENT entity
      // up front. Previously a missing target sailed past the gate and only blew
      // up at approval with a raw 500 "Entity not found" — a proposal that can
      // never materialize. Check existence BEFORE checkPermissionOrPropose so the
      // caller gets an immediate NOT_FOUND instead of a doomed proposal.
      const existing = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
        columns: { id: true, workspaceId: true, type: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Entity not found: ${input.id}`,
        });
      }

      if (input.targetWorkspaceId) {
        const { validateWorkspaceAccess } =
          await import("../utils/workspace-membership.js");
        const allowedWorkspaceIds = await validateWorkspaceAccess(ctx.userId, [
          input.targetWorkspaceId,
        ]);
        if (!allowedWorkspaceIds.includes(input.targetWorkspaceId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Access denied to target workspace",
          });
        }
      }

      const placementWorkspaceId = input.global ? null : existing.workspaceId;
      const overlayWorkspaceId =
        input.targetWorkspaceId ??
        ctx.workspaceId ??
        existing.workspaceId ??
        null;
      const governanceWorkspaceId = existing.workspaceId ?? overlayWorkspaceId;

      // Resolve framed-view trust SERVER-SIDE (never from the request body).
      const issuer = input.viewContext
        ? await resolveViewTrust(
            input.viewContext,
            ctx.userId,
            overlayWorkspaceId
          )
        : undefined;

      // 1. Emit .requested event
      const requestedEvent = await auditLog({
        subjectType: "entity",
        action: "update",
        phase: "requested",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: {
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
          profileSlug: input.profileSlug,
        },
      });

      // Scope/identity-bearing edits are NOT field patches: promoting a
      // workspace entity to pod-wide (global) or changing its profile TYPE
      // changes the record's visibility/identity. These must ALWAYS be reviewed,
      // even when entity.update otherwise auto-approves — so force a proposal.
      const promotesToGlobal =
        input.global === true && existing.workspaceId !== null;
      const changesProfileType =
        input.profileSlug !== undefined && input.profileSlug !== existing.type;
      const forcePropose =
        promotesToGlobal || changesProfileType || input.forcePropose === true;

      // 2. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "entity",
        action: "update",
        source: input.source,
        issuer,
        forcePropose,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sessionId: ctx.sessionId ?? undefined,
        data: {
          id: input.id,
          title: input.title,
          description: input.description,
          properties: input.properties,
          deleteProperties: input.deleteProperties,
          documentId: input.documentId,
          profileSlug: input.profileSlug,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed",
          message: "Update proposed for review",
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const entityRepo = new EntityRepository(database, eventRepo);

      // Snapshot old properties for relation sync (before update)
      let oldEntity:
        | { profileId: string | null; properties: unknown; type: string | null }
        | undefined;
      if (input.properties || input.deleteProperties?.length) {
        oldEntity = await database.query.entities.findFirst({
          where: eq(entities.id, input.id),
          columns: { profileId: true, properties: true, type: true },
        });
      }

      await entityRepo.update(
        input.id,
        {
          title: input.title || undefined,
          preview: input.description || undefined,
          documentId: input.documentId,
          properties: input.properties || undefined,
          deleteProperties: input.deleteProperties,
          profileSlug: input.profileSlug || undefined,
          // Thread the workspace lens so overlay props validate/index correctly
          workspaceId: overlayWorkspaceId,
        },
        ctx.userId
      );

      // 3b. Persist explicit global placement changes after the content/property update.
      // `targetWorkspaceId` is a validation/overlay lens for legacy callers, not an
      // entity move operation. Moving between workspaces should stay explicit.
      if (input.global === true && existing.workspaceId !== null) {
        await database
          .update(entities)
          .set({ workspaceId: placementWorkspaceId })
          .where(eq(entities.id, input.id));
      }

      // 3c. Auto-sync entity_id properties → relations (non-blocking)
      if (input.properties && oldEntity?.profileId) {
        const oldProps =
          (oldEntity.properties as Record<string, unknown>) ?? {};
        const newProps = { ...oldProps, ...input.properties };
        syncPropertyToRelations(
          input.id,
          oldEntity.profileId,
          governanceWorkspaceId,
          ctx.userId,
          oldProps,
          newProps
        ).catch((err) => {
          logger.warn(
            { err },
            "[entities.update] Property→relation sync failed"
          );
        });

        // 3d. Auto-register identity signals (email/phone/url/handle) — non-blocking.
        // Only when a signal-relevant key actually changed, so an unrelated
        // property edit doesn't re-scan + re-write signals every time.
        const changedKeys = new Set(Object.keys(input.properties));
        const touchedIdentityKey = Object.values(
          IDENTITY_SIGNAL_PROPERTY_KEYS
        ).some((keys) => keys.some((k) => changedKeys.has(k)));
        if (touchedIdentityKey) {
          const signals = extractIdentitySignals(newProps);
          if (signals.length > 0) {
            runSignalWrite(() =>
              registerIdentitySignals(
                database,
                input.id,
                signals,
                "entities.update"
              ).catch((err) => {
                logger.warn(
                  { err },
                  "[entities.update] Identity signal registration failed"
                );
              })
            );
          }
        }
      }

      // Compute changed properties before emit so automation triggers can filter on them
      const changedProperties: Record<string, unknown> = {};
      if ((input.properties || input.deleteProperties?.length) && oldEntity) {
        const oldProps =
          (oldEntity.properties as Record<string, unknown>) ?? {};
        // Apply deletions then merge new values, mirroring EntityRepository.update
        const afterDeletions = { ...oldProps };
        for (const key of input.deleteProperties ?? []) {
          delete afterDeletions[key];
        }
        const mergedProps = { ...afterDeletions, ...(input.properties ?? {}) };
        for (const key of new Set([
          ...Object.keys(oldProps),
          ...Object.keys(mergedProps),
        ])) {
          if (
            JSON.stringify(oldProps[key]) !== JSON.stringify(mergedProps[key])
          ) {
            changedProperties[key] = mergedProps[key];
          }
        }
      }

      // 4. Emit .completed event + side-effects — ONE door (recordDomainMutation).
      // Session-scope lifecycle updates (e.g. dealStage lead→client inside a
      // session) so playbook `member_of` automations fire. Null otherwise.
      // `logData: {}` keeps the audit row payload as it was (no changed-prop
      // detail on the log — that shape belongs only to the automation fan-out).
      await recordDomainMutation({
        subjectType: "entity",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        sessionId: ctx.sessionId ?? null,
        data: {
          profileSlug: input.profileSlug ?? oldEntity?.type ?? undefined,
          ...(Object.keys(changedProperties).length > 0
            ? {
                changedKeys: Object.keys(changedProperties),
                ...Object.fromEntries(
                  Object.keys(changedProperties).map((k) => [
                    `changed.${k}`,
                    true,
                  ])
                ),
                ...changedProperties,
              }
            : {}),
        },
        logData: {},
      });

      // Dispatch webhooks for entity property updates (fire-and-forget, non-blocking)
      if (input.properties && oldEntity) {
        if (Object.keys(changedProperties).length > 0) {
          dispatchWebhooksForEvent("entity.update.completed", {
            entityId: input.id,
            entityType: oldEntity.type,
            workspaceId: governanceWorkspaceId,
            changedProperties,
          });
        }
      }

      // Dispatch entity embedding job (non-blocking — only if searchable fields changed).
      // Debounce: rapid successive edits to the SAME entity collapse into one
      // queued embedding job via pg-boss singleton throttling (singletonKey =
      // entity id, throttled over a short window) so a burst of keystroke-level
      // updates doesn't fire one embedding LLM call each.
      if (input.title !== undefined || input.description !== undefined) {
        try {
          await getBoss().send(
            "entity-embedding",
            {
              entityId: input.id,
              title: input.title,
              preview: input.description,
              userId: ctx.userId,
              action: "update",
            },
            {
              singletonKey: `entity-embedding:${input.id}`,
              singletonSeconds: 30,
            }
          );
        } catch (err) {
          logger.warn(
            { err },
            "[entities.update] Failed to queue embedding job"
          );
        }
      }

      return { status: "updated", message: "Entity updated" };
    }),

  /**
   * Attach a facet (role-profile) to an entity — Kind + Facets (Wave 1C).
   *
   * Follows the entity-mutation skeleton EXACTLY:
   *   .requested audit → checkPermissionOrPropose(facet.attach) → FacetRepository
   *   write on grant → .completed audit → facet emit chain (parent refresh).
   * The write is the ONE door (`FacetRepository.attach`); never insert
   * entity_facets directly.
   */
  attachFacet: podProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        profileSlug: z.string().optional(),
        profileId: z.string().uuid().optional(),
        /** Facet visibility lens. null = pod-wide; omitted = inherit parent. */
        workspaceId: z.string().uuid().nullable().optional(),
        /** Disambiguator when the same role attaches in multiple contexts. */
        contextEntityId: z.string().uuid().nullable().optional(),
        status: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        source: FACET_SOURCE_ENUM,
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        automationContext: AUTOMATION_CONTEXT_INPUT,
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!input.profileSlug && !input.profileId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either profileSlug or profileId must be provided",
        });
      }
      const correlationId = randomUUID();

      // Load the parent entity through the visibility floor — confirms it exists
      // and resolves its workspace for the governance + emit lens.
      const parent = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
        columns: { id: true, workspaceId: true, type: true, title: true },
      });
      if (!parent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Entity not found: ${input.entityId}`,
        });
      }

      // Best-effort readable label for the context entity (disambiguator) —
      // surfaced on proposal cards alongside entityTitle.
      let contextEntityTitle: string | undefined;
      if (input.contextEntityId) {
        const contextEntity = await db.query.entities.findFirst({
          where: and(
            eq(entities.id, input.contextEntityId),
            isNull(entities.deletedAt),
            entityWriteVisibleWhere(ctx.userId)
          ),
          columns: { title: true },
        });
        if (!contextEntity) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Context entity not found: ${input.contextEntityId}`,
          });
        }
        contextEntityTitle = contextEntity.title ?? undefined;
      }

      // Facet lens follows the parent by default. But when the parent is
      // pod-wide (workspaceId null) and the caller didn't pin a lens, the role
      // itself may be enabled in exactly one workspace — derive that through the
      // one door (rung 2) so a pod-wide entity's role-hat still lands in the
      // domain that enabled it. Deterministic-only: no aiHint / no ASK, so an
      // ambiguous or unimplied role keeps the parent's pod-wide null lens (never
      // a silent guess on a governed write).
      let facetWorkspaceId: string | null;
      if (input.workspaceId !== undefined) {
        facetWorkspaceId = input.workspaceId;
      } else if (parent.workspaceId != null) {
        facetWorkspaceId = parent.workspaceId;
      } else {
        // Resolve the role-profile ROW ONCE, and make the lens decision against
        // THAT row.
        //
        // When the caller pinned `profileId`, the pinned row IS the answer —
        // fetching its slug and then re-querying BY SLUG could decide against a
        // DIFFERENT row, because one slug can be carried by several rows
        // (`profile-repository.ts:164-170`). When only a slug is given, resolve
        // it through `profileRepo.getBySlug`, which applies the caller's
        // visibility floor AND the deterministic specificity sort — an
        // ORDER BY-less `findFirst` let an arbitrary twin win.
        let roleProfile: {
          id: string;
          slug: string;
          scope: string;
          profileKind: string | null;
          isActive: boolean;
        } | null = null;
        if (input.profileId) {
          roleProfile =
            (await db.query.profiles.findFirst({
              where: eq(profiles.id, input.profileId),
              columns: {
                id: true,
                slug: true,
                scope: true,
                profileKind: true,
                isActive: true,
              },
            })) ?? null;
        } else {
          const profileRepo = new (
            await import("@synap/database")
          ).ProfileRepository(db);
          roleProfile = await profileRepo.getBySlug(
            input.profileSlug!,
            undefined,
            ctx.userId
          );
        }
        const facetSlug = roleProfile?.slug ?? input.profileSlug;
        // Only an ACTIVE role-profile drives the ontology pin; anything else
        // (a kind, a soft-deleted row) leaves the decision to placement below.
        const activeRole =
          roleProfile &&
          roleProfile.profileKind === "role" &&
          roleProfile.isActive
            ? roleProfile
            : null;
        // A CROSS-LENS role (a shared/system role-profile surfaced in MANY
        // workspaces) is pod-wide by nature — pinning it to the single lens the
        // caller happens to be a member of would defeat "visible in both". Keep
        // such a role pod-wide (workspace_id = NULL). Only a role that is
        // genuinely single-workspace (workspace-scoped, or shared+granted to
        // exactly one ws) is eligible for the rung-2 ontology pin.
        let stayPodWide = false;
        if (activeRole?.scope === "system") {
          stayPodWide = true;
        } else if (activeRole?.scope === "shared") {
          const grants = await db.query.profileWorkspaceAccess.findMany({
            where: eq(profileWorkspaceAccess.profileId, activeRole.id),
            columns: { workspaceId: true },
          });
          if (grants.length > 1) stayPodWide = true;
        }
        if (stayPodWide || !facetSlug) {
          facetWorkspaceId = null;
        } else {
          const facetPlacement = await resolveWorkspacePlacement(db, {
            userId: ctx.userId,
            facetSlugs: [facetSlug],
            ambientWorkspaceId: null,
          });
          // Only a definitive ontology pick (rung 2, single survivor) moves the
          // facet off pod-wide; candidates / no-signal keep the null lens.
          facetWorkspaceId =
            facetPlacement.rung === 2 ? facetPlacement.workspaceId : null;
        }
      }
      const governanceWorkspaceId = facetWorkspaceId ?? ctx.workspaceId ?? null;

      // Fast-fail BEFORE governance: a structurally impossible attach (target
      // profile isn't a role, or the role doesn't apply to this kind) must be
      // rejected here, not parked as a proposal that can never materialize.
      // FacetRepository remains the validation SSOT — this pre-check throws
      // the repository's own error classes so messages stay single-sourced.
      {
        const candidates = await db.query.profiles.findMany({
          where: input.profileId
            ? eq(profiles.id, input.profileId)
            : eq(profiles.slug, input.profileSlug!),
          columns: {
            id: true,
            slug: true,
            profileKind: true,
            applicableKinds: true,
          },
        });
        if (candidates.length > 0) {
          const roleCandidates = candidates.filter(
            (p) => p.profileKind === "role"
          );
          if (roleCandidates.length === 0) {
            throw new FacetProfileKindError(
              candidates[0].id,
              candidates[0].slug
            );
          }
          const applies = roleCandidates.some(
            (p) =>
              !p.applicableKinds ||
              p.applicableKinds.length === 0 ||
              p.applicableKinds.includes(parent.type)
          );
          if (!applies) {
            throw new FacetKindMismatchError(
              roleCandidates[0].slug,
              parent.type,
              roleCandidates[0].applicableKinds ?? []
            );
          }
        }
        // No candidates → fall through; the repository reports NOT_FOUND with
        // workspace-aware resolution on the granted path.
      }

      // 1. .requested
      const requestedEvent = await auditLog({
        subjectType: "entity_facet",
        action: "attach",
        phase: "requested",
        subjectId: input.entityId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: {
          entityId: input.entityId,
          profileSlug: input.profileSlug,
          profileId: input.profileId,
          contextEntityId: input.contextEntityId,
          status: input.status,
        },
      });

      // 2. Permission → subjectType "facet", action "attach" so the proposal row
      // gets targetType="facet"/proposalType="attach" (the executor's key).
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "facet",
        action: "attach",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sessionId: ctx.sessionId ?? undefined,
        data: {
          entityId: input.entityId,
          entityTitle: parent.title,
          profileSlug: input.profileSlug,
          profileId: input.profileId,
          workspaceId: facetWorkspaceId,
          // I3: the facet lens follows the parent entity (facetWorkspaceId is
          // parent.workspaceId when the caller didn't override). Persist it as
          // the resolved placement — may be an explicit null for a pod-wide
          // parent — so the materializer never re-pins the facet to the ambient
          // governance workspace (the four-door bug, facet flavour).
          resolvedWorkspaceId: facetWorkspaceId,
          contextEntityId: input.contextEntityId ?? null,
          ...(contextEntityTitle ? { contextEntityTitle } : {}),
          status: input.status,
          properties: input.properties,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Facet attach proposed for review",
          facet: null as Record<string, unknown> | null,
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Write — the ONE door.
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const facetRepo = new FacetRepository(database, eventRepo);
      const facet = await facetRepo.attach(
        {
          entityId: input.entityId,
          profileId: input.profileId,
          profileSlug: input.profileSlug,
          userId: ctx.userId,
          workspaceId: facetWorkspaceId,
          contextEntityId: input.contextEntityId ?? null,
          status: input.status,
          properties: input.properties,
          agentUserId: input.agentUserId,
          correlationId,
        },
        ctx.userId
      );

      // 4. .completed + emit chain
      await auditLog({
        subjectType: "entity_facet",
        action: "attach",
        phase: "completed",
        subjectId: facet.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { entityId: input.entityId, facetId: facet.id },
      });

      const profileSlug =
        input.profileSlug ?? (await resolveFacetProfileSlug(facet.profileId));
      emitFacetSideEffects({
        action: "attach",
        entityId: input.entityId,
        facetId: facet.id,
        profileSlug,
        status: facet.status,
        userId: ctx.userId,
        workspaceId: facet.workspaceId ?? governanceWorkspaceId,
        sessionId: ctx.sessionId ?? null,
        entityTitle: parent.title,
        contextEntityTitle,
        automationContext: input.automationContext,
      });

      return {
        status: "attached" as const,
        message: "Facet attached",
        facetId: facet.id,
        facet,
      };
    }),

  /**
   * Update a facet's status/properties — Kind + Facets (Wave 1C).
   */
  updateFacet: podProcedure
    .input(
      z.object({
        facetId: z.string().uuid(),
        status: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        /** Overlay lens for property validation (defaults to the facet's stored ws). */
        workspaceId: z.string().uuid().nullable().optional(),
        source: FACET_SOURCE_ENUM,
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        automationContext: AUTOMATION_CONTEXT_INPUT,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const facetRepo = new FacetRepository(database, eventRepo);

      // A workspace-scoped role is shared operational state (owner/admin/editor
      // of that workspace); a pod-wide role answers to the pod owner/admins.
      const existing = await facetRepo.getById(input.facetId);
      if (!existing || !(await canWriteFacet(existing, ctx.userId))) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Facet not found: ${input.facetId}`,
        });
      }
      const governanceWorkspaceId =
        existing.workspaceId ?? ctx.workspaceId ?? null;

      // Best-effort readable label for the parent entity — surfaced on
      // proposal/notification cards (which otherwise show raw entity ids).
      const parentForUpdate = await db.query.entities.findFirst({
        where: eq(entities.id, existing.entityId),
        columns: { title: true },
      });

      // 1. .requested
      const requestedEvent = await auditLog({
        subjectType: "entity_facet",
        action: "update",
        phase: "requested",
        subjectId: input.facetId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { facetId: input.facetId, status: input.status },
      });

      // 2. Permission → targetType="facet"/proposalType="update".
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "facet",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sessionId: ctx.sessionId ?? undefined,
        data: {
          // entityId drives the proposal targetId (points the review card at the
          // parent entity); facetId is what the executor re-runs against.
          entityId: existing.entityId,
          entityTitle: parentForUpdate?.title,
          facetId: input.facetId,
          status: input.status,
          properties: input.properties,
          workspaceId: input.workspaceId ?? null,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Facet update proposed for review",
          facet: null as Record<string, unknown> | null,
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Write
      const facet = await facetRepo.update(
        input.facetId,
        {
          status: input.status,
          properties: input.properties,
          workspaceId: input.workspaceId ?? undefined,
        },
        ctx.userId,
        existing.userId
      );

      // 4. .completed + emit
      await auditLog({
        subjectType: "entity_facet",
        action: "update",
        phase: "completed",
        subjectId: facet.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
      });

      const changedKeys = [
        ...(input.status !== undefined ? ["status"] : []),
        ...(input.properties ? Object.keys(input.properties) : []),
      ];
      emitFacetSideEffects({
        action: "update",
        entityId: existing.entityId,
        facetId: facet.id,
        profileSlug: await resolveFacetProfileSlug(facet.profileId),
        status: facet.status,
        changedKeys,
        userId: ctx.userId,
        workspaceId: facet.workspaceId ?? governanceWorkspaceId,
        sessionId: ctx.sessionId ?? null,
        entityTitle: parentForUpdate?.title,
        automationContext: input.automationContext,
      });

      return { status: "updated" as const, message: "Facet updated", facet };
    }),

  /**
   * Detach a facet (soft-delete) — Kind + Facets (Wave 1C).
   */
  detachFacet: podProcedure
    .input(
      z.object({
        facetId: z.string().uuid(),
        source: FACET_SOURCE_ENUM,
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        automationContext: AUTOMATION_CONTEXT_INPUT,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const facetRepo = new FacetRepository(database, eventRepo);

      const existing = await facetRepo.getById(input.facetId);
      if (!existing || !(await canWriteFacet(existing, ctx.userId))) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Facet not found: ${input.facetId}`,
        });
      }
      const governanceWorkspaceId =
        existing.workspaceId ?? ctx.workspaceId ?? null;

      // Best-effort readable label for the parent entity — surfaced on
      // proposal/notification cards (which otherwise show raw entity ids).
      const parentForDetach = await db.query.entities.findFirst({
        where: eq(entities.id, existing.entityId),
        columns: { title: true },
      });

      // 1. .requested
      const requestedEvent = await auditLog({
        subjectType: "entity_facet",
        action: "detach",
        phase: "requested",
        subjectId: input.facetId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { facetId: input.facetId, entityId: existing.entityId },
      });

      // 2. Permission → targetType="facet"/proposalType="detach".
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "facet",
        action: "detach",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sessionId: ctx.sessionId ?? undefined,
        data: {
          entityId: existing.entityId,
          entityTitle: parentForDetach?.title,
          facetId: input.facetId,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Facet detach proposed for review",
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Write (soft-delete)
      await facetRepo.detach(input.facetId, ctx.userId, existing.userId);

      // 4. .completed + emit
      await auditLog({
        subjectType: "entity_facet",
        action: "detach",
        phase: "completed",
        subjectId: input.facetId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
      });

      emitFacetSideEffects({
        action: "detach",
        entityId: existing.entityId,
        facetId: input.facetId,
        profileSlug: await resolveFacetProfileSlug(existing.profileId),
        userId: ctx.userId,
        workspaceId: existing.workspaceId ?? governanceWorkspaceId,
        sessionId: ctx.sessionId ?? null,
        entityTitle: parentForDetach?.title,
        automationContext: input.automationContext,
      });

      return { status: "detached" as const, message: "Facet detached" };
    }),

  /**
   * Delete entity (soft delete)
   */
  delete: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent"])
          .optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();

      // PROPOSE-TIME VALIDATION: reject a delete against a NONEXISTENT (or
      // already-deleted) entity up front, so an agent never files a proposal that
      // can only fail at approval with a raw 500.
      const existing = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
        columns: { id: true, workspaceId: true, correlationId: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Entity not found: ${input.id}`,
        });
      }
      const governanceWorkspaceId = existing.workspaceId ?? null;

      // 1. Emit .requested event
      const requestedEvent = await auditLog({
        subjectType: "entity",
        action: "delete",
        phase: "requested",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { id: input.id },
      });

      // 2. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "entity",
        action: "delete",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed",
          message: "Deletion proposed for review",
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();

      // B1 / soft-delete reversibility: this is a SOFT delete (sets `deletedAt`
      // below, "Keeping deleted rows preserves audit/proposal reversibility").
      // We DELIBERATELY do NOT delete the entity's document/storage here — a
      // restore must be able to recover the body. The old user-pref-gated
      // `entity.deleteDocument` cascade was removed: on a soft delete it would
      // have orphaned a restore (deleting the body of a still-restorable row).
      // The unconditional document→storage reverse-cascade (EntityBodyService
      // .deleteBody) fires only on the HARD/permanent delete paths
      // (`adminDelete` / `adminBatchDelete`).

      // Snapshot profileSlug before deletion for automation trigger filtering
      const [deletedEntityRow] = await database
        .select({ type: entities.type })
        .from(entities)
        .where(eq(entities.id, input.id))
        .limit(1);

      // Permission is already verified above — soft-delete by id only, no userId
      // filter. entityRepo.delete() restricts to creator (user_id=$userId) which
      // would silently no-op for workspace admins deleting others' entities.
      // Keeping deleted rows preserves audit/proposal reversibility.
      await database
        .update(entities)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(entities.id, input.id));

      // 4. Emit .completed event + side-effects — ONE door (recordDomainMutation).
      // Fire-and-forget (delete already committed); symmetric with create/update,
      // session-scope deletes so playbook automations fire. `logData: {}` keeps
      // the audit row payload unchanged (profileSlug is fan-out-only).
      void recordDomainMutation({
        subjectType: "entity",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        sessionId: ctx.sessionId ?? null,
        data: { profileSlug: deletedEntityRow?.type ?? undefined },
        logData: {},
      });

      // Feedback signal — a human deleted an entity the AI created (carries a
      // correlationId back to the decision that produced it). Best-effort:
      // never fail the delete over an audit-log hiccup.
      if (existing.correlationId) {
        await emitAiCorrection({
          action: "delete",
          userId: ctx.userId,
          subjectId: input.id,
          agentUserId: input.agentUserId,
          workspaceId: governanceWorkspaceId,
          data: {
            kind: AI_KIND.EXTRACT,
            entityId: input.id,
            correlationId: existing.correlationId,
          },
        });
      }

      return { status: "deleted", message: "Entity deleted" };
    }),

  /**
   * Move entities to a different workspace — a governed operation distinct
   * from `update`'s `global` flag (which only promotes to pod-wide/null).
   *
   * Two-sided access check:
   *   - SOURCE: `checkPermissionOrPropose` gated on the entity's CURRENT
   *     workspaceId (mirrors `update`'s governance so agent callers get
   *     proposal-gated instead of blocked, per CLAUDE.md).
   *   - TARGET: `assertWorkspaceWrite` — the caller must also be an editor+
   *     member of the DESTINATION workspace, since moving an entity there is
   *     a write to that workspace too (new check; `update`'s `global` path
   *     never needed one because it only ever moves TO null).
   *
   * Best-effort per entity (mirrors `batchCreate`'s partial-success shape) —
   * one entity's not-found/denied/proposed outcome never blocks the others.
   */
  moveToWorkspace: podProcedure
    .input(
      z.object({
        entityIds: z.array(z.string().uuid()).min(1),
        workspaceId: z.string().uuid(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();

      // Target-side gate: caller must be able to write INTO the destination
      // workspace. Membership check, not row-scoped (there is no row there yet).
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: input.workspaceId,
      });

      const moved: string[] = [];
      const proposed: Array<{ entityId: string; proposalId: string }> = [];
      const errors: Array<{ entityId: string; error: string }> = [];

      for (const entityId of input.entityIds) {
        try {
          const existing = await db.query.entities.findFirst({
            where: and(
              eq(entities.id, entityId),
              isNull(entities.deletedAt),
              entityWriteVisibleWhere(ctx.userId)
            ),
            columns: { id: true, workspaceId: true, correlationId: true },
          });
          if (!existing) {
            errors.push({ entityId, error: "Entity not found" });
            continue;
          }
          const fromWorkspaceId = existing.workspaceId;

          // No-op guard: the entity is already in the destination. Skip the
          // write AND — critically — the `ai_correction` emit. Emitting a
          // `kind:"route"` correction with fromWorkspaceId === toWorkspaceId
          // would tag the entity's AI decision as "corrected", dropping
          // routingAccuracy for a decision that was actually right — the exact
          // metric this feature exists to produce. Reachable via a batch move
          // that includes an entity already in the target. Count it as moved
          // (the caller's desired end-state holds) and move on.
          if (fromWorkspaceId === input.workspaceId) {
            moved.push(entityId);
            continue;
          }

          const correlationId = randomUUID();

          // 1. Emit .requested event
          const requestedEvent = await auditLog({
            subjectType: "entity",
            action: "move",
            phase: "requested",
            subjectId: entityId,
            userId: ctx.userId,
            workspaceId: fromWorkspaceId,
            correlationId,
            data: {
              fromWorkspaceId,
              toWorkspaceId: input.workspaceId,
              reason: input.reason,
            },
          });

          // 2. Source-side permission check — gated on the CURRENT workspace,
          // same governance ladder `update` uses (action mapped to "write" via
          // requiredPermissionFor("update"); "move" itself isn't a registered
          // action in @synap/governance-policy).
          const perm = await checkPermissionOrPropose({
            userId: ctx.userId,
            workspaceId: fromWorkspaceId,
            subjectType: "entity",
            action: "update",
            reasoning: input.reason,
            correlationId,
            requestedEventId: requestedEvent?.id,
            data: { id: entityId, toWorkspaceId: input.workspaceId },
          });

          if ("denied" in perm && perm.denied) {
            errors.push({ entityId, error: perm.reason });
            continue;
          }
          if ("proposalId" in perm) {
            proposed.push({ entityId, proposalId: perm.proposalId });
            continue;
          }

          // 3. Materialize — inline DB write (auto-approved)
          await database
            .update(entities)
            .set({ workspaceId: input.workspaceId })
            .where(eq(entities.id, entityId));

          // 4. Emit .completed event
          await auditLog({
            subjectType: "entity",
            action: "move",
            phase: "completed",
            subjectId: entityId,
            userId: ctx.userId,
            workspaceId: input.workspaceId,
            correlationId,
          });

          moved.push(entityId);

          // Feedback signal (PRIMARY) — a human rerouted an entity the AI
          // placed via a captured decision. Best-effort: never fail the move.
          if (existing.correlationId) {
            await emitAiCorrection({
              action: "reroute",
              userId: ctx.userId,
              subjectId: entityId,
              workspaceId: input.workspaceId,
              data: {
                kind: AI_KIND.ROUTE,
                entityId,
                fromWorkspaceId,
                toWorkspaceId: input.workspaceId,
                correlationId: existing.correlationId,
              },
            });
          }
        } catch (err) {
          errors.push({
            entityId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { moved, proposed, errors };
    }),

  /**
   * Set entity view mode: "document" (default) or "bento" (dashboard).
   *
   * 3-level bento hierarchy for the initial layout:
   *   1. workspace.settings.profileEntityBentoTemplates[profileSlug]  — template-defined default
   *   2. Generic fallback (header + properties + content)
   *
   * State is stored in entity.systemData (not entity.properties) to avoid polluting
   * user-defined fields and bypassing property validation.
   * Any workspace member can set view mode (not just the entity creator).
   *
   * Built-in bento templates for common profiles provide richer defaults than
   * the generic 3-widget layout. Workspace settings can override these.
   */

  // ── Built-in per-profile bento templates ──────────────────────────────────
  // keyed by profileSlug → array of bento blocks
  // These provide sensible defaults when no workspace-level template exists.

  setEntityViewMode: workspaceProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        mode: z.enum(["document", "bento"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Any workspace MEMBER may set the view mode (not just the creator) —
      // that part is deliberate. What was NOT deliberate: the previous lookup
      // was `or(eq(workspaceId, ctx.workspaceId), isNull(workspaceId))`, and
      // that `isNull` branch carried NO user term. A pod-personal row
      // (`workspace_id IS NULL`) belonging to ANOTHER user matched it, so any
      // authenticated user could pass a foreign entity id and mutate its
      // `systemData` — a cross-user WRITE, not merely a read.
      // `entityWriteVisibleWhere` is the canonical floor and applies the OWNER
      // condition to NULL-workspace rows. Same fix as the door below; the two
      // must not diverge again.
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const currentSystemData =
        (entity.systemData as Record<string, unknown>) || {};
      let bentoViewId = currentSystemData.bentoViewId as string | undefined;

      // Create bento view on first switch to bento mode
      if (input.mode === "bento" && !bentoViewId) {
        // Look up workspace settings for a profile-specific bento template
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, ctx.workspaceId as string),
        });

        const profileSlug = entity.type; // entity.type === profile slug
        const workspaceSettings =
          (workspace?.settings as Record<string, unknown>) ?? {};
        const profileTemplates =
          workspaceSettings.profileEntityBentoTemplates as
            Record<string, { blocks: unknown[] }> | undefined;

        // Level 1: profile-specific template from workspace settings
        // Level 2: built-in profile templates for common entity types
        // Level 3: generic 3-widget fallback
        const blocks = profileTemplates?.[profileSlug]?.blocks ??
          DEFAULT_ENTITY_BENTO_TEMPLATES[profileSlug] ?? [
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
              id: "entity-content",
              kind: "widget",
              widgetType: "entity-links",
              pos: { x: 4, y: 2, w: 8, h: 6 },
            },
          ];

        const newViewId = randomUUID();
        await db.insert(views).values({
          id: newViewId,
          workspaceId: ctx.workspaceId || null,
          userId: ctx.userId,
          type: "bento",
          category: "composite",
          name: `${entity.title || "Entity"} Dashboard`,
          config: { layout: "bento", blocks },
          metadata: {
            entityId: input.entityId,
            source: "entity-bento",
            profileSlug,
          },
        });
        bentoViewId = newViewId;
      }

      // Write to systemData column (not properties) — clean separation from user fields
      const updatedSystemData: Record<string, unknown> = {
        ...currentSystemData,
        viewMode: input.mode,
        ...(bentoViewId ? { bentoViewId } : {}),
      };

      await db
        .update(entities)
        .set({ systemData: updatedSystemData, updatedAt: new Date() })
        .where(eq(entities.id, input.entityId));

      return {
        status: "ok",
        viewMode: input.mode,
        bentoViewId: bentoViewId ?? null,
      };
    }),

  /**
   * Set (or clear) the PER-ENTITY renderer override.
   *
   * This is the governed write door for `entities.system_data.renderer` — the
   * lowest, most specific layer of renderer resolution. Precedence (one
   * definition, mirrored in `@synap-core/renderer-runtime`):
   *
   *   1. entity `systemData.renderer`   ← this door
   *   2. entity `systemData.viewMode`/`bentoViewId` (legacy bento toggle)
   *   3. workspace overlay / profile default  (profiles.setProfileRendererOverride)
   *   4. hardcoded host fallback
   *
   * GOVERNED, unlike the sibling `setEntityViewMode` (which is an ungoverned
   * `workspaceProcedure` — a known hole; do not copy it). Same three-way
   * contract as `profiles.setProfileRendererOverride`: applied / proposed /
   * FORBIDDEN.
   */
  setEntityRenderer: workspaceProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        /** `null` clears the override. Narrowed to `cell` — see EntityRendererRefSchema. */
        ref: EntityRendererRefSchema.nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Load first — the write is gated on the row's OWN workspace via the
      // canonical write floor, never on a request-supplied workspaceId
      // (access-layer rule). `entityWriteVisibleWhere` also applies the
      // OWNER floor to NULL-workspace (pod-personal) rows — the naive
      // `or(eq(workspaceId, ctx.workspaceId), isNull(workspaceId))` that
      // `setEntityViewMode` uses does NOT, and lets any user reach another
      // user's unfiled entities.
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
        columns: {
          id: true,
          workspaceId: true,
          type: true,
          title: true,
          systemData: true,
        },
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: ctx.agentUserId ?? undefined,
        workspaceId: entity.workspaceId ?? ctx.workspaceId,
        subjectType: "entity",
        action: "renderer.set",
        source: ctx.source ?? undefined,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        sessionId: ctx.sessionId ?? undefined,
        projectId: ctx.projectId ?? undefined,
        data: {
          entityId: input.entityId,
          entityTitle: entity.title,
          profileSlug: entity.type,
          ref: input.ref,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          success: false,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // MERGE — `systemData` is a shared bag (viewMode, bentoViewId,
      // onboardingScaffold, mergedInto, …). A wholesale `.set({ systemData })`
      // would silently destroy every other key.
      const nextSystemData = mergeSystemData(entity.systemData, {
        renderer: input.ref,
      });

      await db
        .update(entities)
        .set({ systemData: nextSystemData, updatedAt: new Date() })
        .where(eq(entities.id, input.entityId));

      logger.info(
        {
          entityId: input.entityId,
          cleared: input.ref === null,
          cellKey: input.ref?.cellKey,
          workspaceId: entity.workspaceId ?? ctx.workspaceId,
        },
        "Entity renderer override updated"
      );

      return {
        success: true,
        status: "applied" as const,
        proposalId: null,
      };
    }),

  /**
   * Admin: list entities pod-wide or scoped to a workspace.
   *
   * - workspaceId === undefined → all entities pod-wide
   * - workspaceId === null      → only pod-wide entities (workspace_id IS NULL)
   * - workspaceId === string    → that workspace's entities
   */
  adminList: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.union([z.string().uuid(), z.null()]).optional(),
        profileSlug: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const conditions: any[] = [isNull(entities.deletedAt)];

      if (input.workspaceId === null) {
        conditions.push(isNull(entities.workspaceId));
      } else if (typeof input.workspaceId === "string") {
        conditions.push(eq(entities.workspaceId, input.workspaceId));
      }

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }

      if (input.search && input.search.trim().length > 0) {
        const term = `%${input.search.trim()}%`;
        conditions.push(
          or(
            drizzleSql`${entities.title} ILIKE ${term}`,
            drizzleSql`${entities.preview} ILIKE ${term}`,
            drizzleSql`${entities.properties}::text ILIKE ${term}`
          )
        );
      }

      const totalRow = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(entities)
        .where(and(...conditions));
      const total = totalRow[0]?.count ?? 0;

      const rows = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.updatedAt)],
        limit: input.limit,
        offset: input.offset,
        columns: {
          id: true,
          title: true,
          preview: true,
          type: true,
          workspaceId: true,
          userId: true,
          createdAt: true,
          updatedAt: true,
          properties: true,
        },
      });

      // Resolve workspace names for the rows
      const wsIds = Array.from(
        new Set(
          rows.map((r) => r.workspaceId).filter((id): id is string => !!id)
        )
      );
      const wsRows =
        wsIds.length > 0
          ? await db.query.workspaces.findMany({
              where: inArray(workspaces.id, wsIds),
              columns: { id: true, name: true },
            })
          : [];
      const wsNameById = new Map(wsRows.map((w) => [w.id, w.name]));

      // Truncate properties to keep payload small
      const items = rows.map((r) => {
        const propsString = JSON.stringify(r.properties ?? {});
        const truncated =
          propsString.length > 240
            ? propsString.slice(0, 240) + "…"
            : propsString;
        return {
          id: r.id,
          title: r.title,
          preview: r.preview,
          profileSlug: r.type,
          workspaceId: r.workspaceId,
          workspaceName: r.workspaceId
            ? (wsNameById.get(r.workspaceId) ?? null)
            : null,
          userId: r.userId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          propertiesPreview: truncated,
        };
      });

      return { items, total };
    }),

  /**
   * Batch create entities in a single call.
   *
   * Auto-creates missing profiles on the fly (workspace-scoped, with optional
   * displayName/icon/color). Each entity is identified by a caller-supplied
   * `refKey` (e.g. "app:web", "pkg:@synap-core/client") so relations can
   * reference them without knowing UUIDs ahead of time.
   *
   * Idempotent: entities with the same (profileSlug, title) in the same
   * workspace are returned as-is, not duplicated.
   */
  batchCreate: podProcedure
    .input(
      z.object({
        entities: z.array(
          z.object({
            /** Stable caller-supplied reference key (e.g. "app:web", "pkg:@synap-core/client") */
            refKey: z.string().min(1),
            profileSlug: z.string().min(1),
            title: z.string().min(1),
            description: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            content: z.string().optional(),
            source: z
              .enum(["user", "ai", "intelligence", "system", "agent", "cli"])
              .optional(),
            /** If the profile doesn't exist, create it with these hints */
            profileHints: z
              .object({
                displayName: z.string().optional(),
                icon: z.string().optional(),
                color: z.string().optional(),
                description: z.string().optional(),
              })
              .optional(),
          })
        ),
      })
    )
    .output(
      z.object({
        created: z.number(),
        skipped: z.number(),
        profilesCreated: z.number(),
        entityIds: z.record(z.string(), z.string()), // refKey → entityId
        errors: z.array(
          z.object({
            refKey: z.string(),
            error: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const entityRepo = new EntityRepository(database, eventRepo);
      const profileRepo = new (
        await import("@synap/database")
      ).ProfileRepository(database);

      // 1. Ensure all profiles exist (auto-create missing ones)
      const profileCache = new Map<string, string>(); // slug → id
      // slug → the profile's entity-scope ("pod" | "workspace"), for placement.
      const entityScopeCache = new Map<string, string | null>();
      // slug → resolved workspace placement (computed once per slug via the door).
      const placementCache = new Map<string, string | null>();
      let profilesCreated = 0;

      // Gather unique profile slugs that need hints
      const profileHintsMap = new Map<
        string,
        {
          displayName?: string;
          icon?: string;
          color?: string;
          description?: string;
        }
      >();
      for (const e of input.entities) {
        if (e.profileHints && !profileHintsMap.has(e.profileSlug)) {
          profileHintsMap.set(e.profileSlug, e.profileHints);
        }
      }

      for (const entity of input.entities) {
        if (profileCache.has(entity.profileSlug)) continue;

        // Resolve the existing profile. `getBySlug` tolerates a null workspace
        // (pod-wide floor: SYSTEM/SHARED + the caller's member profiles) —
        // `getBySlugForWorkspace` demands a string, so it can't serve the relaxed
        // pod-wide path. With a workspace it delegates to the same lookup, so
        // behavior is identical when one is present.
        const existing = await profileRepo.getBySlug(
          entity.profileSlug,
          ctx.workspaceId ?? undefined,
          ctx.userId
        );
        if (existing) {
          profileCache.set(entity.profileSlug, existing.id);
          entityScopeCache.set(
            entity.profileSlug,
            existing.entityScope ?? null
          );
          continue;
        }

        // Profile doesn't exist. Auto-creating it needs a concrete workspace to
        // scope the new (workspace-scoped) profile to — the pod-wide path can't
        // invent one, so leave the slug uncached; each such row is reported as an
        // error in step 3 rather than forcing a bogus scope.
        if (!ctx.workspaceId) continue;
        const hints = profileHintsMap.get(entity.profileSlug) ?? {};
        const newProfile = await profileRepo.create({
          slug: entity.profileSlug,
          displayName: hints.displayName ?? entity.profileSlug,
          uiHints: {
            icon: hints.icon,
            color: hints.color,
            description: hints.description,
          },
          scope: "workspace" as any,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        });
        profileCache.set(entity.profileSlug, newProfile.id);
        entityScopeCache.set(
          entity.profileSlug,
          newProfile.entityScope ?? null
        );
        profilesCreated++;
      }

      // 2. Resolve per-slug placement via the ONE door, UP FRONT (cached per
      // slug). An explicit ambient workspace PINS every row to it (rung 1 —
      // identical to the pre-relax behavior, no extra DB query); with no
      // ambient, a pod kind lands pod-wide and a workspace-scoped kind follows
      // its ontology (rung 2) — which can resolve to a concrete workspace even
      // on the headerless path. Resolving this BEFORE the idempotency check
      // below (rather than lazily per-row during creation) lets that check key
      // on where each slug will actually land.
      for (const entity of input.entities) {
        if (placementCache.has(entity.profileSlug)) continue;
        const placement = await resolveWorkspacePlacement(database, {
          userId: ctx.userId,
          kindSlug: entity.profileSlug,
          entityScope:
            (entityScopeCache.get(entity.profileSlug) as
              "pod" | "workspace" | null) ?? null,
          explicitWorkspaceId: ctx.workspaceId ?? undefined,
          ambientWorkspaceId: ctx.workspaceId,
        });
        placementCache.set(entity.profileSlug, placement.workspaceId);
      }

      // 3. Check for existing entities (idempotency by profileSlug + title),
      // scoped to the RESOLVED placement workspace per slug — not
      // unconditionally `isNull(workspaceId)`. On the headerless path a
      // workspace-scoped kind can resolve (rung 2 ontology) into a concrete
      // workspace; keying the dedup check on `isNull` alone missed those rows
      // entirely, so a re-run created a duplicate instead of matching the one
      // already placed there. Callers that pass an explicit ctx.workspaceId are
      // unaffected — every slug still resolves to that same pinned workspace.
      const placedWorkspaceIds = new Set(placementCache.values());
      const existingEntities = await database.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          or(
            ...Array.from(placedWorkspaceIds).map((wsId) =>
              wsId
                ? eq(entities.workspaceId, wsId)
                : isNull(entities.workspaceId)
            )
          ),
          inArray(
            entities.type,
            input.entities.map((e) => e.profileSlug)
          )
        ),
      });

      const existingByKey = new Map<string, string>(); // "slug:title:workspaceId" → entityId
      for (const e of existingEntities) {
        existingByKey.set(
          `${e.type}:${e.title}:${e.workspaceId ?? "null"}`,
          e.id
        );
      }

      // 4. Create missing entities
      const entityIds: Record<string, string> = {};
      const errors: Array<{ refKey: string; error: string }> = [];
      let created = 0;
      let skipped = 0;

      for (const entity of input.entities) {
        const placedWorkspaceId =
          placementCache.get(entity.profileSlug) ?? null;
        const cacheKey = `${entity.profileSlug}:${entity.title}:${placedWorkspaceId ?? "null"}`;

        // Already exists → skip
        if (existingByKey.has(cacheKey)) {
          entityIds[entity.refKey] = existingByKey.get(cacheKey)!;
          skipped++;
          continue;
        }

        try {
          const profileId = profileCache.get(entity.profileSlug);
          if (!profileId) {
            throw new Error(`Profile ${entity.profileSlug} not in cache`);
          }

          const result = await entityRepo.create(
            {
              profileId,
              title: entity.title,
              properties: entity.properties,
              workspaceId: placedWorkspaceId,
              userId: ctx.userId,
              skipValidation: true, // seed data — trust the input
            },
            ctx.userId
          );
          entityIds[entity.refKey] = result.id;
          created++;
        } catch (err) {
          errors.push({
            refKey: entity.refKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { created, skipped, profilesCreated, entityIds, errors };
    }),

  /**
   * Admin: get full entity detail by id (pod-admin only).
   */
  adminGet: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const row = await db.query.entities.findFirst({
        where: eq(entities.id, input.id),
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const ws = row.workspaceId
        ? await db.query.workspaces.findFirst({
            where: eq(workspaces.id, row.workspaceId),
            columns: { id: true, name: true },
          })
        : null;

      return {
        ...row,
        properties: row.properties ?? {},
        systemData: row.systemData ?? {},
        workspaceName: ws?.name ?? null,
      };
    }),

  /**
   * Admin: hard-delete a single entity by id (no userId filter).
   */
  adminDelete: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      const [deleted] = await database
        .delete(entities)
        .where(eq(entities.id, input.id))
        .returning({
          id: entities.id,
          type: entities.type,
          documentId: entities.documentId,
        });
      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }
      // B1: a HARD delete reclaims the linked document row + ALL its storage
      // objects (the current-content object + every version snapshot).
      // Previously orphaned — adminDelete cleaned up neither. Unconditional
      // reverse-cascade via the one body door. The entity row is already gone,
      // so we pass the captured `documentId` directly.
      if (deleted.documentId) {
        await new EntityBodyService(database, eventRepository).deleteBody({
          documentId: deleted.documentId,
        });
      }
      console.log(
        `[pod-admin] adminDelete: entity ${deleted.id} (type=${deleted.type}) permanently deleted`
      );
      return { deleted: true, id: deleted.id, type: deleted.type };
    }),

  /**
   * Admin: hard-delete multiple entities by id list or by profileSlug/workspaceId filter.
   * Requires at least one of: ids or profileSlug.
   */
  adminBatchDelete: podAdminProcedure
    .input(
      z
        .object({
          ids: z.array(z.string().uuid()).optional(),
          profileSlug: z.string().optional(),
          workspaceId: z.string().uuid().nullable().optional(),
        })
        .refine(
          (v) => (v.ids?.length ?? 0) > 0 || v.profileSlug !== undefined,
          "Provide ids or profileSlug"
        )
    )
    .mutation(async ({ input }) => {
      const database = await getDb();
      const conditions: any[] = [];
      if (input.ids?.length) {
        conditions.push(inArray(entities.id, input.ids));
      }
      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }
      if (input.workspaceId === null) {
        conditions.push(isNull(entities.workspaceId));
      } else if (input.workspaceId) {
        conditions.push(eq(entities.workspaceId, input.workspaceId));
      }
      const deleted = await database
        .delete(entities)
        .where(and(...conditions))
        .returning({ id: entities.id, documentId: entities.documentId });
      // B1: reclaim each hard-deleted entity's document + storage objects
      // (previously orphaned). Unconditional reverse-cascade via the one body
      // door; best-effort per row so one cleanup miss never aborts the batch.
      const bodyService = new EntityBodyService(database, eventRepository);
      for (const row of deleted) {
        if (row.documentId) {
          await bodyService
            .deleteBody({ documentId: row.documentId })
            .catch(() => {});
        }
      }
      console.log(
        `[pod-admin] adminBatchDelete: ${deleted.length} entities permanently deleted`
      );
      return { deletedCount: deleted.length };
    }),

  /**
   * Admin: list profile slugs with entity counts (for the profile filter).
   */
  adminListProfiles: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.union([z.string().uuid(), z.null()]).optional(),
      })
    )
    .query(async ({ input }) => {
      const conditions: any[] = [isNull(entities.deletedAt)];
      if (input.workspaceId === null) {
        conditions.push(isNull(entities.workspaceId));
      } else if (typeof input.workspaceId === "string") {
        conditions.push(eq(entities.workspaceId, input.workspaceId));
      }

      const rows = await db
        .select({
          profileSlug: entities.type,
          count: drizzleSql<number>`count(*)::int`,
        })
        .from(entities)
        .where(and(...conditions))
        .groupBy(entities.type)
        .orderBy(desc(drizzleSql`count(*)`));

      return rows.map((r) => ({
        profileSlug: r.profileSlug,
        count: r.count,
      }));
    }),
});
