/**
 * Relations Router — Semantic Graph Relations
 *
 * Manages TYPED GRAPH EDGES between entities (the `relations` table).
 * These are SEMANTIC / EMERGENT relationships — not predefined by profile schemas.
 *
 * ── Two connection systems in Synap ──────────────────────────────────────────
 *
 * 1. STRUCTURAL LINKS (entity_id properties)
 *    - Defined in profile schemas as properties with `valueType: "entity_id"`
 *    - Part of the entity's core data model (e.g. Task.assignee, Deal.contact)
 *    - Schema-first, form-based, one-directional
 *    - How templates wire things together
 *
 * 2. SEMANTIC RELATIONS (this router — `relations` table)
 *    - Created on the fly: by users, AI, or automations
 *    - Not tied to any profile schema
 *    - Bi-directional, traversable, support metadata
 *    - Power the knowledge graph view
 *    - Types come from `relation_defs` (workspace-scoped, DB-driven)
 *
 * Use `getConnections()` to fetch BOTH systems unified in one response.
 *
 * @see /docs/docs/concepts/entity-connections.md — full architecture guide
 *
 * Procedures:
 * - listTypes()       - All relation types available in this workspace
 * - get()             - Semantic relations for an entity
 * - getRelated()      - Resolved entity objects that are related
 * - getStats()        - Relation count statistics
 * - getConnections()  - UNIFIED: graph + property links + thread references
 * - create()          - Create a new semantic relation
 * - update()          - Update relation metadata (by ID or by source+target+type)
 * - delete()          - Delete a semantic relation
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  db,
  eq,
  and,
  or,
  asc,
  desc,
  getDb,
  eventRepository,
  RelationRepository,
  RelationDefRepository,
  ProjectMemberRepository,
  getWorkspaceMembership,
  SYSTEM_RELATION_TYPES,
  inArray,
  loadFacetSlugsBatch,
  isNull,
} from "@synap/database";
import {
  relations,
  relationDefs,
  entities,
  entityPropertyIndex,
  propertyDefs,
  channelContextItems,
  ChannelContextObjectType,
  channels,
  focusSessions,
  projectMembers,
} from "@synap/database/schema";
import { scopedDb, AccessContext } from "../access/index.js";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { getLinksFor } from "../services/links/links-service.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import {
  VISIBLE_TO,
  BELONGS_TO_PROJECT,
  accessScopeWhere,
} from "../utils/project-scope.js";
import { emitAiCorrection } from "../utils/ai-feedback-events.js";
import { AI_KIND } from "../lib/ai-events.js";
import { auditLog } from "../utils/audit-log.js";
import { channelVisibilityWhere } from "../utils/channel-visibility.js";
import { workspaceLensWhere } from "../utils/user-visible-where.js";
import { emitSideEffects } from "@synap/events";
import { randomUUID } from "crypto";
import { resolveFacetVisibilityScope } from "../utils/workspace-membership.js";
import {
  syncRelationToPropertyOnCreate,
  syncRelationToPropertyOnDelete,
} from "../utils/property-relation-sync.js";
import { inheritRelationWorkspaceId } from "../lib/relation-workspace-inherit.js";
import {
  filterUnavailableEntityConnections,
  structuralNeighbor,
  type EntityConnection,
} from "../services/object-graph/entity-connections.js";

/**
 * Administer-the-anchor authz (chantier α, GO-LIVE control #1). Granting anchor
 * membership / exposing entities to an anchor admits a principal to that anchor's
 * exposed set (cross-workspace) — higher-privilege than ordinary edits. So gate
 * on the anchor ENTITY OWNER or a workspace OWNER/ADMIN, NOT a mere editor.
 */
async function assertAnchorAdmin(
  db: unknown,
  userId: string,
  anchor: { workspaceId: string | null; userId: string | null }
): Promise<void> {
  if (anchor.userId && anchor.userId === userId) return; // anchor entity owner
  if (anchor.workspaceId) {
    const m = await getWorkspaceMembership(db, anchor.workspaceId, userId);
    if (m && (m.role === "owner" || m.role === "admin")) return;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      "Only the anchor owner or a workspace owner/admin may administer this anchor.",
  });
}

/**
 * Direction schema for relation queries
 */
const DirectionSchema = z.enum(["source", "target", "both"]).default("both");

/**
 * Entity rows use the data-table access resolver: pod-personal rows stay
 * owner-gated, workspace rows follow membership, and exposed rows remain
 * visible through their anchor. The optional workspace is a narrowing lens.
 */
function entityConnectionVisibilityWhere(
  userId: string,
  workspaceId?: string | null
) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    workspaceLens: workspaceId,
  });
}

/** Channels have their own visibility rules because a NULL workspace is private. */
function channelConnectionVisibilityWhere(
  userId: string,
  workspaceId?: string | null
) {
  if (workspaceId === undefined) return channelVisibilityWhere(userId);
  if (workspaceId === null) {
    return and(isNull(channels.workspaceId), eq(channels.userId, userId));
  }
  return and(
    eq(channels.workspaceId, workspaceId),
    channelVisibilityWhere(userId)
  );
}

function focusSessionConnectionVisibilityWhere(workspaceId?: string | null) {
  if (workspaceId === undefined) return undefined;
  return workspaceId === null
    ? isNull(focusSessions.workspaceId)
    : eq(focusSessions.workspaceId, workspaceId);
}

/**
 * Generic built-in relation types introduced by "impact-aware writes". These
 * are accepted by `create` WITHOUT a workspace relation-def (like
 * SYSTEM_RELATION_TYPES) so the entity-create handler can auto-connect
 * same-named facets across profiles. Kept deliberately generic.
 *
 * - `same_subject`: two entities (different profiles, same name) are facets of
 *   one real-world subject — e.g. a `person` and a `company` both named "Acme".
 */
