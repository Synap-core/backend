/**
 * THE LOOP BACK — ONE door that hands a person's answer or decision to an
 * EXTERNAL agent through its binding's `send` verb.
 *
 * Called where the pod would otherwise start an IS turn for a pod-run agent:
 *   - an answer to the agent's question / owed slot (`session-answer.ts`, when
 *     the waking agent's reach is `'dispatch'`);
 *   - a `dev.plan_approval` / `dev.deploy_approval` decision (approve and
 *     reject), for the agent that filed it.
 *
 * A pod-run agent never comes here (it gets its IS turn); a `'pull'` agent is
 * never woken (it reads the answer through its own door). Only reach
 * `'dispatch'` is sent to.
 *
 * On failure the error is LOGGED and posted in the session room — never
 * swallowed: an answer that silently never reached the agent is a session
 * that stalls with everyone believing the agent was told.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  eq,
  and,
  desc,
  drizzleSql,
  focusSessions,
  playbookRuns,
  liveRunStatusWhere,
} from "@synap/database";
import type { PlaybookRunExternalAgent } from "@synap/database/schema";
import {
  AgentBindingError,
  resolveAgentBinding,
  resolveAgentReach,
} from "./agent-binding.js";
import {
  callBindingVerb,
  fenceUntrustedData,
  postDispatchNotice,
} from "./binding-call.js";
import {
  DEV_DEPLOY_APPROVAL_TYPE,
  DEV_PLAN_APPROVAL_TYPE,
} from "../proposals/dev-approval.js";

const logger = createLogger({ module: "agent-dispatch/wake" });

export interface WakeExternalAgentInput {
  sessionId: string;
  agentUserId: string;
  kind: "answer" | "decision";
  /** The person's words (an answer) or the decision's note. */
  text: string;
  /** The slot the answer is about (label or key). */
  slotKey?: string;
  proposalId?: string;
  decision?: "approved" | "rejected";
  /**
   * The provider tool call this decision settles — ONLY from a typed approve /
   * reject of the approval card that named it (`OpenQuestion.confirmationId`).
   * Without it the binding sends the words as a message: a plan / deploy
   * decision or an answer in words NEVER approves a pending push or merge.
   */
  confirmationId?: string;
  /**
   * What makes this send ONE operation — the answer's message id or the
   * decided proposal's id. Keyed through `executeCapability`'s explicit-key
   * idempotency, so a repeated decision / replayed answer sends once.
   */
  idempotencyKey: string;
}

export type WakeExternalAgentResult =
  | { status: "sent"; runId: string }
  /** Governance deferred the send to a person. */
  | { status: "proposed"; reviewUrl: string }
  /**
   * Nothing was sent, by design: not an agent the pod dispatches to, or no
   * LIVE run in this session was handed to it (nothing to send to).
   */
  | { status: "not_dispatch" }
  | { status: "failed"; message: string };

/**
 * The session's newest LIVE run handed to this agent, with the provider task
 * id it was started as. `null` ⇒ nothing to send to.
 */
async function dispatchedRunFor(
  sessionId: string,
  agentUserId: string
): Promise<{ id: string; ext: PlaybookRunExternalAgent } | null> {
  const [row] = await db
    .select({ id: playbookRuns.id, ext: playbookRuns.externalAgent })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, sessionId),
        liveRunStatusWhere(playbookRuns.status),
        drizzleSql`${playbookRuns.externalAgent}->>'agentUserId' = ${agentUserId}`,
        drizzleSql`${playbookRuns.externalAgent}->>'externalId' IS NOT NULL`
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  return row?.ext
    ? { id: row.id, ext: row.ext as PlaybookRunExternalAgent }
    : null;
}

