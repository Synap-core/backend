/**
 * Projects Router — Project Management (projects TABLE)
 *
 * Projects are first-class table rows in the `projects` pgTable — NOT entities.
 * Synchronous CRUD with ProjectRepository + direct table queries.
 */

import { z } from "zod";
import { router, podProcedure } from "../trpc.js";
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
  isSubjectEntityVisible,
  listProjectAutomations,
  loadProjectSubjects,
  setProjectAutomationMembership,
  setProjectSubject,
} from "../utils/project-subject.js";

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
/**
 * Load a project ONLY if the caller may see it — the ONE visibility floor for
 * single-project reads and for any write that must gate on the project itself.
 *
 * Pod-personal projects (NULL workspace) are owner-only; workspace-scoped ones
 * are visible to every member. Extracted from `get`'s inline predicate so a
 * second caller cannot drift from it — the `automations` read and the
 * membership write both need exactly this floor, and re-typing it is how the
 * two would silently diverge.
 */
async function loadVisibleProject(
  db: Awaited<ReturnType<typeof getDb>>,
  projectId: string,
  userId: string
): Promise<{ id: string; workspaceId: string | null } | undefined> {
  return db.query.projects.findFirst({
    columns: { id: true, workspaceId: true },
    where: and(
      eq(projects.id, projectId),
      or(
        and(isNull(projects.workspaceId), eq(projects.userId, userId)),
        and(
          isNotNull(projects.workspaceId),
          userVisibleWhere(projects.workspaceId, userId)
        )
      )!
    ),
  });
}

