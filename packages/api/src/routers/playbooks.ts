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

import { randomUUID } from "node:crypto";
import { createLogger } from "@synap-core/core";
import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  getDb,
  eq,
  and,
  or,
  asc,
  desc,
  drizzleSql,
  playbooks,
  skills,
  focusSessions,
  automations,
  playbookAutomations,
  playbookEnrollments,
  entities,
  secrets,
  vaultGrants,
  workspaceMembers,
  links,
  loadFacetSlugsBatch,
  type FlowDefinition,
} from "@synap/database";
import type {
  Playbook,
  FocusSession,
  Automation,
} from "@synap/database/schema";
import { AccessContext, scopedDb } from "../access/index.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { stableStringify } from "../utils/stable-stringify.js";
import { getLinksFor, createLinks } from "../services/links/links-service.js";
import {
  listCapabilities,
  listCapabilityGrants,
} from "../services/capabilities/capability-registry.js";
import { getWorkspaceRole, requirePodAdmin } from "../utils/workspace-role.js";
import { auditLog } from "../utils/audit-log.js";
import {
  instantiateSession,
  promoteSessionToPlaybook,
  resolveGoal,
} from "../services/playbooks/playbook-lifecycle.js";
import { runPlaybook } from "../services/playbooks/run-playbook.js";
import { materializePlaybookCronAutomation } from "../services/playbooks/cron-automation.js";
import { flowValidationErrorMessage } from "../services/automations/validate-flow.js";

const logger = createLogger({ module: "playbooks-router" });

/**
 * Resolve a subject entity id to bind to a run/session, guarding cross-workspace
 * IDOR: `subject_entity_id` has no FK, so every writer must verify the entity is
 * visible (its own workspace OR pod-wide NULL) before binding. Mirrors the
 * automation-executor guard. Throws NOT_FOUND if the id isn't visible here.
 */
async function resolveVisibleSubjectId(
  database: Awaited<ReturnType<typeof getDb>>,
  subjectId: string | undefined,
  workspaceId: string
): Promise<string | undefined> {
  if (!subjectId) return undefined;
  const subj = await database.query.entities.findFirst({
    columns: { id: true, workspaceId: true },
    where: eq(entities.id, subjectId),
  });
  if (subj && (subj.workspaceId === workspaceId || subj.workspaceId === null)) {
    return subj.id;
  }
  throw new TRPCError({
    code: "NOT_FOUND",
    message: `Subject entity ${subjectId} not found in this workspace`,
  });
}

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
  stages: z.array(jsonRecord).optional(),
  subjectProfile: jsonRecord.optional(),
  schedule: jsonValue.optional(),
  /**
   * Free-form playbook metadata (persisted to `playbooks.metadata`). Carries the
   * propose-only governance marker for unattended maintenance playbooks:
   * `{ governance: { forceProposeWrites: true } }`. `executePlaybookRun` copies
   * this onto the run's focus session so every agent write in the session routes
   * to a reviewable proposal (see permission-check deriveSessionForceProposeGovernance).
   */
  metadata: jsonRecord.optional(),
  executor: executorRefSchema.default("is-agent"),
  status: playbookStatusSchema.default("draft"),
  /**
   * Layer-2 "context skill" — an AI-generated HOW-to-run-this-playbook
   * instruction (Markdown). Persisted as a non-runnable `instruction` skill and
   * linked to the playbook via a `documents` edge; the executor prepends its
   * body to the kickoff. The CALLER generates the body (this mutation stays
   * LLM-free). Optional — omit for playbooks whose goalTemplate is sufficient.
   */
  contextSkill: z
    .object({
      name: z.string().max(200).optional(),
      body: z.string().min(1).max(20000),
    })
    .optional(),
});

