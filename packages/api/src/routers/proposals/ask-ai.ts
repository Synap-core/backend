/**
 * askAiAboutProposal — the ONE server door behind "Ask AI to resolve this".
 *
 * ## What it is (and is deliberately NOT)
 *
 * It is NOT a repair. It does not revise the proposal, it does not retry the
 * approval, it does not widen `revise` to `approval_failed`. Repairing a failed
 * proposal in place would let an agent change a request the user already acted
 * on. Instead this opens the CONVERSATION that already exists for every
 * proposal — the proposal-bound thread (`contextObjectType: "proposal"`) — with
 * a seed message, and lets the agent do what an agent is for: explain the
 * failure in plain words and, if a fix exists, FILE A NEW PROPOSAL through the
 * normal governed door. The user still decides.
 *
 * ## Why the whole flow is server-side
 *
 * A client that only pre-fills a composer draft posts nothing and starts no
 * turn, so the agent never sees the failure. Doing all of it here is what stops
 * each surface shipping its own half-flow and forking the rule.
 *
 * ## The four invariants
 *
 *  1. AUTHORIZATION is `assertProposalVisibleTo` — the SAME predicate the
 *     channel-bind chokepoint enforces, so this door can never open a thread on
 *     a proposal the caller could not already open one for.
 *  2. The channel is RESOLVED, never created blind — `resolveOrCreateChannel`,
 *     which re-applies (1) at the bind and dedups per
 *     (user, workspace, contextObjectType, contextObjectId).
 *  3. The turn starts through the ONE door `triggerAutoRespond` — never a
 *     hand-rolled enqueue of the IS trigger job. (The `a2ai-one-door` tripwire
 *     scans source WITHOUT stripping comments, so this sentence deliberately
 *     does not name the queue constant: naming it even in prose trips it.)
 *  4. IDEMPOTENT under double-tap: an UNANSWERED seed already in the thread is
 *     returned as-is. Two taps must not produce two turns.
 */

import { TRPCError } from "@trpc/server";
import { db, eq } from "@synap/database";
import { proposals, ChannelType } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { assertProposalVisibleTo } from "../../utils/proposal-visibility.js";
import { resolveOrCreateChannel } from "../../utils/resolve-or-create-channel.js";
import { triggerAutoRespond } from "../../utils/trigger-auto-respond.js";
import { postSeedOnce } from "../../services/messaging/post-seed-once.js";
import { verifyWorkspaceAccess } from "../hub-protocol/rest/_shared.js";

const logger = createLogger({ module: "proposal-ask-ai" });

/**
 * The seed the user is understood to be saying. Deliberately a plain sentence
 * and not a prompt: the agent's INSTRUCTIONS for a failed proposal live in the
 * IS prompt (`SECTION_ANCHORED_COMMENT`), and the proposal's failure detail is
 * rendered into its context by `render-for-prompt.ts`. A door that smuggled
 * behaviour in through message text would be a third place the rule lives.
 */
export const ASK_AI_SEED = "Explain why this failed and help me resolve it.";

/**
 * Is this message OUR seed? Derived from the seed constant itself, not from a
 * second hand-written literal — `postChannelMessage` has no metadata channel,
 * so the content IS the marker and the two must never be able to drift.
 */
export function isAskAiSeed(
  role: string | null,
  content: string | null
): boolean {
  return role === "user" && (content ?? "").startsWith(ASK_AI_SEED);
}

export interface AskAiAboutProposalResult {
  channelId: string;
  /** false ⇒ an unanswered seed was already waiting; nothing new was posted. */
  seeded: boolean;
  /** Whether the agent turn was actually enqueued (see triggerAutoRespond). */
  triggered: boolean;
}

export async function askAiAboutProposal(params: {
  proposalId: string;
  userId: string;
  /** The caller's active workspace — used only when the proposal has none. */
  fallbackWorkspaceId?: string | null;
  /** Optional extra sentence from the user, appended to the seed. */
  note?: string;
}): Promise<AskAiAboutProposalResult> {
  const { proposalId, userId } = params;

  // (1) AUTHORIZATION FIRST — before anything is read that could disclose the
  // proposal's placement. NOT_FOUND / FORBIDDEN come from the shared gate.
  await assertProposalVisibleTo(proposalId, userId, { db });

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.id, proposalId),
    columns: { id: true, workspaceId: true, status: true, sessionId: true },
  });
  if (!proposal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
  }

  // A proposal-bound THREAD requires a workspace. The proposal's own workspace
  // wins; the caller's active workspace is the fallback — the exact rule the
  // workbench hook already applied client-side, lifted here so both surfaces
  // share it. With NEITHER we refuse rather than pick one: filing this thread
  // into a guessed workspace grants its members sight of the proposal.
  const workspaceId = proposal.workspaceId ?? params.fallbackWorkspaceId;
  if (!workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This proposal isn't in a workspace — open a workspace to discuss it with AI.",
    });
  }

  // The FALLBACK is CALLER-SUPPLIED, and filing this thread into a workspace
  // grants its members sight of the proposal. `assertProposalVisibleTo` above
  // proved the caller may see the PROPOSAL; it proves nothing about the
  // workspace they named. Without this, a pod-wide proposal (no workspaceId of
  // its own) could be threaded into any workspace id a caller could type —
  // disclosing it to that workspace's members. The proposal's OWN workspace is
  // not re-checked: it was placed there by the pod, not by this request.
  if (!proposal.workspaceId) {
    const member = await verifyWorkspaceAccess(userId, workspaceId);
    if (!member) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You are not a member of that workspace.",
      });
    }
  }

  // (2) Resolve-or-create the proposal-bound thread. This re-applies the
  // visibility gate at the bind; it is not redundant, it is the chokepoint.
  const channel = await resolveOrCreateChannel({
    userId,
    channelType: ChannelType.THREAD,
    contextObjectType: "proposal",
    contextObjectId: proposalId,
    workspaceId,
    agentSlug: "orchestrator",
  });

  const note = params.note?.trim();
  const content = note ? `${ASK_AI_SEED}\n\n${note}` : ASK_AI_SEED;

  // (4) IDEMPOTENCY — an unanswered seed already waiting means a turn is
  // already in flight (or already dropped); either way a second seed produces a
  // second turn answering the same question. Keyed on the LAST message: if it
  // is our own seed, the agent has not replied yet. The read-then-write race is
  // closed by the WRITE (a deterministic idempotency key naming the message the
  // decision was made against), never by a lock — the shared mechanism and why
  // the advisory lock had to go live in `postSeedOnce`.
  //
  // Posted as the CALLER, role `user` — this is the human asking, and `user`
  // is the role the turn starter expects to be answering.
  const seed = await postSeedOnce({
    channelId: channel.id,
    userId,
    content,
    idempotencyScope: `ask-ai:${proposalId}`,
    isPendingSeed: (latest) => isAskAiSeed(latest.role, latest.content),
  });
  if (!seed.seeded) {
    logger.info(
      { proposalId, channelId: channel.id, reason: seed.reason },
      seed.reason === "pending"
        ? "ask-ai seed already unanswered — not posting a second one"
        : "ask-ai seed lost the idempotent insert — a concurrent tap owns the turn"
    );
    return { channelId: channel.id, seeded: false, triggered: false };
  }
  const posted = seed;

  // (3) THE ONE DOOR.
  const triggered = await triggerAutoRespond({
    channelId: channel.id,
    userMessageId: posted.messageId,
    content,
    sourceUserId: userId,
    focusSessionId: proposal.sessionId ?? null,
  });

  return { channelId: channel.id, seeded: true, triggered };
}
