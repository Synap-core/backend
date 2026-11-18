/**
 * START AN ORCHESTRATOR — one session that coordinates several running
 * sessions (founder decision D5, plan b38bc224; lane design doc 5fccda9b).
 *
 * The Operations view ticks N sessions and asks for ONE orchestrator: a new
 * session that reads their rooms, posts one merged plan, and holds every one
 * of them until the person says yes. ONE door, three transports (tRPC
 * `focusSessions.startOrchestrator`, Hub `POST /focus-sessions/orchestrate`,
 * MCP `synap_start_orchestrator`), one input schema
 * ({@link startOrchestratorInputSchema}), one governed write
 * (`focus_session/orchestrate`, a gate door: an agent proposes, a person in a
 * signed-in client applies at once).
 *
 * What it writes, at approval or at once ({@link applyOrchestration}), every
 * piece through the door that already owns it:
 *   1. the orchestrator session (`createFocusSession`, under the id the
 *      proposal named): goal = the brief, a `merged-plan` deliverable and the
 *      person's `plan-approval` slot (a confirm ask) — the human gate;
 *   2. `child --orchestrated_by--> orchestrator` for each picked session.
 *      NOT a second `spawned_from`: every lineage reader assumes one parent
 *      (`getParentSessionId`, the packet's parent row, `parentOfGraph`), and
 *      the picked sessions already belong to their wave;
 *   3. each picked session that is `active` is paused (`setSessionStatus`,
 *      compare-and-set) with a hold that waits on the person's answer to
 *      `plan-approval`: the answer door wakes the hold-resume job, so the yes
 *      resumes them all with nothing new;
 *   4. one `handoff` note into each picked session's room, from the
 *      orchestrator (`resolveSessionPost` + `postChannelMessage`, the MCP
 *      door's own pair), so its agent stops and posts its plan.
 *
 * Owner floor everywhere: a picked session the caller does not own is
 * NOT_FOUND (an existence oracle otherwise), the same floor as `spawned_from`
 * and `blocked_by`. Nothing is written before the gate says yes.
 *
 * Key reach, per picked session ({@link pickedOutOfReach}): the gate checks
 * the key's grant in ONE place (where the orchestrator is filed), but the
 * write pauses a session in EVERY picked space. So, before the gate, a key
 * bound to one workspace may pick only sessions in it, and a key's grant
 * must allow the move (`session.update`) on each picked session's space and
 * project; one outside it refuses the whole ask (403, nothing written).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import {
  db,
  and,
  eq,
  inArray,
  focusSessions,
  getRequestGrant,
  links,
  users,
  setSessionStatus,
  workUnitActorOf,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { SESSION_TITLE_MAX } from "@synap-core/types/focus-sessions";
import type { Hold } from "@synap-core/types/lifecycle";
import type { ExpectedOutput, SlotAnswer } from "@synap/playbooks";
import { isDeclinedValue } from "@synap-core/types/ask";
import { ORCHESTRATOR_APPROVAL_SLOT } from "@synap/jobs/utils/orchestrator-hold.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import {
  grantDeniedKey,
  recordGrantDenial,
} from "../../utils/grant-write-check.js";

const logger = createLogger({ module: "start-orchestrator" });

/** How many sessions one orchestrator may hold (a coordination, not a fleet). */
export const ORCHESTRATOR_MIN_SESSIONS = 2;
export const ORCHESTRATOR_MAX_SESSIONS = 12;
export const ORCHESTRATOR_BRIEF_MAX = 4000;

/**
 * The person's yes: the slot every picked session's hold waits on. Declared
 * in @synap/jobs, where the stage-move rule reads it (`orchestrator-hold.ts`).
 */
export { ORCHESTRATOR_APPROVAL_SLOT };
/** The orchestrator's one deliverable before the yes. */
export const ORCHESTRATOR_PLAN_SLOT = "merged-plan";

/** Statuses a session can be orchestrated from: running, or already paused. */
const ORCHESTRATABLE = ["active", "paused"] as const;

/** THE input, parsed by all three transports. */
export const startOrchestratorInputSchema = z.object({
  /** The running sessions to coordinate (yours), 2 to 12, deduplicated. */
  sessionIds: z
    .array(z.string().uuid())
    .min(ORCHESTRATOR_MIN_SESSIONS)
    .max(ORCHESTRATOR_MAX_SESSIONS),
  /** What the orchestrator is for: its goal, and the note each room gets. */
  brief: z.string().trim().min(1).max(ORCHESTRATOR_BRIEF_MAX),
  /** Its name; default "Orchestrate N sessions". */
  title: z.string().trim().min(1).max(SESSION_TITLE_MAX).optional(),
  /** The agent (on a computer, `synap_list_agents`) that runs it; none = the person's. */
  agentId: z.string().uuid().optional(),
  /** Why, in the person's words: shown to whoever reviews the proposal. */
  reasoning: z.string().trim().max(1000).optional(),
});
export type StartOrchestratorInput = z.infer<
  typeof startOrchestratorInputSchema
