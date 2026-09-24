/**
 * Hub Protocol REST — focus sessions
 *
 * IS-facing REST surface for goal-bound user work sessions.
 * All routes require hub-protocol.write (or .read) scope.
 *
 * Routes (static before dynamic — Hono is first-match):
 *   GET    /focus-sessions          — list sessions for a workspace
 *   GET    /focus-sessions/:id      — get a single session by id
 *   POST   /focus-sessions          — create/upsert a session (by correlationId)
 *   PATCH  /focus-sessions/:id      — update progress / status / correlationId
 *   POST   /focus-sessions/:id/complete — lifecycle close + proposal pack
 *   POST   /focus-sessions/:id/used — record capability usage link
 *   POST   /focus-sessions/:id/channel — mint the session room if it has none
 *   POST   /focus-sessions/:id/outputs — record an existing object as an output
 *   POST   /focus-sessions/:id/outputs/delegate — hand a declared slot to an agent
 *   POST   /focus-sessions/:sessionId/complete-run — close running playbook_run
 *
 * Uses Drizzle directly — focusSessions lives on coreRouter, not hubProtocolRouter,
 * so getCaller() (which creates a hubProtocolRouter caller) cannot reach it.
 */

import { z } from "@hono/zod-openapi";
import {
  sessionCriteriaSchema,
  sessionEvidenceSchema,
} from "../../../schemas/session-criteria.js";
import {
  db,
  eq,
  and,
  desc,
  focusSessions,
  playbookRuns,
  drizzleSql,
} from "@synap/database";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../../utils/permission-check.js";
import { createLinks } from "../../../services/links/links-service.js";
import { emitHubRealtimeEvent } from "../../../utils/domain-event-bridge.js";
import { assertWorkspaceWrite } from "../../../utils/workspace-write-access.js";
import { createFocusSession } from "../../../services/focus-sessions/create-session.js";
import { requestClientKey } from "../../../services/focus-sessions/resolve-work-session.js";
import type { SessionCriterion } from "@synap/playbooks";
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX,
  titleSourcePatch,
} from "@synap-core/types/focus-sessions";
import { completeFocusSession } from "../../../services/focus-sessions/complete-session.js";
import { sessionListConditions } from "../../../services/focus-sessions/session-list-conditions.js";
import {
  isTerminalSessionStatus,
  SESSION_STATUSES,
  UPDATABLE_SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
} from "../../../services/focus-sessions/session-statuses.js";
import { attachTriage } from "../../../services/focus-sessions/triage.js";
import {
  SESSION_KINDS,
  attachSessionKind,
} from "../../../services/focus-sessions/session-kind.js";
import { resolveCaptureActorUserId } from "../../../services/capture-agent/resolve-capture-actor.js";
import {
  recordSessionArtifact,
  SESSION_ARTIFACT_KINDS,
} from "../../../services/focus-sessions/record-session-artifact.js";
import { isOutputRefVisible } from "../../../services/focus-sessions/assert-output-ref-visible.js";
import type { FollowOutcome } from "../../../services/focus-sessions/follow-playbook.js";
import { delegateExpectedOutput } from "../../../services/focus-sessions/delegate-output.js";
import {
  guidanceForBlockedSlots,
  newlyBlockedSlots,
} from "../../../services/focus-sessions/block-guidelines.js";
import { BLOCKED_REASONS, type ExpectedOutput } from "@synap/playbooks";
import {
  blockExpectedOutput,
  unblockExpectedOutput,
  type BlockExpectedOutputResult,
} from "../../../services/focus-sessions/block-output.js";
import {
  expectedOutputWireSchema,
  outputRefWireSchema,
  mergeExpectedOutputs,
} from "../../../services/focus-sessions/update-session.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  isUuid,
  logger,
  rejectAgentReviewer,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { revertSession } from "../../../services/focus-sessions/revert-session.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

// ── Wire schemas ───────────────────────────────────────────────────────────

// The ONE wire shape for a declared deliverable, shared verbatim with the tRPC
// door rather than re-declared here. A narrower local copy STRIPS the
// server-owned slot fields (`delegatedTo`, `returnedReason`,
// `satisfiedByProposalId`, …) out of any array an agent echoes back, at the
// PARSE — before `mergeExpectedOutputs` could carry them forward.
const ExpectedOutputItemSchema = expectedOutputWireSchema;

const FocusSessionWireSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  projectId: z.string().nullable(),
  userId: z.string(),
  correlationId: z.string().nullable(),
  /** Short optional name; null = untitled (show `resolveSessionTitle`). */
  title: z.string().nullable(),
  goal: z.string(),
  status: z.string(),
  templateId: z.string().nullable(),
  expectedOutputs: z.unknown(),
  channelId: z.string().nullable(),
  progress: z.number().nullable(),
  currentStage: z.string().nullable(),
  agentIds: z.array(z.string()),
  closedAt: z.string().nullable(),
  verificationReport: z.unknown().nullable(),
  metadata: z.unknown(),
  startedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Projected, never stored (`services/focus-sessions/session-kind.ts`).
   * ALWAYS present on the LIST door's rows; optional here because the same
   * schema documents the single-row doors, which do not project it.
   * (`triage` is projected on the list door too and is likewise not spelled
   * out on this schema — a pre-existing doc gap, named rather than widened.)
   */
  kind: z.enum(SESSION_KINDS).optional(),
});

const CreateBodySchema = z
  .object({
    // workspaceId OR projectId — a session may be scoped to either (or both).
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    /**
     * The TRACK (a method running in a project) this session is born inside.
     * Names its own project — satisfies the scope requirement below on its
     * own; a different `projectId` is refused.
     */
    trackId: z.string().uuid().optional(),
    userId: z.string().min(1),
    /** Short one-line NAME; `goal` is the outcome. Blank ⇒ untitled. */
    title: z.string().max(SESSION_TITLE_MAX).optional(),
    goal: z.string().min(1).max(2000),
    correlationId: z.string().optional(),
    /**
     * A playbook to start from. Omitted on an AGENT start ⇒ a matching playbook
     * is applied above a confidence threshold and reported on `template`;
     * `null` opts out of matching.
     */
    templateId: z.string().nullable().optional(),
    /**
     * Answers to the template's declared params (only meaningful with
     * `templateId`). Free-form on the wire — the playbook owns the shape — and
     * validated against its declaration by the service.
     */
    params: z.record(z.string(), z.unknown()).optional(),
    expectedOutputs: z.array(ExpectedOutputItemSchema).optional(),
    /** Binary acceptance criteria (validated by the service's shared schema). */
    criteria: z.array(z.unknown()).optional(),
    channelId: z.string().uuid().optional(),
    agentIds: z.array(z.string()).optional(),
    /**
     * The entity this session is ABOUT — the subject-spine anchor. Floored
     * server-side through the same `isOutputRefVisible` predicate an output's
     * ref goes through; an entity the caller cannot see is a 404.
     */
    subjectEntityId: z.string().uuid().optional(),
    /**
     * This session's PARENT — it is a child: a detour or a planned sub-session.
     * Recorded as `session --spawned_from--> session`; owner-floored
     * server-side. An unowned/unknown parent does not fail the create — the
     * response's `parentLink` reports it. The parent stays open and lists its
     * children. Never a column, never a governance inherit.
     */
    parentSessionId: z.string().uuid().optional(),
    /** One line describing what the PARENT was about to do, at push time. */
    suspendedIntent: z.string().min(1).max(2000).optional(),
    /**
     * Sessions this one waits on — `session --blocked_by--> session` edges,
     * validated and written through the same door as POST /links, each outcome
     * reported per id on the response's `blockerLinks`.
     */
    blockedBySessionIds: z.array(z.string().uuid()).max(20).optional(),
    /**
     * Open a NEW session even when an open session of the same goal and scope
     * exists. Without it the response is that existing session, flagged
     * `deduped: true` (near-goal sessions ride `dedupCandidates`).
     */
    forceCreate: z.boolean().optional(),
  })
  .refine((b) => !!b.workspaceId || !!b.projectId || !!b.trackId, {
    message: "Provide a workspaceId, a projectId or a trackId",
    path: ["workspaceId"],
  });

/**
 * Fields this door does NOT implement, REJECTED rather than silently stripped.
 *
 * zod strips undeclared keys, so a PATCH carrying `completeOutput` returned 200
 * with the whole session and the slot untouched — and an unchanged 200 is what
 * an agent reads as "marked done". Worse, that silence is indistinguishable
 * from the governance floor that legitimately refuses to close a human-owned
 * slot, and from an actual success.
 *
 * Marking a declared deliverable done belongs to the MCP `synap_update_session`
 * door, which takes the row lock this PATCH deliberately does not (see the
 * header of `services/focus-sessions/update-session.ts` on why the two doors
 * are distinct). Returns the caller-facing message, or null when the body is
 * clean.
 */
