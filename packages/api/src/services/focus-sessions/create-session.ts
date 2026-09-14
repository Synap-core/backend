/**
 * createFocusSession — shared service behind both Hub REST and MCP adapter.
 *
 * Creates a focus session (goal-bound work session) with governance gating.
 * Idempotent by correlationId. Emits realtime events for browser mirroring.
 */
import {
  db,
  focusSessions,
  playbooks,
  playbookRuns,
  eq,
  and,
  recordSessionSpawn,
  resolveSessionProjectPlacement,
} from "@synap/database";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import { randomUUID } from "node:crypto";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";
import { ensureSessionChannel } from "./ensure-session-channel.js";
import { createLogger } from "@synap-core/core";
import type { ExpectedOutput } from "@synap/playbooks";
import { sanitizeDeclaredOutputs } from "./update-session.js";
import {
  guidanceForBlockedSlots,
  newlyBlockedSlots,
  type BlockGuidance,
} from "./block-guidelines.js";
// STATIC — see the note on the same import in `update-session.ts`: there is no
// cycle here, the `await import()` this replaces stated no reason, and
// `block-output.ts` has always imported this module statically.
import {
  findUnreachableOutputRefs,
  unreachableOutputRefError,
} from "./assert-output-ref-visible.js";
import {
  addCreateTimeBlockers,
  type CreateTimeBlockerReport,
} from "./session-blocked-by.js";
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX,
} from "@synap-core/types/focus-sessions";

const logger = createLogger({ module: "focus-sessions/create-session" });

/** RFC-4122 UUID shape — templateId may be a legacy free-text template name. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The key of a playbook's first stage, or null for a stageless playbook.
 * Stages are stored as JSONB, so this stays defensive about shape rather than
 * trusting the row to be well-formed.
 */
export function firstStageKey(stages: unknown): string | null {
  if (!Array.isArray(stages) || stages.length === 0) return null;
  const first = stages[0] as { key?: unknown } | null;
  const key = first && typeof first === "object" ? first.key : undefined;
  return typeof key === "string" && key.length > 0 ? key : null;
}

export interface CreateFocusSessionParams {
  userId: string;
  /**
   * Workspace the session belongs to. Optional — a session may instead be
   * anchored to a project or live on the user floor. When null/undefined the governance membrane
   * treats it as a personal resource and auto-grants (no membership needed).
   */
  workspaceId?: string | null;
  projectId?: string | null;
  /**
   * The entity this session is "about" — the subject-spine anchor. Written on
   * the ad-hoc start path so a session can be tied to a person/company/deal.
   */
  subjectEntityId?: string | null;
  /**
   * Short optional one-line NAME, separate from `goal` (the outcome). Blank ⇒
   * null (untitled; surfaces show the goal's first line via
   * `resolveSessionTitle`). Longer than `SESSION_TITLE_MAX` is refused.
   */
  title?: string | null;
  goal: string;
  agentUserId?: string;
  correlationId?: string;
  channelId?: string | null;
  agentIds?: string[];
  templateId?: string | null;
  /**
   * Declared deliverables. The SHARED type, not an inline copy — the four-field
   * inline shape that used to sit here quietly narrowed what this door believed
   * a slot was, so a slot's delegation, its return note and (now) its
   * blocked-on-human declaration were invisible to the create path.
   */
  expectedOutputs?: ExpectedOutput[];
  /**
   * The PARENT of this session — a child is either a detour or a planned
   * sub-session; both are the ONE edge `session --spawned_from--> session`
   * (never a column: see `schema/links.ts`). The parent stays open and lists its
   * children; closing either never closes the other. The parent must belong to
   * the same user; an unowned or unknown parent does not fail the create, and
   * the miss is REPORTED on the result as `parentLink` — never a silent drop.
   *
   * The child NEVER inherits the parent's `metadata` — least of all
   * `metadata.governance`, which `deriveSessionForceProposeGovernance` reads to
   * force-propose every AI write in the session.
   */
  parentSessionId?: string | null;
  /**
   * "What were you about to do" — one line captured at SUSPENSION and written
   * onto the PARENT's `metadata.suspended`, so popping back restates the goal.
   * Only meaningful together with `parentSessionId`.
   */
  suspendedIntent?: string | null;
  /**
   * Sessions this one is BLOCKED BY, declared at birth. Each becomes a
   * `session --blocked_by--> session` edge through `addCreateTimeBlockers` (the
   * same validate + write door as `POST /links`), after the row exists; each
   * outcome is reported per id on `blockerLinks`. On the PROPOSED path they ride
   * the proposal and are written at approval.
   */
  blockedBySessionIds?: string[];
}