export const updateInputSchema = z.object({
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
  stages: z.array(jsonRecord).optional(),
  subjectProfile: jsonRecord.optional(),
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

// ── Capability grants sub-router (polymorphic grant management) ──────────────

const GRANT_KINDS = ["secret", "tool", "skill", "command"] as const;

const capabilityGrantsRouter = router({
  /**
   * List capability grants across ALL grantable kinds (tool · skill · command ·
   * secret) the caller can see, each enriched with the granted capability's
   * display name. Generalizes `secretsVault.listAllGrants` (secret-only) so the
   * polymorphic grants the applier seeds become LISTABLE. Visibility = pod-wide
   * grants + grants in the caller's workspaces.
   */
  list: protectedProcedure
    .input(z.object({ kind: z.enum(GRANT_KINDS).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const memberships = await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.userId, ctx.userId),
        columns: { workspaceId: true },
      });
      return listCapabilityGrants({
        visibleWorkspaceIds: memberships.map((m) => m.workspaceId),
        kind: input?.kind,
      });
    }),

  /**
   * Revoke a capability grant (sets `revokedAt`). Owner/pod-admin gated PER kind:
   *   - workspace-scoped grant → caller must be owner of that workspace;
   *   - pod-wide grant (null workspaceId) → caller must be pod-admin;
   *   - secret grant → caller must own the secret (mirrors the secrets-vault path).
   * Idempotent — re-revoking is a no-op. REUSES the same `vault_grants` table and
   * the shared owner/pod-admin gates (`getWorkspaceRole` / `requirePodAdmin`); it
   * does NOT duplicate `secretsVault.revokeGrant`, which stays for the per-secret
   * surface.
   */
  revoke: protectedProcedure
    .input(z.object({ grantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      const grant = await db.query.vaultGrants.findFirst({
        where: eq(vaultGrants.id, input.grantId),
        columns: {
          id: true,
          grantableType: true,
          grantableId: true,
          workspaceId: true,
          revokedAt: true,
        },
      });
      if (!grant)
        throw new TRPCError({ code: "NOT_FOUND", message: "Grant not found" });

      // Owner/pod-admin gate, keyed off the LOADED grant (never caller input).
      if (grant.grantableType === "secret") {
        // Secret grant — caller must own the underlying secret (same gate as
        // secretsVault.revokeGrant), so the two surfaces agree.
        const secret = await db.query.secrets.findFirst({
          where: and(
            eq(secrets.id, grant.grantableId),
            eq(secrets.userId, ctx.userId)
          ),
          columns: { id: true },
        });
        if (!secret)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not your secret",
          });
      } else if (grant.workspaceId) {
        const role = await getWorkspaceRole(ctx.userId, grant.workspaceId);
        if (role !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace owners can revoke capability grants.",
          });
        }
      } else {
        // Pod-wide (null-workspace) grant — pod-level privileged action.
        await requirePodAdmin(ctx.userId);
      }

      if (!grant.revokedAt) {
        await db
          .update(vaultGrants)
          .set({ revokedAt: new Date() })
          .where(eq(vaultGrants.id, input.grantId));

        auditLog({
          subjectType: "capability_grant",
          action: "revoke",
          phase: "completed",
          subjectId: grant.grantableId,
          userId: ctx.userId,
          workspaceId: grant.workspaceId ?? undefined,
          data: { grantId: input.grantId, grantableType: grant.grantableType },
        });
      }

      return { success: true };
    }),
});

