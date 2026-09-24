/**
 * Playbook STAGE GATES — pausing a run at a stage boundary for a human.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * A playbook stage may declare `gate: { kind: "human" }`. When a run advances
 * INTO that stage, the session is set to `paused` and a proposal is filed. The
 * stage STANDS — `currentStage` is already the gated stage, the run really is
 * there — it is simply not running until a person answers. On approval the
 * executor flips the session back to `active`.
 *
 * ── Why a pause, not a veto ─────────────────────────────────────────────────
 * The gate does not block the stage write. Blocking would mean the advance had
 * to be replayed on approval, and the advance is not a pure value: the same
 * update call can carry a goal change, a progress number and an outputs
 * mutation. Re-running it later, against a row that has since moved, is how a
 * "resume" quietly reapplies stale data. Pausing after the fact keeps the write
 * exactly once and makes the approval a one-field state change.
 *
 * Rejecting the gate therefore leaves the session PAUSED, not rewound. There is
 * no honest rewind: nothing records what the previous stage's state was.
 *
 * ── The load-bearing rule: APPROVAL RESUMES, IT NEVER RUNS ──────────────────
 * Same rule as the dev-loop gates (`services/proposals/dev-approval.ts`): the
 * executor stamps the session and stops. It does not invoke the stage's grants,
 * does not dispatch the stage's tasks, does not call an agent. The agent
 * watching the session sees `active` and acts under its own credentials.
 */

import { z } from "zod";
import {
  db,
  focusSessions,
  playbooks,
  playbookRuns,
  eq,
  and,
  desc,
  drizzleSql,
} from "@synap/database";
import {
  resolveStageGate,
  stageGateProposalType,
  type PlaybookStage,
  type PlaybookStageGate,
} from "@synap/playbooks";
import {
  CHECK_GATE_METADATA_KEY,
  CHECK_GATE_UNEVALUATED,
} from "@synap-core/types/focus-sessions";
import { createEventBackedProposal } from "../../utils/event-backed-proposal.js";
import { trackRepository } from "../tracks/track-repo.js";

/** A stage gate's proposal targets the SESSION — see dev-approval's target type. */
export const STAGE_GATE_TARGET_TYPE = "focus_session";
/** A TRACK's stage gate (0272) targets the track — executor `track/playbook.stage_gate`. */
export const TRACK_STAGE_GATE_TARGET_TYPE = "track";

/**
 * The proposal `data` payload. Validated at the door for the same reason the
 * dev approvals are: the generic proposal door takes `Record<string, unknown>`
 * and checks nothing, so a producer that misspells `stageKey` files a gate whose
 * review body renders empty and whose executor resumes a session it cannot name.
 */
export const StageGatePayloadSchema = z
  .object({
    /**
     * The gated SUBJECT — exactly one of these two. A session gate names its
     * session (every gate filed before tracks existed); a track gate (0272) names
     * its track. The refine below makes "neither" and "both" a validation error
     * rather than a proposal whose executor resumes nothing.
     */
    sessionId: z.string().uuid().optional(),
    trackId: z.string().uuid().optional(),
    stageKey: z.string().min(1).max(120),
    stageName: z.string().min(1).max(200),
    /** The stage's own goal, when it declares one — what the reviewer is signing off. */
    stageGoal: z.string().max(5000).optional(),
    playbookId: z.string().uuid().optional(),
    /** The `playbook_runs` row this session is executing, when there is one. */
    playbookRunId: z.string().uuid().optional(),
    fromStage: z.string().max(120).nullable().optional(),
  })
  .refine((p) => !!p.sessionId !== !!p.trackId, {
    message: "A stage gate names exactly one subject: sessionId or trackId",
  });
export type StageGatePayload = z.infer<typeof StageGatePayloadSchema>;

/** One-line human summary — what the push notification and the feed row say. */
export function summarizeStageGate(payload: StageGatePayload): string {
  return `Approve entry into "${payload.stageName}"`;
}

/**
 * Find a stage by key in a stage list read out of jsonb.
 *
 * Takes `unknown[]` because both sources (a playbook row's `stages` and a run's
 * frozen `definitionSnapshot.stages`) are untyped bags.
 */
export function findStage(
  stages: unknown,
  stageKey: string
): PlaybookStage | undefined {
  if (!Array.isArray(stages)) return undefined;
  return stages.find(
    (s) =>
      s && typeof s === "object" && (s as { key?: unknown }).key === stageKey
  ) as PlaybookStage | undefined;
}

export interface StageGateLookup {
  stage: PlaybookStage;
  gate: PlaybookStageGate;
}