export function unsupportedUpdateFieldError(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  if ("completeOutput" in raw) {
    return "completeOutput is not supported on PATCH /focus-sessions/:id — nothing was changed. Use the synap_update_session tool (MCP) to mark a declared deliverable done; it takes the row lock this door does not.";
  }
  if ("stages" in raw) {
    return "stages is not supported on PATCH /focus-sessions/:id — nothing was changed. A session's own phase snapshot (focus_sessions.stages) is written through the tRPC focusSessions.update door.";
  }
  if ("projectId" in raw) {
    return "projectId is not supported on PATCH /focus-sessions/:id — nothing was changed. Filing a session into a project is always reviewed: use the synap_update_session tool (MCP) with projectId, which files it as a proposal the person approves.";
  }
  return null;
}

/**
 * ⚠️ THE LIST ABOVE IS HAND-MAINTAINED, AND THAT IS THE KNOWN WEAKNESS.
 *
 * `UpdateBodySchema` is a plain `z.object`, so Zod STRIPS any key it does not
 * declare. A PATCH carrying an undeclared field therefore lands, returns 200
 * with the full session body, and changes nothing — which an agent parses as
 * success. That is the exact defect `focus-sessions.unsupported-field.test.ts`
 * was written about, and it is why this function exists at all.
 *
 * But the function only catches fields somebody REMEMBERED to add here. It held
 * one key (`completeOutput`) while `stages` shipped on the tRPC door and walked
 * straight past it — found by review, not by a gate. `stages` is now named, so
 * the lie is closed for it, but the SHAPE of the guard is still the
 * hand-maintained-set anti-pattern this repo has been bitten by repeatedly (a
 * `DOORS` array holding the one door that was already correct while four others
 * were broken).
 *
 * The real fix is to DERIVE the rejected set rather than list it: compare the
 * incoming keys against `UpdateBodySchema`'s own `.shape` and refuse anything
 * unknown, so a new field joins the guard BY EXISTING. That is a behaviour
 * change for every caller of this door (a body with a stray key starts failing
 * where it used to be silently ignored), so it is deliberately NOT done in this
 * wave alongside unrelated work — it needs its own change with its own
 * compatibility check across the CLI and IS callers.
 */

// workspaceId is accepted for back-compat with CLI callers that still send it,
// but the authoritative workspace comes from the LOADED ROW (write-gate rule:
// never trust a caller-supplied workspaceId for scoping a mutation).
const UpdateBodySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  // ONE status vocabulary — the same list the tRPC `focus_sessions.update` door
  // takes, so the two write doors can never drift apart.
  status: z.enum(UPDATABLE_SESSION_STATUSES).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  channelId: z.string().uuid().optional(),
  correlationId: z.string().optional(),
  // Rename; `null` or blank CLEARS (untitled).
  title: z.string().max(SESSION_TITLE_MAX).nullable().optional(),
  goal: z.string().min(1).max(2000).optional(),
  agentIds: z.array(z.string()).optional(),
  // APPEND one agent, as against `agentIds` which REPLACES the roster. Routed
  // through the ONE append door (`attachSessionAgent`) so it is idempotent and
  // cannot lose a concurrent attach; the two may be sent together, in which
  // case the wholesale assignment lands first and the append is applied on top.
  addAgentId: z.string().min(1).optional(),
  expectedOutputs: z.array(ExpectedOutputItemSchema).optional(),
  verificationReport: z.unknown().optional(),
  // First-class stages: advance the active playbook stage (PlaybookStage.key).
  currentStage: z.string().min(1).optional(),
  // Re-point (or CLEAR, with an explicit `null`) the subject-spine anchor.
  // Same floor as the create door; `null` is the un-set.
  subjectEntityId: z.string().uuid().nullable().optional(),
  // Free-form metadata bag — SHALLOW-MERGED into the existing row metadata.
  metadata: z.record(z.string(), z.unknown()).optional(),
  // WHOLESALE replace of the session's binary acceptance criteria (max 12).
  criteria: sessionCriteriaSchema.optional(),
  // FOLLOW a playbook with this live session; `null` RELEASES it. The session
  // BECOMES A RUN of that playbook — it joins the playbook's runs and leaves
  // the work lens. ONE implementation (`follow-playbook.ts`), shared with the
  // tRPC and MCP doors and the approval executor.
  followPlaybookId: z.string().uuid().nullable().optional(),
  // Which stage the work is ALREADY in. Omitted ⇒ the stage is left alone
  // (never seeded to stage 1); an unknown key is REFUSED with the valid keys.
  followStageKey: z.string().min(1).nullable().optional(),
  /** @see UpdateSessionParams.params — only with followPlaybookId. */
  params: z.record(z.string(), z.unknown()).optional(),
  agentUserId: z.string().uuid().optional(),
  reasoning: z.string().optional(),
});

/**
 * Door parity with the tRPC `focusSessions.attachOutput` — same field names,
 * same DERIVED kind list (`SESSION_ARTIFACT_KINDS`, the artifacts ledger's own),
 * so the human door and the agent door cannot drift.
 */
const AttachOutputBodySchema = z.object({
  kind: z.enum(SESSION_ARTIFACT_KINDS),
  refId: z.string().min(1),
  label: z.string().min(1).max(500).optional(),
  /** A declared `expectedOutputs[].label` this output is claimed against. */
  expectedLabel: z.string().min(1).max(500).optional(),
  /**
   * FALLBACK lens, used ONLY when the session itself has none — parity with the
   * tRPC door. The session's own workspace always wins, so this can never
   * re-file an output away from the session that produced it. Omitted on a
   * pod-personal session ⇒ a pod-personal (NULL-workspace) row, which
   * `artifacts.workspace_id` has allowed since 0245.
   */
  workspaceId: z.string().uuid().optional(),
});

/**
 * Delegation body. The label rides in the BODY, not the path.
 *
 * The obvious REST shape — `/outputs/:label/delegate` — puts a free-text human
 * label ("Q3 board memo (draft)") into a path segment, where a slash or a `%`
 * in a perfectly legal label becomes a routing bug and every client owes the
 * same encoding dance. The sibling route one line up
 * (`POST /focus-sessions/:id/outputs`) already carries `expectedLabel` in the
 * body for exactly that reason, so this keeps ONE place a slot label is spelled
 * on this surface. The path stays static (`/outputs/delegate`), which is also
 * what Hono's first-match ordering wants.
 */
const DelegateOutputBodySchema = z.object({
  expectedLabel: z.string().min(1).max(500),
  /** Absent ⇒ the orchestrator, `triggerAutoRespond`'s own default. */
  agentType: z.string().min(1).max(100).optional(),
});

/**
 * The ownership pair. `blockedReason` is `z.enum(BLOCKED_REASONS)` — the closed
 * set from `@synap/playbooks`, never a locally retyped copy: a sixth value
 * added there must not need a second edit here to be sendable.
 */
const BlockOutputBodySchema = z.object({
  expectedLabel: z.string().min(1).max(500),
  blockedReason: z.enum(BLOCKED_REASONS),
  why: z.string().max(500).optional(),
  /**
   * WHERE the person must go. `null` clears a stored pointer; omitted leaves it.
   * Twin of the tRPC `blockOutput.ref` — same union, same one visibility floor.
   */
  ref: outputRefWireSchema.nullable().optional(),
});

const UnblockOutputBodySchema = z.object({
  expectedLabel: z.string().min(1).max(500),
});

const UsedCapabilityBodySchema = z.object({
  capabilityKind: z.enum(["tool", "skill", "command"]),
  capabilityId: z.string().min(1),
});

const CompleteBodySchema = z.object({
  summary: z.string().optional(),
  verificationReport: z.record(z.string(), z.unknown()).optional(),
  // Every lifecycle exit, not just `closed`. The PATCH door above has always
  // been able to cancel/fail a session (its enum derives from
  // UPDATABLE_SESSION_STATUSES); this route hardcoded `closed`, so the CLI and
  // the MCP door — which both close through here — could record only success.
  // Derived from the SSOT so a fourth terminal status is accepted by default.
  terminalStatus: z.enum(TERMINAL_SESSION_STATUSES).optional(),
});

// ── Registration ───────────────────────────────────────────────────────────