>;

export type OrchestratedChildOutcome = {
  sessionId: string;
  /** `paused`: held on the yes. `already_paused`: keeps its own hold. `moved`: it changed status meanwhile, not held. `ended`: closed since; neither linked nor held. */
  held: "paused" | "already_paused" | "moved" | "ended";
  linked: boolean;
  /** The note in its room; a failed post is said, never hidden. */
  noted: boolean;
  noteError?: string;
};

export type StartOrchestratorResult =
  | {
      status: "started";
      orchestratorSessionId: string;
      channelId: string | null;
      children: OrchestratedChildOutcome[];
    }
  | {
      status: "proposed";
      orchestratorSessionId: string;
      proposalId: string;
      proposalType?: string;
      summary?: string;
      reviewPath?: string;
      reviewUrl?: string;
      message: string;
    };

type ChildRow = {
  id: string;
  title: string | null;
  goal: string;
  status: string;
  workspaceId: string | null;
  projectId: string | null;
  trackId: string | null;
};

/** The picked sessions the OWNER holds (any status), by id. */
async function loadOwnedSessions(
  ownerId: string,
  ids: readonly string[]
): Promise<Map<string, ChildRow>> {
  const rows = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      workspaceId: focusSessions.workspaceId,
      projectId: focusSessions.projectId,
      trackId: focusSessions.trackId,
    })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.id, [...ids]),
        eq(focusSessions.userId, ownerId)
      )
    );
  return new Map(rows.map((r) => [r.id, r as ChildRow]));
}

/** The one value every row shares, else null. */
function shared<T>(rows: readonly ChildRow[], pick: (r: ChildRow) => T | null) {
  const first = rows[0] ? pick(rows[0]) : null;
  return first !== null && rows.every((r) => pick(r) === first) ? first : null;
}

/**
 * Where the orchestrator is filed: the goal every picked session shares, else
 * their shared project, else their shared space; with none shared, the first
 * picked session's project (or space). Never a goal it does not share.
 */
export function orchestratorPlacement(rows: readonly ChildRow[]): {
  trackId: string | null;
  projectId: string | null;
  workspaceId: string | null;
} {
  const trackId = shared(rows, (r) => r.trackId);
  const projectId = shared(rows, (r) => r.projectId);
  const workspaceId = shared(rows, (r) => r.workspaceId);
  if (trackId || projectId || workspaceId) {
    return { trackId, projectId, workspaceId };
  }
  const first = rows[0];
  return {
    trackId: null,
    projectId: first?.projectId ?? null,
    workspaceId: first?.projectId ? null : (first?.workspaceId ?? null),
  };
}

/**
 * Why the calling key may not orchestrate these sessions, or null. Checked for
 * EACH picked session, since the write pauses every one of them: a key bound
 * to a workspace reaches only the sessions in it (`resolveConfinedWorkspace`'s
 * contract; a session in no space is outside it too, as a bound key never
 * lists one), and a key's grant must allow the move on each one's space and
 * project, the request the gate would derive (`focus_session/orchestrate`
 * folds to `session.update`). The refusal names only the key's own binding or
 * the id the caller sent, never the space it was refused in.
 */
async function pickedOutOfReach(
  rows: readonly ChildRow[],
  boundWorkspaceId: string | null
): Promise<string | null> {
  if (
    boundWorkspaceId &&
    rows.some((r) => r.workspaceId !== boundWorkspaceId)
  ) {
    return `This key is confined to workspace ${boundWorkspaceId}: every picked session must be in it.`;
  }
  const grant = getRequestGrant();
  if (!grant) return null;
  for (const r of rows) {
    const denied = await grantDeniedKey(
      {
        subjectType: "focus_session",
        action: "orchestrate",
        workspaceId: r.workspaceId,
        projectId: r.projectId,
        data: { id: r.id },
      },
      grant
    );
    if (!denied) continue;
    const message = `This key's grant does not allow "${denied.key}" on session ${r.id}, so it cannot orchestrate it.`;
    recordGrantDenial(message, denied.key, { clientId: grant.clientId });
    return message;
  }
  return null;
}

