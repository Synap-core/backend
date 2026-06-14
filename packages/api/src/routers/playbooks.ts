/**
 * Playbooks tRPC Router (+ folded `links` read + `capabilities` list)
 *
 * Playbooks & Capability Substrate — the session-template store.
 * A Playbook is CONFIGURATION (a template of a Session): goal + params +
 * granted capabilities + input-strategy + channel-spec + expected outputs +
 * optional schedule + executor target.
 *
 * Governance: every create / update / archive flows through
 * `checkPermissionOrPropose({ subjectType: "playbook", action })` and the
 * write-gate — mutations load the row by id and gate on the LOADED row's
 * workspaceId, never a caller-supplied value. Reads are auto-approved
 * ("playbook.read" / "link.read" / "capability.read" in @synap/governance-policy)
 * and scoped through the access layer (scopedDb visibility rule).
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.2)
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  getDb,
  eq,
  and,
  desc,
  playbooks,
  focusSessions,
} from "@synap/database";
import type { Playbook, FocusSession } from "@synap/database/schema";
import { AccessContext, scopedDb } from "../access/index.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { getLinksFor } from "../services/links/links-service.js";
import { listCapabilities } from "../services/capabilities/capability-registry.js";
import {
  instantiateSession,
  promoteSessionToPlaybook,
} from "../services/playbooks/playbook-lifecycle.js";
import { runPlaybook } from "../services/playbooks/run-playbook.js";

// ── Shared input schemas ─────────────────────────────────────────────────────

const executorRefSchema = z.enum(["is-agent", "external-agent", "hybrid"]);
const playbookStatusSchema = z.enum(["draft", "active", "paused", "archived"]);

const linkEndpointTypeSchema = z.enum([
  "playbook",
  "tool",
  "skill",
  "command",
  "session",
  "source",
  "entity",
  "channel",
  "participant",
]);

// The richer JSONB shapes (params/inputStrategy/channelSpec/expectedOutputs/
// schedule) conform to @synap/playbooks contracts; stored loosely and validated
// at the domain boundary, so accept them as open JSON here.
const jsonRecord = z.record(z.string(), z.unknown());
const jsonValue: z.ZodType<unknown> = z.unknown();

const createInputSchema = z.object({
  /** AI attribution — set by AI callers so the governance gate runs the agent ladder. */
  agentUserId: z.string().uuid().optional(),
  source: z.string().optional(),
  reasoning: z.string().optional(),
  name: z.string().min(1).max(500),
  description: z.string().optional(),
  goalTemplate: z.string().min(1).max(5000),
  params: z.array(jsonRecord).optional(),
  inputStrategy: jsonRecord.optional(),
  channelSpec: jsonRecord.optional(),
  expectedOutputs: z.array(jsonRecord).optional(),
  schedule: jsonValue.optional(),
  executor: executorRefSchema.default("is-agent"),
  status: playbookStatusSchema.default("draft"),
});

const updateInputSchema = z.object({
  id: z.string().uuid(),
  agentUserId: z.string().uuid().optional(),
  source: z.string().optional(),
  reasoning: z.string().optional(),
  name: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  goalTemplate: z.string().min(1).max(5000).optional(),
  params: z.array(jsonRecord).optional(),
  inputStrategy: jsonRecord.optional(),
  channelSpec: jsonRecord.optional(),
  expectedOutputs: z.array(jsonRecord).optional(),
  schedule: jsonValue.optional(),
  executor: executorRefSchema.optional(),
  status: playbookStatusSchema.optional(),
});

// ── Links sub-router (read-only) ─────────────────────────────────────────────