export function registerFocusSessionsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────

  registerOpenApi(app, {
    method: "get",
    path: "/focus-sessions",
    tags: ["FocusSessions"],
    summary: "List focus sessions for a workspace",
    request: {
      query: z.object({
        workspaceId: z.string(),
        status: z.enum([...SESSION_STATUSES, "all"]).optional(),
        // Triage lens. Default here is `all` (agent-facing door); `default`
        // hides agent/automation-originated sessions not yet accepted by a
        // human, `triage` returns only those. Rows carry `triage.pending`.
        lens: z.enum(["default", "triage", "all"]).optional(),
        // Population lens (`services/focus-sessions/session-kind.ts`).
        // Default here is `all`, NOT the tRPC door's `work`: this is the
        // agent-facing door, and an agent listing sessions wants its own
        // write receipts and the runs it opened — exactly the rows a person's
        // work surface hides. Rows carry `kind` under every value.
        kind: z.enum([...SESSION_KINDS, "all"]).optional(),
        // FLOW-DEFINITION filters — the same two the tRPC door carries, so a
        // detail surface narrows in SQL rather than paging and filtering.
        // Both name a DEFINITION, never one execution: `automationId` is
        // `metadata.automationId`, NOT `automationRunId`.
        playbookId: z.string().uuid().optional(),
        automationId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
    },
    responses: {
      200: { description: "Sessions", schema: z.array(FocusSessionWireSchema) },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/focus-sessions/:id",
    tags: ["FocusSessions"],
    summary: "Get a focus session by ID",
    request: {
      params: z.object({ id: z.string().uuid() }),
      // workspaceId optional: when omitted, floor on owner/user (project-scoped OK).
      query: z.object({ workspaceId: z.string().optional() }),
    },
    responses: {
      200: { description: "Session", schema: FocusSessionWireSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/focus-sessions/:id/complete",
    tags: ["FocusSessions"],
    summary: "Complete (close) a focus session and return the proposal pack",
    description:
      "Lifecycle close via completeFocusSession — stamps closed, finishes any " +
      "running playbook_run, returns pendingProposals + counts + warnings. " +
      "Distinct from POST .../complete-run (playbook run only).",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: CompleteBodySchema,
    },
    responses: {
      200: {
        description: "Closed session + proposal pack",
        schema: z.object({}).passthrough(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden or proposed", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/focus-sessions",
    tags: ["FocusSessions"],
    summary: "Create a focus session",
    description:
      "IS creates a focus session, optionally with a correlationId for idempotency. " +
      "If a session with the same correlationId already exists it is returned as-is.",
    request: { body: CreateBodySchema },
    responses: {
      200: {
        description: "Created or existing session",
        schema: FocusSessionWireSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/focus-sessions/:id",
    tags: ["FocusSessions"],
    summary: "Update a focus session",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: UpdateBodySchema,
    },
    responses: {
      200: { description: "Updated session", schema: FocusSessionWireSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/focus-sessions/:id/outputs",
    tags: ["FocusSessions"],
    summary: "Record an existing object as a session output",
    description:
      "Writes one `artifacts` provenance row attributing an already-existing " +
      "view/cell/document/entity/url to this session. `expectedLabel` claims a " +
      "declared deliverable slot for the join; it never stamps it done.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: AttachOutputBodySchema,
    },
    responses: {
      200: {
        description: "Recorded",
        schema: z.object({ ok: z.boolean(), outputId: z.string() }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/focus-sessions/:id/outputs/delegate",
    tags: ["FocusSessions"],
    summary: "Hand a declared deliverable to an agent",
    description:
      "Posts one ask in the session room, starts an agent turn for it, and " +
      "stamps `delegatedTo`/`delegatedAt` on the named slot. Never stamps " +
      "`status` — only an approval may do that.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: DelegateOutputBodySchema,
    },
    responses: {
      200: {
        description: "Delegated",
        schema: z.object({
          ok: z.boolean(),
          expectedLabel: z.string(),
          kind: z.string(),
          agentType: z.string(),
          channelId: z.string(),
          messageId: z.string(),
          triggered: z.boolean(),
          agentAttached: z.boolean(),
        }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/focus-sessions/:id/outputs/block",
    tags: ["FocusSessions"],
    summary: "Hand a declared deliverable to the human",
    description:
      "Stamps `owner: 'human'` + `blockedReason` + `why` + `owedSince` on the " +
      "named slot. The slot stays `pending` — declaring that you cannot do the " +
      "work is the opposite of having done it. When a standing guideline " +
      "covers this kind of block, `blockGuidelines` carries its text.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: BlockOutputBodySchema,
    },
    responses: {
      200: {
        description: "Blocked on the human",
        schema: z.object({
          ok: z.boolean(),
          expectedLabel: z.string(),
          kind: z.string(),
          blockGuidelines: z.unknown().optional(),
        }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/focus-sessions/:id/outputs/unblock",
    tags: ["FocusSessions"],
    summary: "Reclaim a deliverable handed to the human",
    description:
      "Clears `owner`, `blockedReason`, `why` and `owedSince` together. The " +
      "deliverable itself is unchanged and still owed.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: UnblockOutputBodySchema,
    },
    responses: {
      200: {
        description: "Reclaimed",
        schema: z.object({
          ok: z.boolean(),
          expectedLabel: z.string(),
          kind: z.string(),
        }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── Handlers ─────────────────────────────────────────────────────────────
  // Static route (/focus-sessions) BEFORE dynamic (/focus-sessions/:id) —
  // Hono is first-match.

  /**
   * GET /focus-sessions?workspaceId=...&status=...&limit=...
   */
  app.get("/focus-sessions", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const workspaceIdParam = c.req.query("workspaceId");
    if (!workspaceIdParam) {
      return c.json({ error: "workspaceId is required" }, 400);
    }
    // Validate the caller is a member of the requested workspace and bind the
    // acting user. Without this the read scoped by a caller-supplied workspaceId
    // ALONE with no userId floor — exposing every member's private sessions in
    // any workspace id an agent key chose to pass (cross-user + cross-workspace).
    const acting = await resolveActingContext(c, {
      workspaceId: workspaceIdParam,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    const statusRaw = c.req.query("status") ?? "all";
    const limitRaw = parseInt(c.req.query("limit") ?? "20", 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 50)
      : 20;
    // ONE status vocabulary (session-statuses.ts) — this door used to carry a
    // hand-mirrored copy that would silently reject any status the schema
    // later learned.
    const validStatuses = [...SESSION_STATUSES, "all"] as const;
    const status = validStatuses.includes(
      statusRaw as (typeof validStatuses)[number]
    )
      ? (statusRaw as (typeof validStatuses)[number])
      : "all";

    // Triage lens, same vocabulary as tRPC `focusSessions.list`. This is the
    // AGENT-facing door (IS + CLI), so the default is `all`: an agent listing
    // sessions is usually looking for the one it just opened, which is exactly
    // the row the human default lens hides. Rows still carry the projection so
    // a human overview riding this door can group Drafted itself.
    const lensRaw = c.req.query("lens") ?? "all";
    const lens: "default" | "triage" | "all" =
      lensRaw === "default" || lensRaw === "triage" ? lensRaw : "all";

    // Population lens, same vocabulary as tRPC `focusSessions.list`, DIFFERENT
    // default — see the OpenAPI note above.
    const kindRaw = c.req.query("kind") ?? "all";
    const kind = (SESSION_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as (typeof SESSION_KINDS)[number])
      : "all";

    // Optional: narrow to the sessions of ONE flow definition.
    const playbookId = c.req.query("playbookId");
    const automationId = c.req.query("automationId");

    // Optional: narrow to sessions ABOUT a specific subject entity (the
    // subject-spine anchor). Lets a caller fetch "the sessions linked to this
    // client/person/deal" — the session half of an entity's neighborhood.
    const subjectEntityId = c.req.query("subjectEntityId");

    try {
      // The SAME WHERE clause the tRPC door builds. This door used to hand-write
      // its own copy (status, triage, kind, flow), the twin that could drift.
      // What differs here is only what it passes: the agent-facing `"all"`
      // defaults resolved above, and the one narrowing it owns alone,
      // `subjectEntityId`. See `session-list-conditions.ts`.
      const conditions = sessionListConditions({
        userId: acting.userId,
        scope: { workspaceLens: workspaceIdParam, projectLens: undefined },
        status,
        lens,
        kind,
        flow: { playbookId, automationId },
      });
      if (subjectEntityId) {
        conditions.push(eq(focusSessions.subjectEntityId, subjectEntityId));
      }

      const rows = await db
        .select()
        .from(focusSessions)
        .where(and(...conditions))
        .orderBy(desc(focusSessions.startedAt))
        .limit(limit);

      return c.json(attachSessionKind(attachTriage(rows)));
    } catch (err) {
      logger.error({ err }, "focus-sessions.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /focus-sessions/:id?workspaceId=...
   *
   * workspaceId is optional. When provided: membership check + workspace floor
   * (legacy callers). When omitted: owner/user floor only — same as MCP
   * synap_get_session — so project-scoped sessions (workspaceId NULL) resolve.
   */
  app.get("/focus-sessions/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const id = c.req.param("id");
    // A malformed id (e.g. a display-truncated uuid) must not reach the
    // `eq(focusSessions.id, id)` cast below — postgres throws invalid-uuid-
    // syntax there, which surfaces as a 500 for what is a client typo. Same
    // shape the caller gets for a well-formed-but-missing id: neither
    // discloses whether SOME session exists at that handle.
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const workspaceIdParam = c.req.query("workspaceId");
    // Bind acting user; optional workspace membership when a lens is supplied.
    const acting = await resolveActingContext(c, {
      workspaceId: workspaceIdParam || undefined,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const conditions = [
        eq(focusSessions.id, id),
        eq(focusSessions.userId, acting.userId),
      ];
      if (workspaceIdParam) {
        conditions.push(eq(focusSessions.workspaceId, workspaceIdParam));
      }

      const row = await db.query.focusSessions.findFirst({
        where: and(...conditions),
      });

      if (!row) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }

      // Same projection as tRPC `focusSessions.get` and MCP `synap_get_session`:
      // the continuation packet, which carries the rerun door's own rule.
      const { projectContinuationPacket } =
        await import("../../../services/focus-sessions/continuation-packet.js");
      const continuation = await projectContinuationPacket(row, {
        database: db,
        userId: acting.userId,
      });
      return c.json({
        ...row,
        rerun: continuation.rerun,
        continuation,
        // Same lift as tRPC `focusSessions.get`: normalized criteria, verdict,
        // current evaluation per criterion. Absent when the read failed.
        ...(continuation.evaluation.status === "ok"
          ? {
              criteria: continuation.evaluation.criteria,
              verdict: continuation.evaluation.verdict,
              evaluations: continuation.evaluation.evaluations,
            }
          : {}),
      });
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.get failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /focus-sessions
   * IS creates a session, optionally with correlationId for idempotency.
   * Goes through checkPermissionOrPropose so the governance membrane is honored.
   */
  app.post("/focus-sessions", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const raw = await c.req.json().catch(() => null);
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = CreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) =>
          i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message
        )
        .join(", ");
      return c.json({ error: message }, 400);
    }

    const body = parsed.data;

    // Bind the acting identity to the authenticated principal and verify
    // workspace membership — mirrors artifacts.ts POST pattern. For a
    // project-scoped session (no workspaceId) we still bind the user but keep
    // the session's workspace null — we do NOT stamp the membership fallback.
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: body.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;
    // Item 3 Part 3: positively pin a bound service key to its workspace. A
    // project-scoped session (no workspaceId) from a bound key still pins.
    // A mismatching bound key throws FORBIDDEN → surface 403, not a blanket 500.
    let workspaceId: string | null;
    try {
      workspaceId =
        getConfinedWorkspace(c, body.workspaceId ? acting.workspaceId : null) ??
        null;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }

    // VISIBILITY FLOOR on the subject anchor — the same predicate and the same
    // refusal the PATCH door applies, so the two cannot disagree about what a
    // caller may point a session at.
    if (body.subjectEntityId) {
      const { isOutputRefVisible } =
        await import("../../../services/focus-sessions/assert-output-ref-visible.js");
      const visible = await isOutputRefVisible({
        userId,
        kind: "entity",
        refId: body.subjectEntityId,
      });
      if (!visible) {
        return c.json(
          { error: `No entity ${body.subjectEntityId} you can access` },
          404
        );
      }
    }

    try {
      // Delegate to the shared service (used by both Hub REST and MCP adapter).
      // On the capture path (X-Capture: 1) attribute the write to the seeded
      // Capture agent so focus_session.create auto-approves; otherwise keep the
      // caller's own agent identity (normal governance).
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const agentUserId = await resolveCaptureActorUserId(c, ctxAgentUserId, {
        workspaceId,
      });
      const result = await createFocusSession({
        userId,
        workspaceId,
        projectId: body.projectId ?? null,
        trackId: body.trackId ?? null,
        title: body.title ?? null,
        goal: body.goal,
        agentUserId,
        correlationId: body.correlationId,
        channelId: body.channelId ?? null,
        agentIds: body.agentIds,
        templateId: body.templateId,
        params: body.params,
        // Session-first defaults are for AI starts only — keyed on the KEY's
        // own agent, not the capture-path remap above: a person's start (or a
        // capture they made) is never re-shaped by a guessed template.
        matchTemplate: !!ctxAgentUserId,
        clientKey: ctxAgentUserId ? requestClientKey(ctxAgentUserId) : null,
        criteria: body.criteria as SessionCriterion[] | undefined,
        expectedOutputs: body.expectedOutputs,
        subjectEntityId: body.subjectEntityId ?? null,
        parentSessionId: body.parentSessionId ?? null,
        suspendedIntent: body.suspendedIntent ?? null,
        blockedBySessionIds: body.blockedBySessionIds ?? [],
        forceCreate: body.forceCreate,
      });

      if (result.status === "deduped") {
        // The EXISTING session, flagged — never silent. The row's own `status`
        // is its lifecycle, so reuse rides as `deduped: true`.
        return c.json({
          ...result.session,
          deduped: true,
          ...(result.candidates.length > 0
            ? { dedupCandidates: result.candidates }
            : {}),
        });
      }

      if (result.status === "proposed") {
        return jsonGoverned(c, {
          status: "proposed",
          message: result.message,
          proposalId: result.proposalId,
          summary: result.summary,
          reviewPath: result.reviewPath,
          reviewUrl: result.reviewUrl,
          session: null,
        });
      }

      return c.json({
        ...result.session,
        ...(result.candidates ? { dedupCandidates: result.candidates } : {}),
        ...(result.blockGuidelines
          ? { blockGuidelines: result.blockGuidelines }
          : {}),
        // Edge outcomes, only when asked for — a failed edge is reported here.
        ...(result.parentLink ? { parentLink: result.parentLink } : {}),
        ...(result.blockerLinks ? { blockerLinks: result.blockerLinks } : {}),
        // The pod's playbooks ranked against this session's words (suggestions
        // only — nothing applied), and the auto-opened session adopted.
        ...(result.playbooks ? { playbooks: result.playbooks } : {}),
        ...(result.adopted ? { adopted: true } : {}),
      });
    } catch (err) {
      logger.error({ err }, "focus-sessions.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * PATCH /focus-sessions/:id
   * IS updates progress / status / correlationId.
   *
   * Write-gate pattern (mirrors artifacts.ts PATCH):
   *   1. Load the row by id alone (never trust a caller-supplied workspaceId for scoping).
   *   2. Verify the caller's membership in the LOADED ROW's workspace via resolveActingContext.
   *   3. Gate through checkPermissionOrPropose — the membrane decides approve vs propose.
   *   4. Execute the raw DB update only after gate approval.
   */
  app.patch("/focus-sessions/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const id = c.req.param("id");
    // Same malformed-id-as-500 trap as GET /focus-sessions/:id — refuse before
    // the uuid cast, not after postgres throws.
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const raw = await c.req.json().catch(() => null);
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);

    const unsupported = unsupportedUpdateFieldError(raw);
    if (unsupported) return c.json({ error: unsupported }, 400);

    const parsed = UpdateBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) =>
          i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message
        )
        .join(", ");
      return c.json({ error: message }, 400);
    }

    // workspaceId from the body is accepted for back-compat but NOT used for scoping.

    const { workspaceId: _ignored, ...patch } = parsed.data;

    try {
      // Step 1: load by id alone — workspaceId comes from the ROW, not the body.
      const existing = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, id),
      });

      if (!existing) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }

      // Step 2: verify the caller's membership in the row's workspace.
      // workspaceId is nullable since Phase 4 (project-scoped sessions). Pass
      // undefined when null so resolveActingContext falls back to pod-level auth.
      const acting = await resolveActingContext(c, {
        workspaceId: existing.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const { userId, workspaceId } = acting;

      // Step 2b: VISIBILITY FLOOR on the subject anchor, before the membrane
      // for the same reason the output-ref floor sits there: an entity the
      // caller cannot see must be refused to the caller who wrote it, not
      // laundered into a proposal that explodes on the human at approval time.
      // ONE door — `isOutputRefVisible`, the same predicate the output doors
      // apply. `null` clears and names nothing, so it skips.
      if (patch.subjectEntityId) {
        const { isOutputRefVisible } =
          await import("../../../services/focus-sessions/assert-output-ref-visible.js");
        const visible = await isOutputRefVisible({
          userId,
          kind: "entity",
          refId: patch.subjectEntityId,
        });
        if (!visible) {
          return c.json(
            { error: `No entity ${patch.subjectEntityId} you can access` },
            404
          );
        }
      }

      // Step 3: governance membrane. On the capture path (X-Capture: 1) attribute
      // the write to the seeded Capture agent so focus_session.update auto-approves;
      // a body-supplied agentUserId still wins, and a non-capture caller keeps its
      // own agent identity (normal governance).
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const agentUserId =
        patch.agentUserId ??
        (await resolveCaptureActorUserId(c, ctxAgentUserId, { workspaceId }));

      // Gate data: always include goal from the row (proposal summary label) plus
      // every field being patched so focus_session/update can materialize on approve.
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId,
        workspaceId,
        subjectType: "focus_session",
        action: "update",
        source: "intelligence",
        reasoning: patch.reasoning,
        data: {
          id,
          goal: patch.goal !== undefined ? patch.goal : existing.goal,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
          ...(patch.channelId !== undefined
            ? { channelId: patch.channelId }
            : {}),
          ...(patch.correlationId !== undefined
            ? { correlationId: patch.correlationId }
            : {}),
          ...(patch.agentIds !== undefined ? { agentIds: patch.agentIds } : {}),
          // Carried so the PROPOSED path is not a silent no-op — the
          // `focus_session/update` executor re-applies it on approval.
          ...(patch.addAgentId !== undefined
            ? { addAgentId: patch.addAgentId }
            : {}),
          ...(patch.expectedOutputs !== undefined
            ? { expectedOutputs: patch.expectedOutputs }
            : {}),
          ...(patch.verificationReport !== undefined
            ? { verificationReport: patch.verificationReport }
            : {}),
          ...(patch.currentStage !== undefined
            ? { currentStage: patch.currentStage }
            : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
          ...(patch.subjectEntityId !== undefined
            ? { subjectEntityId: patch.subjectEntityId }
            : {}),
          ...(patch.criteria !== undefined ? { criteria: patch.criteria } : {}),
          // Carried so the PROPOSED path is not a silent no-op — the
          // `focus_session/update` executor re-applies the follow on approval.
          // `null` is the RELEASE, hence the `!== undefined` test.
          ...(patch.followPlaybookId !== undefined
            ? { followPlaybookId: patch.followPlaybookId }
            : {}),
          ...(patch.followStageKey !== undefined
            ? { followStageKey: patch.followStageKey }
            : {}),
          // Same reason as `followPlaybookId` above: without this the answers
          // would land on the direct path and vanish on the approved one.
          ...(patch.params !== undefined ? { params: patch.params } : {}),
        },
      });

      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return jsonGoverned(c, {
          status: "proposed",
          message: proposedMessageFor(
            perm.proposalType,
            "Focus session update proposed for review"
          ),
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          session: null,
        });
      }

      // Step 4a: a TERMINAL status funnels through the ONE close door first
      // (pack + run close + ephemeral expiry + close event). This PATCH used to
      // stamp `closed` directly — the "known dual path" — and a `cancelled`
      // write skipped every close side-effect.
      if (
        isTerminalSessionStatus(patch.status) &&
        !isTerminalSessionStatus(existing.status)
      ) {
        try {
          const closed = await completeFocusSession({
            sessionId: id,
            userId,
            agentUserId,
            terminalStatus: patch.status,
          });
          if (!closed) {
            return c.json({ error: `Focus session ${id} not found` }, 404);
          }
        } catch (err) {
          const code = (err as { code?: string }).code;
          const message = err instanceof Error ? err.message : String(err);
          return c.json({ error: message }, code === "FORBIDDEN" ? 403 : 409);
        }
        // The row is now terminal; apply the rest of the patch below.
        delete (patch as { status?: string }).status;
      }

      // Step 4: execute the update.
      const set: Partial<typeof focusSessions.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (patch.status !== undefined) set.status = patch.status;
      if (patch.progress !== undefined) set.progress = patch.progress;
      if (patch.channelId !== undefined) set.channelId = patch.channelId;
      if (patch.correlationId !== undefined)
        set.correlationId = patch.correlationId;
      if (patch.goal !== undefined) set.goal = patch.goal;
      if (patch.title !== undefined)
        set.title = normalizeSessionTitle(patch.title);
      if (patch.agentIds !== undefined) set.agentIds = patch.agentIds;
      // Merge, never assign — the SAME merge the tRPC and MCP doors use, so a
      // caller that echoes back only the fields it knows about cannot erase a
      // delegation, a reviewer's return note, or an approval's lineage.
      if (patch.expectedOutputs !== undefined)
        set.expectedOutputs = mergeExpectedOutputs(
          (existing.expectedOutputs as typeof patch.expectedOutputs) ?? [],
          patch.expectedOutputs
        );
      // Shallow-merge, exactly like the `metadata` bag below — `verificationReport`
      // is the SAME shape of thing: an open JSONB bag written by SEVERAL
      // independent producers at different moments in a session's life.
      //
      // `completeFocusSession` writes `{ summary }` at close; a verify step writes
      // `{ codeQuality }`. Under the previous full REPLACE, whichever landed second
      // silently destroyed the other — verify-then-close threw away the code-quality
      // result, close-then-verify threw away the session narrative. Nothing warned,
      // and the loss is invisible because the surface only ever renders one key.
      //
      // Merging makes the column additive, which is what every producer already
      // assumes. To CLEAR a key a caller must now send it explicitly as null —
      // acceptable, because no caller does, and silent destruction is the worse
      // default by a wide margin.
      if (patch.verificationReport !== undefined) {
        const existingReport =
          (existing.verificationReport as Record<string, unknown> | null) ?? {};
        set.verificationReport = {
          ...existingReport,
          ...patch.verificationReport,
        };
      }
      if (patch.currentStage !== undefined)
        set.currentStage = patch.currentStage;
      // `undefined` leaves the anchor; `null` is the CLEAR.
      if (patch.subjectEntityId !== undefined)
        set.subjectEntityId = patch.subjectEntityId;
      if (patch.criteria !== undefined) set.criteria = patch.criteria;
      // Shallow-merge the metadata bag into the existing row metadata (additive).
      if (patch.metadata !== undefined) {
        const existingMeta =
          (existing.metadata as Record<string, unknown> | null) ?? {};
        set.metadata = { ...existingMeta, ...patch.metadata };
      }
      // Title provenance: an agent's rename is never overwritten by the
      // background titler; a CLEAR hands the name back to it ("derived").
      // Folded into the metadata write above when there is one (the server's
      // stamp wins over a body key), otherwise MERGED in SQL — never assigned
      // over the row's metadata.
      if (patch.title !== undefined) {
        const stamp = titleSourcePatch(set.title ? "agent" : "derived");
        set.metadata =
          set.metadata !== undefined
            ? { ...(set.metadata as Record<string, unknown>), ...stamp }
            : drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`;
      }

      let [updated] = await db
        .update(focusSessions)
        .set(set)
        .where(eq(focusSessions.id, id))
        .returning();

      // Roster append through the ONE append door (row-locked, idempotent).
      // AFTER the row update on purpose: `agentIds` and `addAgentId` may both be
      // sent, and a wholesale REPLACE followed by an APPEND is the only ordering
      // where neither silently discards the other. Folding the append into `set`
      // instead would be a second append implementation with no lock — the exact
      // read-modify-write race the door exists to own.
      if (updated && patch.addAgentId !== undefined) {
        const { attachSessionAgent } =
          await import("../../../services/focus-sessions/attach-session-agent.js");
        const attached = await attachSessionAgent({
          sessionId: id,
          agentId: patch.addAgentId,
          userId,
        });
        if (attached.status === "attached") {
          updated = { ...updated, agentIds: attached.agentIds };
        }
      }

      // ── STAGE ADVANCE ─────────────────────────────────────────────────────
      // ONE door owns the `stage_changed` fan-out AND the human stage gate
      // (`services/focus-sessions/advance-stage.ts`). This door used to carry a
      // hand-copy of the emit and NO gate, so an Intelligence-Service advance
      // into a `gate: { kind: "human" }` stage never paused and never filed.
      //
      // `stageWrite: "caller"` — the stage was already written by the UPDATE above.
      // `agentUserId` is threaded so the gate proposal carries agent provenance,
      // exactly as the MCP door does.
      if (updated && patch.currentStage !== undefined) {
        const { advanceSessionStage } =
          await import("../../../services/focus-sessions/advance-stage.js");
        const advance = await advanceSessionStage({
          session: {
            id: updated.id,
            currentStage: existing.currentStage,
            workspaceId: existing.workspaceId,
            projectId: existing.projectId,
            channelId: existing.channelId,
            playbookId: existing.playbookId,
            subjectEntityId: existing.subjectEntityId,
          },
          toStage: patch.currentStage,
          userId,
          agentUserId,
          stageWrite: "caller",
        });
        // Report the status the ROW now holds — see the MCP door for why a
        // caller told "active" past an open gate is the dangerous answer.
        if (advance.paused) updated = { ...updated, status: "paused" };
      }

      // ── FOLLOW / RELEASE A PLAYBOOK ───────────────────────────────────────
      // ONE implementation, shared with the tRPC and MCP doors. AFTER the field
      // write so the playbook's criteria and deliverables merge onto what this
      // call just wrote. A refusal is a 400 naming the reason — this door is
      // reached by an AGENT key, and a 200 with an unchanged row is exactly the
      // "guard holds, report misleads" shape the output floor already pays for.
      let follow: FollowOutcome | undefined;
      if (updated && patch.followPlaybookId !== undefined) {
        const { followPlaybook } =
          await import("../../../services/focus-sessions/follow-playbook.js");
        const result = await followPlaybook({
          sessionId: id,
          userId,
          agentUserId,
          followPlaybookId: patch.followPlaybookId,
          followStageKey: patch.followStageKey,
          params: patch.params,
        });
        if (result.status === "refused") {
          return c.json({ error: result.reason }, 400);
        }
        if (result.status === "not_found") {
          return c.json({ error: `Focus session ${id} not found` }, 404);
        }
        if (result.status === "proposed") {
          return jsonGoverned(c, {
            status: "proposed",
            message: result.reason,
            proposalId: result.proposalId,
            summary: result.summary,
            reviewPath: result.reviewPath,
            reviewUrl: result.reviewUrl,
            session: updated,
          });
        }
        updated = result.session as typeof updated;
        follow = result.follow;
      }

      emitHubRealtimeEvent({
        eventType: "focus_session.update.completed",
        subjectId: updated.id,
        userId,
        data: {
          id: updated.id,
          workspaceId: updated.workspaceId,
          status: updated.status,
          goal: updated.goal,
          progress: updated.progress,
        },
      });

      // The safety net every block door carries (`block-guidelines.ts`): the
      // IS appends a slot through THIS wholesale array, so a guideline covering
      // the block it just declared must ride back on this response.
      const blockGuidelines =
        patch.expectedOutputs !== undefined
          ? await guidanceForBlockedSlots({
              userId,
              workspaceId: existing.workspaceId ?? null,
              slots: newlyBlockedSlots(
                existing.expectedOutputs as ExpectedOutput[] | null,
                set.expectedOutputs as ExpectedOutput[] | undefined
              ),
            })
          : undefined;

      return c.json({
        ...updated,
        ...(blockGuidelines ? { blockGuidelines } : {}),
        // What the follow DID — which playbook, which stage, how much
        // structure merged. Without it the caller must infer an attach from a
        // `playbookId` that appeared, and can never see a release's note.
        ...(follow ? { follow } : {}),
      });
    } catch (err) {
      // A WRITE-AUTHORITY refusal is a CALLER error, not a server fault. The
      // slot floor throws `TRPCError(BAD_REQUEST)` naming the slot and the
      // field; without this branch it escaped as a generic 500 reading "An
      // unexpected server error occurred", which tells an agent nothing about
      // what it may not write and reads as our bug rather than its own.
      // Same lesson as the `completeOutput` refusal: a guard that holds while
      // its report misleads is only half a guard.
      const code = (err as { code?: string }).code;
      if (code === "BAD_REQUEST" || code === "FORBIDDEN") {
        return c.json(
          { error: err instanceof Error ? err.message : "Refused" },
          code === "FORBIDDEN" ? 403 : 400
        );
      }
      logger.error({ err, id }, "focus-sessions.update failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:id/complete
   *
   * Lifecycle close via completeFocusSession (same service as MCP
   * synap_complete_session). Returns the proposal pack (pendingProposals,
   * counts, warnings). Does not reimplement close — leave complete-run alone.
   */
  /**
   * GET /focus-sessions/:id/evaluations — criteria, verdict, the CURRENT
   * evaluation per criterion, and the full append-only `history`.
   */
  app.get("/focus-sessions/:id/evaluations", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    try {
      const row = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, id),
          eq(focusSessions.userId, acting.userId)
        ),
      });
      if (!row) return c.json({ error: `Focus session ${id} not found` }, 404);
      const { listSessionEvaluations, summarizeEvaluations } =
        await import("../../../services/focus-sessions/evaluations/record.js");
      const history = await listSessionEvaluations({
        sessionId: id,
        userId: acting.userId,
      });
      return c.json({
        ...summarizeEvaluations(row.criteria, history),
        history,
      });
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.evaluations failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:id/evaluations — run the pending criteria
   * (evidence → capability → judge). Body `{ evidence? }` grades
   * evidence-checked criteria in the same call.
   *
   * POST /focus-sessions/:id/evidence — the agent's deterministic report,
   * `{ evidence: { [evidenceKey]: { passed, detail? } } }`. Grades ONLY the
   * evidence-checked criteria (never spends a judge call or runs a capability).
   *
   * Both return `{ results, criteria, verdict, evaluations, resumed }`.
   */
  for (const [path, onlyEvidence] of [
    ["/focus-sessions/:id/evaluations", false],
    ["/focus-sessions/:id/evidence", true],
  ] as const) {
    app.post(path, async (c) => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
        return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
      }
      const id = c.req.param("id");
      if (!isUuid(id)) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }
      const raw = (await c.req.json().catch(() => ({}))) as unknown;
      const parsed = z
        .object({
          evidence: onlyEvidence
            ? sessionEvidenceSchema
            : sessionEvidenceSchema.optional(),
        })
        .safeParse(raw ?? {});
      if (!parsed.success) {
        return c.json(
          {
            error: parsed.error.issues
              .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
              .join(", "),
          },
          400
        );
      }
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      try {
        const { evaluateSession } =
          await import("../../../services/focus-sessions/evaluations/evaluate.js");
        const result = await evaluateSession({
          sessionId: id,
          userId: acting.userId,
          agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
          evidence: parsed.data.evidence,
          ...(onlyEvidence ? { kinds: ["evidence"] as const } : {}),
        });
        if (result.status === "not_found") {
          return c.json({ error: `Focus session ${id} not found` }, 404);
        }
        return c.json(result);
      } catch (err) {
        logger.error({ err, id }, "focus-sessions.evaluate failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    });
  }

  app.post("/focus-sessions/:id/complete", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const raw = await c.req.json().catch(() => ({}));
    const parsed = CompleteBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) =>
          i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message
        )
        .join(", ");
      return c.json({ error: message }, 400);
    }

    try {
      // Load by id alone — workspace from the ROW (write-gate: never trust body).
      const existing = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, id),
      });
      if (!existing) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }

      // Project-scoped sessions have null workspaceId — resolveActingContext
      // falls back to pod-level owner floor (same as PATCH).
      const acting = await resolveActingContext(c, {
        workspaceId: existing.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const { userId, workspaceId } = acting;

      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const agentUserId = await resolveCaptureActorUserId(c, ctxAgentUserId, {
        workspaceId,
      });

      const result = await completeFocusSession({
        sessionId: id,
        userId,
        agentUserId,
        summary: parsed.data.summary,
        verificationReport: parsed.data.verificationReport,
        terminalStatus: parsed.data.terminalStatus,
      });

      if (!result) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }

      return c.json({
        // The status the ROW holds. A literal here would report a cancel or a
        // failure as a successful close.
        status: result.session.status,
        session: result.session,
        pendingProposals: result.pendingProposals,
        counts: result.counts,
        warnings: result.warnings,
      });
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === "FORBIDDEN") {
        const e = err as {
          message?: string;
          proposalId?: string;
          summary?: string;
          reasoning?: string;
          reviewPath?: string;
          reviewUrl?: string;
        };
        // Proposed shape (consistent with PATCH/create) — 403 when governance
        // still forced a proposal (lifecycle escape should normally prevent this).
        if (e.proposalId) {
          return jsonGoverned(c, {
            status: "proposed" as const,
            message:
              e.message ??
              "Session completion proposed for review — approval required",
            proposalId: e.proposalId,
            summary: e.summary,
            reasoning: e.reasoning,
            reviewPath: e.reviewPath,
            reviewUrl: e.reviewUrl,
            session: null,
          });
        }
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      }
      logger.error({ err, id }, "focus-sessions.complete failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:id/cancel — cancel a session (a run): the ONE close
   * door with `cancelled`. Stops queued jobs and running replies bound to the
   * session and returns the `cancel` record (stopped · notStoppable ·
   * finished), also kept on `metadata.run.cancel`. Governed like `/complete`:
   * an agent's cancel may come back `proposed` (403, nothing stopped yet).
   */
  app.post("/focus-sessions/:id/cancel", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const raw = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof raw?.reason === "string" ? raw.reason : undefined;

    try {
      // OWNER FLOOR on the first read: another user's session and a missing
      // one answer the SAME 404 — this lookup is not an existence oracle. (The
      // close door floors on the owner again; this stops the read itself from
      // telling the two apart.)
      const floorUserId = c.get("userId") as string | undefined;
      const existing = floorUserId
        ? await db.query.focusSessions.findFirst({
            where: and(
              eq(focusSessions.id, id),
              eq(focusSessions.userId, floorUserId)
            ),
          })
        : undefined;
      if (!existing) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }
      const acting = await resolveActingContext(c, {
        workspaceId: existing.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const { userId, workspaceId } = acting;
      const agentUserId = await resolveCaptureActorUserId(
        c,
        c.get("agentUserId") as string | undefined,
        { workspaceId }
      );

      const { cancelSession } =
        await import("../../../services/focus-sessions/cancel-session.js");
      const result = await cancelSession({
        sessionId: id,
        userId,
        agentUserId,
        reason,
      });
      if (!result) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }
      return c.json({
        status: result.session.status,
        session: result.session,
        cancel: result.cancel ?? null,
        alreadyClosed: result.cancel === undefined,
        counts: result.counts,
        warnings: result.warnings,
      });
    } catch (err) {
      const e = err as {
        code?: unknown;
        message?: string;
        proposalId?: string;
        summary?: string;
        reasoning?: string;
        reviewPath?: string;
        reviewUrl?: string;
      };
      if (e.code === "FORBIDDEN" && e.proposalId) {
        return jsonGoverned(c, {
          status: "proposed" as const,
          message: e.message ?? "Session cancel proposed for review",
          proposalId: e.proposalId,
          summary: e.summary,
          reasoning: e.reasoning,
          reviewPath: e.reviewPath,
          reviewUrl: e.reviewUrl,
          session: null,
        });
      }
      if (e.code === "FORBIDDEN") {
        return c.json({ error: e.message ?? "Forbidden" }, 403);
      }
      logger.error({ err, id }, "focus-sessions.cancel failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:id/revert — undo everything a session (a run)
   * applied. Every approved / auto-approved proposal of the session is reverted
   * newest-first through the canonical `proposals.revert` door, and each gets
   * an outcome: reverted · partial · skipped (changed since) · permanent
   * (external side effect) · unsupported · failed. Items the user edited since
   * are left alone and named — never silently deleted.
   *
   * Human review, like `/proposals/:id/revert`: an agent credential is refused.
   */
  app.post("/focus-sessions/:id/revert", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const blocked = rejectAgentReviewer(c, "revert");
    if (blocked) return blocked;

    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const raw = (await c.req.json().catch(() => ({}))) as {
      reason?: unknown;
      proposalIds?: unknown;
    };
    const reason = typeof raw?.reason === "string" ? raw.reason : undefined;
    let proposalIds: string[] | undefined;
    if (raw?.proposalIds !== undefined) {
      const parsedIds = z
        .array(z.string().uuid())
        .min(1)
        .max(500)
        .safeParse(raw.proposalIds);
      if (!parsedIds.success) {
        return c.json(
          { error: "proposalIds must be a non-empty array of proposal UUIDs" },
          400
        );
      }
      proposalIds = parsedIds.data;
    }

    try {
      const userId = c.get("userId") as string;
      const scopes = c.get("scopes") as string[];
      const callerContext = await createHubProtocolCallerContext(
        userId,
        scopes
      );
      const result = await revertSession({
        sessionId: id,
        userId,
        reason,
        proposalIds,
        callerContext,
      });
      if (!result.ok) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }
      return c.json(
        {
          sessionId: result.sessionId,
          proposals: result.proposals,
          counts: result.counts,
        },
        200
      );
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.revert failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /focus-sessions/:id/rerun — a NEW session `spawned_from` this run
   * that re-analyses its stored sources with the current guidelines.
   * Body: `{ mode: "replace"|"add", scope?: { sourceDocumentIds }, dryRun?, reason? }`.
   * Dry-run variant: `?dryRun=true` (or `dryRun: true`) — counts + cap verdict,
   * nothing written. Same service and response body as tRPC
   * `focusSessions.rerun`. Refusals: 404 unknown session · 403 an agent
   * credential asking for `replace` (reverting approved work is human review)
   * · 409 still open / over cap / no stored sources / mint failed.
   */
  app.post("/focus-sessions/:id/rerun", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const parsed = z
      .object({
        mode: z.enum(["replace", "add"]),
        scope: z
          .object({
            sourceDocumentIds: z.array(z.string().uuid()).min(1).max(500),
          })
          .optional(),
        dryRun: z.boolean().optional(),
        reason: z.string().max(2000).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }
    try {
      const userId = c.get("userId") as string;
      const scopes = c.get("scopes") as string[];
      const agentUserId = (c.get("agentUserId") as string | undefined) ?? null;
      const callerContext = await createHubProtocolCallerContext(
        userId,
        scopes,
        null,
        null,
        null,
        agentUserId
      );
      const { rerunSession } =
        await import("../../../services/focus-sessions/rerun-session.js");
      const result = await rerunSession({
        sessionId: id,
        userId,
        mode: parsed.data.mode,
        scope: parsed.data.scope,
        dryRun: parsed.data.dryRun || c.req.query("dryRun") === "true",
        reason: parsed.data.reason,
        agentUserId,
        callerContext,
      });
      if (result.ok) return c.json(result, 200);
      const status =
        result.reason === "not_found"
          ? 404
          : result.reason === "replace_is_a_human_decision"
            ? 403
            : 409;
      return c.json(result, status);
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.rerun failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /focus-sessions/:id/used — record a capability invocation as
   * `session --used--> {tool|skill|command}`. This is PROVENANCE, written at the
   * moment the agent USES a capability (the IS tool-wrapper fires it), so it is
   * auto (not governance-gated) — it asserts what happened, it doesn't mutate
   * user data. Idempotent via the links unique edge. Powers the session room's
   * "Tools & skills" Frame and promoteSessionToPlaybook's capability re-grant.
   */
  app.post("/focus-sessions/:id/used", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = UsedCapabilityBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }
    const { capabilityKind, capabilityId } = parsed.data;
    try {
      // Load by id, bind to the row's workspace (membership check).
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, id),
      });
      if (!session)
        return c.json({ error: `Focus session ${id} not found` }, 404);
      const acting = await resolveActingContext(c, {
        workspaceId: session.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      await createLinks([
        {
          workspaceId: session.workspaceId,
          fromType: "session",
          fromId: session.id,
          toType: capabilityKind,
          toId: capabilityId,
          linkType: "used",
          metadata: { usedAt: new Date().toISOString() },
        },
      ]);
      return c.json({ status: "recorded" as const });
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.used failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:id/channel — MINT the session's room if it has none.
   * Parity door for the tRPC `focusSessions.ensureChannel`.
   *
   * NEVER a second channel writer: the insert, the title derivation and the
   * `focus_sessions.channel_id` write all stay inside `ensureSessionChannel`.
   * Idempotent by construction — an existing `channelId` is returned as-is, so
   * a retry cannot mint two rooms.
   *
   * Ungoverned like `/used`: minting the room a session already implies is
   * provenance plumbing, not a mutation of user data.
   */
  app.post("/focus-sessions/:id/channel", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    try {
      // Load by id, bind to the row's workspace (membership check) — the same
      // two steps `/used` and PATCH take.
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, id),
      });
      if (!session)
        return c.json({ error: `Focus session ${id} not found` }, 404);
      const acting = await resolveActingContext(c, {
        workspaceId: session.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const { ensureSessionChannel } =
        await import("../../../services/focus-sessions/ensure-session-channel.js");
      const channelId = await ensureSessionChannel({
        sessionId: session.id,
        userId: acting.userId,
        workspaceId: session.workspaceId,
        goal: session.goal,
      });
      if (!channelId) {
        return c.json(
          { error: "Could not create a room for this session" },
          500
        );
      }
      return c.json({ channelId });
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.ensureChannel failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:id/outputs
   *
   * Record an EXISTING object as this session's output. Parity door for the
   * tRPC `focusSessions.attachOutput`.
   *
   * FLOOR — WORKSPACE MEMBERSHIP, not the owner floor the tRPC door uses. This
   * is a DELIBERATE asymmetry, kept in parity with `POST .../used` directly
   * above rather than tightened here in passing: this door is walked by an
   * AGENT acting on a session it did not open (the IS records what a run
   * produced), so an owner floor would refuse the ledger write the door exists
   * to make. The tRPC door is the HUMAN surface, where the caller IS the owner
   * and anything else is a cross-user write. Membership is still a real floor —
   * `resolveActingContext` binds to the ROW's workspace, never a body-supplied
   * one — and the ledger row records who produced it either way. Tightening
   * this to an owner floor is a decision about the whole hub session surface
   * (`/used`, PATCH, `/complete-run` all share it), not about this handler.
   *
   * The row's OWNER is still `session.userId`, and the `refId` floor below is
   * evaluated against that owner — so a member cannot use this door to surface
   * an object the session's owner cannot see.
   *
   * Ungoverned, like `POST .../used` directly above: both write a PROVENANCE
   * row about work that already happened, not a domain mutation. Routing this
   * through `checkPermissionOrPropose` would mint a `focus_session/update`
   * proposal no executor re-applies — a silent no-op on approval, which is
   * worse than an honest ungoverned ledger write. Scope + workspace membership
   * are the floor, and the row records WHO produced it either way.
   */
  /**
   * POST /focus-sessions/:id/outputs/delegate
   *
   * The Hub twin of `focusSessions.delegateOutput`. Registered BEFORE the
   * 3-segment `/outputs` route — Hono is first-match, and keeping the more
   * specific path first is the house rule even where the segment counts differ.
   *
   * OWNER-FLOORED, identically to the tRPC door: the service takes the acting
   * user as the floor, so a caller who is not the session's owner gets 404 (the
   * "missing" and "not yours" cases stay indistinguishable). Deliberately
   * TIGHTER than the sibling `/outputs` route's membership floor — delegating
   * spends an agent turn and speaks in someone's room, which is not a thing a
   * co-member of the workspace should be able to do to another person's session.
   */
  app.post("/focus-sessions/:id/outputs/delegate", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = DelegateOutputBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }
    try {
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, id),
      });
      if (!session) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }
      const acting = await resolveActingContext(c, {
        workspaceId: session.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const result = await delegateExpectedOutput({
        sessionId: session.id,
        userId: acting.userId,
        expectedLabel: parsed.data.expectedLabel,
        agentType: parsed.data.agentType,
      });
      switch (result.status) {
        case "not_found":
          return c.json({ error: `Focus session ${id} not found` }, 404);
        case "unknown_label":
          return c.json(
            {
              error: `This session declares no output labelled "${parsed.data.expectedLabel}"`,
            },
            404
          );
        case "already_done":
          return c.json(
            { error: `"${parsed.data.expectedLabel}" is already delivered` },
            400
          );
        case "no_channel":
          return c.json(
            { error: "Could not open a room for this session" },
            500
          );
        default:
          return c.json({
            ok: true as const,
            expectedLabel: result.expectedLabel,
            kind: result.kind,
            agentType: result.agentType,
            channelId: result.channelId,
            messageId: result.messageId,
            triggered: result.triggered,
            agentAttached: result.agentAttached,
          });
      }
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.delegateOutput failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:id/outputs/block
   * POST /focus-sessions/:id/outputs/unblock
   *
   * The Hub twins of `focusSessions.blockOutput` / `.unblockOutput`. Registered
   * BEFORE the 3-segment `/outputs` route for the same first-match reason the
   * delegate route is. OWNER-FLOORED identically: the service takes the acting
   * user as the floor, so a co-member of the workspace gets 404 rather than the
   * ability to re-own someone else's slot.
   */
  const slotOwnershipRoute = (
    path: "block" | "unblock",
    run: (args: {
      sessionId: string;
      userId: string;
      body: unknown;
    }) => Promise<BlockExpectedOutputResult>,
    schema: typeof BlockOutputBodySchema | typeof UnblockOutputBodySchema
  ) => {
    app.post(`/focus-sessions/:id/outputs/${path}`, async (c) => {
      if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
        return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
      }
      const id = c.req.param("id");
      if (!isUuid(id)) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid request body", details: parsed.error.flatten() },
          400
        );
      }
      try {
        const session = await db.query.focusSessions.findFirst({
          where: eq(focusSessions.id, id),
        });
        if (!session) {
          return c.json({ error: `Focus session ${id} not found` }, 404);
        }
        const acting = await resolveActingContext(c, {
          workspaceId: session.workspaceId ?? undefined,
        });
        if (!acting.ok) return c.json({ error: acting.error }, acting.status);

        const result = await run({
          sessionId: session.id,
          userId: acting.userId,
          body: parsed.data,
        });
        switch (result.status) {
          case "not_found":
            return c.json({ error: `Focus session ${id} not found` }, 404);
          case "unknown_label":
            return c.json(
              {
                error: `This session declares no output labelled "${parsed.data.expectedLabel}"`,
              },
              404
            );
          case "already_done":
            return c.json(
              {
                error: `"${parsed.data.expectedLabel}" is already delivered`,
              },
              400
            );
          case "ref_unreachable":
            // Named, never defaulted: the `default` below is the SUCCESS arm,
            // so an unhandled refusal would answer 200 with no label at all.
            return c.json({ error: result.reason }, 400);
          default:
            return c.json({
              ok: true as const,
              expectedLabel: result.expectedLabel,
              kind: result.kind,
              ...(result.blockGuidelines
                ? { blockGuidelines: result.blockGuidelines }
                : {}),
            });
        }
      } catch (err) {
        logger.error({ err, id }, `focus-sessions.${path}Output failed`);
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    });
  };

  slotOwnershipRoute(
    "block",
    ({ sessionId, userId, body }) =>
      blockExpectedOutput({
        sessionId,
        userId,
        ...(body as z.infer<typeof BlockOutputBodySchema>),
      }),
    BlockOutputBodySchema
  );

  slotOwnershipRoute(
    "unblock",
    ({ sessionId, userId, body }) =>
      unblockExpectedOutput({
        sessionId,
        userId,
        ...(body as z.infer<typeof UnblockOutputBodySchema>),
      }),
    UnblockOutputBodySchema
  );

  app.post("/focus-sessions/:id/outputs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = c.req.param("id");
    if (!isUuid(id)) {
      return c.json({ error: `Focus session ${id} not found` }, 404);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = AttachOutputBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }
    const {
      kind,
      refId,
      label,
      expectedLabel,
      workspaceId: fallbackWorkspaceId,
    } = parsed.data;
    try {
      // Load by id, bind to the row's workspace (membership check) — the same
      // two steps `/used` and the PATCH door take.
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, id),
      });
      if (!session) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }
      const acting = await resolveActingContext(c, {
        workspaceId: session.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      // MEMBERSHIP FLOOR on the FALLBACK lens. `resolveActingContext` above
      // membership-checks the SESSION's workspace, but the body's
      // `workspaceId` is bare request input and was never checked: a caller
      // could file the row into a workspace they do not belong to, and the
      // `artifacts` visibility rule (workspace rows follow membership) would
      // hand it to that workspace's members. Gated on the ACTING user.
      if (!session.workspaceId && fallbackWorkspaceId) {
        try {
          await assertWorkspaceWrite(db, acting.userId, {
            workspaceId: fallbackWorkspaceId,
          });
        } catch {
          return c.json(
            { error: "You are not a member of this resource's workspace." },
            403
          );
        }
      }

      // The object the output POINTS AT must already be visible to the SESSION
      // OWNER — otherwise attaching it and re-reading the room leaks its live
      // title. Same floor, same reason, as the tRPC door.
      const refVisible = await isOutputRefVisible({
        userId: session.userId,
        kind,
        refId,
      });
      if (!refVisible) {
        return c.json({ error: `No ${kind} ${refId} you can access` }, 404);
      }

      const outputId = await recordSessionArtifact({
        sessionId: session.id,
        // A pod-personal session files a pod-personal output; the body's
        // `workspaceId` is only a fallback for a session with no lens.
        workspaceId: session.workspaceId ?? fallbackWorkspaceId ?? null,
        // Owner of the ledger row is the session's owner, even when an agent
        // acted — the same rule `recordSessionArtifact` documents.
        userId: session.userId,
        kind,
        refId,
        title: label ?? refId,
        expectedLabel,
        agentUserId: c.get("agentUserId") as string | undefined,
      });
      if (!outputId) {
        return c.json({ error: "Could not record the session output" }, 500);
      }
      return c.json({ ok: true as const, outputId });
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.outputs failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:sessionId/complete-run
   *
   * Fire-and-forget provenance: when an IS agent finishes working on a
   * session-scoped channel, it calls this to close any running playbook_run
   * for that session. Best-effort — if there's no running run, that's fine.
   */
  app.post("/focus-sessions/:sessionId/complete-run", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const sessionId = c.req.param("sessionId");
    if (!isUuid(sessionId)) {
      return c.json({ error: `Focus session ${sessionId} not found` }, 404);
    }

    try {
      // Load the session to resolve the acting context (membership check).
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, sessionId),
      });
      if (!session) {
        return c.json({ error: `Focus session ${sessionId} not found` }, 404);
      }

      const acting = await resolveActingContext(c, {
        workspaceId: session.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      // Find the running playbook_run for this session.
      const [run] = await db
        .select()
        .from(playbookRuns)
        .where(
          and(
            eq(playbookRuns.sessionId, sessionId),
            eq(playbookRuns.status, "running")
          )
        )
        .limit(1);

      if (!run) {
        return c.json({ status: "no-running-run" as const });
      }

      // Mark as completed.
      await db
        .update(playbookRuns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(playbookRuns.id, run.id));

      return c.json({ status: "completed" as const });
    } catch (err) {
      logger.error({ err, sessionId }, "focus-sessions.complete-run failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
