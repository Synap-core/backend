/**
 * Answer → decision (W2 of the decision mesh). Called by the answer door
 * (`answerExpectedOutput`) AFTER the answer committed, for every answered
 * `confirm` / `choose` ask:
 *
 *   - slot carries `decisionId` ⇒ UPDATE that decision (the slot was opened
 *     for a `proposed` decision by the decision-ask reactor, or a previous
 *     answer to this slot already filed one — re-answering revises it);
 *   - otherwise ⇒ CREATE a `decision`, link it to what the agent looked at,
 *     and stamp `decisionId` on the slot.
 *
 * NOT IN THE ANSWER'S TRANSACTION, deliberately: the decision goes through the
 * canonical entity door (`decision-entity-door.ts`), which owns its own writes
 * and side effects. So a failure here can never lose the answer — and it is
 * never swallowed either: it is logged at error level and returned as
 * `{status: 'failed'}`, which the door hands back to its caller.
 */

import { createLogger } from "@synap-core/core";
import type { ExpectedOutput, SlotAnswer, LinkInput } from "@synap/playbooks";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import { updateExpectedOutputsLocked } from "../focus-sessions/delegate-output.js";
import { decisionFromAnswer } from "./decision-from-answer.js";
import {
  createDecisionEntity,
  updateDecisionEntity,
} from "./decision-entity-door.js";

const logger = createLogger({ module: "file-answer-decision" });

export type DecisionFilingOutcome =
  | { status: "filed"; decisionId: string; slotStamped: boolean }
  | { status: "updated"; decisionId: string }
  | { status: "failed"; reason: string };

/** `lookedAt` kinds that are link endpoints (`view` is not one). */
const LINKABLE_LOOKED_AT = new Set([
  "entity",
  "document",
  "automation",
  "playbook",
]);

/** The `decision --about--> <looked-at>` edges for an ask. Pure. */
export function lookedAtLinks(
  decisionId: string,
  workspaceId: string | null,
  lookedAt: ReadonlyArray<{ kind: string; id: string }> | undefined
): LinkInput[] {
  return (lookedAt ?? [])
    .filter((r) => LINKABLE_LOOKED_AT.has(r.kind))
    .map((r) => ({
      workspaceId,
      fromType: "entity",
      fromId: decisionId,
      toType: r.kind as LinkInput["toType"],
      toId: r.id,
      linkType: "about",
      metadata: { via: "ask.lookedAt" },
    }));
}

export async function fileAnswerDecision(p: {
  userId: string;
  slot: ExpectedOutput;
  answer: SlotAnswer;
  session: {
    id: string;
    workspaceId: string | null;
    projectId: string | null;
    agentIds: string[];
  };
}): Promise<DecisionFilingOutcome | undefined> {
  const draft = decisionFromAnswer({
    slot: p.slot,
    answer: p.answer,
    sessionId: p.session.id,
    // Named only when it is unambiguous WHICH agent asked.
    askedByAgent:
      p.session.agentIds.length === 1 ? p.session.agentIds[0] : null,
  });
  if (!draft) return undefined;

  const scope = {
    userId: p.userId,
    workspaceId: p.session.workspaceId,
    sessionId: p.session.id,
  };

  if (p.slot.decisionId) {
    try {
      await updateDecisionEntity(scope, p.slot.decisionId, draft.properties);
      return { status: "updated", decisionId: p.slot.decisionId };
    } catch (err) {
      return failed(err, p, "update");
    }
  }

  let decisionId: string;
  try {
    decisionId = await createDecisionEntity(scope, {
      title: draft.title,
      properties: draft.properties,
      projectId: p.session.projectId,
    });
  } catch (err) {
    return failed(err, p, "create");
  }

  // Provenance edges: best-effort AFTER the decision exists, logged on miss.
  const edges = lookedAtLinks(
    decisionId,
    p.session.workspaceId,
    p.answer.askSnapshot?.lookedAt ?? p.slot.ask?.lookedAt
  );
  if (edges.length > 0) {
    try {
      const { createLinks } = await import("../links/links-service.js");
      await createLinks(edges);
    } catch (err) {
      logger.error(
        { err, decisionId, sessionId: p.session.id },
        "decision filed, but its lookedAt edges FAILED to write"
      );
    }
  }

  let slotStamped = false;
  try {
    const wanted = normalizeExpectedLabel(p.slot.label);
    slotStamped = await updateExpectedOutputsLocked(p.session.id, (current) =>
      current.map((o) =>
        normalizeExpectedLabel(o?.label) === wanted && !o.decisionId
          ? { ...o, decisionId }
          : o
      )
    );
  } catch (err) {
    logger.error(
      { err, decisionId, sessionId: p.session.id, label: p.slot.label },
      "decision filed, but stamping decisionId on the slot FAILED — a re-answer will file a second decision"
    );
  }
  return { status: "filed", decisionId, slotStamped };
}

function failed(
  err: unknown,
  p: { session: { id: string }; slot: ExpectedOutput },
  op: "create" | "update"
): DecisionFilingOutcome {
  const reason = err instanceof Error ? err.message : String(err);
  logger.error(
    {
      err,
      sessionId: p.session.id,
      label: p.slot.label,
      decisionId: p.slot.decisionId,
    },
    `the answer is recorded, but filing its decision (${op}) FAILED`
  );
  return { status: "failed", reason };
}
