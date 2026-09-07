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
  isNull,
  inArray,
  getDb,
  EventRepository,
  sql,
  ProjectRepository,
  playbooks,
  findProjectDedupCandidates,
  assessEvidenceGravity,
  buildNearMatchMessage,
  buildProjectProvenance,
} from "@synap/database";
import type { Playbook } from "@synap/database/schema";
import {
  resolveStageCategory,
  type PlaybookStage,
  type PlaybookStageCategory,
} from "@synap/playbooks";
import { TRPCError } from "@trpc/server";
import { AccessContext, scopedDb } from "../access/index.js";
import { createLinks } from "../services/links/links-service.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
import { ownerPrivateVisibleWhere } from "../utils/user-visible-where.js";
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
): Promise<
  | {
      id: string;
      workspaceId: string | null;
      userId: string;
      phase: string | null;
      settings: unknown;
    }
  | undefined
> {
  // `userId` / `phase` / `settings` are additive to the original
  // `{ id, workspaceId }`: `instantiateFromPlaybook` needs the CURRENT settings
  // to merge into (a wholesale `.set()` on the jsonb would clobber every other
  // key) and the current phase to decide whether it may seed one. Existing
  // callers destructure only what they used before.
  return db.query.projects.findFirst({
    columns: {
      id: true,
      workspaceId: true,
      userId: true,
      phase: true,
      settings: true,
    },
    where: and(
      eq(projects.id, projectId),
      ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId)!
    ),
  });
}

// ─── Project ↔ playbook stage binding (pure) ──────────────────────────────────

/**
 * The keys `instantiateFromPlaybook` writes into `projects.settings` (jsonb).
 *
 * There is NO column and NO migration for any of this: `projects.settings`
 * already exists, and `links` already accepts `fromType: "project"` +
 * `linkType: "instantiated_from"` (both are `$type<>` annotations on plain
 * `text`, with no DB check constraint).
 */
export const PROJECT_STAGES_KEY = "stages";
export const PROJECT_SOURCE_PLAYBOOK_KEY = "sourcePlaybookId";
export const PROJECT_SOURCE_PLAYBOOK_VERSION_KEY = "sourcePlaybookVersion";

/**
 * Build the project's new `settings` when it is bound to a project playbook.
 *
 * TWO invariants live here, and both are the point of the function:
 *
 *  1. MERGE, never replace. `ProjectRepository.update` passes `settings`
 *     straight into `.set()`, so returning a bare `{ stages }` would DROP every
 *     other key the project already carried.
 *
 *  2. DEEP copy the stages. `structuredClone`, not a spread — a spread
 *     (`[...playbook.stages]`) copies the ARRAY but shares every stage OBJECT
 *     with the playbook, so editing the project's copy would silently edit the
 *     template (and vice versa). That is a documented, shipped bug in Odoo's
 *     "duplicate project from template", and it is exactly what this door would
 *     reproduce. `settings` is jsonb, so the values are plain JSON and
 *     `structuredClone` is total over them.
 *
 * The copy is a SNAPSHOT: a later edit to the playbook does NOT propagate. The
 * lineage keys (+ the `project --instantiated_from--> playbook` edge the caller
 * writes) are what make the snapshot traceable back to its source.
 */
export function buildProjectStageSettings(
  currentSettings: unknown,
  playbook: { id: string; version: number; stages: unknown },
  now: Date = new Date()
): Record<string, unknown> {
  const base =
    currentSettings &&
    typeof currentSettings === "object" &&
    !Array.isArray(currentSettings)
      ? (currentSettings as Record<string, unknown>)
      : {};
  const source = Array.isArray(playbook.stages)
    ? (playbook.stages as PlaybookStage[])
    : [];

  return {
    ...base,
    [PROJECT_STAGES_KEY]: structuredClone(source),
    [PROJECT_SOURCE_PLAYBOOK_KEY]: playbook.id,
    [PROJECT_SOURCE_PLAYBOOK_VERSION_KEY]: playbook.version,
    stagesBoundAt: now.toISOString(),
  };
}

/** The stages a project has copied, or `[]` when it was never bound to one. */
export function readProjectStages(settings: unknown): PlaybookStage[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return [];
  }
  const stored = (settings as Record<string, unknown>)[PROJECT_STAGES_KEY];
  return Array.isArray(stored) ? (stored as PlaybookStage[]) : [];
}

/**
 * Resolve a project's free-text `phase` onto the CLOSED rollup category a
 * cross-project board can group on.
 *
 * This adds NO second defaulting site: the only thing done here is finding the
 * copied stage whose `key` matches the phase — the category itself always comes
 * out of `resolveStageCategory`, the ONE place that default lives. An unbound
 * project (free text, no copied stages — every project today) and a legacy
 * category-less stage therefore land on the SAME documented default, through
 * the same function, rather than on a locally invented answer.
 */
