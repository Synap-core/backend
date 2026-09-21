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
import { decodeHtmlEntities } from "@synap-core/types/text";
import {
  router,
  protectedProcedure,
  workspaceProcedure,
  assertWorkspaceUsable,
} from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  getDb,
  eq,
  and,
  or,
  gt,
  lt,
  isNull,
  ne,
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
import {
  readPlaybookParams,
  resolveStageCategory,
  validatePlaybookParams,
  type PlaybookStageCategory,
} from "@synap/playbooks";
import { playbookStagesSchema } from "../schemas/playbook-stage.js";
import { sessionCriteriaSchema } from "../schemas/session-criteria.js";
import { playbookScheduleInputSchema } from "../schemas/playbook-schedule.js";
import { AccessContext, scopedDb } from "../access/index.js";
import { rankRouteCandidates } from "../services/routing/suggest-routes.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import {
  checkPermissionOrPropose,
  previewPermissionDecision,
  proposedMessageFor,
} from "../utils/permission-check.js";
import { stableStringify } from "../utils/stable-stringify.js";
import { assertKnownProfileSlug } from "../utils/assert-known-profile-slug.js";
import { rankByTerms, queryTerms } from "../utils/term-match.js";
import { getLinksFor, createLinks } from "../services/links/links-service.js";
import {
  listCapabilities,
  listCapabilityGrants,
} from "../services/capabilities/capability-registry.js";
import { getWorkspaceRole, requirePodAdmin } from "../utils/workspace-role.js";
import { auditLog } from "../utils/audit-log.js";
import {
  instantiateSession,
  PlaybookParamsError,
  describeParamFailure,
  buildRunSessionTitle,
  buildRunSessionName,
  RUN_PROMPT_METADATA_KEY,
  promoteSessionToPlaybook,
  resolveGoal,
} from "../services/playbooks/playbook-lifecycle.js";
import { runPlaybook } from "../services/playbooks/run-playbook.js";
import { resolvePlaybookRunWriteWorkspace } from "../services/playbooks/resolve-playbook-name.js";
import { computePlaybookScorecard } from "@synap/jobs/utils/playbook-scorecard.js";
import {
  materializePlaybookCronAutomation,
  findNonArchivedAutomationByName,
} from "../services/playbooks/cron-automation.js";
import { findUnresolvedGoalReferences } from "../services/playbooks/goal-references.js";
import { findUnenabledPlaybookSkills } from "../services/playbooks/playbook-skill-preflight.js";
import { proposeCapabilityEnable } from "../services/capabilities/propose-capability-enable.js";
import { flowValidationErrorMessage } from "../services/automations/validate-flow.js";
import {
  decodeDefinitionCursor,
  encodeDefinitionCursor,
} from "../utils/keyset-cursor.js";

const logger = createLogger({ module: "playbooks-router" });

/** Postgres unique-violation SQLSTATE — raised by playbooks_workspace_name_active_uq. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

/**
 * Load the surviving non-archived playbook for (workspaceId, name).
 * Case-insensitive on name; NULL workspace = pod-wide (matches the unique index
 * COALESCE sentinel). Oldest-wins so concurrent 23505 recovery agrees with the
 * migration's soft-archive keep-oldest rule.
 */
async function findNonArchivedPlaybookByName(
  database: Awaited<ReturnType<typeof getDb>>,
  workspaceId: string | null | undefined,
  name: string
): Promise<Playbook | null> {
  const scope =
    workspaceId == null || workspaceId === ""
      ? isNull(playbooks.workspaceId)
      : eq(playbooks.workspaceId, workspaceId);
  const [row] = await database
    .select()
    .from(playbooks)
    .where(
      and(
        scope,
        drizzleSql`lower(${playbooks.name}) = lower(${name})`,
        ne(playbooks.status, "archived")
      )
    )
    .orderBy(asc(playbooks.createdAt), asc(playbooks.id))
    .limit(1);
  return (row as Playbook | undefined) ?? null;
}

/**
 * WARN (never reject) when a persisted goal carries references substitution
 * cannot resolve. This is the catch-all door — MCP, CLI, Hub and the browser
 * all land here, and unlike the IS tool's `.refine()` it sees the MERGED stored
 * row rather than only the params passed in the same call. Rejecting would fail
 * several live playbooks and would stop an author saving a work-in-progress
 * goal, so the write proceeds and the miss is named in the log.
 */
function warnUnresolvedGoalReferences(playbook: Playbook): void {
  const unresolved = findUnresolvedGoalReferences(
    playbook.goalTemplate,
    playbook.params
  );
  if (unresolved.length === 0) return;
  logger.warn(
    {
      playbookId: playbook.id,
      workspaceId: playbook.workspaceId,
      unresolved,
    },
    "Playbook goalTemplate has references no declared param backs — substitution will drop or pass them through"
  );
}

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

// The richer JSONB shapes (params/inputStrategy/channelSpec/expectedOutputs)
// conform to @synap/playbooks contracts; stored loosely and validated at the
// domain boundary, so accept them as open JSON here. `stages` and `schedule`
// are the exceptions — validated by their own schemas (../schemas/).
const jsonRecord = z.record(z.string(), z.unknown());

