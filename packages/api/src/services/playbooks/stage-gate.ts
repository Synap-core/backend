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
} from "@synap/database";
import {
  resolveStageGate,
  stageGateProposalType,
  type PlaybookStage,
  type PlaybookStageGate,
} from "@synap/playbooks";
import { createEventBackedProposal } from "../../utils/event-backed-proposal.js";

/** A stage gate's proposal targets the SESSION — see dev-approval's target type. */
export const STAGE_GATE_TARGET_TYPE = "focus_session";

/**
 * The proposal `data` payload. Validated at the door for the same reason the
 * dev approvals are: the generic proposal door takes `Record<string, unknown>`
 * and checks nothing, so a producer that misspells `stageKey` files a gate whose
 * review body renders empty and whose executor resumes a session it cannot name.
 */
export const StageGatePayloadSchema = z.object({
  sessionId: z.string().uuid(),
  stageKey: z.string().min(1).max(120),
  stageName: z.string().min(1).max(200),
  /** The stage's own goal, when it declares one — what the reviewer is signing off. */
  stageGoal: z.string().max(5000).optional(),
  playbookId: z.string().uuid().optional(),
  /** The `playbook_runs` row this session is executing, when there is one. */
  playbookRunId: z.string().uuid().optional(),
  fromStage: z.string().max(120).nullable().optional(),
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

export interface OpenStageGateInput {
  sessionId: string;
  /** Owner of the session — the human who reviews. */
  userId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  /** Set when an AGENT key drove the advance, so provenance sees it. */
  agentUserId?: string | null;
  channelId?: string | null;
  playbookId?: string | null;
  playbookRunId?: string | null;
  stage: PlaybookStage;
  gate: PlaybookStageGate;
  fromStage?: string | null;
}

export interface OpenStageGateResult {
  proposalId: string;
  proposalType: string;
  stageKey: string;
  /** True when the session row was actually flipped to `paused` by this call. */
  paused: boolean;
}

/**
 * Pause the session and file the gate proposal. Call this AFTER the stage write
 * has landed — the stage stands and the pause describes it.
 *
 * The pause update is guarded on `status = "active"`: a session a human already
 * paused, or one that closed between the advance and here, must not be dragged
 * back into a state it left. `paused` in the result names what the UPDATE
 * actually returned, never that this function reached its last line.
 */
export async function openStageGate(
  input: OpenStageGateInput
): Promise<OpenStageGateResult> {
  const proposalType = stageGateProposalType(input.gate);

  const payload = StageGatePayloadSchema.parse({
    sessionId: input.sessionId,
    stageKey: input.stage.key,
    stageName: input.stage.name,
    ...(input.stage.goal ? { stageGoal: input.stage.goal } : {}),
    ...(input.playbookId ? { playbookId: input.playbookId } : {}),
    ...(input.playbookRunId ? { playbookRunId: input.playbookRunId } : {}),
    fromStage: input.fromStage ?? null,
  });

  const paused = await db
    .update(focusSessions)
    .set({ status: "paused", updatedAt: new Date() })
    .where(
      and(
        eq(focusSessions.id, input.sessionId),
        eq(focusSessions.status, "active")
      )
    )
    .returning({ id: focusSessions.id });

  const summary = summarizeStageGate(payload);

  const { proposal } = await createEventBackedProposal({
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    targetType: STAGE_GATE_TARGET_TYPE,
    // The session IS the target: it is what pauses, what the executor stamps,
    // and what a reviewer opens from the proposal.
    targetId: input.sessionId,
    proposalType,
    action: "stage_gate",
    source: "intelligence",
    summary,
    agentUserId: input.agentUserId ?? null,
    createdBy: input.agentUserId ?? input.userId,
    threadId: input.channelId ?? null,
    sessionId: input.sessionId,
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
    stageKey: input.stage.key,
    paused: paused.length > 0,
  };
}

/**
 * THE ONE CALL a stage-advance door makes. Resolve the gate for the stage just
 * entered and, if there is one, pause + file. Returns null when the stage is
 * ungated — the overwhelmingly common case, and one extra query only when the
 * stage actually changed.
 */
export async function applyStageGateOnAdvance(params: {
  sessionId: string;
  userId: string;
  agentUserId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  channelId?: string | null;
  playbookId?: string | null;
  toStage: string;
  fromStage?: string | null;
}): Promise<OpenStageGateResult | null> {
  const found = await resolveStageGateForSession({
    sessionId: params.sessionId,
    playbookId: params.playbookId,
    stageKey: params.toStage,
  });
  if (!found) return null;

  return openStageGate({
    sessionId: params.sessionId,
    userId: params.userId,
    agentUserId: params.agentUserId ?? null,
    workspaceId: params.workspaceId ?? null,
    projectId: params.projectId ?? null,
    channelId: params.channelId ?? null,
    playbookId: params.playbookId ?? null,
    playbookRunId: found.playbookRunId ?? null,
    stage: found.stage,
    gate: found.gate,
    fromStage: params.fromStage ?? null,
  });
}