export function resolveProjectPhaseCategory(
  phase: string | null | undefined,
  settings: unknown
): PlaybookStageCategory {
  const stages = readProjectStages(settings);
  const match = phase
    ? stages.find((stage) => stage?.key === phase)
    : undefined;
  return resolveStageCategory(match);
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
        ownerPrivateVisibleWhere(
          projects.workspaceId,
          projects.userId,
          ctx.userId
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
        // Additive: the CLOSED rollup category the free-text `phase` maps onto,
        // resolved from the project's own copied stages. Sent from here so a
        // board can group without re-deriving it (and without a second
        // defaulting site) — `phase` itself is untouched.
        phaseCategory: resolveProjectPhaseCategory(p.phase, p.settings),
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
          ownerPrivateVisibleWhere(
            projects.workspaceId,
            projects.userId,
            ctx.userId
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
      return {
        project,
        subject: subjects.get(project.id) ?? null,
        // Same additive rollup field `list` carries — see there.
        phaseCategory: resolveProjectPhaseCategory(
          project.phase,
          project.settings
        ),
      };
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
   * Bind a project to a PROJECT-SCOPED playbook — the door that turns a
   * project's free-text `phase` into a DECLARED stage.
   *
   * The playbook's `stages` are DEEP-COPIED onto the project
   * (`settings.stages`) rather than referenced: a project is a months-long
   * container, and a template edited after the fact must not silently rewrite
   * the vocabulary a live engagement is already sitting in. See
   * `buildProjectStageSettings` for why the copy is `structuredClone` and not a
   * spread. Lineage (source playbook id + its `version`, plus a
   * `project --instantiated_from--> playbook` edge) is what keeps the snapshot
   * traceable.
   *
   * podProcedure + gate on the LOADED project's workspace — the same floor
   * `update` and `setAutomationMembership` apply, and for the same reasons (a
   * pod-personal project has no workspace at all; the caller's active lens is
   * never the gate's subject).
   */
  instantiateFromPlaybook: podProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        playbookId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();

      const project = await loadVisibleProject(db, input.projectId, ctx.userId);
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // The playbook's own visibility floor — `scopedDb` + the `playbooks`
      // VisibilityRule, exactly as `playbooks.get` reads it. `AccessContext.from`
      // carries no workspace lens, so this works pod-wide.
      const playbook = await scopedDb(
        AccessContext.from(ctx)
      ).findFirst<Playbook>(playbooks, {
        where: eq(playbooks.id, input.playbookId),
      });
      if (!playbook) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.playbookId} not found`,
        });
      }

      // A SESSION playbook is a template for a focus_session — a bounded run
      // with a goal, granted capabilities and a channel. Copying its stages onto
      // a project would give the container a vocabulary describing a work
      // session, not an engagement. Only `scope: "project"` may bind here.
      if (playbook.scope !== "project") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `Playbook "${playbook.name}" is ${playbook.scope ?? "session"}-scoped. ` +
            "Only a project-scoped playbook can be bound to a project — a session " +
            "playbook is instantiated as a focus session instead.",
        });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: ctx.agentUserId ?? undefined,
        workspaceId: project.workspaceId ?? undefined,
        subjectType: "project",
        action: "instantiate_from_playbook",
        // EVERYTHING the executor needs, not just `{ id }` — a gate that stored
        // only the id is why an earlier approved update applied nothing. Both
        // ids are re-resolved (and re-gated) by the replay, so nothing derived
        // from them is stored here.
        data: { id: input.projectId, playbookId: input.playbookId },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      const settings = buildProjectStageSettings(project.settings, playbook);
      const stages = readProjectStages(settings);

      // Seed the phase ONLY when the project has none. An existing phase is a
      // human's statement about where the work is; silently rewriting it to the
      // template's first stage would move a live engagement backwards. The
      // result says which happened rather than leaving the caller to guess.
      const seedPhase =
        !project.phase && stages.length > 0 ? stages[0].key : undefined;

      const eventRepo = new EventRepository(sql);
      const projectRepo = new ProjectRepository(db, eventRepo);
      await projectRepo.update(
        input.projectId,
        {
          settings,
          ...(seedPhase !== undefined ? { phase: seedPhase } : {}),
        },
        ctx.userId
      );

      // Provenance edge — the same `createLinks` door and the same
      // `instantiated_from` shape `playbook-lifecycle.ts` writes for a session.
      // Idempotent on the unique edge, so re-binding never duplicates it.
      await createLinks([
        {
          workspaceId: project.workspaceId,
          fromType: "project",
          fromId: input.projectId,
          toType: "playbook",
          toId: playbook.id,
          linkType: "instantiated_from",
        },
      ]);

      auditLog({
        subjectType: "project",
        action: "instantiate_from_playbook",
        phase: "completed",
        subjectId: input.projectId,
        userId: ctx.userId,
        workspaceId: project.workspaceId ?? undefined,
      });

      // Emitted as a project UPDATE, not as the specific verb: the project row
      // genuinely changed (settings, possibly phase), and every existing
      // downstream consumer — feeds, detectors, cache invalidation — is
      // subscribed to `project.update`. A new event name would be invisible to
      // all of them, which is the "fired into a provably empty receiver set"
      // defect this codebase has already hit.
      emitSideEffects({
        subjectType: "project",
        action: "update",
        subjectId: input.projectId,
        userId: ctx.userId,
        workspaceId: project.workspaceId ?? undefined,
      });

      return {
        status: "instantiated" as const,
        playbookId: playbook.id,
        playbookVersion: playbook.version,
        stageCount: stages.length,
        phase: seedPhase ?? project.phase,
        /** The project had no phase and one was seeded from `stages[0]`. */
        phaseSeeded: seedPhase !== undefined,
        /** The project already had a phase and it was LEFT ALONE. */
        phaseKept: !!project.phase,
      };
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
