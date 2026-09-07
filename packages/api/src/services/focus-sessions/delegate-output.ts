/**
 * delegateExpectedOutput — hand ONE declared deliverable of a focus session to
 * an agent, and actually start it.
 *
 * WHY IT HAS TO EXIST. A session's `expectedOutputs` were a list a human read
 * and then went and did something about somewhere else: there was no verb on a
 * slot at all. "Ask an agent for this one" meant opening the session channel,
 * typing a sentence that happened to name the deliverable, and hoping the turn
 * that followed was about that slot rather than the session at large. Nothing
 * recorded that the ask had been made, so the board could not tell an untouched
 * slot from one an agent was already working on, and a second reader asked
 * again.
 *
 * WHAT IT IS NOT. It is not a new write path. Every step is an existing door,
 * called in order, and that is the whole point:
 *   1. `ensureSessionChannel` — the session room (minted if this session never
 *      had one, which the ad-hoc create path leaves null).
 *   2. `attachSessionAgent` — the append-only roster, so the declaration of who
 *      is on this session survives the delegation.
 *   3. `postChannelMessage` — the ONE message door. `triggerAI: false` on
 *      purpose: that flag's own kickoff cannot carry an `agentType`, so the
 *      delegation would silently land on the orchestrator. We post, then start
 *      the turn ourselves with the type.
 *   4. `triggerAutoRespond` — the ONE turn starter (tripwire
 *      `__tripwires__/a2ai-one-door.test.ts`), with `focusSessionId` so the
 *      agent's Hub writes carry `X-Session-Id` and therefore reach governance
 *      as session writes.
 *   5. the row-locked `expectedOutputs` read-modify-write — the same TOCTOU
 *      guard `update-session.ts` and `satisfyExpectedOutputs` use.
 *
 * WHAT IT STAMPS, AND WHAT IT DELIBERATELY DOES NOT. It writes `delegatedTo` +
 * `delegatedAt`. It does NOT write `status` — `satisfyExpectedOutputs` remains
 * the ONE door that may stamp `done`, and a delegation is the opposite of
 * evidence: it is the moment the work has NOT been done. A slot that was
 * previously RETURNED has its `returnedReason`/`returnedAt` cleared here,
 * because re-asking is a new ask and the old reviewer's note is no longer the
 * slot's current state.
 *
 * ORDER. The message is posted BEFORE the stamp, and the turn is started AFTER
 * it. A stamp written before a post that then fails would claim a delegation
 * nobody was ever asked to do — the durable-lie shape. The window in the other
 * direction (posted, stamp throws) surfaces as a thrown error with the message
 * visible in the room, which is a legible state rather than a silent one.
 *
 * OWNER-FLOORED, exactly like its siblings: `focus_sessions` is owner-private
 * and carries no `VisibilityRule`, so the floor is an explicit `userId`
 * predicate on the load (`attach-session-agent.ts` documents the reasoning). A
 * session that is missing and a session that is not yours are indistinguishable.
 */

import { db, focusSessions, and, eq, users } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import type { ExpectedOutput } from "@synap/playbooks";
import { normalizeExpectedLabel } from "./satisfy-expected-output.js";
import { ensureSessionChannel } from "./ensure-session-channel.js";
import { attachSessionAgent } from "./attach-session-agent.js";
import { postChannelMessage } from "../messaging/post-message.js";
import { triggerAutoRespond } from "../../utils/trigger-auto-respond.js";

const logger = createLogger({ module: "focus-sessions/delegate-output" });

/**
 * The agent type a delegation lands on when the caller names none. Mirrors
 * `triggerAutoRespond`'s own default verbatim — one default, not two.
 */
export const DEFAULT_DELEGATE_AGENT_TYPE = "meta";

export interface DelegateExpectedOutputParams {
  sessionId: string;
  /** Owner floor — the session must belong to this user. */
  userId: string;
  /** The declared slot label to hand over (matched trimmed + case-insensitive). */
  expectedLabel: string;
  /** Specialist agent type. Absent ⇒ {@link DEFAULT_DELEGATE_AGENT_TYPE}. */
  agentType?: string | null;
}

export type DelegateExpectedOutputResult =
  | { status: "not_found" }
  /** No declared slot carries that label. */
  | { status: "unknown_label" }
  /** The slot is already satisfied — delegating a delivered thing is a no-op ask. */
  | { status: "already_done" }
  /** The session room could not be resolved or minted; nothing was posted. */
  | { status: "no_channel" }
  | {
      status: "delegated";
      /** The DECLARED label (the slot's own casing), never the caller's. */
      expectedLabel: string;
      kind: string;
      agentType: string;
      channelId: string;
      messageId: string;
      /** `false` ⇒ the ask is in the room but no agent turn was enqueued. */
      triggered: boolean;
      /** `false` ⇒ no agent USER exists for this type; the roster is unchanged. */
      agentAttached: boolean;
    };