/**
 * Does advancing into `stageKey` hit a human gate? Returns the stage and its
 * resolved gate, or null when the stage is ungated, unknown, or the session is
 * not running a playbook at all.
 *
 * Source precedence: the RUN's frozen `definitionSnapshot` first, the playbook
 * row second. A run executes the definition it started with — reading the live
 * playbook would let an edit made mid-run add or remove a gate under a run that
 * never agreed to it.
 */
export async function resolveStageGateForSession(params: {
  sessionId: string;
  playbookId: string | null | undefined;
  stageKey: string;
}): Promise<(StageGateLookup & { playbookRunId?: string }) | null> {
  const { sessionId, playbookId, stageKey } = params;

  const [run] = await db
    .select({
      id: playbookRuns.id,
      definitionSnapshot: playbookRuns.definitionSnapshot,
    })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, sessionId),
        eq(playbookRuns.status, "running")
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);

  const snapshotStages = (
    run?.definitionSnapshot as { stages?: unknown } | null
  )?.stages;
  let stage = findStage(snapshotStages, stageKey);

  if (!stage && playbookId) {
    const [row] = await db
      .select({ stages: playbooks.stages })
      .from(playbooks)
      .where(eq(playbooks.id, playbookId))
      .limit(1);
    stage = findStage(row?.stages, stageKey);
  }
  if (!stage) return null;

  const gate = resolveStageGate(stage);
  if (!gate) return null;

  return { stage, gate, ...(run?.id ? { playbookRunId: run.id } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CORE — one gate evaluation, whatever advanced.
//
// A stage can be advanced on a SESSION (`advanceSessionStage`) or on a TRACK
// (`advanceTrackStage`, services/tracks). The gate rules — resolve the stage,
// read its gate, a human gate pauses + files, a check gate evaluates the stage
// being LEFT and pauses only on a miss, unmeasured is never passed — live ONCE,
// in `applyStageGate`. What differs per subject is only WHERE the stage
// definition comes from, WHICH row pauses, HOW the left stage is measured and
// WHAT the proposal targets. That is the `StageGateSubject` adapter, and it is
// all an adapter may decide.
// ─────────────────────────────────────────────────────────────────────────────

/** What differs between gating a session and gating a track. Nothing else may. */
export interface StageGateSubject {
  kind: "session" | "track";
  id: string;
  /** Resolve the stage entered, from the definition this subject is judged by. */
  resolveStage(
    stageKey: string
  ): Promise<{ stage: PlaybookStage; playbookRunId?: string } | null>;
  /**
   * Flip the subject `active → paused`, guarded on `active` in the WHERE clause
   * so a subject a human already paused (or that closed mid-advance) is never
   * dragged back. `metadataPatch` is merged into the row's metadata. Returns
   * whether a row actually flipped — what the UPDATE returned, never "reached
   * this line".
   */
  pause(metadataPatch?: Record<string, unknown>): Promise<boolean>;
  /**
   * A check gate: the keys of the LEFT stage's required criteria that do not
   * pass. An evaluation that could not run answers `[CHECK_GATE_UNEVALUATED]` —
   * unmeasured is not passed.
   */
  checkFailing(fromStage: string): Promise<string[]>;
  /** Where the human-gate proposal points. */
  proposal: {
    targetType: string;
    workspaceId: string | null;
    projectId: string | null;
    channelId: string | null;
    /** The session the proposal is filed under, when the subject is one. */
    sessionId: string | null;
    playbookId: string | null;
  };
}

export interface StageGateAdvance {
  /** Owner of the subject — the human who reviews. */
  userId: string;
  /** Set when an AGENT key drove the advance, so provenance sees it. */
  agentUserId?: string | null;
  toStage: string;
  fromStage?: string | null;
}

export interface OpenStageGateResult {
  proposalId: string;
  proposalType: string;
  stageKey: string;
  /** True when the subject row was actually flipped to `paused` by this call. */
  paused: boolean;
}

export interface CheckGateResult {
  kind: "check";
  stageKey: string;
  /** True when every required criterion of the stage being left passes. */
  passed: boolean;
  /** Keys of the left stage's required criteria that do not pass (yet). */
  failing: string[];
  /** True only when the subject row was actually flipped to `paused`. */
  paused: boolean;
}

export type StageGateOutcome =
  ({ kind: "human" } & OpenStageGateResult) | CheckGateResult | null;

/**
 * Pause the subject and file the gate proposal. Call this AFTER the stage write
 * has landed — the stage stands and the pause describes it. HUMAN gates only.
 */
async function openStageGate(
  subject: StageGateSubject,
  input: StageGateAdvance,
  stage: PlaybookStage,
  gate: PlaybookStageGate,
  playbookRunId: string | null
): Promise<OpenStageGateResult> {
  const proposalType = stageGateProposalType(gate);

  const payload = StageGatePayloadSchema.parse({
    ...(subject.kind === "session"
      ? { sessionId: subject.id }
      : { trackId: subject.id }),
    stageKey: stage.key,
    stageName: stage.name,
    ...(stage.goal ? { stageGoal: stage.goal } : {}),
    ...(subject.proposal.playbookId
      ? { playbookId: subject.proposal.playbookId }
      : {}),
    ...(playbookRunId ? { playbookRunId } : {}),
    fromStage: input.fromStage ?? null,
  });

  const paused = await subject.pause();
  const summary = summarizeStageGate(payload);

  const { proposal } = await createEventBackedProposal({
    userId: input.userId,
    workspaceId: subject.proposal.workspaceId,
    projectId: subject.proposal.projectId,
    targetType: subject.proposal.targetType,
    // The SUBJECT is the target: it is what pauses, what the executor stamps,
    // and what a reviewer opens from the proposal.
    targetId: subject.id,
    proposalType,
    action: "stage_gate",
    source: "intelligence",
    summary,
    agentUserId: input.agentUserId ?? null,
    createdBy: input.agentUserId ?? input.userId,
    threadId: subject.proposal.channelId,
    sessionId: subject.proposal.sessionId,
    data: {
      ...payload,
      // What `derivePresentation` branches on in the clients — without it a
      // `focus_session` target with no `goal` renders a blank session card.
      changeType: "stage_gate",
      source: "agent",
      sourceId: input.agentUserId ?? input.userId,
      summary,
    },
  });

  return {
    proposalId: proposal.id,
    proposalType,
    stageKey: stage.key,
    paused,
  };
}

/**
 * A `check` gate: evaluate the criteria of the stage being LEFT; all required
 * passing ⇒ the subject continues; otherwise PAUSE (same guard as the human
 * gate) and record `metadata.checkGate = { stageKey, fromStage, failing }` so
 * the failing criteria are visible. No proposal: the resume is re-running the
 * evaluation (or a human grade).
 *
 * A stage entered with no stage behind it has nothing to check and passes.
 */
async function applyCheckGate(
  subject: StageGateSubject,
  stageKey: string,
  fromStage: string | null
): Promise<CheckGateResult> {
  if (!fromStage) {
    return {
      kind: "check",
      stageKey,
      passed: true,
      failing: [],
      paused: false,
    };
  }
  const failing = await subject.checkFailing(fromStage);
  if (failing.length === 0) {
    return { kind: "check", stageKey, passed: true, failing, paused: false };
  }
  const paused = await subject.pause({
    [CHECK_GATE_METADATA_KEY]: { stageKey, fromStage, failing },
  });
  return { kind: "check", stageKey, passed: false, failing, paused };
}

/**
 * THE ONE gate evaluation. Resolve the stage just entered and, if it declares a
 * gate, apply it: a human gate pauses + files a proposal, a check gate
 * evaluates and pauses only on a miss. Returns null when the stage is ungated
 * or unknown — the overwhelmingly common case.
 */
export async function applyStageGate(
  subject: StageGateSubject,
  advance: StageGateAdvance
): Promise<StageGateOutcome> {
  const found = await subject.resolveStage(advance.toStage);
  if (!found) return null;
  const gate = resolveStageGate(found.stage);
  if (!gate) return null;

  if (gate.kind === "check") {
    return applyCheckGate(subject, advance.toStage, advance.fromStage ?? null);
  }
  const opened = await openStageGate(
    subject,
    advance,
    found.stage,
    gate,
    found.playbookRunId ?? null
  );
  return { kind: "human", ...opened };
}

/** Pure: the required criteria of `fromStage` whose current verdict is not pass. */
export function checkGateFailing(
  summary: {
    criteria: Array<{ key: string; required?: boolean; stageKey?: string }>;
    evaluations: Array<{ criterionKey: string; verdict: string }>;
  },
  fromStage: string
): string[] {
  const current = new Map(
    summary.evaluations.map((e) => [e.criterionKey, e.verdict])
  );
  return summary.criteria
    .filter(
      (c) =>
        c.stageKey === fromStage &&
        c.required !== false &&
        current.get(c.key) !== "pass"
    )
    .map((c) => c.key);
}

// The gate's two stored literals live in `@synap-core/types/focus-sessions`,
// because their readers are UIs (a pause whose cause is unrendered reads as an
// ordinary pause). Re-exported here so this service stays the one place a
// reader of the GATE looks.
export {
  CHECK_GATE_METADATA_KEY,
  CHECK_GATE_UNEVALUATED,
} from "@synap-core/types/focus-sessions";

// ── SESSION adapter ─────────────────────────────────────────────────────────

export interface SessionStageGateParams {
  sessionId: string;
  userId: string;
  agentUserId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  channelId?: string | null;
  playbookId?: string | null;
  toStage: string;
  fromStage?: string | null;
}

/**
 * A session as a gate subject. Stage source: the RUN's frozen snapshot, then
 * the live playbook (`resolveStageGateForSession`). Check measurement: the
 * session's own criteria, re-evaluated (`evaluateSession`).
 */
export function sessionGateSubject(
  params: SessionStageGateParams
): StageGateSubject {
  return {
    kind: "session",
    id: params.sessionId,
    async resolveStage(stageKey) {
      const found = await resolveStageGateForSession({
        sessionId: params.sessionId,
        playbookId: params.playbookId,
        stageKey,
      });
      return found
        ? {
            stage: found.stage,
            ...(found.playbookRunId
              ? { playbookRunId: found.playbookRunId }
              : {}),
          }
        : null;
    },
    async pause(metadataPatch) {
      const rows = await db
        .update(focusSessions)
        .set({
          status: "paused",
          updatedAt: new Date(),
          ...(metadataPatch
            ? {
                metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(metadataPatch)}::jsonb`,
              }
            : {}),
        })
        .where(
          and(
            eq(focusSessions.id, params.sessionId),
            eq(focusSessions.status, "active")
          )
        )
        .returning({ id: focusSessions.id });
      return rows.length > 0;
    },
    async checkFailing(fromStage) {
      const { evaluateSession } =
        await import("../focus-sessions/evaluations/evaluate.js");
      const result = await evaluateSession({
        sessionId: params.sessionId,
        userId: params.userId,
        agentUserId: params.agentUserId ?? null,
        stageKey: fromStage,
      });
      // An evaluation that did not RUN is not a clean gate. `evaluateSession`
      // answers `not_found` when the session cannot be loaded for this caller
      // (a race with a close, the wrong userId) — reading that as "nothing
      // failing" would advance the run ungated on the one path the gate exists
      // to hold. Unmeasured is not passed.
      return result.status === "evaluated"
        ? checkGateFailing(result, fromStage)
        : [CHECK_GATE_UNEVALUATED];
    },
    proposal: {
      targetType: STAGE_GATE_TARGET_TYPE,
      workspaceId: params.workspaceId ?? null,
      projectId: params.projectId ?? null,
      channelId: params.channelId ?? null,
      sessionId: params.sessionId,
      playbookId: params.playbookId ?? null,
    },
  };
}

/**
 * THE ONE CALL a SESSION stage-advance door makes — the session adapter over
 * {@link applyStageGate}. Kept under its historical name because the four
 * session doors and the jobs IoC slot call it.
 */
export async function applyStageGateOnAdvance(
  params: SessionStageGateParams
): Promise<StageGateOutcome> {
  return applyStageGate(sessionGateSubject(params), params);
}

// ── TRACK adapter ───────────────────────────────────────────────────────────

export interface TrackStageGateParams {
  trackId: string;
  /** Who advanced — attribution on the pause's `track.update.completed`. */
  userId: string;
  projectId: string;
  /** The track's project's workspace — the proposal's workspace. */
  workspaceId: string | null;
  playbookId: string | null;
  /** `project_tracks.definition_snapshot.stages` — the pinned definition. */
  snapshotStages: unknown;
}

/**
 * A track as a gate subject.
 *
 * Stage source: ONLY the track's pinned `definition_snapshot.stages` — never
 * the live playbook. A track executes the method version it was started with,
 * exactly as a run executes its snapshot; a method edit reaches a track only
 * through an explicit method update.
 *
 * Check measurement: a track carries NO criteria or evaluations of its own
 * (those belong to the sessions inside it), so a check gate on a track cannot
 * be measured here and answers `[CHECK_GATE_UNEVALUATED]` — it HOLDS, fail-
 * closed, the same verdict the session adapter returns when an evaluation
 * cannot run. Resuming is an explicit `setTrackStatus(active)`. Aggregating the
 * track's sessions' evaluations is a deliberate later decision, not a guess
 * made here.
 */
export function trackGateSubject(
  params: TrackStageGateParams
): StageGateSubject {
  return {
    kind: "track",
    id: params.trackId,
    async resolveStage(stageKey) {
      const stage = findStage(params.snapshotStages, stageKey);
      return stage ? { stage } : null;
    },
    async pause(metadataPatch) {
      // Through the repository (guarded `active → paused` in its WHERE), so the
      // pause emits `track.update.completed` like every other track write.
      const flipped = await (
        await trackRepository()
      ).transitionStatus(
        params.trackId,
        { from: "active", to: "paused", metadataPatch },
        params.userId
      );
      return flipped !== null;
    },
    async checkFailing() {
      return [CHECK_GATE_UNEVALUATED];
    },
    proposal: {
      targetType: TRACK_STAGE_GATE_TARGET_TYPE,
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      channelId: null,
      sessionId: null,
      playbookId: params.playbookId,
    },
  };
}
