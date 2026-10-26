/**
 * The asks NOBODY ASKED retire (founder decision 1, 2026-10-26).
 *
 * Before that decision, the decision-ask reactor raised an owed ask for ANY
 * proposed decision on ANY write: the 2026-10-18 title backfill renamed nine
 * of the founder's own recovered decisions and raised nine "Decide:" asks
 * nobody had asked. The reactor now asks only for an agent-authored decision
 * entering `proposed`; this reconcile settles what the old rule left behind:
 *
 *   - an OPEN decision ask (the reactor's slot shape, unanswered, still owed)
 *     whose decision has no agent author is retired `not_asked` — a retirement,
 *     never a delete: the person's decision stays exactly as it is;
 *   - the "Decide:" session the reactor opened for it is then closed through
 *     the ONE close door (`closeSettledDecisionSessions` →
 *     `completeFocusSession`), only once nothing else is owed there. A session
 *     the ask was merely homed in is never closed.
 *
 * IDEMPOTENT, runs at every boot: a retired slot is no longer open, so a
 * second pass finds nothing. Logged when it touched anything. Never throws
 * per row: a failure is logged and the next row still runs.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  inArray,
  drizzleSql,
  entities,
  focusSessions,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { OPEN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import { resolveRetiredReasonLabel } from "@synap-core/types/vocabulary";
import { updateExpectedOutputsLocked } from "../focus-sessions/delegate-output.js";
import {
  DECISION_PROFILE_SLUG,
  closeSettledDecisionSessions,
  decisionHasAgentAuthor,
  isOpenDecisionAsk,
} from "./decision-ask-reactor.js";

const logger = createLogger({ module: "retire-unasked-decision-asks" });

/** The reactor's slot shape: a `decision` slot pointing at its decision. */
function isReactorDecisionAsk(o: ExpectedOutput): o is ExpectedOutput & {
  decisionId: string;
} {
  return (
    !!o?.decisionId &&
    o.kind === "decision" &&
    isOpenDecisionAsk(o, o.decisionId)
  );
}

/**
 * Retire every open decision ask about one of `unasked`. Pure; `null` = no
 * change.
 */
export function retireUnaskedAsks(
  outputs: ExpectedOutput[],
  unasked: ReadonlySet<string>,
  now: Date = new Date()
): { outputs: ExpectedOutput[]; retired: number } | null {
  let retired = 0;
  const next = outputs.map((o) => {
    if (!isReactorDecisionAsk(o) || !unasked.has(o.decisionId)) return o;
    retired += 1;
    return {
      ...o,
      retiredAt: now.toISOString(),
      retiredReason: "not_asked" as const,
    };
  });
  return retired > 0 ? { outputs: next, retired } : null;
}

export async function retireUnaskedDecisionAsks(
  now: Date = new Date()
): Promise<{ retiredSlots: number; closedSessions: number }> {
  const sessions = await db
    .select({
      id: focusSessions.id,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        drizzleSql`${focusSessions.expectedOutputs} @> ${JSON.stringify([
          { kind: "decision" },
        ])}::jsonb`
      )
    );
  const asked = new Set<string>();
  for (const s of sessions) {
    for (const o of Array.isArray(s.expectedOutputs)
      ? (s.expectedOutputs as ExpectedOutput[])
      : []) {
      if (isReactorDecisionAsk(o)) asked.add(o.decisionId);
    }
  }
  if (asked.size === 0) return { retiredSlots: 0, closedSessions: 0 };

  const rows = await db
    .select({
      id: entities.id,
      userId: entities.userId,
      workspaceId: entities.workspaceId,
      title: entities.title,
      properties: entities.properties,
      type: entities.type,
      createdByKind: entities.createdByKind,
      agentUserId: entities.agentUserId,
    })
    .from(entities)
    .where(inArray(entities.id, [...asked]));
  const unasked = rows
    .filter((r) => r.type === DECISION_PROFILE_SLUG)
    .filter((r) => !decisionHasAgentAuthor(r))
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      workspaceId: r.workspaceId ?? null,
      title: r.title ?? null,
      properties:
        r.properties && typeof r.properties === "object"
          ? (r.properties as Record<string, unknown>)
          : {},
      createdByKind: r.createdByKind ?? null,
      agentUserId: r.agentUserId ?? null,
    }));
  if (unasked.length === 0) return { retiredSlots: 0, closedSessions: 0 };
  const unaskedIds = new Set(unasked.map((d) => d.id));

  let retiredSlots = 0;
  for (const s of sessions) {
    try {
      await updateExpectedOutputsLocked(s.id, (current) => {
        const r = retireUnaskedAsks(current, unaskedIds, now);
        if (r) retiredSlots += r.retired;
        return r?.outputs ?? null;
      });
    } catch (err) {
      logger.error(
        { err, sessionId: s.id },
        "retiring the unasked decision asks of a session FAILED — they stay owed until the next boot"
      );
    }
  }

  let closedSessions = 0;
  const summary = resolveRetiredReasonLabel("not_asked");
  for (const d of unasked) {
    try {
      closedSessions += await closeSettledDecisionSessions(d, { summary });
    } catch (err) {
      logger.error(
        { err, decisionId: d.id },
        "closing the Decide session of an unasked decision FAILED — it stays open until the next boot"
      );
    }
  }
  if (retiredSlots > 0 || closedSessions > 0) {
    logger.info(
      { retiredSlots, closedSessions, decisions: unasked.length },
      "retired decision asks nobody asked"
    );
  }
  return { retiredSlots, closedSessions };
}