export const createInputSchema = z.object({
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
  /**
   * First-class stages — the ONE runtime schema (@synap/playbooks). Unlike the
   * neighbouring jsonb bags these are VALIDATED: `category` is required so a
   * cross-playbook board can roll up on it, and `key` must be unique (it is what
   * `focus_sessions.currentStage` stores).
   */
  stages: playbookStagesSchema.optional(),
  /**
   * Binary acceptance criteria every session instantiated from this playbook
   * is graded against (with each stage's own — `collectPlaybookCriteria`).
   * Validated like `stages`: a criterion is a control, not a loose bag.
   */
  criteria: sessionCriteriaSchema.optional(),
  /**
   * Bypass the near-duplicate refusal below. Same name and same meaning as
   * `entities.create.forceCreate`: the caller has SEEN the candidates and
   * judged this genuinely distinct.
   */
  forceCreate: z.boolean().optional(),
  subjectProfile: jsonRecord.optional(),
  /** Validated so `mode` ("run" | "appointment") has a declared writer. Loose; null clears. */
  schedule: playbookScheduleInputSchema.optional(),
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
   * What this template instantiates (0240). `session` = today's meaning, a
   * template of ONE focus session. `project` = a blueprint for a long-running
   * container, whose ordered `stages` coordinate rather than execute.
   *
   * ONE object with two scopes, deliberately, rather than a second template
   * table to drift out of sync: the coordinating playbooks that already exist
   * are exactly the ones stuck in `draft` because they did not fit the session
   * runtime. Omitted reads as `session` — nothing reclassifies itself.
   */
  scope: z.enum(["session", "project"]).optional(),
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
  /** See `createInputSchema.stages` — validated, `category` required. */
  stages: playbookStagesSchema.optional(),
  /** See `createInputSchema.criteria`. */
  criteria: sessionCriteriaSchema.optional(),
  subjectProfile: jsonRecord.optional(),
  /** Validated so `mode` ("run" | "appointment") has a declared writer. Loose; null clears. */
  schedule: playbookScheduleInputSchema.optional(),
  executor: executorRefSchema.optional(),
  status: playbookStatusSchema.optional(),
  /** See `createInputSchema.scope`. */
  scope: z.enum(["session", "project"]).optional(),
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
          message: proposedMessageFor(
            perm.proposalType,
            "Composing automation into playbook proposed for review"
          ),
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
          message: proposedMessageFor(
            perm.proposalType,
            "Removing automation from playbook proposed for review"
          ),
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
  /** Closed rollup category — resolved via `resolveStageCategory` (legacy-safe). */
  category: PlaybookStageCategory;
  count: number;
}

/**
 * Read a playbook's stored `stages` jsonb for DISPLAY. Tolerant on purpose: a
 * stage stored before `category` existed must still render, so the category
 * comes from `resolveStageCategory` — the ONE place that default lives — rather
 * than being re-derived here.
 */
function readStoredStages(
  stored: unknown
): Array<{ key: string; name: string; category: PlaybookStageCategory }> {
  if (!Array.isArray(stored)) return [];
  return (stored as Array<{ key: string; name: string }>).map((stage) => ({
    key: stage.key,
    name: stage.name,
    category: resolveStageCategory(stage),
  }));
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

      const stages = readStoredStages(playbook.stages);
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

      const stages = readStoredStages(playbook.stages);

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
        category: stage.category,
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
          message: proposedMessageFor(
            perm.proposalType,
            "Enrolling entity into playbook proposed for review"
          ),
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
          message: proposedMessageFor(
            perm.proposalType,
            "Unenrolling entity from playbook proposed for review"
          ),
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

/**
 * Refuse a `subjectProfile` that names a kind/role slug no profile resolves.
 *
 * MEASURED DEFECT (live, 2026-09-21). The shipped CRM playbook "Qualify a CRM
 * lead" carries `subjectProfile: { profileSlug: "crm-lead" }`, and NO profile
 * with that slug exists in the pod. Nothing ever checked. The playbook is
 * permanently unusable — `matchForEntity` keys candidates off
 * `subjectProfile->>'profileSlug'` (see the matcher below), so a slug that
 * resolves to nothing can never match any entity, and the failure is silent:
 * the playbook simply never appears as a candidate for anything. A second
 * playbook in the same workspace points at `lead`, which IS real but is a
 * ROLE in another workspace — the "two lead models" the dogfood report hit.
 *
 * This is the same class as the twin-slug `finding` bug: a STORED CONFIG
 * references a kind by slug, and nothing validates the reference at write
 * time. Config-over-code only works if the references are checked when they
 * are written; otherwise the config is a dangling pointer nobody can see.
 *
 * Deliberately routed through `assertKnownProfileSlug` — the ONE existing door
 * for "does this slug resolve" (it is what every entity read already uses, and
 * it returns the rows so no second query is needed). A local `profiles WHERE
 * slug = ?` here would be a second implementation of a question that already
 * has an answer.
 *
 * Checked BEFORE the governance gate on purpose: otherwise an agent's bad slug
 * is filed as a proposal that can only fail at approve time, handing the user
 * a review item that was never approvable. Same placement and same reason as
 * the reserved-kind guard in `entities/create.ts`.
 *
 * A `subjectProfile` with no `profileSlug` key is untouched — the column is a
 * free JSON bag and this guard makes no claim about its other contents.
 */
async function assertSubjectProfileResolves(
  db: Parameters<typeof assertKnownProfileSlug>[0],
  subjectProfile: unknown
): Promise<void> {
  if (!subjectProfile || typeof subjectProfile !== "object") return;
  const slug = (subjectProfile as { profileSlug?: unknown }).profileSlug;
  if (typeof slug !== "string" || slug.length === 0) return;
  // Throws TRPCError NOT_FOUND naming the slug and pointing at list_profiles.
  await assertKnownProfileSlug(db, slug);
}

/** How many near-duplicates to hand back. The report asked for three. */
const OVERLAP_CANDIDATE_LIMIT = 3;

/**
 * Score PER QUERY TERM above which an AI create is refused as a probable
 * duplicate.
 *
 * NORMALISED by term count, and that matters for SHORT inputs. `rankByTerms`
 * sums over every query term, so a raw total grows with how much the caller
 * wrote. Note `queryTerms` caps at `MAX_QUERY_TERMS` (8) after stopword
 * removal and de-duplication, so for any reasonably-worded playbook the
 * divisor is simply 8 — the normalisation earns its keep only on a terse
 * one-or-two-word create, which would otherwise be scored on a different
 * scale from everything else.
 *
 * TUNED ON THE TWO REAL CASES, measured 2026-09-21 against the live CRM
 * workspace rows (the same rows `playbooks.create-overlap-guard.test.ts`
 * uses, copied verbatim from `synap_list_playbooks`):
 *   - the duplicate that was actually filed, "Lead → qualified (discovery)"
 *     vs "Qualify a CRM lead":                47.0 / term  → must refuse
 *   - a genuinely distinct playbook in the same workspace,
 *     "Quarterly revenue forecast":           21.1 / term  → must allow
 * 30 sits between them with roughly equal margin on both sides.
 *
 * HONEST LIMITATION: two data points is a weak basis for a constant, and this
 * WILL misjudge some pair. That is survivable only because `forceCreate` makes
 * a false refusal a one-call recovery rather than a dead end — do not remove
 * that escape hatch, and do not raise this into a hard block without one.
 */
const OVERLAP_REFUSE_SCORE_PER_TERM = 30;

/**
 * "Discover before inventing", enforced at the write door instead of asked for
 * in a prompt.
 *
 * MEASURED DEFECT (live, 2026-09-21). The CRM workspace already held "Qualify a
 * CRM lead", "Enrich Lead/Company", "Lead Outreach" and "CRM Hygiene". An agent
 * created "Lead → qualified (discovery)", overlapping three of them, and the
 * pod accepted it without a word. The rule existed only as instruction prose,
 * and prose is followed on the days somebody remembers it.
 *
 * Deliberately reuses `rankByTerms` — the pod's existing IDF-weighted ranker,
 * already the "closest by name/description" helper behind capability search —
 * rather than adding a second similarity implementation. `rankRouteCandidates`
 * was the other candidate and is the wrong shape here: its kind/facet signals
 * score an ENTITY against playbooks, and its `anyKind` bonus would rank every
 * subject-less playbook highly regardless of text.
 *
 * AI CALLERS ONLY, mirroring the exact-name idempotency directly below it: a
 * template install, a reconciler, a marketplace apply and a human author all
 * create playbooks deliberately and must not be second-guessed. `forceCreate`
 * is the escape hatch, named and behaved identically to `entities.create`.
 */
async function findOverlappingPlaybooks(
  database: Awaited<ReturnType<typeof getDb>>,
  workspaceId: string | null | undefined,
  input: {
    name: string;
    description?: string | null;
    goalTemplate?: string | null;
  }
): Promise<
  Array<{ id: string; name: string; description: string | null; score: number }>
> {
  const scope =
    workspaceId == null || workspaceId === ""
      ? isNull(playbooks.workspaceId)
      : eq(playbooks.workspaceId, workspaceId);
  const rows = await database
    .select({
      id: playbooks.id,
      name: playbooks.name,
      description: playbooks.description,
      goalTemplate: playbooks.goalTemplate,
    })
    .from(playbooks)
    .where(and(scope, ne(playbooks.status, "archived")));
  if (rows.length === 0) return [];

  // Rank the NEW playbook's own words against the existing ones. Rarity is
  // measured over this workspace's set, so workspace-wide boilerplate ("the",
  // "lead" in a lead-heavy CRM) is discounted automatically.
  const query = [input.name, input.description, input.goalTemplate]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
  const termCount = queryTerms(query).length;
  if (termCount === 0) return [];
  return rankByTerms(query, rows, (r) => ({
    // Weighted, not a flat bag: a name collision is the strongest duplicate
    // signal, the goal template is the motion itself, and the description is
    // prose that varies most between two playbooks doing the same thing.
    primary: r.name,
    secondary: r.goalTemplate ? [r.goalTemplate] : [],
    tertiary: r.description,
  }))
    .slice(0, OVERLAP_CANDIDATE_LIMIT)
    .map(({ item, score }) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      // Normalised, so the caller compares against a scale-stable threshold.
      score: score / termCount,
    }));
}

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
   * List playbooks on the caller's USER FLOOR (every member workspace +
   * pod-wide rows), most recent first. Visibility enforced via the scopedDb
   * predicate.
   *
   * `protectedProcedure`, NOT `workspaceProcedure`: the predicate is
   * `scopedDb(AccessContext.from(ctx)).predicate(playbooks)` with NO workspace
   * lens, so `ctx.workspaceId` never narrowed this query — the header gate only
   * REFUSED callers who had no active workspace, while returning the same rows
   * to everyone who did. Dropping it changes no result set; it lets a pod-wide
   * surface (Relay) list exactly what `run` — now also pod-wide — can run.
   *
   * There is deliberately NO `playbooks.listAll`: the list/listAll two-door
   * split was COLLAPSED to one floor-first `.list` door, and
   * `access/read-scoping.tripwire.test.ts` fails CI on a new `listAll:`.
   */
  list: protectedProcedure
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
        .orderBy(desc(playbooks.createdAt), asc(playbooks.id))
        .limit(input?.limit ?? 50);
    }),

  /**
   * Cursor-paginated definition list. The additive procedure avoids changing
   * `list`'s array response while allowing operational inventories to load all
   * visible playbooks without a misleading 100-row ceiling.
   */
  listPage: workspaceProcedure
    .input(
      z
        .object({
          status: playbookStatusSchema.optional(),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(playbooks);
      const cursor = input?.cursor
        ? decodeDefinitionCursor(input.cursor)
        : undefined;
      const limit = input?.limit ?? 50;

      const rows = await database
        .select()
        .from(playbooks)
        .where(
          and(
            visibility,
            input?.status !== undefined
              ? eq(playbooks.status, input.status)
              : undefined,
            cursor
              ? or(
                  lt(playbooks.createdAt, new Date(cursor.at)),
                  and(
                    eq(playbooks.createdAt, new Date(cursor.at)),
                    gt(playbooks.id, cursor.id)
                  )
                )
              : undefined
          )
        )
        .orderBy(desc(playbooks.createdAt), asc(playbooks.id))
        .limit(limit + 1);

      const hasNextPage = rows.length > limit;
      const page = hasNextPage ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        playbooks: page,
        nextCursor:
          hasNextPage && last
            ? encodeDefinitionCursor({ at: last.createdAt, id: last.id })
            : null,
      };
    }),

  /**
   * Pod-wide sibling of `listPage`: same cursor contract, same output shape,
   * but `protectedProcedure` — no `X-Workspace-Id` header required. Visibility
   * is UNCHANGED (`scopedDb(AccessContext.from(ctx)).predicate(playbooks)` was
   * already lens-free / pod-wide — `listPage`'s `workspaceProcedure` gate never
   * narrowed the query, it only forced callers to have an active workspace
   * before they could see ANY playbook, including pod-wide ones). This mirrors
   * `automations.listPage` (routers/automations.ts), which is the pod-wide
   * `protectedProcedure` for automations with the identical optional
   * `workspaceId` narrow-only filter. Follows the `list` / `listAll` contract
   * in `.claude/rules/backend-rules.md`.
   */
  listAllPage: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().nullable().optional(),
          status: playbookStatusSchema.optional(),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(playbooks);
      const cursor = input?.cursor
        ? decodeDefinitionCursor(input.cursor)
        : undefined;
      const limit = input?.limit ?? 50;

      const rows = await database
        .select()
        .from(playbooks)
        .where(
          and(
            visibility,
            // Narrow-only: a specific workspace still includes pod-wide (NULL)
            // rows, mirroring `automations.listPage`.
            input?.workspaceId
              ? or(
                  isNull(playbooks.workspaceId),
                  eq(playbooks.workspaceId, input.workspaceId)
                )
              : undefined,
            input?.status !== undefined
              ? eq(playbooks.status, input.status)
              : undefined,
            cursor
              ? or(
                  lt(playbooks.createdAt, new Date(cursor.at)),
                  and(
                    eq(playbooks.createdAt, new Date(cursor.at)),
                    gt(playbooks.id, cursor.id)
                  )
                )
              : undefined
          )
        )
        .orderBy(desc(playbooks.createdAt), asc(playbooks.id))
        .limit(limit + 1);

      const hasNextPage = rows.length > limit;
      const page = hasNextPage ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        playbooks: page,
        nextCursor:
          hasNextPage && last
            ? encodeDefinitionCursor({ at: last.createdAt, id: last.id })
            : null,
      };
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
   * Filter: status='active' AND the access predicate. When `profileSlug` is
   * given, also require a kind/facet match OR a NULL `subjectProfile` (a
   * null-subject playbook like Content OS "Plan Next Content" stays findable
   * when talking about a post). When `profileSlug` is omitted, the pool is
   * every active visible playbook — ranked by `intentText`, not narrowed to
   * null-subject rows. Returns the lean candidate shape; [] when none.
   */
  matchForEntity: workspaceProcedure
    .input(
      z.object({
        profileSlug: z.string().min(1).optional(),
        // When provided, its live facet-role slugs WIDEN the match set (below);
        // also round-tripped by the caller into `instantiate`/`run` as `subjectId`.
        entityId: z.string().uuid().optional(),
        workspaceId: z.string().uuid(),
        /**
         * What the user said they want (capture note / intent). Ranks the
         * candidates — never filters them; see `rankRouteCandidates`. Sufficient
         * on its own when `profileSlug` is omitted.
         */
        intentText: z.string().max(2000).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(playbooks);

      // Build the match set: the passed KIND slug (if any) plus, when an entity
      // is given, its live facet-role slugs (deduped). loadFacetSlugsBatch
      // enforces the canonical facet visibility lens (this workspace's facets +
      // pod-wide, owner-floored), so a caller can only widen the set with
      // facets it can see.
      const matchSlugs: string[] = [];
      if (input.profileSlug) matchSlugs.push(input.profileSlug);
      const facetSlugs: string[] = [];
      if (input.entityId) {
        const facetSlugsByEntity = await loadFacetSlugsBatch(
          database,
          [input.entityId],
          { userId: ctx.userId, workspaceId: ctx.workspaceId }
        );
        for (const slug of facetSlugsByEntity.get(input.entityId) ?? []) {
          if (!matchSlugs.includes(slug)) matchSlugs.push(slug);
          if (slug !== input.profileSlug) facetSlugs.push(slug);
        }
      }

      const rows = await database
        .select()
        .from(playbooks)
        .where(
          and(
            visibility,
            eq(playbooks.status, "active"),
            // When a kind/facet set is named: match those slugs OR a NULL
            // subject (null-subject playbooks stay in the pool). When omitted,
            // skip the subject filter so the pool is every active visible row.
            // NOTE: do NOT use `= ANY(${matchSlugs})` — binding a JS array into
            // the SQL template serializes it as a Postgres array literal, which
            // the pod image's postgres.js driver faults on (same class of gotcha
            // as `sql.json()` — see driver notes). An OR of scalar `=` params is
            // the portable form (mirrors automations.matchForEntity).
            matchSlugs.length > 0
              ? or(
                  ...matchSlugs.map(
                    (slug) =>
                      drizzleSql`${playbooks.subjectProfile}->>'profileSlug' = ${slug}`
                  ),
                  isNull(playbooks.subjectProfile)
                )
              : undefined
          )
        )
        .orderBy(desc(playbooks.updatedAt));

      // Ranked with a human-readable `reason` (suggest-and-confirm): intent
      // words first, then kind, then facet. Ties keep the updatedAt order.
      const ranked = rankRouteCandidates({
        entity: {
          entityId: input.entityId,
          ...(input.profileSlug ? { profileSlug: input.profileSlug } : {}),
          facetSlugs,
        },
        intentText: input.intentText,
        candidates: rows.map((p) => ({
          kind: "playbook" as const,
          id: p.id,
          name: p.name,
          text: [p.goalTemplate],
          subjectProfileSlug:
            (p.subjectProfile as { profileSlug?: string } | null)
              ?.profileSlug ?? null,
          row: p,
        })),
      });

      const MATCH_LIMIT = 20;
      return ranked
        .filter((r) => r.signals.length > 0)
        .slice(0, MATCH_LIMIT)
        .map(({ candidate, score, reason, signals }) => ({
          id: candidate.row.id,
          name: candidate.row.name,
          goalTemplate: candidate.row.goalTemplate,
          subjectProfileSlug: candidate.subjectProfileSlug,
          // The DECLARATION (name/type/required/options/default), so a caller
          // choosing a candidate can see what it must supply BEFORE it runs —
          // the match→confirm→run path's whole intake contract.
          params: candidate.row.params,
          executor: candidate.row.executor,
          score,
          reason,
          signals,
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
   * How this playbook's runs went, for the CALLER's sessions (sessions are
   * owner-private): runs closed / evaluated / reopened, pass rate per
   * criterion, how often a person overrode the judge, escalations. Derived on
   * read — no table. The one derivation, shared with the weekly lessons
   * scanner: `@synap/jobs/utils/playbook-scorecard`.
   */
  scorecard: protectedProcedure
    .input(z.object({ playbookId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await scopedDb(AccessContext.from(ctx)).findFirst<Playbook>(
        playbooks,
        { where: eq(playbooks.id, input.playbookId) }
      );
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Playbook ${input.playbookId} not found`,
        });
      }
      return computePlaybookScorecard(await getDb(), {
        playbookId: row.id,
        userId: ctx.userId,
      });
    }),

  /**
   * Create a new playbook. Governance-gated: AI callers (agentUserId set) route
   * through checkPermissionOrPropose; on "proposed" the row is NOT written.
   */
  create: workspaceProcedure
    .input(createInputSchema)
    .mutation(async ({ ctx, input }) => {
      // Decode an agent's XML-escaped name once, at the one create door —
      // see `entities/create.ts` for the full rationale.
      if (input.name) input.name = decodeHtmlEntities(input.name);
      // Dangling `subjectProfile` slugs are refused here, before the gate.
      await assertSubjectProfileResolves(await getDb(), input.subjectProfile);
      const gateOpts = {
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "playbook" as const,
        action: "create" as const,
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
          criteria: input.criteria,
          subjectProfile: input.subjectProfile,
          schedule: input.schedule,
          metadata: input.metadata,
          executor: input.executor,
          status: input.status,
          scope: input.scope,
          contextSkill: input.contextSkill,
        },
      };

      // IDEMPOTENCY ABOVE THE PROPOSE PATH (AI callers only).
      //
      // The 23505 recovery below protects only the EXECUTE path — an agent whose
      // write routes to a PROPOSAL filed a fresh proposal on every retry, forever
      // (generic `computeProposalDedupHash` can't collapse them: LLM-authored
      // prose in description/goalTemplate/stages hashes differently each run, so
      // NAME is the only stable identity).
      //
      // ORDER IS LOAD-BEARING: dry-run the governance door FIRST and re-throw a
      // deny exactly as the real gate would, BEFORE the existence lookup — a
      // caller who may not write must never learn whether the playbook exists,
      // nor receive its row. Only a caller that would have been permitted (to
      // execute OR to propose) reaches the lookup.
      const isAiCaller =
        Boolean(input.agentUserId) ||
        input.source === "ai" ||
        input.source === "intelligence";
      if (isAiCaller) {
        const preview = await previewPermissionDecision(gateOpts);
        if (preview.decision === "deny") {
          throw new TRPCError({ code: "FORBIDDEN", message: preview.reason });
        }
        const existingByName = await findNonArchivedPlaybookByName(
          await getDb(),
          ctx.workspaceId,
          input.name
        );
        if (existingByName) {
          logger.info(
            {
              playbookId: existingByName.id,
              workspaceId: ctx.workspaceId,
              name: input.name,
            },
            "playbooks.create: name already exists — returning existing playbook without filing a proposal"
          );
          return {
            playbook: existingByName,
            status: "created" as const,
            message: "Playbook already exists (idempotent create)",
            proposalId: null as string | null,
          };
        }

        // DISCOVER BEFORE INVENTING — enforced, not asked for. An exact name
        // match was handled above; this catches the overlap that actually
        // happens, where an agent invents a near-twin under a different name.
        if (!input.forceCreate) {
          const overlapping = await findOverlappingPlaybooks(
            await getDb(),
            ctx.workspaceId,
            input
          );
          const top = overlapping[0];
          if (top && top.score >= OVERLAP_REFUSE_SCORE_PER_TERM) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                `This looks like an existing playbook. Closest matches: ` +
                overlapping.map((c) => `"${c.name}" (${c.id})`).join(", ") +
                `. Extend one of them with playbooks.update, or resend with ` +
                `forceCreate: true if this is genuinely a different motion.`,
              // Machine-readable, same shape as the entity door's candidates
              // so a caller can act on it without parsing the sentence.
              cause: { overlapping } as unknown as Error,
            });
          }
        }
      }

      const perm = await checkPermissionOrPropose(gateOpts);

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          playbook: null as Playbook | null,
          status: "proposed" as const,
          message: proposedMessageFor(
            perm.proposalType,
            "Playbook creation proposed for review"
          ),
          proposalId: perm.proposalId,
        };
      }

      const database = await getDb();

      // Insert with 23505 recovery against playbooks_workspace_name_active_uq
      // (0227). Reconcile/package-apply already peek-then-create; concurrent
      // callers both miss the peek and race the insert — the unique index makes
      // the loser a unique-violation, and we return the winner instead of a 500
      // or a second clone (mirrors insertPendingProposal / rememberFact).
      let created: Playbook;
      let reused = false;
      try {
        const [row] = await database
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
            criteria: input.criteria ?? [],
            subjectProfile: input.subjectProfile ?? null,
            schedule: input.schedule ?? null,
            metadata: input.metadata ?? {},
            executor: input.executor,
            status: input.status,
            // NULL, not a defaulted 'session': the column's documented reading
            // is "NULL means session", and writing the default eagerly would
            // make an unstated scope indistinguishable from a chosen one.
            scope: input.scope ?? null,
          })
          .returning();
        created = row as Playbook;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const winner = await findNonArchivedPlaybookByName(
          database,
          ctx.workspaceId,
          input.name
        );
        if (!winner) throw err;
        created = winner;
        reused = true;
        logger.info(
          {
            playbookId: winner.id,
            workspaceId: ctx.workspaceId,
            name: input.name,
          },
          "playbooks.create: unique violation — returning existing non-archived playbook"
        );
      }

      // Side-effects only for a true insert. A 23505 reuse must NOT re-materialize
      // cron automations or re-attach a context skill (would spam those too).
      if (!reused) {
        warnUnresolvedGoalReferences(created);

        // S1: a scheduled playbook maintains ONE backing cron automation (stamped
        // on flow_automation_id) that the existing automation-cron-scheduler fires.
        await materializePlaybookCronAutomation(created, {
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
                fromId: created.id,
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
              { err, playbookId: created.id },
              "playbooks.create: context skill persist failed (non-fatal)"
            );
          }
        }
      }

      return {
        playbook: created,
        // Minimal API surface: still "created" so call sites that only branch on
        // created|proposed keep working. Idempotent create returns the survivor.
        status: "created" as const,
        message: reused
          ? "Playbook already exists (idempotent create)"
          : "Playbook created",
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

      // 2b. A patch that REPOINTS the subject must name a slug that resolves —
      // same guard and same reason as the create door. Only when the field is
      // actually in the patch: an update that does not mention it must not be
      // refused for a dangling value it did not introduce (that is the create
      // door's job, and refusing here would make an existing broken playbook
      // uneditable — including uneditable to FIX it).
      if (input.subjectProfile !== undefined) {
        await assertSubjectProfileResolves(database, input.subjectProfile);
      }

      // 3. Governance membrane decides approve vs propose.
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: existing.workspaceId,
        subjectType: "playbook",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        // The WHOLE patch, not `{ id, name }`: the `playbook/update` executor
        // replays these fields, and a reviewer shown only a name cannot judge a
        // change to a goal template, a stage list, or the scope that decides
        // what kind of template this is.
        data: {
          id: input.id,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.goalTemplate !== undefined
            ? { goalTemplate: input.goalTemplate }
            : {}),
          ...(input.params !== undefined ? { params: input.params } : {}),
          ...(input.inputStrategy !== undefined
            ? { inputStrategy: input.inputStrategy }
            : {}),
          ...(input.channelSpec !== undefined
            ? { channelSpec: input.channelSpec }
            : {}),
          ...(input.expectedOutputs !== undefined
            ? { expectedOutputs: input.expectedOutputs }
            : {}),
          ...(input.stages !== undefined ? { stages: input.stages } : {}),
          ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
          ...(input.subjectProfile !== undefined
            ? { subjectProfile: input.subjectProfile }
            : {}),
          ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
          ...(input.executor !== undefined ? { executor: input.executor } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          playbook: null as Playbook | null,
          status: "proposed" as const,
          message: proposedMessageFor(
            perm.proposalType,
            "Playbook update proposed for review"
          ),
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
      if (input.criteria !== undefined) set.criteria = input.criteria;
      if (input.subjectProfile !== undefined)
        set.subjectProfile = input.subjectProfile;
      if (input.schedule !== undefined) set.schedule = input.schedule;
      if (input.executor !== undefined) set.executor = input.executor;
      if (input.status !== undefined) set.status = input.status;
      if (input.scope !== undefined) set.scope = input.scope;

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
        "criteria",
      ] as const;
      const definitionChanged = DEFINITION_FIELDS.some(
        (f) =>
          set[f] !== undefined &&
          stableStringify(set[f]) !==
            stableStringify((existing as Record<string, unknown>)[f])
      );
      if (definitionChanged) set.version = (existing.version ?? 1) + 1;

      let updated: Playbook;
      try {
        const [row] = await database
          .update(playbooks)
          .set(set)
          .where(eq(playbooks.id, input.id))
          .returning();
        updated = row as Playbook;
      } catch (err) {
        // Name/status transition collided with another non-archived playbook
        // under playbooks_workspace_name_active_uq — surface as CONFLICT, not 500.
        if (isUniqueViolation(err)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A non-archived playbook named "${input.name ?? existing.name}" already exists in this workspace`,
          });
        }
        throw err;
      }

      warnUnresolvedGoalReferences(updated);

      // S1: re-reconcile the backing cron automation against the new schedule.
      // Idempotent — re-points/updates the SAME row via flow_automation_id, or
      // tears it down when the schedule was cleared/disabled.
      await materializePlaybookCronAutomation(updated, {
        userId: input.agentUserId ?? ctx.userId,
      });

      return {
        playbook: updated,
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
          message: proposedMessageFor(
            perm.proposalType,
            "Playbook archive proposed for review"
          ),
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

      // S1: an archived playbook is not live, so neither is its schedule.
      // Materialize reads `status` and takes the teardown branch — without this
      // call the backing cron automation stayed `active` with a live nextRunAt
      // and kept firing a playbook nothing else would surface.
      await materializePlaybookCronAutomation(archived as Playbook, {
        userId: input.agentUserId ?? ctx.userId,
      });

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

      // PARAMS — validated at PROPOSE time as well as at write time, with the
      // same pure function the funnel uses. Two reasons it cannot wait for
      // `instantiateSession` below: the proposal's `prompt` is rendered HERE
      // (so a default that never reached it would make the reviewed payload
      // differ from what gets written), and filing a proposal a human must
      // read, approve and watch fail is a worse refusal than refusing now.
      const instantiateParams = validatePlaybookParams(
        readPlaybookParams(playbook.params),
        input.params
      );
      if (
        instantiateParams.missingRequired.length > 0 ||
        instantiateParams.typeErrors.length > 0
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: describeParamFailure(
            instantiateParams.missingRequired,
            instantiateParams.typeErrors
          ),
        });
      }

      // The subject's own title, for the run title on the PROPOSE path (the
      // direct path resolves it inside instantiateSession).
      let subjectTitle: string | null = null;
      if (subjectId) {
        const subject = await database.query.entities.findFirst({
          columns: { title: true },
          where: eq(entities.id, subjectId),
        });
        subjectTitle = subject?.title ?? null;
      }

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
        // missing goal". Build BOTH halves NOW (propose time), matching the
        // direct instantiateSession path so the materialized session is
        // identical whether approved or direct: `goal` is the TITLE
        // (buildRunSessionTitle — the same pure builder the direct path uses),
        // and the rendered goalTemplate rides `prompt`, which the executor
        // stamps onto metadata. Resolving only the template here would have
        // re-introduced the paragraph-as-title on the approved path alone.
        // The executor materializes through the same `instantiateSession`
        // body when `playbookId` is present, so the approved row carries the
        // playbook, its first stage, the subject and this derived `title`
        // exactly as the direct path below writes them.
        data: {
          playbookId: input.playbookId,
          name: playbook.name,
          goal: buildRunSessionTitle(playbook.name, subjectTitle),
          title: buildRunSessionName(playbook.name, subjectTitle),
          ...(subjectId ? { subjectEntityId: subjectId } : {}),
          ...(input.channelId ? { channelId: input.channelId } : {}),
          ...(input.agentIds?.length ? { agentIds: input.agentIds } : {}),
          // The DECLARED answers, carried so the approved path stores the same
          // `metadata.params` the direct path does. `declaredValues`, not
          // `values`: the prompt was already rendered above (and rides as
          // `prompt`), so an undeclared key has nothing left to substitute
          // into — carrying it would only put unbounded caller JSON into a
          // payload a human reads.
          params: instantiateParams.declaredValues,
          [RUN_PROMPT_METADATA_KEY]: resolveGoal(
            playbook.goalTemplate,
            // The RESOLVED values — defaults applied, types coerced — so the
            // payload a reviewer reads is the one that gets written.
            instantiateParams.values,
            input.playbookId
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
          message: proposedMessageFor(
            perm.proposalType,
            "Session instantiation proposed for review"
          ),
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
      if (input.name) input.name = decodeHtmlEntities(input.name);
      const database = await getDb();

      // Owner floor: focus_sessions are owner-private, and promote now WRITES
      // the session (rename + conversion receipt), so membership alone would
      // let a co-member rename another person's session and arm its revert.
      const session = await database.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
        ),
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
          message: proposedMessageFor(
            perm.proposalType,
            "Playbook promotion proposed for review"
          ),
          proposalId: perm.proposalId,
        };
      }

      const result = await promoteSessionToPlaybook({
        sessionId: input.sessionId,
        userId: input.agentUserId ?? ctx.userId,
        name: input.name,
        description: input.description,
        agentUserId: input.agentUserId,
      });
      // The project-scope guard is a REFUSAL, not a server fault — it used to
      // throw a bare Error and surface as a 500. BAD_REQUEST carries the typed
      // reason so a caller can branch on it instead of matching prose.
      if (result.status === "refused") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: result.message,
          cause: result.reason,
        });
      }
      return {
        playbook: result.playbook,
        status: "promoted" as const,
        message: "Session promoted to playbook",
        proposalId: null as string | null,
        /**
         * The conversion receipt — `created` (kind/id/name), `renamedFrom` (the
         * session's goal BEFORE the rename) and `undoUntil`. Consumed verbatim
         * by the frontend receipt, which names BOTH sides of the conversion and
         * offers Undo (`focusSessions.revertConversion`).
         */
        receipt: result.receipt,
        reused: result.reused,
      };
    }),

  /**
   * Run a playbook (config → runtime → dispatch). The executor spine (P3):
   * instantiates a session, creates the run channel, records a playbook_run, and
   * dispatches to the playbook's executor (is-agent | external-agent | hybrid).
   *
   * POD-WIDE DOOR (parity with `runPlaybookDoor`, the Hub/MCP door). This is a
   * `protectedProcedure`, NOT a `workspaceProcedure`: the playbook is resolved
   * on the USER FLOOR and the run's write workspace is then derived FROM the
   * playbook through the one ladder `resolvePlaybookRunWriteWorkspace`.
   *
   * Why: `list` (and Relay's picker on top of it) is already pod-wide — its
   * predicate carries no workspace lens — so what a caller can SEE and what it
   * could RUN disagreed. A playbook in workspace A launched while
   * `X-Workspace-Id` said B was filed into B, and `resolveRunnablePlaybook`'s
   * cross-workspace floor threw "playbook <id> not visible in workspace B".
   * The header is now the LAST rung of the ladder (an ambient lens), never the
   * first.
   *
   * Nothing is widened. The playbook read is the same `scopedDb` user floor it
   * always was (`workspaceProcedure` never narrowed it — it only forced a
   * header to exist). Every guard below now runs against the RESOLVED
   * workspace, which is the one the session/channel/run rows actually land in:
   *   - `assertWorkspaceUsable` — membership + not-archived, the same check
   *     `workspaceProcedure` applies, on the resolved workspace.
   *   - `assertWorkspaceWrite`  — the editor+ write floor (strictly stronger
   *     than `workspaceProcedure`'s any-role membership).
   *   - `resolveVisibleSubjectId` — the subject IDOR guard.
   *   - `findUnenabledPlaybookSkills` / `checkPermissionOrPropose` — preflight
   *     and governance.
   * A pod-wide playbook with no explicit/subject/ambient workspace REFUSES
   * (BAD_REQUEST) rather than picking a membership.
   *
   * Governance: editor+ write floor + checkPermissionOrPropose
   * ({ subjectType: "playbook", action: "run" }). On "denied" → 403; on
   * "proposed" → no run is created (the proposal is the record). Only on
   * approval does `runPlaybook` execute.
   */
  run: protectedProcedure
    .input(
      z.object({
        playbookId: z.string().uuid(),
        /**
         * Explicit write lens — the caller NAMING where this run belongs. Tops
         * the ladder. Omit it and the run lands in the playbook's own home.
         */
        workspaceId: z.string().uuid().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        agentIds: z.array(z.string()).optional(),
        agentUserId: z.string().uuid().optional(),
        /** Subject entity to bind this run to (polymorphic — any entity). */
        subjectId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
        /**
         * What to do about a `required` param this call did not answer — see
         * `InstantiateInput.onMissingRequired` for the contract. DEFAULT
         * `"refuse"`, because this door's primary caller is a person with a
         * form in front of them; the headless doors (MCP / Hub REST, through
         * `runPlaybookDoor`) pass `"owe"`.
         */
        onMissingRequired: z.enum(["refuse", "owe"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // The playbook must be on the caller's USER FLOOR (every member
      // workspace + pod-wide rows) — unchanged predicate, pod-wide as it
      // always was.
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

      // WRITE HOME — the ONE ladder, shared with `runPlaybookDoor`:
      // explicit → playbook home → subject home → ambient header. Never a
      // membership pick.
      let subjectWorkspaceId: string | null | undefined;
      if (!input.workspaceId && !playbook.workspaceId && input.subjectId) {
        const subjectRow = await database.query.entities.findFirst({
          columns: { workspaceId: true },
          where: eq(entities.id, input.subjectId),
        });
        subjectWorkspaceId = subjectRow?.workspaceId ?? null;
      }
      const runWorkspaceId = resolvePlaybookRunWriteWorkspace({
        explicitWorkspaceId: input.workspaceId,
        playbookWorkspaceId: playbook.workspaceId,
        subjectWorkspaceId,
        ambientWorkspaceId: ctx.workspaceId,
      });
      if (!runWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${playbook.name}" is a pod-wide playbook, so nothing says which workspace this run belongs to. Pass workspaceId (or a subject entity that has one).`,
        });
      }

      // Membership + not-archived on the RESOLVED workspace — the same gate
      // `workspaceProcedure` applies, moved after resolution because the
      // workspace comes from the playbook, not the header.
      await assertWorkspaceUsable(ctx.userId, runWorkspaceId);

      // Editor+ write floor — running a playbook spawns a session + channel +
      // run (all writes), so require editor+ like the rest of this router.
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: runWorkspaceId,
      });

      // Validate the subject (if any) is visible in the workspace the run will
      // be FILED IN before binding (IDOR guard).
      const subjectId = await resolveVisibleSubjectId(
        database,
        input.subjectId,
        runWorkspaceId
      );

      // D3 preflight — a playbook that depends on installed-but-not-enabled
      // skills says so BEFORE anything launches (and before a run proposal is
      // filed that would only fail on approval). An agent gets a structured
      // refusal plus one enable request per pack; a human gets the names and
      // the Settings pointer. Nothing is enabled here.
      const unenabledSkills = await findUnenabledPlaybookSkills({
        playbook,
        userId: ctx.userId,
        workspaceId: runWorkspaceId,
      });
      if (unenabledSkills.length > 0) {
        const names = unenabledSkills.map((s) => s.name).join(", ");
        if (!input.agentUserId) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `"${playbook.name}" uses skills that are not enabled yet: ${names}. Enable them in Settings → Capabilities, then run it again.`,
          });
        }
        const enableProposals = await proposeCapabilityEnable({
          refused: unenabledSkills,
          userId: ctx.userId,
          workspaceId: runWorkspaceId,
          agentUserId: input.agentUserId,
        });
        const filed = enableProposals.some((o) => o.status === "proposed");
        return {
          run: null,
          session: null as FocusSession | null,
          status: "blocked" as const,
          message: filed
            ? `Nothing ran: "${playbook.name}" uses skills that are not enabled yet (${names}). A request to enable them is waiting for review — run the playbook again after it is approved.`
            : `Nothing ran: "${playbook.name}" uses skills that are not enabled yet (${names}), and the request to enable them could not be filed. Ask the user to enable them (Settings → Capabilities).`,
          proposalId: null as string | null,
          unenabledSkills,
          enableProposals,
        };
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: runWorkspaceId,
        subjectType: "playbook",
        action: "run",
        source: input.source,
        reasoning: input.reasoning,
        /**
         * The RUN ARGUMENTS ride with the proposal, not just the target.
         *
         * They used to be dropped here, and the approval executor could not
         * recover them from anywhere — so it refused every parameterised
         * playbook outright (`executors/playbook.ts`, which says so in its own
         * header). That was the honest choice while the arguments were lost:
         * starting a session under a goal with `{}` substituted into it is
         * worse than not starting one. But it meant the governed path — the
         * DEFAULT for every agent — could not run any playbook that declares
         * params, which is 14 of the ones installed on this pod.
         *
         * `params` feeds both `resolveInputItems` and the goalTemplate
         * substitution, `subjectId` becomes `focus_sessions.subjectEntityId`
         * ("onboard Acme" vs "onboard nobody"), and `agentIds` are the extra
         * agents on the run channel. Storing them is what lets the executor
         * replay the run the caller actually asked for.
         */
        data: {
          playbookId: input.playbookId,
          name: playbook.name,
          ...(input.params ? { params: input.params } : {}),
          ...(input.subjectId ? { subjectId: input.subjectId } : {}),
          ...(input.agentIds?.length ? { agentIds: input.agentIds } : {}),
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          run: null,
          session: null as FocusSession | null,
          status: "proposed" as const,
          message: proposedMessageFor(
            perm.proposalType,
            "Playbook run proposed for review"
          ),
          proposalId: perm.proposalId,
        };
      }

      // Declared params that were not satisfied are a REFUSAL the caller can
      // act on (fill the form), never a 500 — the same reason `PromoteResult`
      // carries a typed refusal. Handled with `.catch` rather than a
      // `try`/`let` pair so the call keeps the exact `const { run, session } =
      // await runPlaybook({` shape that `severed-approval-doors.test.ts` (6b)
      // scans for when it proves this door passes no `idempotentBySubject`.
      const { run, session } = await runPlaybook({
        playbookId: input.playbookId,
        workspaceId: runWorkspaceId,
        userId: ctx.userId,
        params: input.params,
        agentIds: input.agentIds,
        agentUserId: input.agentUserId,
        subjectId,
        ...(input.onMissingRequired
          ? { onMissingRequired: input.onMissingRequired }
          : {}),
      }).catch((err: unknown) => {
        if (err instanceof PlaybookParamsError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
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
          message: proposedMessageFor(
            perm.proposalType,
            "Flow save proposed for review"
          ),
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
      // 23505 recovery against automations_workspace_name_active_uq (0230): a
      // non-archived automation of this name may already exist (the playbook's
      // backing row survived a flow_automation_id reset). Adopt it and persist
      // THIS flow onto it — saveFlow's whole contract — rather than 500-ing or
      // cloning. Case-insensitive identity handled by findNonArchivedAutomationByName.
      let automationId: string;
      try {
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
        automationId = (created as Pick<Automation, "id">).id;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const winner = await findNonArchivedAutomationByName(
          database,
          existing.workspaceId,
          existing.name
        );
        if (!winner) throw err;
        await database
          .update(automations)
          .set({ flowDefinition: flowDef, updatedAt: new Date() })
          .where(eq(automations.id, winner.id));
        automationId = winner.id;
      }

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
