/**
 * Entities Router - Profile-Based Entity Management
 *
 * Event-driven CRUD with audit trail:
 *   .requested → permission check → inline materialization → .completed
 * Proposal path (AI requiring review) defers to the materializer worker.
 *
 * Supports global entities (workspaceId = null) visible across all workspaces.
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
  sql,
  eq,
  desc,
  and,
  or,
  isNull,
  inArray,
  getDb,
  ProfileResolutionService,
  EventRepository,
  EntityRepository,
  DocumentRepository,
  FacetRepository,
  getEffectiveFacets,
  facetVisibilityConditions,
  drizzleSql,
  exists,
  links,
  type LinkEndpointType,
  type LinkType,
  linkEntityToProject,
  stampProvenance,
  FacetProfileKindError,
  FacetKindMismatchError,
  extractIdentitySignals,
  registerIdentitySignals,
  IDENTITY_SIGNAL_PROPERTY_KEYS,
} from "@synap/database";
import {
  entities,
  documents,
  views,
  workspaces,
  entityExternalLinks,
  userEntityState,
  profiles,
  entityFacets,
} from "@synap/database/schema";
import { type Entity, EntitySchema } from "@synap-core/types";
import { entityToWire } from "./hub-protocol/rest/_codecs/entity.js";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { resolveViewTrust } from "../services/view-trust-service.js";
import { auditLog } from "../utils/audit-log.js";
import {
  emitSideEffects,
  getBoss,
  type SideEffectPayload,
} from "@synap/events";
import { randomUUID } from "crypto";
import { syncPropertyToRelations } from "../utils/property-relation-sync.js";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
import { dispatchWebhooksForEvent } from "../utils/webhook-delivery.js";
import { workspaceLensWhere } from "../utils/user-visible-where.js";
import { accessScopeWhere, projectLensWhere } from "../utils/project-scope.js";
import { resolveContentTarget } from "../import/materialize-document.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "entities-router" });

// The entity user floor = the canonical DATA-table resolver (`accessScopeWhere`,
// no lens): pod-personal (NULL workspace, owner-gated) OR workspace-member access
// OR exposure membership (a PROJECT member via belongs_to_project OR a CLIENT via
// visible_to sees their anchor's exposed entities across workspaces). Delegating
// here converges entities onto the SAME resolver documents/the registry use —
// behaviour-identical to the prior hand-rolled union (proven equivalent: same
// three branches, same default EXPOSURE_RELATION_TYPES whitelist).
function entityVisibleWhere(userId: string) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
  });
}

function entityLensWhere(
  userId: string,
  lens?: string | null,
  opts?: { includePodWide?: boolean }
) {
  if (lens === undefined) return entityVisibleWhere(userId);
  if (lens === null) {
    return and(isNull(entities.workspaceId), eq(entities.userId, userId))!;
  }
  const workspaceBranch = workspaceLensWhere(
    entities.workspaceId,
    userId,
    lens
  );
  if (!opts?.includePodWide) return workspaceBranch;
  return or(
    and(isNull(entities.workspaceId), eq(entities.userId, userId)),
    workspaceBranch
  )!;
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
function toApiEntity(entity: any): Entity {
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
  } as Entity;
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
    "openclaw",
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
      return { counts };
    }),

  /**
   * Create entity with profile-based type system
   *
   * When `global: true`, the entity is created without a workspaceId
   * and will be visible across all workspaces.
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
         * "openwebui-pipeline", "openclaw", "extension") so the proposal layer
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
            "openclaw",
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

      // 1. Emit .requested event — records intent regardless of outcome
      const requestedEvent = await auditLog({
        subjectType: "entity",
        action: "create",
        phase: "requested",
        subjectId: entityId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
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
        workspaceId: governanceWorkspaceId,
        subjectType: "entity",
        action: "create",
        source: input.source,
        issuer,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        sessionId: ctx.sessionId ?? undefined,
        projectId: input.projectId ?? undefined,
        data: {
          id: entityId,
          profileSlug,
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
          content: input.content,
          global: input.global,
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
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);

      // Resolve profile for defaultValues and entityScope
      let resolvedProfile: any = earlyResolvedProfile;
      if (!resolvedProfile && input.profileSlug) {
        const resolutionService = new ProfileResolutionService(database);
        resolvedProfile = await resolutionService.resolveProfile(
          input.profileSlug,
          ctx.userId,
          governanceWorkspaceId
        );
      }
      if (!resolvedProfile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${profileSlug}`,
        });
      }

      // Determine effective workspaceId. Precedence:
      //   1. global flag           → null (visible everywhere)
      //   2. explicit targetWorkspaceId → that workspace (wins for ALL profiles,
      //      incl. pod-default ones)
      //   3. workspaceScoped flag  → the active workspace (explicit isolation
      //      request, e.g. imports — overrides a profile's pod-default)
      //   4. otherwise             → profile pod-default (pod → null) else the
      //      active workspace (today's interactive behavior, unchanged)
      const profileEntityScope = resolvedProfile.entityScope ?? "workspace";
      const explicitWorkspaceScope = input.workspaceScoped === true;
      const entityWorkspaceId = input.global
        ? null
        : (input.targetWorkspaceId ??
          (explicitWorkspaceScope
            ? governanceWorkspaceId
            : profileEntityScope === "pod"
              ? null
              : governanceWorkspaceId));

      // Merge profile.defaultValues into caller-supplied properties.
      const profileDefaults =
        (resolvedProfile?.defaultValues as Record<string, unknown>) ?? {};
      const effectiveProperties: Record<string, unknown> = {
        ...profileDefaults,
        ...(input.properties ?? {}),
      };

      let createdEntity: any;

      // Resolve where content lives ONCE (heuristic-gated, shared with the
      // capture paths): long-form → a versioned document linked via documentId,
      // short → inline properties.content. The document is scoped to the SAME
      // workspace as the entity so a workspace purge reclaims both.
      const { documentId: contentDocumentId, inlineContent } =
        await resolveContentTarget({
          content: input.content || undefined,
          title: input.title || undefined,
          userId: ctx.userId,
          workspaceId: entityWorkspaceId ?? null,
          db: database,
          eventRepo,
          logContext: { profileSlug, title: input.title },
        });
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
        // points to it) so we don't leak storage + a stranded row.
        if (contentDocumentId) {
          try {
            await new DocumentRepository(database, eventRepo).delete(
              contentDocumentId,
              ctx.userId
            );
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

      // Membership: file the entity into the active project lens (the project
      // mirror of workspaceId) on the granted inline path. The proposal path is
      // covered by checkPermissionOrPropose threading projectId → the materializer.
      // Idempotent via relations_belongs_to_project_unique.
      if (input.projectId && createdEntity?.id) {
        await linkEntityToProject(database, {
          entityId: createdEntity.id,
          projectId: input.projectId,
          userId: ctx.userId,
          workspaceId: entityWorkspaceId ?? null,
        });
      }

      // 3b. Auto-sync entity_id properties → relations (non-blocking)
      if (
        createdEntity.profileId &&
        effectiveProperties &&
        Object.keys(effectiveProperties).length > 0
      ) {
        syncPropertyToRelations(
          createdEntity.id,
          createdEntity.profileId,
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

      // 3c. Auto-register identity signals (email/phone/url/handle) — non-blocking.
      // Feeds resolveIdentity's strong path so later writes dedup against this
      // entity instead of creating a duplicate. Never blocks or fails the mutation.
      if (createdEntity?.id) {
        const signals = extractIdentitySignals(
          propertiesWithContent as Record<string, unknown>
        );
        if (signals.length > 0) {
          runSignalWrite(() =>
            registerIdentitySignals(
              database,
              createdEntity.id,
              signals,
              "entities.create"
            ).catch((err) => {
              logger.warn(
                { err },
                "[entities.create] Identity signal registration failed"
              );
            })
          );
        }
      }

      // 4. Emit .completed event + side-effects
      await auditLog({
        subjectType: "entity",
        action: "create",
        phase: "completed",
        subjectId: createdEntity.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { profileSlug, title: input.title, global: input.global },
      });

      emitSideEffects({
        subjectType: "entity",
        action: "create",
        subjectId: createdEntity.id,
        userId: ctx.userId,
        workspaceId: governanceWorkspaceId,
        // Stamp the session so the automation matcher resolves it → playbook →
        // `member_of` automations and fires them for entities produced in this
        // session (e.g. import under a contact-leads playbook). Null on
        // non-session paths → workspace-wide automations only (unchanged).
        sessionId: ctx.sessionId ?? null,
        data: { profileSlug, title: input.title },
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

      return {
        status: "created",
        message: "Entity created",
        id: createdEntity.id,
        entity: toApiEntity(createdEntity),
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
         * PRODUCT DECISION (scoped default): when a workspace is active, the
         * list returns ONLY that workspace's entities by default — pod-wide
         * (workspaceId IS NULL) rows are no longer mixed in, so a fresh
         * workspace starts clean. Set `includePodWide: true` to restore the
         * legacy union (this workspace's rows OR pod-wide globals). No data is
         * migrated. Ignored for `globalOnly` and workspace-less callers (those
         * already return pod-wide-only).
         */
        includePodWide: z.boolean().optional().default(true),
        /**
         * Explicit list lens. `undefined` falls back to ctx.workspaceId for
         * backwards compatibility; `null` returns the caller's pod-wide rows.
         */
        workspaceId: z.string().uuid().nullable().optional(),
        /**
         * Project LENS (project-centric-scope) — narrow to one project's data.
         * In the INPUT (not a header) so it lands in the React Query key and the
         * cache separates per project. A lens only narrows: access is enforced by
         * the floor (`entityVisibleWhere`, which already grants project members);
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
      })
    )
    .query(async ({ input, ctx }) => {
      // Scoped-by-default: with an active workspace and includePodWide=false,
      // return ONLY that workspace's rows. includePodWide=true restores the
      // legacy "workspace OR pod-wide globals" union. globalOnly / workspace-less
      // callers are unaffected (they already resolve to pod-wide-only below).
      const lensWorkspaceId =
        input.workspaceId !== undefined ? input.workspaceId : ctx.workspaceId;
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
        workspaceScopeCondition = entityVisibleWhere(ctx.userId);
      } else if (input.globalOnly || input.workspaceId === null) {
        workspaceScopeCondition = entityLensWhere(ctx.userId, null);
      } else if (lensWorkspaceId) {
        workspaceScopeCondition = entityLensWhere(ctx.userId, lensWorkspaceId, {
          includePodWide: input.includePodWide,
        });
      } else {
        workspaceScopeCondition = entityVisibleWhere(ctx.userId);
      }
      // Visibility is enforced at QUERY level — `list` is a `podProcedure`, so there
      // is NO procedure-level workspace gate. `workspaceScopeCondition` delegates to
      // `entityLensWhere`/`entityVisibleWhere`, which restrict rows to the user floor
      // (workspace membership + pod-personal + project membership). `userId` is a
      // security predicate there, not mere attribution.
      const conditions: any[] = [isNull(entities.deletedAt)];

      if (input.sourceProposalId) {
        conditions.push(eq(entities.sourceProposalId, input.sourceProposalId));
      }

      if (input.profileSlug) {
        // Resolve profile slugs to query (optionally including child profiles)
        const database = await getDb();
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
          conditions.push(eq(entities.type, profileSlugs[0]));
        } else {
          conditions.push(inArray(entities.type, profileSlugs));
        }

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
        let facetProfileId = input.facetProfileId;
        if (!facetProfileId && input.facetSlug) {
          const facetProfile = await db.query.profiles.findFirst({
            where: eq(profiles.slug, input.facetSlug),
            columns: { id: true },
          });
          facetProfileId = facetProfile?.id;
        }
        if (facetProfileId) {
          conditions.push(
            exists(
              db
                .select({ one: drizzleSql`1` })
                .from(entityFacets)
                .where(
                  and(
                    eq(entityFacets.entityId, entities.id),
                    eq(entityFacets.profileId, facetProfileId),
                    isNull(entityFacets.deletedAt),
                    ...facetVisibilityConditions({
                      userId: ctx.userId,
                      workspaceId: lensWorkspaceId,
                    })
                  )
                )
            )!
          );
        } else {
          // Unknown facetSlug — no entity can match; short-circuit to empty.
          conditions.push(drizzleSql`false`);
        }
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

      const { items, pagination } = buildPaginatedResponse(
        results.map(toApiEntity),
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
        conditions.push(eq(entities.type, input.profileSlug));
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return { entities: results.map(toApiEntity) };
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
      const eventRepo = new EventRepository(sql);
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

      return { entities: results.map(toApiEntity) };
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
        : entityVisibleWhere(ctx.userId);
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
      // Floor: every search result must belong to the caller. This prevents
      // pod-personal entities (workspaceId IS NULL) that belong to OTHER users
      // from leaking through — both the pod-scoped-profile branch (which
      // previously skipped the workspace filter) and the workspace branch
      // (which had no per-user guard on the NULL case).
      const conditions: any[] = [entityVisibleWhere(ctx.userId)];

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));

        // For workspace-scoped profiles, also narrow to the active workspace
        // (plus pod-wide globals already covered by the floor above).
        const database = await getDb();
        const profileService = new ProfileResolutionService(database);
        const entityScope = await profileService.getEntityScope(
          input.profileSlug,
          ctx.workspaceId
        );

        if (entityScope !== "pod") {
          conditions.push(
            or(
              eq(entities.workspaceId, ctx.workspaceId),
              isNull(entities.workspaceId)
            )
          );
        }
      } else {
        conditions.push(
          or(
            eq(entities.workspaceId, ctx.workspaceId),
            isNull(entities.workspaceId)
          )
        );
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return { entities: results.map(toApiEntity) };
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
          entityVisibleWhere(ctx.userId)
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
         * Rendering/property lens. Object access is still by entity id, but
         * profile overlays are workspace-sensitive and must be cache-keyed by
         * callers that request `includeProfile`.
         */
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .output(
      z.object({
        entity: z.any(),
        profile: z.any().optional(),
        effectiveProperties: z.array(z.any()).optional(),
        /**
         * Live facets (role-profiles attached to this entity) resolved through
         * the same workspace lens as `effectiveProperties`. Additive/optional —
         * present only on the `includeProfile` path. Kind + Facets (Wave 1C).
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
          entityVisibleWhere(ctx.userId)
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      // Reinforcement signal (memory-salience substrate, Wave 2 Phase 1):
      // fire-and-forget access bump on SINGLE-entity opens only. This just
      // accumulates data (viewCount / lastViewedAt) so the signal is warm when
      // Phase 2 ranking lands — no read-behaviour change here. NOT wired into the
      // bulk list/`getEntities` path: bumping per-row there would amplify a 50-row
      // list into 50 writes and hammer the rate-limit-sensitive pod. It must NEVER
      // block or fail the fetch, so it is not awaited in the response path and all
      // errors are swallowed at debug level.
      void (async () => {
        try {
          const now = new Date();
          await db
            .insert(userEntityState)
            .values({
              userId: ctx.userId,
              itemId: entity.id,
              itemType: "entity",
              viewCount: 1,
              lastViewedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                userEntityState.userId,
                userEntityState.itemId,
                userEntityState.itemType,
              ],
              set: {
                viewCount: drizzleSql`${userEntityState.viewCount} + 1`,
                lastViewedAt: now,
                updatedAt: now,
              },
            });
        } catch (err) {
          logger.debug(
            { err, entityId: entity.id },
            "[entities.get] access-bump upsert failed (non-fatal)"
          );
        }
      })();

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

      const lensWorkspaceId =
        input.workspaceId !== undefined
          ? input.workspaceId
          : (entity.workspaceId ?? ctx.workspaceId ?? null);

      if (lensWorkspaceId) {
        const { validateWorkspaceAccess } =
          await import("../utils/workspace-membership.js");
        const allowedWorkspaceIds = await validateWorkspaceAccess(ctx.userId, [
          lensWorkspaceId,
        ]);
        if (!allowedWorkspaceIds.includes(lensWorkspaceId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Access denied to workspace lens",
          });
        }
      }

      const database = await getDb();
      const resolutionService = new ProfileResolutionService(database);
      const profile = await resolutionService.resolveProfile(
        entity.type,
        ctx.userId,
        lensWorkspaceId
      );

      if (!profile) return { entity: typedEntity, externalLinks };

      const effectiveProperties =
        await resolutionService.getEffectiveProperties(
          profile.id,
          lensWorkspaceId
        );

      // Kind + Facets: resolve the entity's live facets through the SAME
      // workspace lens as the property overlays. Additive — never blocks the
      // envelope.
      const facets = await getEffectiveFacets(database, entity.id, {
        userId: ctx.userId,
        workspaceId: lensWorkspaceId,
      });

      return {
        entity: typedEntity,
        profile,
        effectiveProperties,
        // Spread into anonymous objects: interfaces lack index signatures,
        // so EntityFacet/Profile aren't assignable to the Record-typed
        // output schema directly.
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
          entityVisibleWhere(ctx.userId)
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
      const forcePropose = promotesToGlobal || changesProfileType;

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
      const eventRepo = new EventRepository(sql);
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

      // 4. Emit .completed event + side-effects
      await auditLog({
        subjectType: "entity",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
      });

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

      emitSideEffects({
        subjectType: "entity",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: governanceWorkspaceId,
        // Session-scope lifecycle updates (e.g. dealStage lead→client inside a
        // session) so playbook `member_of` automations fire. Null otherwise.
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
          entityVisibleWhere(ctx.userId)
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
          where: eq(entities.id, input.contextEntityId),
          columns: { title: true },
        });
        contextEntityTitle = contextEntity?.title ?? undefined;
      }

      const facetWorkspaceId =
        input.workspaceId !== undefined
          ? input.workspaceId
          : (parent.workspaceId ?? null);
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
      const eventRepo = new EventRepository(sql);
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
      const eventRepo = new EventRepository(sql);
      const facetRepo = new FacetRepository(database, eventRepo);

      // Load the facet (floor: owned by the caller) to resolve entity + lens.
      const existing = await facetRepo.getById(input.facetId);
      if (!existing || existing.userId !== ctx.userId) {
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
        ctx.userId
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
      const eventRepo = new EventRepository(sql);
      const facetRepo = new FacetRepository(database, eventRepo);

      const existing = await facetRepo.getById(input.facetId);
      if (!existing || existing.userId !== ctx.userId) {
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
      await facetRepo.detach(input.facetId, ctx.userId);

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
          entityVisibleWhere(ctx.userId)
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
      const eventRepo = new EventRepository(sql);
      const docRepo = new DocumentRepository(database, eventRepo);

      const { getUserPreference } = await import("@synap/database");
      const userPref = await getUserPreference(
        ctx.userId,
        "entity.deleteDocument"
      );

      if (userPref) {
        const entity = await db.query.entities.findFirst({
          where: and(
            eq(entities.id, input.id),
            eq(entities.userId, ctx.userId)
          ),
        });

        if (entity?.documentId) {
          const document = await db.query.documents.findFirst({
            where: and(
              eq(documents.id, entity.documentId),
              eq(documents.userId, ctx.userId)
            ),
          });

          if (document) {
            const { storage } = await import("@synap/storage");
            try {
              if (document.storageKey)
                await storage.delete(document.storageKey);
            } catch {
              // Storage deletion is best-effort — entity delete proceeds regardless
            }
            await docRepo.delete(entity.documentId, ctx.userId);
          }
        }
      }

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

      // 4. Emit .completed event + side-effects
      auditLog({
        subjectType: "entity",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
      });

      emitSideEffects({
        subjectType: "entity",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: governanceWorkspaceId,
        // Symmetric with create/update — session-scope deletes too. Null otherwise.
        sessionId: ctx.sessionId ?? null,
        data: { profileSlug: deletedEntityRow?.type ?? undefined },
      });

      // Feedback signal — a human deleted an entity the AI created (carries a
      // correlationId back to the decision that produced it). Best-effort:
      // never fail the delete over an audit-log hiccup.
      if (existing.correlationId) {
        try {
          await auditLog({
            subjectType: "ai_correction",
            action: "delete",
            phase: "completed",
            subjectId: input.id,
            userId: ctx.userId,
            agentUserId: input.agentUserId,
            workspaceId: governanceWorkspaceId,
            data: {
              kind: "extract",
              entityId: input.id,
              correlationId: existing.correlationId,
            },
          });
        } catch (err) {
          logger.warn(
            { err, entityId: input.id },
            "ai_correction delete emit failed (delete preserved)"
          );
        }
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
              entityVisibleWhere(ctx.userId)
            ),
            columns: { id: true, workspaceId: true, correlationId: true },
          });
          if (!existing) {
            errors.push({ entityId, error: "Entity not found" });
            continue;
          }
          const fromWorkspaceId = existing.workspaceId;
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
            try {
              await auditLog({
                subjectType: "ai_correction",
                action: "reroute",
                phase: "completed",
                subjectId: entityId,
                userId: ctx.userId,
                workspaceId: input.workspaceId,
                data: {
                  kind: "route",
                  entityId,
                  fromWorkspaceId,
                  toWorkspaceId: input.workspaceId,
                  correlationId: existing.correlationId,
                },
              });
            } catch (err) {
              logger.warn(
                { err, entityId },
                "ai_correction reroute emit failed (move preserved)"
              );
            }
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
      // Fetch entity — allow any workspace member (not just creator)
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          or(
            eq(entities.workspaceId, ctx.workspaceId!),
            isNull(entities.workspaceId)
          )
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
            | Record<string, { blocks: unknown[] }>
            | undefined;

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
  batchCreate: workspaceProcedure
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
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);
      const profileRepo = new (
        await import("@synap/database")
      ).ProfileRepository(database);

      // 1. Ensure all profiles exist (auto-create missing ones)
      const profileCache = new Map<string, string>(); // slug → id
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

        // Try to resolve existing profile
        const existing = await profileRepo.getBySlugForWorkspace(
          entity.profileSlug,
          ctx.workspaceId
        );
        if (existing) {
          profileCache.set(entity.profileSlug, existing.id);
          continue;
        }

        // Profile doesn't exist — create it
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
        profilesCreated++;
      }

      // 2. Check for existing entities (idempotency by profileSlug + title)
      const existingEntities = await database.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          eq(entities.workspaceId, ctx.workspaceId),
          inArray(
            entities.type,
            input.entities.map((e) => e.profileSlug)
          )
        ),
      });

      const existingByKey = new Map<string, string>(); // "slug:title" → entityId
      for (const e of existingEntities) {
        existingByKey.set(`${e.type}:${e.title}`, e.id);
      }

      // 3. Create missing entities
      const entityIds: Record<string, string> = {};
      const errors: Array<{ refKey: string; error: string }> = [];
      let created = 0;
      let skipped = 0;

      for (const entity of input.entities) {
        const cacheKey = `${entity.profileSlug}:${entity.title}`;

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
              workspaceId: ctx.workspaceId,
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
        .returning({ id: entities.id, type: entities.type });
      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
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
        .returning({ id: entities.id });
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
