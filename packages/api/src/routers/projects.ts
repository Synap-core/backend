/**
 * Projects Router — Project Management (projects TABLE)
 *
 * Projects are first-class table rows in the `projects` pgTable — NOT entities.
 * Synchronous CRUD with ProjectRepository + direct table queries.
 */

import { z } from "zod";
import { router, workspaceProcedure, podProcedure } from "../trpc.js";
import {
  projects,
  entities,
  eq,
  desc,
  and,
  or,
  isNull,
  isNotNull,
  inArray,
  getDb,
  EventRepository,
  sql,
  ProjectRepository,
  findProjectDedupCandidates,
  assessEvidenceGravity,
  buildNearMatchMessage,
  buildProjectProvenance,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { accessScopeWhere } from "../utils/project-scope.js";
import {
  listProjectAutomations,
  loadProjectSubjects,
  setProjectAutomationMembership,
  setProjectSubject,
} from "../utils/project-subject.js";
import { workspaceMembers } from "@synap/database";

/**
 * Count how many of `entityIds` actually exist and are visible to `userId`,
 * using the canonical entity access floor (`accessScopeWhere`) — never a
 * request-supplied predicate. Backs the agent evidence-gravity check so an
 * agent cannot claim gravity with ids it can't see or that don't exist.
 */
async function countVisibleEntities(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  entityIds: string[]
): Promise<number> {
  if (entityIds.length === 0) return 0;
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        inArray(entities.id, entityIds),
        isNull(entities.deletedAt),
        accessScopeWhere({
          workspaceIdColumn: entities.workspaceId,
          entityIdColumn: entities.id,
          ownerColumn: entities.userId,
          userId,
        })
      )
    );
  return new Set(rows.map((r) => r.id)).size;
}
export const projectsRouter = router({
  /**
   * List all projects for the current user
   */
  list: workspaceProcedure
    .input(
      paginatedInput
        .extend({
          status: z.enum(["active", "archived", "completed"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();

      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const conditions: ReturnType<typeof eq>[] = [
        or(
          // Pod-wide projects (NULL workspace): only visible to their owner
          and(isNull(projects.workspaceId), eq(projects.userId, ctx.userId)),
          // Workspace-scoped projects: visible to all workspace members
          and(
            isNotNull(projects.workspaceId),
            userVisibleWhere(projects.workspaceId, ctx.userId)
          )
        )!,
      ];

      if (input?.status) {
        conditions.push(eq(projects.status, input.status));
      }

      const results = await db
        .select()
        .from(projects)
        .where(and(...conditions))
        .orderBy(desc(projects.createdAt))
        .limit(limit + 1)
        .offset(offset);

      const { items, pagination } = buildPaginatedResponse(results, {
        limit,
        offset,
      });

      // The subject rides along on the LIST, not on a per-row follow-up: the
      // list's own headings and row titles are derived from it, so fetching it
      // separately would render every row with the generic noun first and then
      // relabel them — a visible flicker on the primary surface.
      const subjects = await loadProjectSubjects(
        db,
        items.map((p) => p.id)
      );
      const withSubject = items.map((p) => ({
        ...p,
        subject: subjects.get(p.id) ?? null,
      }));

      return {
        items: withSubject,
        pagination,
        /** @deprecated Use `items` instead */
        projects: withSubject,
      };
    }),

  /**
   * Get a single project by ID
   */
  get: podProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Single-object read: the WHERE is already pure user-floor (pod-personal
      // owner OR workspace-member visibility). It must not be gated by the
      // active-workspace lens, so it runs on podProcedure, not workspaceProcedure.
      const db = await getDb();

      const project = await db.query.projects.findFirst({
        where: and(
          eq(projects.id, input.id),
          or(
            and(isNull(projects.workspaceId), eq(projects.userId, ctx.userId)),
            and(
              isNotNull(projects.workspaceId),
              userVisibleWhere(projects.workspaceId, ctx.userId)
            )
          )!
        ),
      });

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const subjects = await loadProjectSubjects(db, [project.id]);
      return { project, subject: subjects.get(project.id) ?? null };
    }),

  /**
   * Create a new project
   */
  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        status: z.enum(["active", "archived", "completed"]).default("active"),
        /**
         * Lifecycle position (0240). Free text by design — a consulting
         * engagement, a campaign and a product name their phases differently.
         */
        phase: z.string().max(120).optional(),
        /**
         * The real-world thing this container is about, as an entity id. Written
         * as a `project --targets--> entity` link, never a column — see
         * `utils/project-subject.ts`. The UI derives the project's user-facing
         * noun and title from it.
         */
        subjectEntityId: z.string().uuid().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        /**
         * Agent gravity evidence: existing entity ids that would belong to this
         * project. Required (≥5, caller-visible) for AGENT-initiated creates;
         * ignored for human creators. See `assessEvidenceGravity`.
         */
        evidenceEntityIds: z.array(z.string().uuid()).max(500).optional(),
        /**
         * Internal provenance hint for which door originated the create. Defaults
         * to "trpc"; the MCP handler forwards "mcp". Only labels metadata.
         */
        door: z.enum(["trpc", "hub-rest", "mcp"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const isAgent = !!ctx.agentUserId;
      const door = input.door ?? "trpc";

      // Validate the subject BEFORE anything is created. `setProjectSubject`
      // re-checks it too (it is the door's own floor), but failing there would
      // leave a project already inserted and a caller told it failed.
      if (input.subjectEntityId) {
        const visible = await countVisibleEntities(db, ctx.userId, [
          input.subjectEntityId,
        ]);
        if (visible === 0) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Subject entity not found",
          });
        }
      }

      // ── Agent guardrails (P1) — run BEFORE the governance gate so an agent is
      // told to reuse / gather evidence instead of silently filing a duplicate
      // project proposal. Human creators skip this entirely.
      if (isAgent) {
        const match = await findProjectDedupCandidates(db, {
          userId: ctx.userId,
          name: input.name,
        });

        // Exact-normalized match → reuse idempotently; never a second project.
        if (match.exact) {
          return {
            status: "deduped" as const,
            projectId: match.exact.id,
            reusedProjectId: match.exact.id,
          };
        }

        // Gravity: a project is a commitment. Require ≥5 caller-visible entities.
        const evidence = input.evidenceEntityIds ?? [];
        const visibleCount = await countVisibleEntities(
          db,
          ctx.userId,
          evidence
        );
        const gravity = assessEvidenceGravity({
          providedCount: evidence.length,
          visibleCount,
          near: match.near,
        });
        if (!gravity.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: gravity.message,
          });
        }

        // Gravity satisfied but a near-duplicate exists → do NOT proceed
        // silently; surface the candidate so the agent reuses it.
        if (match.near.length > 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: buildNearMatchMessage(match.near),
          });
        }
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        // Bug fix (object-proposal manifest W1): forward the acting agent
        // identity so an agent-authored project create is GOVERNED (routes to a
        // proposal via the agent ladder) instead of auto-applying as if the human
        // operator created it. Undefined for operator/human requests — unchanged.
        agentUserId: ctx.agentUserId ?? undefined,
        workspaceId: ctx.workspaceId,
        subjectType: "project",
        action: "create",
        // Carry the FULL create payload into the proposal, not just the name.
        // The `project/create` executor reads these defensively and, until now,
        // always found them absent — so an approved project lost its
        // description, status, phase and subject. A reviewer also cannot judge
        // a create they are only shown the name of.
        data: {
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.phase ? { phase: input.phase } : {}),
          ...(input.subjectEntityId
            ? { subjectEntityId: input.subjectEntityId }
            : {}),
          ...(input.settings ? { settings: input.settings } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(isAgent && input.evidenceEntityIds
            ? { evidenceEntityIds: input.evidenceEntityIds }
            : {}),
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed",
          projectId: "",
          proposalId: perm.proposalId,
        };
      }

      const eventRepo = new EventRepository(sql);
      const projectRepo = new ProjectRepository(db, eventRepo);

      const created = await projectRepo.create(
        {
          name: input.name,
          description: input.description,
          status: input.status,
          phase: input.phase ?? null,
          settings: input.settings,
          metadata: input.metadata,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId ?? null,
          provenance: buildProjectProvenance({
            door,
            agentUserId: ctx.agentUserId,
            evidenceEntityIds: input.evidenceEntityIds,
          }),
        },
        ctx.userId
      );

      // Idempotent reuse (exact-name match) emits no create side-effects.
      if (created.deduped) {
        return {
          status: "deduped" as const,
          projectId: created.id,
          reusedProjectId: created.id,
        };
      }

      // Bind the subject only on a REAL create. A deduped create returned above
      // is somebody else's project being reused — rebinding its subject from
      // this caller's payload would silently retitle a project they did not make.
      if (input.subjectEntityId) {
        await setProjectSubject({
          db,
          projectId: created.id,
          workspaceId: ctx.workspaceId ?? null,
          entityId: input.subjectEntityId,
          userId: ctx.userId,
        });
      }

      auditLog({
        subjectType: "project",
        action: "create",
        phase: "completed",
        subjectId: created.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "project",
        action: "create",
        subjectId: created.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return {
        status: "created",
        projectId: created.id,
        ...(created.dedupCandidates
          ? { dedupCandidates: created.dedupCandidates }
          : {}),
      };
    }),

  /**
   * Update an existing project
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        status: z.enum(["active", "archived", "completed"]).optional(),
        /** Lifecycle position (0240). `null` clears it. */
        phase: z.string().max(120).nullable().optional(),
        /**
         * Rebind the container's subject entity. `null` unbinds it (the project
         * falls back to its plain typed name). Omitted = untouched.
         */
        subjectEntityId: z.string().uuid().nullable().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "project",
        action: "update",
        // The WHOLE patch, not just the id: an approver has to see what the
        // change actually is, and the `project/update` executor replays these
        // fields. A gate carrying only `{ id }` made an approved update a no-op.
        data: {
          id: input.id,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.phase !== undefined ? { phase: input.phase } : {}),
          ...(input.subjectEntityId !== undefined
            ? { subjectEntityId: input.subjectEntityId }
            : {}),
          ...(input.settings !== undefined ? { settings: input.settings } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed", proposalId: perm.proposalId };
      }

      const db = await getDb();
      const eventRepo = new EventRepository(sql);
      const projectRepo = new ProjectRepository(db, eventRepo);

      await projectRepo.update(input.id, input, ctx.userId);

      // `undefined` = untouched; `null` = unbind. Both are distinguishable here
      // and neither is guessed at.
      if (input.subjectEntityId !== undefined) {
        const bound = await setProjectSubject({
          db,
          projectId: input.id,
          workspaceId: ctx.workspaceId ?? null,
          entityId: input.subjectEntityId,
          userId: ctx.userId,
        });
        if (!bound.ok) {
          throw new TRPCError({ code: "NOT_FOUND", message: bound.reason });
        }
      }

      auditLog({
        subjectType: "project",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "project",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "updated" };
    }),

  /**
   * The automations enrolled in this project — tier 3 under tier 1.
   *
   * Reads the `automation --member_of--> project` edges (see
   * `utils/project-subject.ts` for why this is an edge and not a column).
   * podProcedure, matching `get`: a project's own page must not be gated by the
   * active-workspace lens.
   */
  automations: podProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const memberships = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, ctx.userId));
      return {
        items: await listProjectAutomations(
          db,
          input.projectId,
          memberships.map((m) => m.workspaceId)
        ),
      };
    }),

  /**
   * Enrol or withdraw an automation from a project.
   *
   * Governed as a `project` update — the project is the thing whose composition
   * changes, and gating on the automation instead would let anyone who can edit
   * an automation silently add it to someone else's container.
   */
  setAutomationMembership: workspaceProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        automationId: z.string().uuid(),
        member: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: ctx.agentUserId ?? undefined,
        workspaceId: ctx.workspaceId,
        subjectType: "project",
        action: "update",
        data: {
          id: input.projectId,
          automationId: input.automationId,
          member: input.member,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      const db = await getDb();
      const memberships = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, ctx.userId));

      const result = await setProjectAutomationMembership({
        db,
        projectId: input.projectId,
        automationId: input.automationId,
        workspaceId: ctx.workspaceId ?? null,
        member: input.member,
        visibleWorkspaceIds: memberships.map((m) => m.workspaceId),
      });
      if (!result.ok) {
        throw new TRPCError({ code: "NOT_FOUND", message: result.reason });
      }

      auditLog({
        subjectType: "project",
        action: "update",
        phase: "completed",
        subjectId: input.projectId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "updated" as const };
    }),

  /**
   * Delete a project
   */
  delete: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "project",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed", proposalId: perm.proposalId };
      }

      const db = await getDb();
      const eventRepo = new EventRepository(sql);
      const projectRepo = new ProjectRepository(db, eventRepo);

      await projectRepo.delete(input.id, ctx.userId);

      auditLog({
        subjectType: "project",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "project",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "deleted" };
    }),
});