export async function delegateExpectedOutput(
  params: DelegateExpectedOutputParams
): Promise<DelegateExpectedOutputResult> {
  const { sessionId, userId } = params;

  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
    columns: {
      id: true,
      userId: true,
      workspaceId: true,
      goal: true,
      channelId: true,
      expectedOutputs: true,
    },
  });
  if (!session) return { status: "not_found" };

  const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  const wanted = normalizeExpectedLabel(params.expectedLabel);
  const slot = wanted
    ? outputs.find((o) => normalizeExpectedLabel(o.label) === wanted)
    : undefined;
  if (!slot) return { status: "unknown_label" };
  if (slot.status === "done") return { status: "already_done" };

  const agentType =
    typeof params.agentType === "string" && params.agentType.trim()
      ? params.agentType.trim()
      : DEFAULT_DELEGATE_AGENT_TYPE;

  const channelId = await ensureSessionChannel({
    sessionId: session.id,
    userId: session.userId,
    workspaceId: session.workspaceId,
    goal: session.goal,
  });
  if (!channelId) return { status: "no_channel" };

  // ROSTER — best effort, and READ-ONLY on identities. An agent TYPE is not an
  // agent USER: `agentIds` holds user ids, so a type with no provisioned user on
  // this pod simply cannot be rostered. We deliberately do NOT mint one here
  // (`findOrCreateServiceAgentUser` would) — a delegation must not create a
  // principal as a side effect, and the turn is routed by TYPE regardless, so
  // the roster is a declaration this call improves when it can and leaves alone
  // when it cannot.
  const agentAttached = await attachDelegateToRoster({
    sessionId: session.id,
    ownerId: session.userId,
    agentType,
  });

  // The ask itself. `resolveObjectNoun` (never a local label map) turns the
  // slot's machine kind into the word a person reads in the room.
  const content = `Please produce "${slot.label}" (${resolveObjectNoun(slot.kind)}) for this session.`;
  const posted = await postChannelMessage({
    channelId,
    content,
    // A USER-role message: this is the human asking. It is also the role the
    // turn starter expects to be answering (the Hub REST and MCP post doors
    // both gate a kickoff on `role === "user"`).
    role: "user",
    // NOT `triggerAI` — that path starts an orchestrator turn with no agentType.
    triggerAI: false,
    userId: session.userId,
  });

  // The stamp is re-derived INSIDE the lock from the REQUESTED slot label —
  // never from the array this call read before the post. An earlier version
  // passed the already-stamped array in and then re-found "the delegated one"
  // by `find((o) => o.delegatedTo)`, which on a session with a sibling slot
  // already delegated re-stamped THAT slot (wiping its return note) and left
  // the requested one untouched: the door reported a delegation it never made.
  const stamped = await updateExpectedOutputsLocked(session.id, (current) =>
    stampDelegated(current, slot.label, agentType)
  );
  // `false` ⇒ the row vanished between the load and the lock. Nothing was
  // recorded, so the ask that IS in the room must not be reported as a
  // delegation — the caller gets the same answer it would have had the session
  // been missing from the start.
  if (!stamped) return { status: "not_found" };

  const triggered = await triggerAutoRespond({
    channelId,
    userMessageId: posted.messageId,
    content,
    sourceUserId: session.userId,
    focusSessionId: session.id,
    agentType,
  });

  return {
    status: "delegated",
    expectedLabel: slot.label,
    kind: slot.kind,
    agentType,
    channelId,
    messageId: posted.messageId,
    triggered,
    agentAttached,
  };
}

/**
 * Stamp the delegation onto the named slot, every other slot untouched. Pure, so
 * the rule is testable without a database. Clears any prior RETURN: a re-ask
 * supersedes the reviewer's note that came back with the last one.
 */
export function stampDelegated(
  outputs: ExpectedOutput[],
  label: string,
  agentType: string,
  now: Date = new Date()
): ExpectedOutput[] {
  const wanted = normalizeExpectedLabel(label);
  return outputs.map((o) => {
    if (normalizeExpectedLabel(o.label) !== wanted) return o;
    const { returnedReason: _r, returnedAt: _a, ...rest } = o;
    return {
      ...rest,
      delegatedTo: agentType,
      delegatedAt: now.toISOString(),
    };
  });
}

/**
 * The row-locked write. Shared by this door and the rejection return so the two
 * JSONB read-modify-writes cannot drift into two different locking stories.
 *
 * `mutate` runs INSIDE the lock and receives the CURRENT array — never the one
 * the caller read before the transaction. Returning `null` aborts the write.
 */
export async function updateExpectedOutputsLocked(
  sessionId: string,
  mutate: (current: ExpectedOutput[]) => ExpectedOutput[] | null
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ expectedOutputs: focusSessions.expectedOutputs })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .for("update");
    if (!locked) return false;
    const current: ExpectedOutput[] = Array.isArray(locked.expectedOutputs)
      ? (locked.expectedOutputs as ExpectedOutput[])
      : [];
    const next = mutate(current);
    if (!next) return false;
    await tx
      .update(focusSessions)
      .set({ expectedOutputs: next, updatedAt: new Date() })
      .where(eq(focusSessions.id, sessionId));
    return true;
  });
}

/**
 * Resolve the agent USER for a type owned by this session's owner and append it
 * to the roster. Returns `false` (never throws) when there is no such user or
 * the append fails — the delegation itself does not depend on it.
 */
async function attachDelegateToRoster(args: {
  sessionId: string;
  ownerId: string;
  agentType: string;
}): Promise<boolean> {
  try {
    const agent = await db.query.users.findFirst({
      where: and(
        eq(users.userType, "agent"),
        eq(users.agentType, args.agentType),
        eq(users.createdByUserId, args.ownerId)
      ),
      orderBy: (u, { asc }) => [asc(u.createdAt)],
      columns: { id: true },
    });
    if (!agent) return false;
    const result = await attachSessionAgent({
      sessionId: args.sessionId,
      agentId: agent.id,
      userId: args.ownerId,
    });
    return result.status === "attached";
  } catch (err) {
    logger.warn(
      { err, sessionId: args.sessionId, agentType: args.agentType },
      "delegate: roster append failed — delegation continues"
    );
    return false;
  }
}