/** What happened to the create-time `spawned_from` edge. */
export type CreateTimeParentLink =
  | {
      status: "linked";
      parentSessionId: string;
      suspendedIntentRecorded: boolean;
    }
  | {
      status: "failed";
      parentSessionId: string;
      reason: "parent_not_found" | "self_parent" | "error";
      message?: string;
    };

export type CreateFocusSessionResult =
  | {
      status: "created";
      session: typeof focusSessions.$inferSelect;
      /** Guidelines for any slot declared already blocked on the human. */
      blockGuidelines?: BlockGuidance;
      /** Present iff a `parentSessionId` was given. */
      parentLink?: CreateTimeParentLink;
      /** Present iff `blockedBySessionIds` was non-empty — one entry per id. */
      blockerLinks?: CreateTimeBlockerReport[];
    }
  | {
      status: "proposed";
      proposalId: string;
      /**
       * Which proposed outcome this is: a CONTENT proposal, or a workspace-JOIN
       * gate filed INSTEAD of the write. Callers derive their sentence from it
       * (`proposedMessageFor`); without it on the TYPE the value cannot cross
       * this boundary and the door has to hardcode a claim it cannot check.
       */
      proposalType?: string;
      message: string;
      summary?: string;
      reasoning?: string;
      reviewPath?: string;
      reviewUrl?: string;
    };