export const projectsRouter = router({
  /**
   * List all projects for the current user.
   *
   * podProcedure, NOT workspaceProcedure — the same reasoning `get` below
   * already carries. The WHERE is a pure USER floor (pod-personal projects the
   * caller owns, plus workspace-scoped projects in workspaces they belong to);
   * it never reads `ctx.workspaceId`, so requiring an active workspace gated a
   * read that does not use one.
   *
   * That gate is what broke the Projects app: a project is a CROSS-CUTTING lens
   * that composes with workspaces rather than living inside one, so the app is
   * reachable pod-wide — and pod-wide is precisely when the client's
   * `workspaceLink` refuses a workspace-required procedure ("No active
   * workspace for projects.list"). The list a user opens to see every project
   * they have cannot be the one read that demands they first pick a workspace.
   *
   * Pod-personal projects (NULL workspace) are ONLY visible to their owner, so
   * dropping the workspace requirement widens nothing.
   */
  list: podProcedure
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
        items.map((p) => p.id),
        ctx.userId
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

      const subjects = await loadProjectSubjects(db, [project.id], ctx.userId);
      return { project, subject: subjects.get(project.id) ?? null };
    }),

  /**
   * Create a new project
   */
  /**
   * Create a project.
   *
   * podProcedure — a project created with no active workspace is a POD-PERSONAL
   * project (`workspaceId: null`), which is already a first-class shape: every
   * `ctx.workspaceId` use below is `?? null` or optional, `ProjectRepository`
   * stores it, and `list` above explicitly surfaces NULL-workspace projects to
   * their owner. Only the builder forbade it, so the app could LIST projects
   * pod-wide and then fail on "New".
   *
   * Authorization is not weakened: at pod scope there is no membership to
   * verify because the authenticated bearer IS the owner (the project is
   * written with `userId: ctx.userId` and only that user can ever see it), and
   * `checkPermissionOrPropose` still runs the AGENT governance ladder — an
   * agent-authored create is proposed exactly as before.
   */
  create: podProcedure
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
        const visible = await isSubjectEntityVisible(
          db,
          input.subjectEntityId,
          ctx.userId
        );
        if (!visible) {
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
        // `!== undefined`, not truthiness — matching `update` below. An empty
        // string is a MEANT value (clearing a description); truthiness dropped
        // it from the proposal, so approving restored the old text instead.
        data: {
          name: input.name,
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
      //
      // The result is CHECKED, and a failure is reported as a partial success
      // rather than thrown. The project genuinely exists at this point and its
      // `create.completed` event has fired, so throwing would tell the caller
      // "failed" about a project that is now in their list — and retrying the
      // identical create hits the exact-name dedup above, which deliberately
      // skips the bind, leaving no way to repair it through this door at all.
      // `subjectBound: false` says exactly what happened; the fix is one
      // `projects.update`.
      let subjectBound: boolean | undefined;
      if (input.subjectEntityId) {
        const bound = await setProjectSubject({
          db,
          projectId: created.id,
          workspaceId: ctx.workspaceId ?? null,
          entityId: input.subjectEntityId,
          userId: ctx.userId,
        });
        subjectBound = bound.ok;
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
        // Present ONLY when a subject was requested. `false` = the project was
        // created but the binding did not land (the entity became unreachable
        // between the pre-check and the write) — the caller should surface that
        // rather than showing a silently unbound project.
        ...(subjectBound !== undefined ? { subjectBound } : {}),
        ...(created.dedupCandidates
          ? { dedupCandidates: created.dedupCandidates }
          : {}),
      };
    }),

  /**
   * Update an existing project
   */
  /**
   * Update a project.
   *
   * podProcedure + gate on the LOADED PROJECT's workspace, not `ctx.workspaceId`.
   * Two bugs in one: (1) it 400'd pod-wide, so a pod-personal project — which
   * has no workspace at all — could never be edited from the lens it lives in;
   * (2) it gated on the caller's ACTIVE LENS rather than the row, which is the
   * "gate on the loaded row's workspaceId, never request-supplied" rule this
   * codebase states explicitly. Editing a workspace-A project while workspace B
   * was active checked the wrong workspace's permissions.
   */
  update: podProcedure
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
      const db = await getDb();
      // Load first: the project's OWN workspace is the gate's subject.
      const target = await loadVisibleProject(db, input.id, ctx.userId);
      if (!target) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: target.workspaceId ?? undefined,
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

      const eventRepo = new EventRepository(sql);
      const projectRepo = new ProjectRepository(db, eventRepo);

      // Validate the subject BEFORE writing anything. These are two separate
      // statements, not one transaction — so a subject that fails validation
      // AFTER the field patch landed would report failure on a change that
      // partly applied (the caller retries, and the phase is already set).
      // `setProjectSubject` re-checks this itself (it owns its own floor); this
      // is about ORDER, so the failing case writes nothing at all.
      if (input.subjectEntityId) {
        const visible = await isSubjectEntityVisible(
          db,
          input.subjectEntityId,
          ctx.userId
        );
        if (!visible) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Subject entity not found",
          });
        }
      }

      await projectRepo.update(input.id, input, ctx.userId);

      // `undefined` = untouched; `null` = unbind. Both are distinguishable here
      // and neither is guessed at.
      if (input.subjectEntityId !== undefined) {
        const bound = await setProjectSubject({
          db,
          projectId: input.id,
          workspaceId: target.workspaceId,
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
        workspaceId: target.workspaceId ?? undefined,
      });

      emitSideEffects({
        subjectType: "project",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: target.workspaceId ?? undefined,
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

      // The PROJECT must be visible first — the same floor `get` applies.
      // Without it, passing any project id returned the automations of yours
      // enrolled in it: not a content leak (they are already your automations),
      // but it discloses the RELATIONSHIP "this automation belongs to that
      // project" for a project the caller cannot see.
      const project = await loadVisibleProject(db, input.projectId, ctx.userId);
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      return {
        items: await listProjectAutomations(db, input.projectId, ctx.userId),
      };
    }),

  /**
   * Enrol or withdraw an automation from a project.
   *
   * Governed as a `project` update — the project is the thing whose composition
   * changes, and gating on the automation instead would let anyone who can edit
   * an automation silently add it to someone else's container.
   */
  // podProcedure: it already loads the project and gates on the PROJECT's
  // workspace (see below), so the caller's active lens is irrelevant — and a
  // project's own tab must work from the lens the project is reachable in.
  setAutomationMembership: podProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        automationId: z.string().uuid(),
        member: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();

      // Load the PROJECT first and gate on ITS workspace — never on
      // `ctx.workspaceId`, which is only the caller's active lens. Gating on the
      // lens meant a member of workspace A could enrol an automation into a
      // project in workspace B they cannot see: the permission check passed
      // against A, and nothing downstream ever looked at the project's own
      // workspace. This is the "gate on the LOADED row's workspaceId, never
      // request-supplied" rule.
      const project = await loadVisibleProject(db, input.projectId, ctx.userId);
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: ctx.agentUserId ?? undefined,
        workspaceId: project.workspaceId ?? undefined,
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

      const result = await setProjectAutomationMembership({
        db,
        projectId: input.projectId,
        automationId: input.automationId,
        // The EDGE belongs to the project's workspace, not the caller's lens —
        // it is what scopes the edge for every later read.
        workspaceId: project.workspaceId,
        member: input.member,
        actingUserId: ctx.userId,
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
        workspaceId: project.workspaceId ?? undefined,
      });

      // A composition change IS a project update — without this it was audited
      // but invisible to the event spine, so nothing downstream (feeds,
      // detectors, cache invalidation) could see an automation join or leave a
      // container. `update` emits it; this door must too.
      emitSideEffects({
        subjectType: "project",
        action: "update",
        subjectId: input.projectId,
        userId: ctx.userId,
        workspaceId: project.workspaceId ?? undefined,
      });

      return { status: "updated" as const };
    }),

  /**
   * Delete a project
   */
  delete: podProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // Same shape as `update`: pod-wide must work (a pod-personal project has
      // no workspace to be active in), and the gate's subject is the PROJECT's
      // workspace, never the caller's lens.
      const db = await getDb();
      const target = await loadVisibleProject(db, input.id, ctx.userId);
      if (!target) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: target.workspaceId ?? undefined,
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

      const eventRepo = new EventRepository(sql);
      const projectRepo = new ProjectRepository(db, eventRepo);

      await projectRepo.delete(input.id, ctx.userId);

      auditLog({
        subjectType: "project",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: target.workspaceId ?? undefined,
      });

      emitSideEffects({
        subjectType: "project",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: target.workspaceId ?? undefined,
      });

      return { status: "deleted" };
    }),
});