export const IMPACT_RELATION_TYPES = ["same_subject"] as const;

/**
 * Build a human-readable label from a relation's endpoints so a proposal inbox
 * card shows e.g. "Create relation" with entity context, not a bare action name.
 * Paralleling the `POST /links` title pattern.
 */
function buildRelationTitle(
  sourceId: string,
  targetId: string,
  type: string
): string {
  return `${sourceId.slice(0, 8)} --${type}--> ${targetId.slice(0, 8)}`;
}

export const relationsRouter = router({
  /**
   * List all semantic relations in the current workspace.
   *
   * Used for bulk loading the knowledge graph, exports, and workspace-level
   * relation summaries. For per-entity traversal use get() / getRelated().
   */
  list: protectedProcedure
    .input(
      z.object({
        type: z.string().optional(),
        limit: z.number().min(1).max(500).default(100),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      // Pod-wide-by-default through the access seam: the registered `workspace`
      // rule applies the user floor (every workspace the caller belongs to +
      // pod-wide globals); an active workspace header NARROWS to that workspace
      // (== the prior `eq(workspaceId)`), no header = the full floor (instead of
      // the old empty list that hung the cross-workspace graph). `?? undefined`
      // (not `?? null`) so a workspace-less caller gets the floor, not globals-only.
      const results = await scopedDb(
        AccessContext.from(ctx).withLens(ctx.workspaceId ?? undefined)
      ).findMany<typeof relations.$inferSelect>(relations, {
        where: input.type ? eq(relations.type, input.type) : undefined,
        orderBy: [desc(relations.createdAt)],
        limit: input.limit,
        offset: input.offset,
      });

      return { relations: results };
    }),

  /**
   * List all available relation types with metadata
   *
   * Returns all relation definitions from the workspace's relation_defs table.
   * Default types (assigned_to, depends_on, etc.) are seeded during workspace creation.
   */
  listTypes: protectedProcedure.query(async ({ ctx }) => {
    // Pod-wide-by-default: relation_defs is the registered substrate `workspace`
    // rule (includeGlobalsInLens) — an active workspace → its defs + pod-wide
    // base defs; no workspace → the floor (all member workspaces' defs + base
    // defs) instead of the old empty list. `?? undefined` = the full floor.
    const defs = await scopedDb(
      AccessContext.from(ctx).withLens(ctx.workspaceId ?? undefined)
    ).findMany<typeof relationDefs.$inferSelect>(relationDefs, {
      orderBy: [asc(relationDefs.slug)],
    });

    const types = defs.map((def) => ({
      type: def.slug,
      label: def.displayName,
      description: def.description ?? "",
      directionality: def.isDirectional
        ? ("unidirectional" as const)
        : ("bidirectional" as const),
      category:
        ((def.uiHints as Record<string, unknown>)?.category as string) ??
        ("custom" as const),
      source: "workspace" as const,
    }));

    return { types };
  }),

  /**
   * Get relations for an entity
   *
   * Returns relationship records (not the related entities themselves).
   * Use getRelated() to get the actual entities.
   */
  get: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        type: z.string().optional(),
        direction: DirectionSchema,
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      // Build where clause based on direction
      let whereClause;

      if (input.direction === "both") {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          or(
            eq(relations.sourceEntityId, input.entityId),
            eq(relations.targetEntityId, input.entityId)
          ),
          input.type ? eq(relations.type, input.type) : undefined
        );
      } else if (input.direction === "source") {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          eq(relations.sourceEntityId, input.entityId),
          input.type ? eq(relations.type, input.type) : undefined
        );
      } else {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          eq(relations.targetEntityId, input.entityId),
          input.type ? eq(relations.type, input.type) : undefined
        );
      }

      const results = await db.query.relations.findMany({
        where: whereClause,
        orderBy: [desc(relations.createdAt)],
        limit: input.limit,
      });

      return { relations: results };
    }),

  /**
   * Get related entities
   *
   * Returns the actual entity objects that are related,
   * not just the relationship records.
   */
  getRelated: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        type: z.string().optional(),
        direction: DirectionSchema,
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      // Get relations first
      let relationRecords;

      if (input.direction === "both") {
        relationRecords = await db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            or(
              eq(relations.sourceEntityId, input.entityId),
              eq(relations.targetEntityId, input.entityId)
            ),
            input.type ? eq(relations.type, input.type) : undefined
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        });
      } else if (input.direction === "source") {
        relationRecords = await db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            eq(relations.sourceEntityId, input.entityId),
            input.type ? eq(relations.type, input.type) : undefined
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        });
      } else {
        relationRecords = await db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            eq(relations.targetEntityId, input.entityId),
            input.type ? eq(relations.type, input.type) : undefined
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        });
      }

      // Extract entity IDs (the "other" entity in each relation).
      // Polymorphic endpoints: a cell endpoint has a NULL entity id — skip it
      // here (this is an entity-centric read).
      const relatedEntityIds = relationRecords
        .map((rel) =>
          rel.sourceEntityId === input.entityId
            ? rel.targetEntityId
            : rel.sourceEntityId
        )
        .filter((id): id is string => id !== null);

      // UNIFIED GRAPH (Option-3 bridge): an entity's neighbours include both
      // entity DATA edges (`relations`) AND config/runtime edges (`links`) where
      // it is an endpoint — e.g. a knowledge entity `--about--> tool`. Surface
      // the config-links alongside the related entities so the detail "related"
      // panel reads ONE neighbour list. Additive: `entities` is unchanged for
      // existing consumers; `configLinks` is the new config-graph slice.
      const configLinks = await getLinksFor(
        ctx.userId,
        "entity",
        input.entityId
      );

      if (relatedEntityIds.length === 0) {
        return { entities: [], configLinks };
      }

      // Fetch the actual entities
      const relatedEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          or(...relatedEntityIds.map((id) => eq(entities.id, id)))
        ),
      });

      return { entities: relatedEntities, configLinks };
    }),

  /**
   * Get relation statistics for an entity
   */
  getStats: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Use SQL COUNT to avoid loading all rows into memory
      const countByType = async (direction: "source" | "target") => {
        const col =
          direction === "source"
            ? relations.sourceEntityId
            : relations.targetEntityId;
        const rows = await db
          .select({ type: relations.type })
          .from(relations)
          .where(
            and(eq(col, input.entityId), eq(relations.userId, ctx.userId))
          );
        const counts: Record<string, number> = {};
        for (const r of rows) {
          counts[r.type] = (counts[r.type] ?? 0) + 1;
        }
        return counts;
      };

      const [outCounts, inCounts] = await Promise.all([
        countByType("source"),
        countByType("target"),
      ]);

      const byType: Record<string, number> = {};
      let outgoingCount = 0;
      let incomingCount = 0;

      for (const [t, c] of Object.entries(outCounts)) {
        byType[t] = (byType[t] ?? 0) + c;
        outgoingCount += c;
      }
      for (const [t, c] of Object.entries(inCounts)) {
        byType[t] = (byType[t] ?? 0) + c;
        incomingCount += c;
      }

      return {
        total: outgoingCount + incomingCount,
        outgoing: outgoingCount,
        incoming: incomingCount,
        byType,
      };
    }),

  /**
   * Create a new relation between entities
   */
  /**
   * Expose an entity to an anchor (chantier α P2) — the SANCTIONED, anchor-admin-
   * gated writer of the `visible_to` exposure edge. This is the ONLY path that may
   * create `visible_to` (relations.create rejects it). The edge makes `entityId`
   * visible to members of `anchorId` via the exposure floor (`exposureMemberWhere`).
   * AuthZ: caller must be able to WRITE the exposed entity AND ADMINISTER the anchor
   * (both gated on the LOADED rows, never request-supplied ids).
   */
  exposeToAnchor: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        anchorId: z.string().uuid(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const [entityRow] = await database
        .select({
          id: entities.id,
          workspaceId: entities.workspaceId,
          userId: entities.userId,
        })
        .from(entities)
        .where(eq(entities.id, input.entityId))
        .limit(1);
      const [anchorRow] = await database
        .select({
          id: entities.id,
          workspaceId: entities.workspaceId,
          userId: entities.userId,
        })
        .from(entities)
        .where(eq(entities.id, input.anchorId))
        .limit(1);
      if (!entityRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }
      if (!anchorRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Anchor entity not found",
        });
      }
      if (!anchorRow.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Anchor entity must be workspace-scoped",
        });
      }

      // AuthZ — gate on the LOADED rows: the caller must be able to write the
      // exposed entity AND administer the anchor. (Never gate on input ids.)
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: entityRow.workspaceId,
        ownerId: entityRow.userId,
      });
      await assertAnchorAdmin(database, ctx.userId, anchorRow);

      const id = randomUUID();
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: anchorRow.workspaceId,
        subjectType: "relation",
        action: "create",
        data: {
          id,
          sourceEntityId: input.entityId,
          targetEntityId: input.anchorId,
          type: VISIBLE_TO,
          // Mirror the direct-write provenance so a materialized proposal carries
          // the right owner/workspace (not the sync fallback).
          userId: ctx.userId,
          workspaceId: anchorRow.workspaceId,
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        // Governed/agent path: the proposal materializes via the materializer
        // worker's `relation/create` case (writes the visible_to edge on approval).
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const relationRepo = new RelationRepository(database, eventRepo);
      const relation = await relationRepo.create(
        {
          id,
          sourceEntityId: input.entityId,
          targetEntityId: input.anchorId,
          type: VISIBLE_TO,
          workspaceId: anchorRow.workspaceId,
          userId: ctx.userId,
          metadata: input.metadata,
        },
        ctx.userId
      );
      auditLog({
        subjectType: "relation",
        action: "create",
        phase: "completed",
        subjectId: relation.id,
        userId: ctx.userId,
        workspaceId: anchorRow.workspaceId,
        data: {
          type: VISIBLE_TO,
          entityId: input.entityId,
          anchorId: input.anchorId,
        },
      });
      return { status: "created" as const, id: relation.id };
    }),

  /**
   * Grant a user membership of an anchor entity (chantier α P2, GO-LIVE control #1)
   * — the gated writer of `project_members`. AuthZ: only someone who can ADMINISTER
   * the anchor may grant membership on it (else a user could add themselves to an
   * arbitrary anchor and read its exposed set). For a CLIENT principal: grant
   * membership on the client anchor and do NOT add them to the workspace — the
   * exposure floor then scopes their reads to that anchor's exposed entities only.
   */
  grantAnchorMembership: protectedProcedure
    .input(
      z.object({
        anchorId: z.string().uuid(),
        userId: z.string().uuid(),
        role: z.enum(["owner", "editor", "viewer"]).default("viewer"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const [anchorRow] = await database
        .select({
          id: entities.id,
          workspaceId: entities.workspaceId,
          userId: entities.userId,
        })
        .from(entities)
        .where(eq(entities.id, input.anchorId))
        .limit(1);
      if (!anchorRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Anchor entity not found",
        });
      }
      if (!anchorRow.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Anchor entity must be workspace-scoped",
        });
      }

      // AuthZ (control #1) — gate on the LOADED anchor row: only an admin of the
      // anchor may grant membership on it.
      await assertAnchorAdmin(database, ctx.userId, anchorRow);

      // Idempotent: a re-grant of an existing membership is a benign, expected
      // event (re-invite/retry) — return the existing row instead of 500-ing on
      // the (project_id, user_id) unique constraint. Placed AFTER the authz gate
      // so it never leaks membership existence to a non-admin caller.
      const [existingMember] = await database
        .select({ id: projectMembers.id })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, input.anchorId),
            eq(projectMembers.userId, input.userId)
          )
        )
        .limit(1);
      if (existingMember) {
        return { status: "exists" as const, memberId: existingMember.id };
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: anchorRow.workspaceId,
        subjectType: "projectMember",
        action: "create",
        data: {
          projectId: input.anchorId,
          userId: input.userId,
          role: input.role,
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        // Governed/agent path: the proposal materializes via the materializer
        // worker's `projectMember/create` case (writes the grant on approval).
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new ProjectMemberRepository(database, eventRepo);
      const member = await memberRepo.add(
        {
          projectId: input.anchorId,
          userId: input.userId,
          role: input.role,
        },
        ctx.userId
      );
      auditLog({
        subjectType: "projectMember",
        action: "create",
        phase: "completed",
        subjectId: member.id,
        userId: ctx.userId,
        workspaceId: anchorRow.workspaceId,
        data: {
          anchorId: input.anchorId,
          grantedUserId: input.userId,
          role: input.role,
        },
      });
      return { status: "created" as const, memberId: member.id };
    }),

  create: protectedProcedure
    .input(
      z.object({
        sourceEntityId: z.string().uuid(),
        targetEntityId: z.string().uuid(),
        // Accept both built-in relation types and workspace-defined custom types
        type: z.string().min(1),
        metadata: z.record(z.string(), z.any()).optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Exposure edges are NOT freely creatable — `visible_to` grants cross-anchor
      // visibility and MUST go through the anchor-admin-gated sanctioned writer.
      if (input.type === VISIBLE_TO) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "visible_to is an exposure edge — use relations.exposeToAnchor (anchor-admin gated), not relations.create.",
        });
      }
      const id = randomUUID();
      // Resolve workspace ID: prefer explicit input, fall back to context header
      const effectiveWorkspaceId = input.workspaceId || ctx.workspaceId;
      if (!effectiveWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "workspaceId is required (pass in input or set X-Workspace-Id header)",
        });
      }

      // Validate type: must be a system/impact built-in OR a workspace-defined
      // relation def. Impact built-ins (e.g. same_subject) need no workspace def
      // so auto-connect can run on any workspace.
      const isSystemType =
        (SYSTEM_RELATION_TYPES as readonly string[]).includes(input.type) ||
        (IMPACT_RELATION_TYPES as readonly string[]).includes(input.type);
      if (!isSystemType) {
        const database = await getDb();
        const relDefRepo = new RelationDefRepository(database);
        const def = await relDefRepo.getBySlug(
          input.type,
          effectiveWorkspaceId
        );
        if (!def) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Unknown relation type: "${input.type}". Must be a workspace relation definition.`,
          });
        }
      }

      // D4: the edge INHERITS its endpoints' lens — this is data PLACEMENT, kept
      // orthogonal to governance (`effectiveWorkspaceId` still gates the write +
      // stamps the audit/side-effects). Resolved ONCE, here, so the proposal
      // persists it (I3) and the materializer reads `data.workspaceId` back
      // verbatim — the auto-approved and proposal-gated paths place identically.
      const placementDb = await getDb();
      const endpointRows = await placementDb.query.entities.findMany({
        where: inArray(entities.id, [
          input.sourceEntityId,
          input.targetEntityId,
        ]),
        columns: { id: true, workspaceId: true },
      });
      const relationWorkspaceId = inheritRelationWorkspaceId(
        endpointRows.map((e) => e.workspaceId),
        effectiveWorkspaceId
      );

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        subjectType: "relation",
        action: "create",
        // Group a link/relation proposal under the agent's active run session.
        sessionId: ctx.sessionId ?? undefined,
        data: {
          id,
          title: buildRelationTitle(
            input.sourceEntityId,
            input.targetEntityId,
            input.type
          ),
          sourceEntityId: input.sourceEntityId,
          targetEntityId: input.targetEntityId,
          type: input.type,
          // I3: persist the resolved D4 placement (may be an explicit null for a
          // pod-wide edge) so materializeRelation reads it back verbatim via
          // resolveMaterializedRelationWorkspaceId — auto-approved + proposal-
          // gated relations place identically.
          resolvedWorkspaceId: relationWorkspaceId,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const database = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const relationRepo = new RelationRepository(database, eventRepo);

      let relation: { id: string };
      try {
        relation = await relationRepo.create(
          {
            id,
            sourceEntityId: input.sourceEntityId,
            targetEntityId: input.targetEntityId,
            type: input.type,
            workspaceId: relationWorkspaceId,
            userId: ctx.userId,
            metadata: input.metadata,
          },
          ctx.userId
        );
      } catch (err) {
        // Idempotency: uniquely-indexed edges (e.g. belongs_to_project) must not
        // 500 on a re-link. On a unique violation, return the existing edge
        // instead of throwing — re-filing an entity into a project is a no-op.
        if ((err as { code?: string })?.code === "23505") {
          const existing = await database.query.relations.findFirst({
            where: and(
              eq(relations.sourceEntityId, input.sourceEntityId),
              eq(relations.targetEntityId, input.targetEntityId),
              eq(relations.type, input.type)
            ),
          });
          if (existing) return { id: existing.id, status: "exists" as const };
        }
        throw err;
      }

      // 2b. Reverse-sync: if this relation type maps to an entity_id property, auto-set it
      syncRelationToPropertyOnCreate(
        input.sourceEntityId,
        input.targetEntityId,
        input.type,
        effectiveWorkspaceId
      ).catch((err) => {
        console.warn(
          "[relations.create] Relation→property reverse sync failed:",
          err
        );
      });

      // 3. Audit log
      auditLog({
        subjectType: "relation",
        action: "create",
        phase: "completed",
        subjectId: relation.id,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: {
          sourceEntityId: input.sourceEntityId,
          targetEntityId: input.targetEntityId,
          type: input.type,
        },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "relation",
        action: "create",
        subjectId: relation.id,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: {
          relationType: input.type,
          fromEntityId: input.sourceEntityId,
          toEntityId: input.targetEntityId,
        },
      });

      return {
        id: relation.id,
        status: "created" as const,
      };
    }),

  /**
   * Get all connections for an entity across the complete local graph:
   *
   * 1. **Semantic graph relations** (`relations` table) — typed graph edges
   *    created manually, by AI, or via the whiteboard.
   *
   * 2. **Structural property links** (`entity_property_index`) — inbound and
   *    outbound `entity_id` properties from the profile schema.
   *
   * 3. **Channel connections** — channels that touched or are about the entity.
   *
   * 4. **Focus sessions** — sessions whose subject is this entity.
   *
   * Use this endpoint to build a unified "Connections" panel on an entity card
   * or to traverse the full knowledge graph around any entity.
   */
  getConnections: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        /** Maximum items per source (default 50) */
        limit: z.number().min(1).max(200).default(50),
        /** Explicit role-visibility lens. Omit for the complete user floor. */
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        input.workspaceId
      );
      const [
        graphRelations,
        propertyLinks,
        channelLinks,
        contextChannels,
        subjectSessions,
      ] = await Promise.all([
        // ── 1. Semantic graph relations ─────────────────────────────────────
        db.query.relations.findMany({
          // Owner-scoped by ctx.userId. The agent-key identity remap (hub/MCP)
          // sets ctx.userId = the operator the agent acts for, so the agent sees
          // the operator's relations graph WITHOUT widening visibility on a
          // multi-user pod (the agent only ever sees ITS operator's data).
          where: and(
            eq(relations.userId, ctx.userId),
            workspaceLensWhere(
              relations.workspaceId,
              ctx.userId,
              input.workspaceId
            ),
            or(
              eq(relations.sourceEntityId, input.entityId),
              eq(relations.targetEntityId, input.entityId)
            )
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        }),

        // ── 2. Structural property links (both directions via index) ────────
        // Find entity_id properties pointing TO this entity and properties ON
        // this entity that point elsewhere. The source entity is joined here so
        // deleted/inaccessible inbound rows never become graph neighbours.
        db
          .select({
            sourceEntityId: entityPropertyIndex.entityId,
            targetEntityId: entityPropertyIndex.valueEntityId,
            propertyDefId: entityPropertyIndex.propertyDefId,
            propertySlug: propertyDefs.slug,
            propertyUiHints: propertyDefs.uiHints,
          })
          .from(entityPropertyIndex)
          .innerJoin(entities, eq(entityPropertyIndex.entityId, entities.id))
          .innerJoin(
            propertyDefs,
            eq(entityPropertyIndex.propertyDefId, propertyDefs.id)
          )
          .where(
            and(
              isNull(entities.deletedAt),
              entityConnectionVisibilityWhere(ctx.userId, input.workspaceId),
              or(
                eq(entityPropertyIndex.entityId, input.entityId),
                eq(entityPropertyIndex.valueEntityId, input.entityId)
              )
            )
          )
          .limit(input.limit),

        // ── 3. Channel connections ───────────────────────────────────────────
        db
          .select({
            channelId: channelContextItems.channelId,
            relationshipType: channelContextItems.relationshipType,
            createdAt: channelContextItems.createdAt,
            channelTitle: channels.title,
            channelWorkspaceId: channels.workspaceId,
          })
          .from(channelContextItems)
          .innerJoin(channels, eq(channelContextItems.channelId, channels.id))
          .where(
            and(
              eq(channelContextItems.objectId, input.entityId),
              eq(
                channelContextItems.objectType,
                ChannelContextObjectType.ENTITY
              ),
              eq(channelContextItems.userId, ctx.userId),
              channelConnectionVisibilityWhere(ctx.userId, input.workspaceId)
            )
          )
          .orderBy(desc(channelContextItems.createdAt))
          .limit(input.limit),

        // ── 4. Channels whose context IS this entity ─────────────────────────
        // channels.contextObjectId = entityId: the channel opened ON the entity
        // detail page (contextObjectType='entity'). Distinct from
        // channel_context_items (messages that touched the entity). Uses the
        // channels_context_idx index on (contextObjectType, contextObjectId).
        db.query.channels.findMany({
          where: and(
            eq(channels.contextObjectType, "entity"),
            eq(channels.contextObjectId, input.entityId),
            // Use the canonical channel-visibility floor (own / member /
            // shared-type-in-accessible-workspace) — NOT owner-only — so the
            // entity graph shows the same channels get_entity's linkedChannels
            // does (which hits /channels → channelVisibilityWhere). Owner-pinning
            // here made a workspace member see the channel in the IS tool but not
            // in the graph.
            channelConnectionVisibilityWhere(ctx.userId, input.workspaceId)
          ),
          orderBy: (ch, { desc }) => [desc(ch.createdAt)],
          limit: input.limit,
        }),

        // ── 5. Focus sessions anchored to this entity ────────────────────────
        // focus_sessions.subjectEntityId = entityId: sessions started with this
        // entity as the subject spine. Uses idx_focus_sessions_subject_entity_id.
        db.query.focusSessions.findMany({
          where: and(
            eq(focusSessions.subjectEntityId, input.entityId),
            eq(focusSessions.userId, ctx.userId),
            focusSessionConnectionVisibilityWhere(input.workspaceId)
          ),
          orderBy: (fs, { desc }) => [desc(fs.startedAt)],
          limit: input.limit,
        }),
      ]);

      // Collect all entity IDs we need to resolve
      const entityIdsToFetch = new Set<string>();

      for (const rel of graphRelations) {
        const otherId =
          rel.sourceEntityId === input.entityId
            ? rel.targetEntityId
            : rel.sourceEntityId;
        // Polymorphic endpoints: skip cell endpoints (NULL entity id).
        if (otherId !== null) entityIdsToFetch.add(otherId);
      }
      for (const link of propertyLinks) {
        if (link.targetEntityId !== null) {
          entityIdsToFetch.add(link.sourceEntityId);
          entityIdsToFetch.add(link.targetEntityId);
        }
      }

      // Fetch all referenced entities in one query, plus their live facet
      // (Kind + Facets) slugs — one batched join, not N+1 — so graph neighbors
      // built from this connection set carry real subtypes (see
      // graph-service.ts connectionsToNeighbors, which reads entity.facetSlugs).
      type ConnectedEntity = typeof entities.$inferSelect & {
        facetSlugs?: string[];
      };
      const entityMap = new Map<string, ConnectedEntity>();
      if (entityIdsToFetch.size > 0) {
        const fetched = await db.query.entities.findMany({
          where: and(
            inArray(entities.id, [...entityIdsToFetch]),
            isNull(entities.deletedAt),
            entityConnectionVisibilityWhere(ctx.userId, input.workspaceId)
          ),
        });
        const facetSlugsByEntity = await loadFacetSlugsBatch(
          db,
          fetched.map((e) => e.id),
          facetVisibilityScope
        );
        for (const e of fetched) {
          entityMap.set(e.id, {
            ...e,
            facetSlugs: facetSlugsByEntity.get(e.id) ?? [],
          });
        }
      }

      // ── Shape the result ──────────────────────────────────────────────────

      const connections: EntityConnection[] = [];

      for (const rel of graphRelations) {
        const isOutgoing = rel.sourceEntityId === input.entityId;
        const otherId = isOutgoing ? rel.targetEntityId : rel.sourceEntityId;
        // Polymorphic endpoints: skip cell endpoints (NULL entity id) in this
        // entity-centric connections view.
        if (otherId === null) continue;
        connections.push({
          entityId: otherId,
          entity: entityMap.get(otherId) ?? null,
          label: rel.type,
          direction: isOutgoing ? "outgoing" : "incoming",
          source: "graph",
          relationId: rel.id,
          relationType: rel.type,
          createdAt: rel.createdAt,
        });
      }

      for (const link of propertyLinks) {
        const structural = structuralNeighbor(
          input.entityId,
          link.sourceEntityId,
          link.targetEntityId
        );
        if (!structural) continue;
        const uiHints = (link.propertyUiHints ?? {}) as Record<string, unknown>;
        const propertyLabel =
          (uiHints.label as string | undefined) ?? link.propertySlug ?? "link";
        connections.push({
          entityId: structural.entityId,
          entity: entityMap.get(structural.entityId) ?? null,
          label: propertyLabel,
          direction: structural.direction,
          source: "property",
          propertySlug: link.propertySlug ?? undefined,
          propertyLabel,
          createdAt: null,
        });
      }

      for (const ci of channelLinks) {
        connections.push({
          entityId: ci.channelId,
          entity: null,
          label: ci.channelTitle ?? ci.relationshipType,
          direction: "incoming",
          source: "thread",
          channelId: ci.channelId,
          channelRelationshipType: ci.relationshipType,
          channelTitle: ci.channelTitle,
          channelWorkspaceId: ci.channelWorkspaceId,
          createdAt: ci.createdAt,
        });
      }

      for (const ch of contextChannels) {
        connections.push({
          entityId: ch.id,
          entity: null,
          label: ch.title ?? ch.channelType,
          direction: "incoming",
          source: "context_channel",
          channelId: ch.id,
          channelTitle: ch.title,
          channelWorkspaceId: ch.workspaceId,
          createdAt: ch.createdAt,
        });
      }

      for (const fs of subjectSessions) {
        connections.push({
          entityId: fs.id,
          entity: null,
          label: fs.goal,
          direction: "incoming",
          source: "focus_session",
          focusSessionId: fs.id,
          focusSessionGoal: fs.goal,
          focusSessionStatus: fs.status,
          focusSessionWorkspaceId: fs.workspaceId,
          createdAt: fs.createdAt,
        });
      }

      const visibleConnections =
        filterUnavailableEntityConnections(connections);

      return {
        connections: visibleConnections,
        counts: {
          total: visibleConnections.length,
          graph: visibleConnections.filter((c) => c.source === "graph").length,
          structural: visibleConnections.filter((c) => c.source === "property")
            .length,
          threads: visibleConnections.filter((c) => c.source === "thread")
            .length,
          contextChannels: visibleConnections.filter(
            (c) => c.source === "context_channel"
          ).length,
          focusSessions: visibleConnections.filter(
            (c) => c.source === "focus_session"
          ).length,
        },
      };
    }),

  /**
   * Update a relation's metadata (and optionally its type).
   *
   * Identify the relation either by its ID or by the (sourceEntityId, targetEntityId, type)
   * triple — the triple form is used by Relay's campaign contact pipeline where the
   * caller doesn't have the relation ID at hand.
   *
   * Only metadata and type are updatable. The source/target/workspace are immutable.
   */
  update: protectedProcedure
    .input(
      z
        .object({
          // Identify by ID
          id: z.string().uuid().optional(),
          // OR identify by triple (source + target + type) — at least one form required
          sourceEntityId: z.string().uuid().optional(),
          targetEntityId: z.string().uuid().optional(),
          // Fields to update
          type: z.string().min(1).optional(),
          metadata: z.record(z.string(), z.any()).optional(),
          workspaceId: z.string().uuid().optional(),
        })
        .refine(
          (v) => v.id || (v.sourceEntityId && v.targetEntityId),
          "Provide either id or (sourceEntityId + targetEntityId)"
        )
    )
    .mutation(async ({ input, ctx }) => {
      const effectiveWorkspaceId =
        input.workspaceId || ctx.workspaceId || undefined;

      const database = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const relationRepo = new RelationRepository(database, eventRepo);

      // Resolve relation ID if not provided directly
      let relationId = input.id;
      if (!relationId) {
        // D4: a (source,target,type) triple resolves to ONE canonical edge —
        // its placement is a function of the endpoints, not of the ambient
        // workspace. Filtering by effectiveWorkspaceId here made a pod-wide
        // edge (workspaceId NULL, e.g. between two pod-wide entities)
        // unresolvable from any workspace context, throwing NOT_FOUND on an
        // edge that plainly exists. Matches the id-less conflict-recovery
        // lookup on the single-create door above, which never filtered by
        // workspace either. The block below still gates the write on the
        // row's REAL workspace once resolved.
        const existing = await database.query.relations.findFirst({
          where: and(
            eq(relations.sourceEntityId, input.sourceEntityId!),
            eq(relations.targetEntityId, input.targetEntityId!),
            ...(input.type ? [eq(relations.type, input.type)] : [])
          ),
          columns: { id: true },
        });

        if (!existing) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Relation not found",
          });
        }
        relationId = existing.id;
      }

      // Gate on the relation's REAL workspace — the perm check below keys off
      // the request workspaceId, which doesn't pin the relation row.
      const relRow = await database.query.relations.findFirst({
        where: eq(relations.id, relationId),
        columns: { workspaceId: true },
      });
      if (!relRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Relation not found",
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: relRow.workspaceId,
      });

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        subjectType: "relation",
        action: "update",
        data: { id: relationId },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Update
      const updateData: { type?: string; metadata?: Record<string, unknown> } =
        {};
      if (input.type !== undefined) updateData.type = input.type;
      if (input.metadata !== undefined) updateData.metadata = input.metadata;
      const relation = await relationRepo.update(
        relationId,
        updateData as Parameters<typeof relationRepo.update>[1],
        ctx.userId
      );

      // 3. Audit + side-effects
      auditLog({
        subjectType: "relation",
        action: "update",
        phase: "completed",
        subjectId: relationId,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: { metadata: input.metadata, type: input.type },
      });

      emitSideEffects({
        subjectType: "relation",
        action: "update",
        subjectId: relationId,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: {
          relationType: relation.type,
          fromEntityId: relation.sourceEntityId,
          toEntityId: relation.targetEntityId,
        },
      });

      return { id: relation.id, status: "updated" as const };
    }),

  /**
   * Delete a relation
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Resolve workspace ID: prefer explicit input, fall back to context header
      const effectiveWorkspaceId =
        input.workspaceId || ctx.workspaceId || undefined;

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        subjectType: "relation",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const database = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const relationRepo = new RelationRepository(database, eventRepo);

      // Snapshot relation data before deletion (for reverse sync)
      const relationToDelete = await database.query.relations.findFirst({
        where: eq(relations.id, input.id),
        columns: {
          sourceEntityId: true,
          targetEntityId: true,
          type: true,
          workspaceId: true,
        },
      });
      if (!relationToDelete) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Relation not found",
        });
      }
      // Gate on the relation's REAL workspace (request workspaceId doesn't pin it).
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: relationToDelete.workspaceId,
      });

      await relationRepo.delete(input.id, ctx.userId);

      // Feedback signal (project dimension) — a human unfiled an entity from a
      // project that an AI project-placement decision had chosen. Join key is the
      // source entity's correlationId (the decision's id). Best-effort + swallow-
      // never-throw (mirrors the entity-reroute correction) — never fail the
      // delete. Discriminated by `dim: "project"` + AI_KIND.PROJECT so the future
      // shared reader can filter it apart from workspace (route) corrections.
      if (
        relationToDelete.type === BELONGS_TO_PROJECT &&
        relationToDelete.sourceEntityId
      ) {
        try {
          const sourceEntity = await database.query.entities.findFirst({
            where: eq(entities.id, relationToDelete.sourceEntityId),
            columns: { correlationId: true },
          });
          if (sourceEntity?.correlationId) {
            await emitAiCorrection({
              action: "unfile",
              userId: ctx.userId,
              subjectId: relationToDelete.sourceEntityId,
              workspaceId: relationToDelete.workspaceId,
              data: {
                kind: AI_KIND.PROJECT,
                dim: "project",
                entityId: relationToDelete.sourceEntityId,
                fromProjectId: relationToDelete.targetEntityId,
                correlationId: sourceEntity.correlationId,
              },
            });
          }
        } catch (err) {
          console.warn(
            "[relations.delete] ai_correction (project) emit failed (delete preserved):",
            err
          );
        }
      }

      // 2b. Reverse-sync: if this relation type maps to a property, auto-clear it.
      // Only entity↔entity relations map to entity_id properties — skip when an
      // endpoint is a cell (NULL entity id).
      if (
        relationToDelete &&
        effectiveWorkspaceId &&
        relationToDelete.sourceEntityId !== null &&
        relationToDelete.targetEntityId !== null
      ) {
        syncRelationToPropertyOnDelete(
          relationToDelete.sourceEntityId,
          relationToDelete.targetEntityId,
          relationToDelete.type,
          effectiveWorkspaceId
        ).catch((err) => {
          console.warn(
            "[relations.delete] Relation→property reverse sync failed:",
            err
          );
        });
      }

      // 3. Audit log
      auditLog({
        subjectType: "relation",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: { id: input.id },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "relation",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: {
          relationType: relationToDelete?.type,
          fromEntityId: relationToDelete?.sourceEntityId,
          toEntityId: relationToDelete?.targetEntityId,
        },
      });

      return {
        status: "deleted" as const,
      };
    }),

  /**
   * Trigger a one-time backfill job that creates relation rows
   * for existing entity_id property values with relationDefId mappings.
   */
  backfill: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Gate membership of the target workspace before enqueuing a
      // workspace-wide backfill job.
      const database = await getDb();
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: input.workspaceId,
      });

      const { getBoss } = await import("@synap/jobs");

      const boss = getBoss();
      const jobId = await boss.send("relation-backfill", {
        workspaceId: input.workspaceId,
        userId: ctx.userId,
      });

      return { jobId };
    }),

  /**
   * Batch create relations in a single call.
   *
   * Auto-creates missing relation definitions on the fly (workspace-scoped).
   * Entities are referenced by UUID.
   *
   * Idempotent: relations with the same (sourceEntityId, targetEntityId, type)
   * in the same workspace are skipped, not duplicated.
   */
  batchCreate: protectedProcedure
    .input(
      z.object({
        relations: z.array(
          z.object({
            sourceEntityId: z.string().uuid(),
            targetEntityId: z.string().uuid(),
            type: z.string().min(1),
            metadata: z.record(z.string(), z.unknown()).optional(),
            /** If the relation type doesn't exist as a def, create it with these hints */
            typeHints: z
              .object({
                displayName: z.string().optional(),
                description: z.string().optional(),
                isDirectional: z.boolean().optional(),
                uiHints: z.record(z.string(), z.unknown()).optional(),
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
        relationDefsCreated: z.number(),
        errors: z.array(
          z.object({
            sourceEntityId: z.string(),
            targetEntityId: z.string(),
            type: z.string(),
            error: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const effectiveWorkspaceId = ctx.workspaceId;
      if (!effectiveWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "workspaceId is required (set X-Workspace-Id header)",
        });
      }

      const database = await getDb();
      // Gate membership of the target (header) workspace before writing
      // relations + auto-creating relation defs into it.
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: effectiveWorkspaceId,
      });
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const relationRepo = new RelationRepository(database, eventRepo);
      const relDefRepo = new RelationDefRepository(database);

      // 1. Ensure all relation definitions exist (auto-create missing ones)
      const existingDefs = await relDefRepo.list(effectiveWorkspaceId);
      const existingDefSlugs = new Set(existingDefs.map((d) => d.slug));
      const systemTypes = new Set(SYSTEM_RELATION_TYPES as readonly string[]);
      let relationDefsCreated = 0;

      // Exposure edges are NOT freely creatable here either — reject visible_to
      // BEFORE any relation-def is auto-created; use relations.exposeToAnchor.
      for (const rel of input.relations) {
        if (rel.type === VISIBLE_TO) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "visible_to is an exposure edge — use relations.exposeToAnchor, not relations.batchCreate.",
          });
        }
      }

      for (const rel of input.relations) {
        if (systemTypes.has(rel.type)) continue;
        if (existingDefSlugs.has(rel.type)) continue;

        // Create the relation def
        const hints = rel.typeHints ?? {};
        await relDefRepo.create({
          slug: rel.type,
          displayName: hints.displayName ?? rel.type.replace(/_/g, " "),
          description: hints.description,
          workspaceId: effectiveWorkspaceId,
          userId: ctx.userId,
          uiHints: hints.uiHints,
          isDirectional: hints.isDirectional ?? true,
        });
        existingDefSlugs.add(rel.type);
        relationDefsCreated++;
      }

      // D4: an edge's placement is a function of its endpoints, not of who's
      // asking — so idempotency (and creation, below) must NOT filter/stamp
      // by the ambient workspace alone. Batch-load every endpoint's scope
      // once, mirroring the single-create door's inheritRelationWorkspaceId
      // usage, so bulk and single create place the SAME (source,target,type)
      // edge identically (I3) instead of reintroducing the four-door bug on
      // this door. This also matches the single-create conflict-recovery
      // lookup a few lines up, which already resolves existence by
      // (source,target,type) alone, no workspaceId filter.
      const endpointIds = Array.from(
        new Set(
          input.relations.flatMap((r) => [r.sourceEntityId, r.targetEntityId])
        )
      );
      const endpointRows = await database.query.entities.findMany({
        where: inArray(entities.id, endpointIds),
        columns: { id: true, workspaceId: true },
      });
      const endpointWorkspaceById = new Map(
        endpointRows.map((e) => [e.id, e.workspaceId])
      );

      // 2. Check for existing relations (idempotency)
      const existingRelations = await database.query.relations.findMany({
        where: inArray(
          relations.type,
          input.relations.map((r) => r.type)
        ),
        columns: {
          id: true,
          sourceEntityId: true,
          targetEntityId: true,
          type: true,
        },
      });

      const existingRelKeys = new Set<string>();
      for (const r of existingRelations) {
        existingRelKeys.add(
          `${r.sourceEntityId}:${r.targetEntityId}:${r.type}`
        );
      }

      // 3. Create missing relations
      let created = 0;
      let skipped = 0;
      const errors: Array<{
        sourceEntityId: string;
        targetEntityId: string;
        type: string;
        error: string;
      }> = [];

      for (const rel of input.relations) {
        const key = `${rel.sourceEntityId}:${rel.targetEntityId}:${rel.type}`;

        if (existingRelKeys.has(key)) {
          skipped++;
          continue;
        }

        try {
          const relationWorkspaceId = inheritRelationWorkspaceId(
            [
              endpointWorkspaceById.get(rel.sourceEntityId) ?? null,
              endpointWorkspaceById.get(rel.targetEntityId) ?? null,
            ],
            effectiveWorkspaceId
          );
          await relationRepo.create(
            {
              sourceEntityId: rel.sourceEntityId,
              targetEntityId: rel.targetEntityId,
              type: rel.type,
              workspaceId: relationWorkspaceId,
              userId: ctx.userId,
              metadata: rel.metadata,
            },
            ctx.userId
          );
          created++;
        } catch (err) {
          errors.push({
            sourceEntityId: rel.sourceEntityId,
            targetEntityId: rel.targetEntityId,
            type: rel.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { created, skipped, relationDefsCreated, errors };
    }),
});