const linksRouter = router({
  /**
   * The ONE query that powers a detail page's "related" panel + the capability
   * graph: every edge touching (type, id) on either end.
   */
  getFor: protectedProcedure
    .input(
      z.object({
        type: linkEndpointTypeSchema,
        id: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Scoped to the caller's visible workspaces (incl. pod-wide) in the service.
      return getLinksFor(ctx.userId, input.type, input.id);
    }),
});

// ── Capabilities sub-router (read-only adapter) ──────────────────────────────

const capabilitiesRouter = router({
  /**
   * The unified capability read-model for the active workspace (tools + skills
   * + commands today; builtin IS tools deferred to a later slice).
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    return listCapabilities({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
    });
  }),
});

// ── Playbooks router ─────────────────────────────────────────────────────────

export const playbooksRouter = router({
  links: linksRouter,
  // Named `capabilityRegistry` (not `capabilities`) to avoid colliding with the
  // pre-existing top-level `capabilities` router in root.ts.
  capabilityRegistry: capabilitiesRouter,

  /**
   * List playbooks visible in the active workspace (pod-wide + this workspace),
   * most recent first. Visibility enforced via scopedDb predicate.
   */
  list: workspaceProcedure
    .input(
      z
        .object({
          status: playbookStatusSchema.optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(playbooks);

      return database
        .select()
        .from(playbooks)
        .where(
          and(
            visibility,
            input?.status !== undefined
              ? eq(playbooks.status, input.status)
              : undefined
          )
        )
        .orderBy(desc(playbooks.createdAt))
        .limit(input?.limit ?? 50);
    }),

  /**
   * Get a single playbook by id. Workspace visibility enforced structurally
   * via scopedDb.findFirst.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await scopedDb(AccessContext.from(ctx)).findFirst<Playbook>(
        playbooks,
        { where: eq(playbooks.id, input.id) }
      );

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.id} not found`,
        });
      }

      return row;
    }),

  /**
   * Create a new playbook. Governance-gated: AI callers (agentUserId set) route
   * through checkPermissionOrPropose; on "proposed" the row is NOT written.
   */
  create: workspaceProcedure
    .input(createInputSchema)
    .mutation(async ({ ctx, input }) => {
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "playbook",
        action: "create",
        source: input.source,
        reasoning: input.reasoning,
        data: { name: input.name, executor: input.executor },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          playbook: null as Playbook | null,
          status: "proposed" as const,
          message: "Playbook creation proposed for review",
          proposalId: perm.proposalId,
        };
      }

      const database = await getDb();
      const [created] = await database
        .insert(playbooks)
        .values({
          workspaceId: ctx.workspaceId,
          createdBy: input.agentUserId ?? ctx.userId,
          name: input.name,
          description: input.description ?? null,
          goalTemplate: input.goalTemplate,
          params: input.params ?? [],
          inputStrategy: input.inputStrategy ?? { kind: "none" },
          channelSpec: input.channelSpec ?? {},
          expectedOutputs: input.expectedOutputs ?? [],
          schedule: input.schedule ?? null,
          executor: input.executor,
          status: input.status,
        })
        .returning();

      return {
        playbook: created as Playbook,
        status: "created" as const,
        message: "Playbook created",
        proposalId: null as string | null,
      };
    }),

  /**
   * Update an existing playbook. Write-gate: load the row by id alone, gate on
   * the LOADED row's workspaceId (never a caller-supplied value), then route
   * through checkPermissionOrPropose before executing.
   */
  update: protectedProcedure
    .input(updateInputSchema)
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      // 1. Load by id ONLY — never trust a caller-supplied workspaceId.
      const existing = await database.query.playbooks.findFirst({
        where: eq(playbooks.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.id} not found`,
        });
      }

      // 2. Verify membership on the LOADED row's workspace.
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
      });

      // 3. Governance membrane decides approve vs propose.
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: existing.workspaceId,
        subjectType: "playbook",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        data: { id: input.id, name: input.name },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          playbook: null as Playbook | null,
          status: "proposed" as const,
          message: "Playbook update proposed for review",
          proposalId: perm.proposalId,
        };
      }

      // 4. Execute only after gate approval — build only supplied fields.
      const set: Partial<typeof playbooks.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) set.name = input.name;
      if (input.description !== undefined) set.description = input.description;
      if (input.goalTemplate !== undefined)
        set.goalTemplate = input.goalTemplate;
      if (input.params !== undefined) set.params = input.params;
      if (input.inputStrategy !== undefined)
        set.inputStrategy = input.inputStrategy;
      if (input.channelSpec !== undefined) set.channelSpec = input.channelSpec;
      if (input.expectedOutputs !== undefined)
        set.expectedOutputs = input.expectedOutputs;
      if (input.schedule !== undefined) set.schedule = input.schedule;
      if (input.executor !== undefined) set.executor = input.executor;
      if (input.status !== undefined) set.status = input.status;

      const [updated] = await database
        .update(playbooks)
        .set(set)
        .where(eq(playbooks.id, input.id))
        .returning();

      return {
        playbook: updated as Playbook,
        status: "updated" as const,
        message: "Playbook updated",
        proposalId: null as string | null,
      };
    }),

  /**
   * Archive a playbook (soft state transition → "archived"). Same write-gate +
   * governance contract as update; "archive" is a destructive verb so it
   * proposes in agent-owned workspaces.
   */
  archive: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      const existing = await database.query.playbooks.findFirst({
        where: eq(playbooks.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.id} not found`,
        });
      }

      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
      });

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: existing.workspaceId,
        subjectType: "playbook",
        action: "archive",
        source: input.source,
        reasoning: input.reasoning,
        data: { id: input.id, name: existing.name },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          playbook: null as Playbook | null,
          status: "proposed" as const,
          message: "Playbook archive proposed for review",
          proposalId: perm.proposalId,
        };
      }

      if (existing.status === "archived") {
        return {
          playbook: existing as Playbook,
          status: "archived" as const,
          message: "Playbook already archived",
          proposalId: null as string | null,
        };
      }

      const [archived] = await database
        .update(playbooks)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(playbooks.id, input.id))
        .returning();

      return {
        playbook: archived as Playbook,
        status: "archived" as const,
        message: "Playbook archived",
        proposalId: null as string | null,
      };
    }),

  /**
   * Instantiate a runtime session from a playbook (config → runtime).
   * Governance-gated (focus_session create): AI callers route through a proposal;
   * a human member creates directly. On "proposed" no session is written.
   */
  instantiate: workspaceProcedure
    .input(
      z.object({
        playbookId: z.string().uuid(),
        params: z.record(z.string(), z.unknown()).optional(),
        agentIds: z.array(z.string()).optional(),
        channelId: z.string().uuid().optional(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // The playbook must be visible in this workspace (pod-wide or a member ws).
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

      // Editor+ write floor — workspaceProcedure only verifies membership of ANY
      // role; instantiating a session is a write, so require editor+ like the
      // rest of this router's mutations.
      const database = await getDb();
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: ctx.workspaceId,
      });

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "focus_session",
        action: "create",
        source: input.source,
        reasoning: input.reasoning,
        data: { playbookId: input.playbookId, name: playbook.name },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          session: null as FocusSession | null,
          status: "proposed" as const,
          message: "Session instantiation proposed for review",
          proposalId: perm.proposalId,
        };
      }

      const session = await instantiateSession({
        playbookId: input.playbookId,
        workspaceId: ctx.workspaceId,
        userId: input.agentUserId ?? ctx.userId,
        params: input.params,
        channelId: input.channelId ?? null,
        agentIds: input.agentIds,
      });
      return {
        session,
        status: "created" as const,
        message: "Session instantiated",
        proposalId: null as string | null,
      };
    }),

  /**
   * Promote a validated session into a reusable Playbook (runtime → config).
   * Write-gated on the LOADED session's workspace; governance-gated (playbook
   * create). Re-grants the capabilities the session used and records lineage.
   */
  promote: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        name: z.string().min(1).max(500).optional(),
        description: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      // Load by id ONLY, then gate on the loaded row's workspace.
      const session = await database.query.focusSessions.findFirst({
        where: eq(focusSessions.id, input.sessionId),
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Session ${input.sessionId} not found`,
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: session.workspaceId,
      });

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: session.workspaceId,
        subjectType: "playbook",
        action: "create",
        source: input.source,
        reasoning: input.reasoning,
        data: { sessionId: input.sessionId, name: input.name },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          playbook: null as Playbook | null,
          status: "proposed" as const,
          message: "Playbook promotion proposed for review",
          proposalId: perm.proposalId,
        };
      }

      const playbook = await promoteSessionToPlaybook({
        sessionId: input.sessionId,
        userId: input.agentUserId ?? ctx.userId,
        name: input.name,
        description: input.description,
      });
      return {
        playbook,
        status: "promoted" as const,
        message: "Session promoted to playbook",
        proposalId: null as string | null,
      };
    }),

  /**
   * Run a playbook (config → runtime → dispatch). The executor spine (P3):
   * instantiates a session, creates the run channel, records a playbook_run, and
   * dispatches to the playbook's executor (is-agent | external-agent | hybrid).
   *
   * Governance: editor+ write floor + checkPermissionOrPropose
   * ({ subjectType: "playbook", action: "run" }). On "denied" → 403; on
   * "proposed" → no run is created (the proposal is the record). Only on
   * approval does `runPlaybook` execute.
   */
  run: workspaceProcedure
    .input(
      z.object({
        playbookId: z.string().uuid(),
        params: z.record(z.string(), z.unknown()).optional(),
        agentIds: z.array(z.string()).optional(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // The playbook must be visible in this workspace (pod-wide or a member ws).
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

      // Editor+ write floor — running a playbook spawns a session + channel +
      // run (all writes), so require editor+ like the rest of this router.
      const database = await getDb();
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: ctx.workspaceId,
      });

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "playbook",
        action: "run",
        source: input.source,
        reasoning: input.reasoning,
        data: { playbookId: input.playbookId, name: playbook.name },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          run: null,
          session: null as FocusSession | null,
          status: "proposed" as const,
          message: "Playbook run proposed for review",
          proposalId: perm.proposalId,
        };
      }

      const { run, session } = await runPlaybook({
        playbookId: input.playbookId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        params: input.params,
        agentIds: input.agentIds,
        agentUserId: input.agentUserId,
      });

      return {
        run,
        session,
        status: "running" as const,
        message: "Playbook run started",
        proposalId: null as string | null,
      };
    }),
});