const sessionName = (r: ChildRow) =>
  (r.title?.trim() || r.goal.trim()).slice(0, 80);

function defaultTitle(n: number): string {
  return `Orchestrate ${n} sessions`;
}

/**
 * Check the ask and file it through the gate. Nothing is written but the
 * proposal (or, for a caller the gate grants, the orchestration itself).
 */
export async function startOrchestrator(p: {
  userId: string;
  agentUserId?: string | null;
  input: unknown;
  /** The calling key's workspace binding (`keyWorkspaceId`), if any. */
  boundWorkspaceId?: string | null;
}): Promise<StartOrchestratorResult> {
  const parsed = startOrchestratorInputSchema.safeParse(p.input);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; "),
    });
  }
  const input = parsed.data;
  const sessionIds = [...new Set(input.sessionIds.map((s) => s.toLowerCase()))];
  if (sessionIds.length < ORCHESTRATOR_MIN_SESSIONS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `An orchestrator coordinates at least ${ORCHESTRATOR_MIN_SESSIONS} different sessions.`,
    });
  }

  const owned = await loadOwnedSessions(p.userId, sessionIds);
  const missing = sessionIds.filter((id) => !owned.has(id));
  if (missing.length > 0) {
    // A session of someone else's reads exactly like a missing one.
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Session not found: ${missing.join(", ")}`,
    });
  }
  const rows = sessionIds.map((id) => owned.get(id)!);
  const notOpen = rows.filter(
    (r) => !(ORCHESTRATABLE as readonly string[]).includes(r.status)
  );
  if (notOpen.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Only running or paused sessions can be orchestrated: ${notOpen
        .map((r) => `"${sessionName(r)}" is ${r.status}`)
        .join("; ")}.`,
    });
  }

  const outOfReach = await pickedOutOfReach(rows, p.boundWorkspaceId ?? null);
  if (outOfReach) {
    throw new TRPCError({ code: "FORBIDDEN", message: outOfReach });
  }

  let agentName: string | null = null;
  if (input.agentId) {
    const [agent] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, input.agentId))
      .limit(1);
    agentName = agent?.name ?? null;
    const { handOffRefusal } = await import("./agent-hand-off.js");
    const refused = await handOffRefusal({
      ownerId: p.userId,
      agentId: input.agentId,
      agentName,
    });
    if (refused) throw new TRPCError({ code: "BAD_REQUEST", message: refused });
  }

  const placement = orchestratorPlacement(rows);
  const orchestratorSessionId = randomUUID();
  const title = input.title ?? defaultTitle(rows.length);

  const perm = await checkPermissionOrPropose({
    userId: p.userId,
    agentUserId: p.agentUserId ?? undefined,
    workspaceId: placement.workspaceId ?? undefined,
    projectId: placement.projectId ?? undefined,
    subjectType: "focus_session",
    action: "orchestrate",
    source: "intelligence",
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    data: {
      // The orchestrator the approval creates, under this id.
      id: orchestratorSessionId,
      // Also the proposal's display name (`extractProposalName` reads `title`).
      title,
      goal: input.brief,
      sessionIds,
      // Display only: what the reviewer approves holding, by name.
      sessions: rows.map((r) => ({ id: r.id, name: sessionName(r) })),
      ...(input.agentId ? { agentId: input.agentId, agentName } : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      orchestratorSessionId,
      proposalId: perm.proposalId,
      proposalType: perm.proposalType,
      summary: perm.summary,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
      message: `Proposed for review: an orchestrator over ${rows.length} sessions. Nothing is paused until the person approves it.`,
    };
  }

  return applyOrchestration({
    ownerId: p.userId,
    orchestratorSessionId,
    sessionIds,
    brief: input.brief,
    title,
    agentId: input.agentId ?? null,
    senderAgentId: input.agentId ?? p.agentUserId ?? null,
    proposalId: null,
  });
}

/** The hold each picked session waits on: the person's answer to the gate slot. */
export function orchestratorHold(orchestratorSessionId: string): Hold {
  return {
    on: "decision",
    ref: `focus_session:${orchestratorSessionId}`,
    reason: "Held by an orchestrator until the person approves its merged plan",
    until: {
      moves: `answer:${orchestratorSessionId}/${ORCHESTRATOR_APPROVAL_SLOT}`,
    },
  };
}

function orchestratorSlots(n: number): ExpectedOutput[] {
  return [
    {
      key: ORCHESTRATOR_PLAN_SLOT,
      kind: "document",
      label: "Merged plan",
      why: `One plan for the ${n} sessions, read from their rooms, saying what each one does next.`,
    },
    {
      key: ORCHESTRATOR_APPROVAL_SLOT,
      kind: "decision",
      label: "Plan approval",
      owner: "human",
      blockedReason: "decision",
      why: `The ${n} sessions stay paused until you approve the merged plan.`,
      unblocks: `The ${n} held sessions resume and each gets its part`,
      ask: {
        mode: "confirm",
        prompt: "Go ahead with the merged plan?",
        stakes: "commitment",
      },
    },
  ];
}

function childNote(p: {
  orchestratorSessionId: string;
  title: string;
  brief: string;
  held: OrchestratedChildOutcome["held"];
}): string {
  const wait =
    p.held === "paused"
      ? "This session is paused until the person approves the orchestrator's merged plan."
      : "This session keeps its own hold; the orchestrator coordinates it from now on.";
  return [
    `Orchestrator "${p.title}" (session ${p.orchestratorSessionId}) now coordinates this session.`,
    wait,
    "Post your current plan and what you wait on in this room. Change no stage until the person's yes; the orchestrator will post your part here.",
    `Brief: ${p.brief}`,
  ].join("\n");
}

/**
 * Apply an orchestration the gate allowed (the approval executor, or a
 * caller the gate granted). Idempotent on `orchestratorSessionId`: the session
 * is created under that id (a replay returns it), the links conflict-do-
 * nothing, a session already paused is not paused twice, and each note
 * carries an idempotency key.
 */
export async function applyOrchestration(p: {
  ownerId: string;
  orchestratorSessionId: string;
  sessionIds: readonly string[];
  brief: string;
  title: string;
  agentId: string | null;
  /** The agent that signs the room notes (a coordination post is an agent's); null = a plain room note. */
  senderAgentId: string | null;
  proposalId: string | null;
}): Promise<Extract<StartOrchestratorResult, { status: "started" }>> {
  // Re-read at approval: weeks may separate the ask and the yes.
  const owned = await loadOwnedSessions(p.ownerId, p.sessionIds);
  const open = p.sessionIds
    .map((id) => owned.get(id))
    .filter(
      (r): r is ChildRow =>
        !!r && (ORCHESTRATABLE as readonly string[]).includes(r.status)
    );
  if (open.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "None of the picked sessions is still running or paused: there is nothing to orchestrate.",
    });
  }

  const placement = orchestratorPlacement(open);
  const { createFocusSession } = await import("./create-session.js");
  const created = await createFocusSession({
    userId: p.ownerId,
    proposedSessionId: p.orchestratorSessionId,
    ...(placement.trackId ? { trackId: placement.trackId } : {}),
    ...(placement.projectId ? { projectId: placement.projectId } : {}),
    ...(placement.workspaceId ? { workspaceId: placement.workspaceId } : {}),
    title: p.title,
    goal: p.brief,
    expectedOutputs: orchestratorSlots(open.length),
    ...(p.agentId ? { agentIds: [p.agentId] } : {}),
    templateId: null,
    forceCreate: true,
    requireCriteria: false,
    matchTemplate: false,
    bindOnFacts: false,
    offerStartContext: false,
  });
  if (created.status !== "created") {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `The orchestrator session could not be created (${created.status}).`,
    });
  }
  const orchestrator = created.session;

  // 2. The edges, child → orchestrator, same owner at both ends.
  await db
    .insert(links)
    .values(
      open.map((r) => ({
        workspaceId: r.workspaceId ?? null,
        fromType: "session" as const,
        fromId: r.id,
        toType: "session" as const,
        toId: orchestrator.id,
        linkType: "orchestrated_by" as const,
        createdBy: p.ownerId,
        metadata: p.proposalId ? { proposalId: p.proposalId } : {},
      }))
    )
    .onConflictDoNothing({
      target: [
        links.fromType,
        links.fromId,
        links.toType,
        links.toId,
        links.linkType,
      ],
    });

  // 3. The holds. A session already paused keeps the hold it has.
  const hold = orchestratorHold(orchestrator.id);
  const outcomes: OrchestratedChildOutcome[] = [];
  for (const r of p.sessionIds) {
    const row = owned.get(r);
    if (!row || !open.includes(row)) {
      outcomes.push({
        sessionId: r,
        held: "ended",
        linked: false,
        noted: false,
      });
      continue;
    }
    let held: OrchestratedChildOutcome["held"] = "already_paused";
    if (row.status === "active") {
      const { rows: moved } = await setSessionStatus(db, {
        sessionId: row.id,
        from: "active",
        to: "paused",
        actor: workUnitActorOf(p.ownerId, null),
        reason: `held by orchestrator ${orchestrator.id}`,
        proposalId: p.proposalId,
        hold,
        set: { updatedAt: new Date() },
      });
      held = moved.length > 0 ? "paused" : "moved";
    }
    outcomes.push({ sessionId: row.id, held, linked: true, noted: false });
  }

  // 4. One note per room. A failed post never undoes the links or holds; it
  // is said on the outcome.
  const { postChannelMessage } = await import("../messaging/post-message.js");
  for (const outcome of outcomes) {
    if (!outcome.linked) continue;
    const content = childNote({
      orchestratorSessionId: orchestrator.id,
      title: p.title,
      brief: p.brief,
      held: outcome.held,
    });
    const idempotencyKey = `orchestrate:${orchestrator.id}:${outcome.sessionId}`;
    try {
      if (p.senderAgentId) {
        const { resolveSessionPost } =
          await import("../messaging/session-post.js");
        const resolved = await resolveSessionPost({
          userId: p.ownerId,
          agentUserId: p.senderAgentId,
          intent: "handoff",
          toSessionId: outcome.sessionId,
          fromSessionId: orchestrator.id,
          refs: [{ kind: "session", id: orchestrator.id }],
        });
        await postChannelMessage({
          channelId: resolved.channelId,
          content,
          kind: "update",
          userId: p.ownerId,
          agentUserId: p.senderAgentId,
          sessionPost: resolved.meta,
          idempotencyKey,
        });
      } else {
        const { ensureSessionChannel } =
          await import("./ensure-session-channel.js");
        const channelId = await ensureSessionChannel({
          sessionId: outcome.sessionId,
          userId: p.ownerId,
        });
        if (!channelId) throw new Error("the session has no room");
        await postChannelMessage({
          channelId,
          content,
          kind: "update",
          role: "system",
          userId: p.ownerId,
          idempotencyKey,
        });
      }
      outcome.noted = true;
    } catch (err) {
      logger.warn(
        { err, orchestratorId: orchestrator.id, sessionId: outcome.sessionId },
        "orchestrator note not posted"
      );
      outcome.noteError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    status: "started",
    orchestratorSessionId: orchestrator.id,
    channelId: orchestrator.channelId ?? null,
    children: outcomes,
  };
}