// ── Playbook automations sub-router (first-class, editable composition) ──────
//
// A playbook composes N automations. Historically expressed ONLY as read-only
// `automation --member_of--> playbook` `links` edges; `playbook_automations`
// (0179) promotes that to a first-class, editable, ordered, role-tagged set
// (packages/database/src/schema/playbook-automations.ts). These procedures are
// the first EDITABLE surface for that composition — until now only the
// automation-trigger-matcher worker read it. Auth mirrors this router's other
// write procedures: load-by-id, `assertWorkspaceWrite` on the LOADED
// workspaceId (never caller input) — see `saveFlow` above.
const playbookAutomationsRouter = router({
  /** List a playbook's composed automations, joined + ordered by sortOrder. */
  listAutomations: protectedProcedure
    .input(z.object({ playbookId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Visibility gate — same pattern as `get`.
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

      const database = await getDb();
      const rows = await database
        .select({
          id: automations.id,
          name: automations.name,
          triggerType: automations.triggerType,
          role: playbookAutomations.role,
          sortOrder: playbookAutomations.sortOrder,
        })
        .from(playbookAutomations)
        .innerJoin(
          automations,
          eq(playbookAutomations.automationId, automations.id)
        )
        .where(eq(playbookAutomations.playbookId, input.playbookId))
        .orderBy(asc(playbookAutomations.sortOrder));

      return rows;
    }),

  /**
   * Compose an automation into a playbook. Write-gate on the LOADED playbook's
   * workspaceId (mirrors `update`/`saveFlow`), plus an explicit IDOR guard that
   * the automation itself is visible in that same workspace (or pod-wide) —
   * mirrors `resolveVisibleSubjectId` above. Governance-gated as a playbook
   * "update" (composition is a playbook-shape change).
   */
  addAutomation: protectedProcedure
    .input(
      z.object({
        playbookId: z.string().uuid(),
        automationId: z.string().uuid(),
        role: z.string().optional(),
        sortOrder: z.number().int().optional(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      // 1. Load the playbook by id ONLY — never trust a caller-supplied workspaceId.
      const playbook = await database.query.playbooks.findFirst({
        where: eq(playbooks.id, input.playbookId),
      });
      if (!playbook) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.playbookId} not found`,
        });
      }

      // 2. Write-gate on the LOADED playbook's workspaceId.
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: playbook.workspaceId,
      });

      // 3. IDOR guard: the automation being composed in must be visible in the
      // playbook's own workspace (or pod-wide) — otherwise a caller with write
      // access to playbook A could splice in an automation from workspace B.
      const automation = await database.query.automations.findFirst({
        where: eq(automations.id, input.automationId),
      });
      if (
        !automation ||
        (automation.workspaceId !== playbook.workspaceId &&
          automation.workspaceId !== null)
      ) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Automation ${input.automationId} not found in this workspace`,
        });
      }

      // 4. Governance membrane — same verb/subject as update/saveFlow.
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: playbook.workspaceId,
        subjectType: "playbook",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          id: input.playbookId,
          name: playbook.name,
          addAutomationId: input.automationId,
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Composing automation into playbook proposed for review",
          proposalId: perm.proposalId,
        };
      }

      // 5. First-class join row (role/sortOrder live here — the links edge
      // below can't carry them).
      await database
        .insert(playbookAutomations)
        .values({
          playbookId: input.playbookId,
          automationId: input.automationId,
          role: input.role ?? null,
          sortOrder: input.sortOrder ?? null,
        })
        .onConflictDoNothing({
          target: [
            playbookAutomations.playbookId,
            playbookAutomations.automationId,
          ],
        });

      // 6. Symmetric `links` edge (transition — createLinks also dual-writes
      // the join row above, so this is a no-op there and just keeps the
      // read-only graph view in sync).
      await createLinks([
        {
          workspaceId: playbook.workspaceId,
          fromType: "automation",
          fromId: input.automationId,
          toType: "playbook",
          toId: input.playbookId,
          linkType: "member_of",
        },
      ]);

      return {
        status: "added" as const,
        message: "Automation composed into playbook",
        proposalId: null as string | null,
      };
    }),

  /**
   * Remove an automation from a playbook's composition. Same write-gate +
   * governance contract as `addAutomation`.
   */
  removeAutomation: protectedProcedure
    .input(
      z.object({
        playbookId: z.string().uuid(),
        automationId: z.string().uuid(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      const playbook = await database.query.playbooks.findFirst({
        where: eq(playbooks.id, input.playbookId),
      });
      if (!playbook) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.playbookId} not found`,
        });
      }

      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: playbook.workspaceId,
      });

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: playbook.workspaceId,
        subjectType: "playbook",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          id: input.playbookId,
          name: playbook.name,
          removeAutomationId: input.automationId,
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Removing automation from playbook proposed for review",
          proposalId: perm.proposalId,
        };
      }

      await database
        .delete(playbookAutomations)
        .where(
          and(
            eq(playbookAutomations.playbookId, input.playbookId),
            eq(playbookAutomations.automationId, input.automationId)
          )
        );

      await database
        .delete(links)
        .where(
          and(
            eq(links.fromType, "automation"),
            eq(links.fromId, input.automationId),
            eq(links.toType, "playbook"),
            eq(links.toId, input.playbookId),
            eq(links.linkType, "member_of")
          )
        );

      return {
        status: "removed" as const,
        message: "Automation removed from playbook",
        proposalId: null as string | null,
      };
    }),
});

/**
 * Enrollment shapes exposed to the frontend (contract with the parallel
 * enrollment-UI agent — field names are load-bearing, do not rename).
 */
export interface EnrollmentRow {
  entityId: string;
  entityName: string;
  stepKey: string | null;
  stepLabel: string | null;
  status: string;
}

export interface FunnelStep {
  stepKey: string;
  label: string;
  count: number;
}

/**
 * `step_state` is jsonb with no fixed shape yet (0180_playbook_enrollments.sql
 * added the column ahead of any writer — the "firing" behavior that advances
 * an enrollment's step is a later wave). By convention with the rest of the
 * playbook runtime (focus_sessions.currentStage is the flat analog), this
 * reads a `{ currentStep: string }` shape when present and falls back to null
 * — i.e. every enrollment is stepKey=null until that wave ships.
 */
function deriveStepKey(stepState: unknown): string | null {
  if (
    stepState &&
    typeof stepState === "object" &&
    "currentStep" in stepState &&
    typeof (stepState as { currentStep?: unknown }).currentStep === "string"
  ) {
    return (stepState as { currentStep: string }).currentStep;
  }
  return null;
}

const playbookEnrollmentsRouter = router({
  /** List a playbook's enrolled entities, joined for display + current step. */
  list: protectedProcedure
    .input(z.object({ playbookId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Visibility gate — same pattern as `listAutomations`.
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

      const stages = Array.isArray(playbook.stages)
        ? (playbook.stages as Array<{ key: string; name: string }>)
        : [];
      const stageLabelByKey = new Map(stages.map((s) => [s.key, s.name]));

      const database = await getDb();
      const rows = await database
        .select({
          entityId: playbookEnrollments.entityId,
          entityName: entities.title,
          status: playbookEnrollments.status,
          stepState: playbookEnrollments.stepState,
        })
        .from(playbookEnrollments)
        .innerJoin(entities, eq(playbookEnrollments.entityId, entities.id))
        .where(eq(playbookEnrollments.playbookId, input.playbookId))
        .orderBy(asc(playbookEnrollments.enrolledAt));

      const result: EnrollmentRow[] = rows.map((row) => {
        const stepKey = deriveStepKey(row.stepState);
        return {
          entityId: row.entityId,
          entityName: row.entityName ?? "",
          stepKey,
          stepLabel: stepKey ? (stageLabelByKey.get(stepKey) ?? null) : null,
          status: row.status,
        };
      });

      return result;
    }),

  /**
   * Braze-style funnel: one row per declared stage (template steps once),
   * each carrying a live count of active enrollments currently at that step.
   * Every stage is included even at count 0 so the funnel shape is stable.
   */
  funnel: protectedProcedure
    .input(z.object({ playbookId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
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

      const stages = Array.isArray(playbook.stages)
        ? (playbook.stages as Array<{ key: string; name: string }>)
        : [];

      const database = await getDb();
      const activeEnrollments = await database
        .select({ stepState: playbookEnrollments.stepState })
        .from(playbookEnrollments)
        .where(
          and(
            eq(playbookEnrollments.playbookId, input.playbookId),
            eq(playbookEnrollments.status, "active")
          )
        );

      const countByStepKey = new Map<string, number>();
      for (const row of activeEnrollments) {
        const stepKey = deriveStepKey(row.stepState);
        if (!stepKey) continue;
        countByStepKey.set(stepKey, (countByStepKey.get(stepKey) ?? 0) + 1);
      }

      const result: FunnelStep[] = stages.map((stage) => ({
        stepKey: stage.key,
        label: stage.name,
        count: countByStepKey.get(stage.key) ?? 0,
      }));

      return result;
    }),

  /**
   * Enroll an entity into a playbook. Write-gate on the LOADED playbook's
   * workspaceId (mirrors `addAutomation`), plus an explicit IDOR guard —
   * reuses `resolveVisibleSubjectId` (module-level above) to verify the
   * entity is visible in the playbook's own workspace (or pod-wide) before
   * binding, since `entityId` has no FK (see schema/playbook-enrollments.ts).
   */
  enroll: protectedProcedure
    .input(
      z.object({
        playbookId: z.string().uuid(),
        entityId: z.string().uuid(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      // 1. Load the playbook by id ONLY — never trust a caller-supplied workspaceId.
      const playbook = await database.query.playbooks.findFirst({
        where: eq(playbooks.id, input.playbookId),
      });
      if (!playbook) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.playbookId} not found`,
        });
      }

      // 2. Write-gate on the LOADED playbook's workspaceId.
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: playbook.workspaceId,
      });

      // 3. IDOR guard: the entity being enrolled must be visible in the
      // playbook's own workspace (or pod-wide) — mirrors `addAutomation`'s
      // automation-visibility check above (playbooks.ts:371-386), via the
      // shared `resolveVisibleSubjectId` helper (playbooks.ts:67-84).
      const visibleEntityId = await resolveVisibleSubjectId(
        database,
        input.entityId,
        playbook.workspaceId ?? ""
      );
      if (!visibleEntityId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Entity ${input.entityId} not found in this workspace`,
        });
      }

      // 4. Governance membrane — same verb/subject as addAutomation/update.
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: playbook.workspaceId,
        subjectType: "playbook",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          id: input.playbookId,
          name: playbook.name,
          enrollEntityId: visibleEntityId,
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Enrolling entity into playbook proposed for review",
          proposalId: perm.proposalId,
        };
      }

      // Re-enroll after unenroll: unenroll soft-cancels the row (unique on
      // playbookId+entityId), so onConflictDoNothing would silently no-op a
      // later re-enroll. Reactivate on conflict instead — keep existing
      // stepState (progress), don't reset it.
      await database
        .insert(playbookEnrollments)
        .values({
          playbookId: input.playbookId,
          entityId: visibleEntityId,
          status: "active",
          stepState: {},
        })
        .onConflictDoUpdate({
          target: [
            playbookEnrollments.playbookId,
            playbookEnrollments.entityId,
          ],
          set: { status: "active", updatedAt: new Date() },
        });

      return {
        status: "enrolled" as const,
        message: "Entity enrolled into playbook",
        proposalId: null as string | null,
      };
    }),

  /**
   * Unenroll an entity from a playbook. Soft (status='cancelled') rather than
   * a hard delete, so the funnel/history stays reconstructable — mirrors the
   * lifecycle-status convention already used by focus_sessions.status.
   */
  unenroll: protectedProcedure
    .input(
      z.object({
        playbookId: z.string().uuid(),
        entityId: z.string().uuid(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      const playbook = await database.query.playbooks.findFirst({
        where: eq(playbooks.id, input.playbookId),
      });
      if (!playbook) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.playbookId} not found`,
        });
      }

      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: playbook.workspaceId,
      });

      // Governance membrane — same verb/subject as addAutomation/enroll.
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: playbook.workspaceId,
        subjectType: "playbook",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          id: input.playbookId,
          name: playbook.name,
          unenrollEntityId: input.entityId,
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Unenrolling entity from playbook proposed for review",
          proposalId: perm.proposalId,
        };
      }

      await database
        .update(playbookEnrollments)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(playbookEnrollments.playbookId, input.playbookId),
            eq(playbookEnrollments.entityId, input.entityId)
          )
        );

      return {
        status: "unenrolled" as const,
        message: "Entity unenrolled from playbook",
        proposalId: null as string | null,
      };
    }),
});