export async function wakeExternalAgent(
  p: WakeExternalAgentInput
): Promise<WakeExternalAgentResult> {
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, p.sessionId),
    columns: { userId: true, channelId: true },
  });
  const channelId = session?.channelId ?? null;
  const ownerId = session?.userId;
  const failed = async (message: string): Promise<WakeExternalAgentResult> => {
    logger.error(
      {
        sessionId: p.sessionId,
        agentUserId: p.agentUserId,
        kind: p.kind,
        message,
      },
      "wakeExternalAgent: the agent was NOT told"
    );
    if (ownerId) {
      await postDispatchNotice({
        channelId,
        ownerId,
        content: `Could not pass your ${p.kind} to the agent: ${message}`,
        idempotencyKey: `agent-wake-failed:${p.sessionId}:${p.agentUserId}:${p.proposalId ?? p.slotKey ?? ""}:${Date.now()}`,
      });
    }
    return { status: "failed", message };
  };
  if (!ownerId) return failed(`session ${p.sessionId} not found`);

  if ((await resolveAgentReach(p.agentUserId)) !== "dispatch") {
    return { status: "not_dispatch" };
  }
  let binding;
  try {
    binding = await resolveAgentBinding(p.agentUserId);
  } catch (err) {
    if (err instanceof AgentBindingError) return failed(err.message);
    throw err;
  }
  if (!binding) return { status: "not_dispatch" };

  const run = await dispatchedRunFor(p.sessionId, p.agentUserId);
  if (!run) return { status: "not_dispatch" };
  const res = await callBindingVerb({
    binding,
    verb: "send",
    agentUserId: p.agentUserId,
    ownerId,
    parameters: {
      externalId: run.ext.externalId,
      runId: run.id,
      sessionId: p.sessionId,
      channelId,
      message: {
        kind: p.kind,
        text: fenceUntrustedData(p.text, `synap session ${p.kind}`),
        ...(p.slotKey ? { slotKey: p.slotKey } : {}),
        ...(p.proposalId ? { proposalId: p.proposalId } : {}),
        ...(p.decision ? { decision: p.decision } : {}),
        ...(p.kind === "decision" && p.decision && p.confirmationId
          ? { confirmationId: p.confirmationId }
          : {}),
      },
    },
    sessionId: p.sessionId,
    channelId,
    idempotencyKey: `agent-send:${run.id}:${p.idempotencyKey}`,
  });
  if (res.status === "ok") return { status: "sent", runId: run.id };
  if (res.status === "proposed") {
    await postDispatchNotice({
      channelId,
      ownerId,
      content: `Passing your ${p.kind} to the ${binding.provider} agent needs approval: ${res.reviewUrl}`,
      idempotencyKey: `agent-wake-proposed:${res.proposalId}`,
    });
    return { status: "proposed", reviewUrl: res.reviewUrl };
  }
  return failed(res.message);
}

/**
 * A dev-loop decision (approve / reject of `dev.plan_approval` /
 * `dev.deploy_approval`) reaches the dispatched agent that filed it. Called by
 * the approve executor and both reject doors; never throws — the decision has
 * already been recorded.
 */
export async function wakeAgentOnDevDecision(p: {
  proposal: {
    id?: string;
    proposalType?: string | null;
    agentUserId?: string | null;
    targetId?: string | null;
  };
  proposalId: string;
  decision: "approved" | "rejected";
  note?: string | null;
}): Promise<WakeExternalAgentResult | null> {
  const type = p.proposal.proposalType;
  if (type !== DEV_PLAN_APPROVAL_TYPE && type !== DEV_DEPLOY_APPROVAL_TYPE) {
    return null;
  }
  const agentUserId = p.proposal.agentUserId;
  const sessionId = p.proposal.targetId;
  if (!agentUserId || !sessionId) return null;
  try {
    const gate = type === DEV_PLAN_APPROVAL_TYPE ? "plan" : "deploy";
    return await wakeExternalAgent({
      sessionId,
      agentUserId,
      kind: "decision",
      decision: p.decision,
      proposalId: p.proposalId,
      // NO confirmationId, ever: approving a plan or a deploy is not approving
      // the push / merge the agent may be blocked on — those settle only from
      // their own approval card. The decision reaches the agent as a message.
      idempotencyKey: `decision:${p.proposalId}`,
      text:
        `Your ${gate} approval was ${p.decision}.` +
        (p.note?.trim() ? ` Reviewer note: ${p.note.trim()}` : ""),
    });
  } catch (err) {
    logger.error(
      { err, proposalId: p.proposalId },
      "dev decision: waking the external agent threw — the decision stands"
    );
    return {
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