export async function createFocusSession(
  params: CreateFocusSessionParams
): Promise<CreateFocusSessionResult> {
  const {
    userId,
    workspaceId = null,
    projectId: explicitProjectId = null,
    subjectEntityId = null,
    title: rawTitle = null,
    goal,
    agentUserId,
    correlationId,
    channelId = null,
    agentIds = [],
    templateId = null,
    expectedOutputs = [],
    parentSessionId = null,
    suspendedIntent = null,
    blockedBySessionIds = [],
  } = params;

  // Refused, never truncated: a clipped name is a claim the caller did not make.
  const title = normalizeSessionTitle(rawTitle);
  if (title && title.length > SESSION_TITLE_MAX) {
    throw Object.assign(
      new Error(
        `title must be at most ${SESSION_TITLE_MAX} characters — ONE line naming the session; put the outcome in goal.`
      ),
      { code: "BAD_REQUEST" }
    );
  }

  // Idempotency: correlationId returns the existing session for this user,
  // scoped to the same workspace when one is given.
  if (correlationId) {
    const existing = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.correlationId, correlationId),
        eq(focusSessions.userId, userId),
        ...(workspaceId ? [eq(focusSessions.workspaceId, workspaceId)] : [])
      ),
    });
    if (existing) return { status: "created", session: existing };
  }

  // PROJECT LENS — derived from the context this door already holds, rather
  // than waited for. Before this, `projectId` was whatever the caller passed and
  // essentially nobody passed one (measured: 10% of sessions). The ladder's
  // rung 1 is the caller's own pin, so an explicit project is byte-identical to
  // before; the widening is only over the callers that supplied nothing.
  //
  // Placed BEFORE the governance membrane so the derived lens is the one stamped
  // on the proposal's provenance too. `projectId` is PROVENANCE in
  // `checkPermissionOrPropose` (it is folded into the WriteEnvelope and never
  // read by an access decision), so deriving it here cannot widen a permission.
  //
  // `NONE` → null. No AI rung, no "the only project" fallback.
  const projectId = (
    await resolveSessionProjectPlacement(db, {
      userId,
      explicitProjectId,
      parentSessionId,
      channelId,
      subjectEntityId,
    })
  ).projectId;

  // VISIBILITY FLOOR for any `ref` a declared slot carries — the SAME
  // `isOutputRefVisible` the attach-output and update doors apply, and BEFORE
  // the membrane so a ref the caller cannot see is refused to the caller who
  // wrote it rather than laundered into the human's proposal queue.
  //
  // Thrown as FORBIDDEN rather than returned: this result type has no refusal
  // member, and the door beside it (`perm.denied`) already refuses this way.
  if (expectedOutputs.length > 0) {
    const unreachable = await findUnreachableOutputRefs({
      userId,
      outputs: expectedOutputs,
    });
    if (unreachable.length > 0) {
      throw Object.assign(new Error(unreachableOutputRefError(unreachable)), {
        code: "FORBIDDEN",
      });
    }
  }

  // Governance membrane — AI callers route through proposals. A session with no
  // workspace is a personal resource and auto-grants via checkPermissionOrPropose.
  // The session's id is minted ONCE, here, and travels as `data.id`: the
  // auto-approve receipt stamps it as its targetId and the PROPOSED path makes
  // it the prospective id the executor inserts at. Left to the column default,
  // the receipt minted its own random id that no row ever had (live receipt
  // 91191f04, 2026-09-14). The dedup hash strips `id`, so retries still dedup.
  const sessionId = randomUUID();
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: workspaceId ?? undefined,
    projectId: projectId ?? undefined,
    subjectType: "focus_session",
    action: "create",
    source: "intelligence",
    // Carry the non-goal fields through the proposal so the approve executor
    // (proposals/approve-executors.ts, focus_session/create) can materialize a
    // full session — otherwise they'd be lost on the PROPOSED path. Only include
    // when present to keep the persisted data lean.
    data: {
      id: sessionId,
      goal,
      // Also the proposal's display name (`extractProposalName` reads `title`).
      ...(title ? { title } : {}),
      templateId,
      ...(subjectEntityId ? { subjectEntityId } : {}),
      ...(channelId ? { channelId } : {}),
      // Sanitized BEFORE it is proposed, so the payload a human reviews is the
      // one that will be written — a proposal showing `attestedBy: "Antoine"`
      // is asking someone to approve a claim about themselves. The executor
      // floors it again at the write, because these two moments are weeks apart
      // and only the second one is the door.
      ...(expectedOutputs.length > 0
        ? { expectedOutputs: sanitizeDeclaredOutputs(expectedOutputs) }
        : {}),
      ...(agentIds.length > 0 ? { agentIds } : {}),
      // Detour lineage must survive the PROPOSED path too, or an agent-opened
      // detour silently loses its parent on approval (the plumbed-field-with-
      // no-producer shape this whole slice exists to retire). Applied by
      // `proposals/executors/focus-session.ts` after the row is inserted.
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(suspendedIntent ? { suspendedIntent } : {}),
      // Same reason: written at approval through `addCreateTimeBlockers`.
      ...(blockedBySessionIds.length > 0 ? { blockedBySessionIds } : {}),
    },
  });

  if ("denied" in perm && perm.denied) {
    throw Object.assign(new Error(perm.reason), { code: "FORBIDDEN" });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      proposalType: perm.proposalType,
      message: proposedMessageFor(
        perm.proposalType,
        "Focus session creation proposed for review"
      ),
      summary: perm.summary,
      reasoning: perm.reasoning,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }

  // If `templateId` is a real Playbook id, this session IS a playbook run: wire
  // the canonical `playbookId` + a `playbook_runs` ledger row so it surfaces in
  // the runs feed. Writing ONLY the deprecated `templateId` (legacy behavior, kept
  // below for compat) produced disconnected "ghost" sessions that ran forever with
  // no ledger row. A non-UUID / free-text templateId resolves to no playbook →
  // unchanged legacy behavior. (Guard the UUID first — comparing a uuid column to
  // free text throws in Postgres.)
  const playbook =
    templateId && UUID_RE.test(templateId)
      ? ((await db.query.playbooks.findFirst({
          where: eq(playbooks.id, templateId),
        })) ?? null)
      : null;

  // Session + its playbook_runs ledger row land in ONE transaction: the
  // correlationId idempotency check returns the existing session on retry, so
  // a partial state (session without its run row) could never be repaired.
  const created = await db.transaction(async (tx) => {
    const [session] = await tx
      .insert(focusSessions)
      .values({
        id: sessionId,
        workspaceId,
        projectId,
        subjectEntityId,
        userId,
        title,
        goal,
        correlationId: correlationId ?? null,
        templateId,
        playbookId: playbook?.id ?? null,
        // Typed origin (migration 0240) — stamped from what this door already
        // resolved, never re-sniffed from metadata. A session created here is a
        // playbook run exactly when `templateId` resolved to a real playbook;
        // automation-origin sessions never come through here, they come through
        // `openRunSession`. Readers prefer this column and fall back to the
        // legacy metadata sniff only for rows a non-stamping writer produced.
        //
        // Otherwise the discriminator is `agentUserId` — the SAME fact the
        // governance membrane above already used to decide whether this write
        // needs a proposal. An agent identity means an agent opened the session
        // ("agent"); its absence means a person did ("human"). Until "human"
        // existed every human-started session was stamped "agent", so the
        // triage lens (which exists to surface sessions somebody else opened
        // for you) could not tell an agent's session from your own.
        origin: playbook ? "playbook" : agentUserId ? "agent" : "human",
        // `focus_sessions.current_stage` is documented as "seeded from the
        // playbook's first stage on instantiation" — but this door only ever
        // wired playbookId, so a session started from a staged playbook opened
        // with a NULL stage and every stage-aware surface read it as stageless.
        // Seed it here so the column matches its contract from birth; stageless
        // playbooks (stages: []) correctly stay NULL.
        currentStage: firstStageKey(playbook?.stages),
        // `owedSince` is present IFF `owner === 'human'`, and that invariant has
        // to hold from BIRTH: a session created with an already-blocked slot
        // would otherwise carry the human's ownership with no clock, and the
        // owed feed has nothing to order or age it by.
        //
        // The SAME door the merge uses, never a second answer here — and it is
        // the whole write-authority floor, not just the clock. This was
        // `reconcileOwedSince` alone, which meant a caller could declare a slot
        // already carrying `attestedBy` (a forged human confirmation) or
        // `retiredAt` (born invisible to the owed board). The update door had
        // refused both for as long as the floor existed; this one had not.
        expectedOutputs: sanitizeDeclaredOutputs(expectedOutputs),
        channelId,
        agentIds,
        status: "active",
      })
      .returning();

    // The playbook_runs ledger row (status "running") so the runs feed sees the
    // session. Mirrors run-playbook.ts's executeSingleRun insert (executor +
    // definition snapshot), minus the executor dispatch — starting a session is
    // "I'm working on this playbook", not a full executor run.
    if (playbook) {
      await tx.insert(playbookRuns).values({
        workspaceId,
        playbookId: playbook.id,
        sessionId: session.id,
        executor: playbook.executor,
        status: "running",
        createdBy: agentUserId ?? userId,
        definitionSnapshot: {
          version: playbook.version,
          goalTemplate: playbook.goalTemplate,
          stages: playbook.stages,
          params: playbook.params,
          expectedOutputs: playbook.expectedOutputs,
        },
      });
    }
    return session;
  });

  // Gate 2: always mint a work channel when the caller did not supply one
  // (parity with runPlaybook). Re-load so the returned row includes channelId.
  let sessionOut = created;
  if (!created.channelId) {
    const channelId = await ensureSessionChannel({
      sessionId: created.id,
      userId,
      workspaceId: created.workspaceId,
      goal: created.goal,
    });
    if (channelId) {
      const reloaded = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, created.id),
      });
      if (reloaded) sessionOut = reloaded;
    }
  }

  // Parent lineage: `child --spawned_from--> parent` (+ the suspend note on the
  // parent). AFTER the session exists, and never inside the transaction — a bad
  // parent handle must not roll back a legitimate session. The producer owns the
  // owner floor and the "never inherit governance" invariant.
  // Best-effort by CONTRACT, not by luck: the session row is already committed,
  // so anything thrown here would hand the caller a 500 over a session that
  // exists. But best-effort is not SILENT: both the producer's expected misses
  // and the unexpected throws land on `parentLink`, so a caller who asked for a
  // parent is told whether it got one.
  let parentLink: CreateTimeParentLink | undefined;
  if (parentSessionId) {
    try {
      const spawn = await recordSessionSpawn({
        childSessionId: sessionOut.id,
        parentSessionId,
        userId,
        workspaceId: sessionOut.workspaceId,
        suspendedIntent,
      });
      parentLink = spawn.linked
        ? {
            status: "linked",
            parentSessionId,
            suspendedIntentRecorded: spawn.suspendedIntentRecorded,
          }
        : { status: "failed", parentSessionId, reason: spawn.reason };
    } catch (err) {
      logger.warn(
        { err, sessionId: sessionOut.id, parentSessionId },
        "recordSessionSpawn failed — session kept, spawned_from edge not written"
      );
      parentLink = {
        status: "failed",
        parentSessionId,
        reason: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Create-time blockers, after the row exists, each reported per id. The
  // governance judgement for an agent caller is the helper's (same as POST /links).
  const blockerLinks =
    blockedBySessionIds.length > 0
      ? await addCreateTimeBlockers({
          sessionId: sessionOut.id,
          blockerSessionIds: blockedBySessionIds,
          userId,
          agentUserId,
        })
      : undefined;

  emitHubRealtimeEvent({
    eventType: "focus_session.create.completed",
    subjectId: sessionOut.id,
    userId,
    data: {
      id: sessionOut.id,
      workspaceId: sessionOut.workspaceId,
      status: sessionOut.status,
      goal: sessionOut.goal,
      progress: sessionOut.progress,
    },
  });

  // A slot can be born blocked; the same safety net as every other block door.
  const blockGuidelines = await guidanceForBlockedSlots({
    userId,
    workspaceId: sessionOut.workspaceId ?? null,
    slots: newlyBlockedSlots(
      [],
      sessionOut.expectedOutputs as ExpectedOutput[] | null
    ),
  });

  return {
    status: "created",
    session: sessionOut,
    ...(blockGuidelines ? { blockGuidelines } : {}),
    ...(parentLink ? { parentLink } : {}),
    ...(blockerLinks ? { blockerLinks } : {}),
  };
}