// ── Playbooks router ─────────────────────────────────────────────────────────

export const playbooksRouter = router({
  links: linksRouter,
  // Named `capabilityRegistry` (not `capabilities`) to avoid colliding with the
  // pre-existing top-level `capabilities` router in root.ts.
  capabilityRegistry: capabilitiesRouter,
  // Polymorphic grant management (tool|skill|command|secret) — the listable +
  // revocable counterpart to the seeded `vault_grants` the applier issues.
  capabilityGrants: capabilityGrantsRouter,
  // First-class, editable playbook↔automation composition (0179's
  // playbook_automations join table): listAutomations/addAutomation/
  // removeAutomation, nested the same way `links`/`capabilityRegistry` are.
  automations: playbookAutomationsRouter,
  // Entity↔playbook enrollment (0180's playbook_enrollments table):
  // list/funnel/enroll/unenroll, nested the same way `automations` is.
  enrollments: playbookEnrollmentsRouter,

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
   * Match active playbooks whose subject is a given entity profile — the
   * Capture→Session matcher. Given a captured/created entity's `profileSlug`,
   * answer "is there a playbook FOR this kind of thing?" so the capture UI can
   * offer to launch a session bound to that entity (via `instantiate`/`run`).
   *
   * Scoping is IDENTICAL to `list`: `AccessContext.from(ctx)` with no workspace
   * lens → the user floor (all member workspaces + pod-wide globals). This is
   * deliberate — a pod-wide (NULL-workspace) template-seeded playbook MUST match
   * for any workspace's entity, and narrowing to a single workspace lens would
   * drop globals (the `playbooks` VisibilityRule has `includeGlobalsInLens`
   * off).
   *
   * FACET-AWARE (the funnel-entry fix): a captured entity is ONE kind (e.g.
   * `person`) but may wear role-facets (`lead`, `competitor`), and playbooks are
   * keyed to EITHER a kind or a role slug (`subjectProfile.profileSlug`). The
   * capture caller passes only the KIND slug, so a playbook whose subject is a
   * facet-role (`Enrich this lead`, `Qualify this lead`, `Research Competitor`)
   * would never surface. When `entityId` is given we resolve that entity's live
   * facet-role slugs and match on the UNION {passed kind slug} ∪ {facet slugs}.
   * This is what makes the `entityId` input load-bearing (previously accepted
   * only to round-trip into `instantiate`/`run`). Facet reads go through the
   * canonical `loadFacetSlugsBatch` — the SAME workspace-lens + owner-floor door
   * every other facet read uses, never a raw `entity_facets` query.
   *
   * Filter: status='active' AND subject_profile->>'profileSlug' = ANY(matchSet).
   * With no `entityId` (or no facets) the set is just `[profileSlug]`, so the
   * match is unchanged (backward compatible). Returns the lean candidate shape
   * the capture picker needs; [] when none.
   */
  matchForEntity: workspaceProcedure
    .input(
      z.object({
        profileSlug: z.string().min(1),
        // When provided, its live facet-role slugs WIDEN the match set (below);
        // also round-tripped by the caller into `instantiate`/`run` as `subjectId`.
        entityId: z.string().uuid().optional(),
        workspaceId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(playbooks);

      // Build the match set: the passed KIND slug plus, when an entity is given,
      // its live facet-role slugs (deduped). loadFacetSlugsBatch enforces the
      // canonical facet visibility lens (this workspace's facets + pod-wide,
      // owner-floored), so a caller can only widen the set with facets it can see.
      const matchSlugs = [input.profileSlug];
      if (input.entityId) {
        const facetSlugsByEntity = await loadFacetSlugsBatch(
          database,
          [input.entityId],
          { userId: ctx.userId, workspaceId: ctx.workspaceId }
        );
        for (const slug of facetSlugsByEntity.get(input.entityId) ?? []) {
          if (!matchSlugs.includes(slug)) matchSlugs.push(slug);
        }
      }

      const rows = await database
        .select()
        .from(playbooks)
        .where(
          and(
            visibility,
            eq(playbooks.status, "active"),
            // Match the subject KIND (plus any facet slugs) by scalar-equality.
            // NOTE: do NOT use `= ANY(${matchSlugs})` — binding a JS array into
            // the SQL template serializes it as a Postgres array literal, which
            // the pod image's postgres.js driver faults on (same class of gotcha
            // as `sql.json()` — see driver notes). An OR of scalar `=` params is
            // the portable form (mirrors automations.matchForEntity).
            or(
              ...matchSlugs.map(
                (slug) =>
                  drizzleSql`${playbooks.subjectProfile}->>'profileSlug' = ${slug}`
              )
            )
          )
        )
        .orderBy(desc(playbooks.updatedAt));

      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        goalTemplate: p.goalTemplate,
        subjectProfileSlug:
          (p.subjectProfile as { profileSlug?: string } | null)?.profileSlug ??
          input.profileSlug,
        params: p.params,
        executor: p.executor,
      }));
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
        // Widened (object-proposal manifest W1): carry the FULL create input so
        // an approved proposal materializes a real playbook via playbooksRouter
        // .create — not just a labelled shell. Only the PROPOSED (pending) row's
        // stored data changes; the granted/direct-create insert below is
        // untouched. goalTemplate is required by createInputSchema, so without
        // this the approve-path materialization would fail zod validation.
        data: {
          name: input.name,
          description: input.description,
          goalTemplate: input.goalTemplate,
          params: input.params,
          inputStrategy: input.inputStrategy,
          channelSpec: input.channelSpec,
          expectedOutputs: input.expectedOutputs,
          stages: input.stages,
          subjectProfile: input.subjectProfile,
          schedule: input.schedule,
          metadata: input.metadata,
          executor: input.executor,
          status: input.status,
          contextSkill: input.contextSkill,
        },
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
          stages: input.stages ?? [],
          subjectProfile: input.subjectProfile ?? null,
          schedule: input.schedule ?? null,
          metadata: input.metadata ?? {},
          executor: input.executor,
          status: input.status,
        })
        .returning();

      // S1: a scheduled playbook maintains ONE backing cron automation (stamped
      // on flow_automation_id) that the existing automation-cron-scheduler fires.
      await materializePlaybookCronAutomation(created as Playbook, {
        userId: input.agentUserId ?? ctx.userId,
      });

      // W6 Layer-2 context skill — persist the AI-generated "how to run this
      // playbook" instruction as a non-runnable `instruction` skill and link it
      // playbook→skill via a non-grant `documents` edge (kept OUT of the
      // grantable/runnable set so it's never executed). Rides the playbook's
      // approval exactly like the cron automation above (this direct-create path
      // is only reached AFTER checkPermissionOrPropose granted).
      //
      // TWO TRUST BOUNDARIES, deliberately separate: approving the PLAYBOOK is
      // not approving arbitrary prose injected into every future kickoff's
      // system prompt. So the executor injects this body ONLY once it is
      // `approved` (is-agent-executor.ts) — which for an agent author means a
      // human must approve the skill separately. Do not "simplify" either side
      // to match the other. Best-effort — never fail the create.
      if (input.contextSkill?.body?.trim()) {
        try {
          const skillId = randomUUID();
          await database.insert(skills).values({
            id: skillId,
            name: input.contextSkill.name ?? `${input.name} — how to run`,
            kind: "instruction",
            body: input.contextSkill.body,
            scope: "workspace",
            workspaceId: ctx.workspaceId,
            userId: input.agentUserId ?? ctx.userId,
            status: "active",
            // Born-approved only for a trusted human author (mirrors
            // insertSkillGoverned). An agent-authored body stays unapproved and
            // the executor SKIPS it (is-agent-executor.ts filters on `approved`)
            // until a human approves — this body is system-prompt surface.
            approved: !input.agentUserId,
          });
          await createLinks([
            {
              workspaceId: ctx.workspaceId,
              fromType: "playbook",
              fromId: (created as Playbook).id,
              toType: "skill",
              toId: skillId,
              linkType: "documents",
            },
          ]);
        } catch (err) {
          // Non-fatal: a context-skill hiccup must never fail the playbook
          // create. Logged, not swallowed — otherwise the playbook looks healthy
          // while every run silently misses the HOW it was meant to carry.
          logger.warn(
            { err, playbookId: (created as Playbook).id },
            "playbooks.create: context skill persist failed (non-fatal)"
          );
        }
      }

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
      if (input.stages !== undefined) set.stages = input.stages;
      if (input.subjectProfile !== undefined)
        set.subjectProfile = input.subjectProfile;
      if (input.schedule !== undefined) set.schedule = input.schedule;
      if (input.executor !== undefined) set.executor = input.executor;
      if (input.status !== undefined) set.status = input.status;

      // D3c: bump the monotonic definition version when a definition-affecting
      // field actually changes (compared against the loaded row, so a no-op
      // save doesn't inflate it). The version is stamped into each run's
      // definitionSnapshot so "what ran" can be diffed against "today".
      const DEFINITION_FIELDS = [
        "goalTemplate",
        "stages",
        "params",
        "inputStrategy",
        "channelSpec",
        "expectedOutputs",
      ] as const;
      const definitionChanged = DEFINITION_FIELDS.some(
        (f) =>
          set[f] !== undefined &&
          stableStringify(set[f]) !==
            stableStringify((existing as Record<string, unknown>)[f])
      );
      if (definitionChanged) set.version = (existing.version ?? 1) + 1;

      const [updated] = await database
        .update(playbooks)
        .set(set)
        .where(eq(playbooks.id, input.id))
        .returning();

      // S1: re-reconcile the backing cron automation against the new schedule.
      // Idempotent — re-points/updates the SAME row via flow_automation_id, or
      // tears it down when the schedule was cleared/disabled.
      await materializePlaybookCronAutomation(updated as Playbook, {
        userId: input.agentUserId ?? ctx.userId,
      });

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
        /** Subject entity to bind this session to (polymorphic — any entity). */
        subjectId: z.string().uuid().optional(),
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

      // Validate the subject (if any) is visible here before binding (IDOR guard).
      const subjectId = await resolveVisibleSubjectId(
        database,
        input.subjectId,
        ctx.workspaceId
      );

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "focus_session",
        action: "create",
        source: input.source,
        reasoning: input.reasoning,
        // The focus_session/create executor requires `goal` — without it an
        // approved instantiate proposal throws "Focus session proposal is
        // missing goal". Resolve the playbook's goalTemplate against params NOW
        // (propose time), matching the direct instantiateSession path so the
        // materialized session's goal is identical whether approved or direct.
        data: {
          playbookId: input.playbookId,
          name: playbook.name,
          goal: resolveGoal(
            playbook.goalTemplate,
            (input.params ?? {}) as Record<string, unknown>
          ),
        },
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
        subjectId,
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
        // Split the overloaded `playbook/create` key: raw create (name +
        // executor + goalTemplate) and promote (sessionId → snapshot a session)
        // both used to emit `playbook/create`, so ONE executor could not
        // materialize both. Promote now emits `playbook/promote` → its own clean
        // executor (playbooksRouter.promote). `requiredPermissionFor("promote")`
        // fail-closes to "write" (identical to "create"), so RBAC/governance is
        // unchanged; only the proposalType string (and thus the apply key) forks.
        action: "promote",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          sessionId: input.sessionId,
          name: input.name,
          description: input.description,
        },
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
        /** Subject entity to bind this run to (polymorphic — any entity). */
        subjectId: z.string().uuid().optional(),
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

      // Validate the subject (if any) is visible here before binding (IDOR guard).
      const subjectId = await resolveVisibleSubjectId(
        database,
        input.subjectId,
        ctx.workspaceId
      );

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
        subjectId,
      });

      return {
        run,
        session,
        status: "running" as const,
        message: "Playbook run started",
        proposalId: null as string | null,
      };
    }),

  /**
   * Get the flow graph for a playbook (Option-C model: playbook references an
   * automation that owns the flow definition via `flow_automation_id`).
   *
   * If `flow_automation_id` is set → load that automation's flowDefinition.
   * If NOT set → return a lazy starter graph (NOT persisted) seeded from the
   * playbook's name and goalTemplate. `automationId: null` signals the caller
   * that no automation exists yet (saveFlow will create one on first save).
   */
  getFlow: protectedProcedure
    .input(z.object({ playbookId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Load with visibility gate — same pattern as `get`.
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

      // Existing automation → return its persisted flow.
      if (playbook.flowAutomationId) {
        const database = await getDb();
        const automation = await database.query.automations.findFirst({
          where: eq(automations.id, playbook.flowAutomationId),
        });
        if (automation) {
          return {
            flowDefinition: automation.flowDefinition as FlowDefinition,
            automationId: automation.id as string,
          };
        }
        // Dangling pointer (automation deleted) — fall through and return starter.
      }

      // No automation yet → return a lazy starter graph (not persisted).
      const triggerId = "trigger-1";
      const commandId = "command-1";
      const starterFlow: FlowDefinition = {
        nodes: [
          {
            id: triggerId,
            type: "trigger",
            position: { x: 250, y: 50 },
            data: {
              triggerType: "manual",
              label: playbook.name,
              config: {},
            },
          },
          {
            id: commandId,
            type: "command",
            position: { x: 250, y: 200 },
            data: {
              commandTitle: playbook.goalTemplate,
              inputMapping: {},
            },
          },
        ],
        edges: [
          {
            id: `${triggerId}-${commandId}`,
            source: triggerId,
            target: commandId,
          },
        ],
      };

      return {
        flowDefinition: starterFlow,
        automationId: null as string | null,
      };
    }),

  /**
   * Save the flow graph for a playbook (Option-C model).
   *
   * If `flow_automation_id` is already set → update that automation's
   * flowDefinition in-place.
   * If NOT set → create a new "manual" draft automation, stamp
   * `playbooks.flow_automation_id`, and write an `automation --activates-->
   * playbook` link edge.
   *
   * Governance-gated (mirrors `update`): write-gate on the LOADED playbook's
   * workspaceId + checkPermissionOrPropose. On "proposed" returns without
   * writing.
   */
  saveFlow: protectedProcedure
    .input(
      z.object({
        playbookId: z.string().uuid(),
        flowDefinition: z.object({
          nodes: z.array(z.unknown()),
          edges: z.array(z.unknown()),
        }),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      // 1. Load by id ONLY — never trust a caller-supplied workspaceId.
      const existing = await database.query.playbooks.findFirst({
        where: eq(playbooks.id, input.playbookId),
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.playbookId} not found`,
        });
      }

      // 2. Write-gate on the LOADED row's workspaceId (never input.*).
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
      });

      // 2b. Node-contract validation — same gate as automations.create/update.
      // saveFlow is the playbook-canvas author-time door that writes an
      // automation's flowDefinition (update in-place or first-save insert), so a
      // malformed flow must be rejected here too, not only via automations.*.
      const flowError = flowValidationErrorMessage(input.flowDefinition);
      if (flowError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: flowError });
      }

      // 3. Governance membrane — same verb as update.
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: existing.workspaceId,
        subjectType: "playbook",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        data: { id: input.playbookId, name: existing.name },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          automationId: null as string | null,
          status: "proposed" as const,
          message: "Flow save proposed for review",
          proposalId: perm.proposalId,
        };
      }

      const flowDef = input.flowDefinition as FlowDefinition;

      // 4a. Existing automation → update its flowDefinition in-place.
      if (existing.flowAutomationId) {
        await database
          .update(automations)
          .set({ flowDefinition: flowDef, updatedAt: new Date() })
          .where(eq(automations.id, existing.flowAutomationId));

        return {
          automationId: existing.flowAutomationId as string,
          status: "updated" as const,
          message: "Flow definition updated",
          proposalId: null as string | null,
        };
      }

      // 4b. No automation yet → create one, stamp playbook, write link edge.
      const [created] = await database
        .insert(automations)
        .values({
          workspaceId: existing.workspaceId,
          createdBy: input.agentUserId ?? ctx.userId,
          name: existing.name,
          description: existing.description ?? null,
          triggerType: "manual",
          triggerConfig: {},
          flowDefinition: flowDef,
          status: "draft",
          metadata: { createdVia: "manual", playbookId: existing.id },
        })
        .returning({ id: automations.id });

      const automationId = (created as Pick<Automation, "id">).id;

      // Stamp the playbook with the new automation id.
      await database
        .update(playbooks)
        .set({ flowAutomationId: automationId, updatedAt: new Date() })
        .where(eq(playbooks.id, existing.id));

      // Write the `automation --activates--> playbook` link edge (idempotent).
      await createLinks([
        {
          workspaceId: existing.workspaceId,
          fromType: "automation",
          fromId: automationId,
          toType: "playbook",
          toId: existing.id,
          linkType: "activates",
        },
      ]);

      return {
        automationId: automationId as string,
        status: "created" as const,
        message: "Flow automation created and linked",
        proposalId: null as string | null,
      };
    }),
});
