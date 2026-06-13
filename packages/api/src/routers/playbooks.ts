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
import { getDb, eq, and, desc, playbooks } from "@synap/database";
import type { Playbook } from "@synap/database/schema";
import { AccessContext, scopedDb } from "../access/index.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { getLinksFor } from "../services/links/links-service.js";
import { listCapabilities } from "../services/capabilities/capability-registry.js";

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
});