/**
 * Is this answer to `plan-approval` a NO? The confirm's "no", or a refusal
 * to answer (`declined`). Any other answer (the yes, plain words) lets the
 * orchestrator go on.
 */
export function isPlanDeclined(value: SlotAnswer["value"]): boolean {
  if (isDeclinedValue(value)) return true;
  const v = value as { type?: unknown; confirmed?: unknown } | null | undefined;
  return v?.type === "confirm" && v.confirmed === false;
}

/**
 * A NO TO THE PLAN (founder decision D-O2, 18 Nov 2026): the sessions the
 * orchestrator held resume exactly as they were — the answer ends their wait
 * (`answer:<orchestrator>/plan-approval`), so the hold-resume job moves each
 * back to the status it left, its stage untouched — and the orchestrator
 * CLOSES, `cancelled` with the reason "Plan declined", through the one close
 * door (`completeFocusSession`), as the person's own act (they answered).
 * A yes changes nothing here: the sessions resume, the orchestrator goes on.
 *
 * Only an orchestrator: the slot is `plan-approval` and some session is
 * `orchestrated_by` this one. Returns null when it is not that (no close
 * asked), else what the close did; never throws (the answer already landed).
 */
export async function closeOrchestratorOnDeclinedPlan(p: {
  sessionId: string;
  userId: string;
  slot: ExpectedOutput;
  answer: SlotAnswer;
}): Promise<{ closed: true } | { closed: false; error: string } | null> {
  if (p.slot.key !== ORCHESTRATOR_APPROVAL_SLOT) return null;
  if (!isPlanDeclined(p.answer.value)) return null;
  try {
    const [held] = await db
      .select({ fromId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.toType, "session"),
          eq(links.toId, p.sessionId),
          eq(links.linkType, "orchestrated_by")
        )
      )
      .limit(1);
    if (!held) return null;
    const { completeFocusSession } = await import("./complete-session.js");
    const closed = await completeFocusSession({
      sessionId: p.sessionId,
      userId: p.userId,
      terminalStatus: "cancelled",
      cancelReason: "Plan declined",
      summary: "Plan declined",
    });
    if (!closed) {
      return { closed: false, error: "the orchestrator session was not found" };
    }
    return { closed: true };
  } catch (err) {
    logger.warn(
      { err, orchestratorId: p.sessionId },
      "orchestrator not closed after its plan was declined"
    );
    return {
      closed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
