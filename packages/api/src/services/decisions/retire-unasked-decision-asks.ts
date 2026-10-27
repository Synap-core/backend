/**
 * The asks NOBODY ASKED retire.
 *
 * Before that decision, the decision-ask reactor raised an owed ask for ANY
 * proposed decision on ANY write: the 2026-10-18 title backfill renamed nine
 * of the founder's own recovered decisions and raised nine "Decide:" asks
 * nobody had asked. The reactor now asks only for an agent-authored decision
 * entering `proposed`; this reconcile settles what the old rule left behind:
 *
 *   - an OPEN decision ask in the OLD reactor's own shape, never answered and
 *     never re-asked by anyone ({@link isLegacyReactorAsk}), whose decision has
 *     no agent author, is retired `not_asked` — a retirement, never a delete:
 *     the person's decision stays exactly as it is;
 *   - the "Decide:" session the reactor opened for it is then closed through
 *     the ONE close door (`closeSettledDecisionSessions` →
 *     `completeFocusSession`), only once nothing else is owed there. A session
 *     the ask was merely homed in is never closed.
 *
 * RUN ONCE: the reactor no longer raises such asks, so after one clean pass
 * there is nothing left for it to find. The marker
 * (`pod_settings.settings.<RETIRE_UNASKED_DECISION_ASKS_SETTINGS_KEY>`) says
 * only that: "every open decision ask was judged by rule v<VERSION>, with no
 * failure"; a pass with a failure writes no marker, so the next boot retries.
 * Bump the version when the rule changes. Logged when it touched anything.
 * Never throws per row: a failure is logged and the next row still runs.
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
  readPodSettingsKey,
  writePodSettingsKey,
} from "../media-copy/backfill-media-copy.js";
import {
  DECISION_PROFILE_SLUG,
  closeSettledDecisionSessions,
  decisionHasAgentAuthor,
  isOpenDecisionAsk,
} from "./decision-ask-reactor.js";

const logger = createLogger({ module: "retire-unasked-decision-asks" });

/** Bump when the rule changes: a marker from an older rule stops counting. */
export const RETIRE_UNASKED_DECISION_ASKS_VERSION = 1;
export const RETIRE_UNASKED_DECISION_ASKS_SETTINGS_KEY =
  "retireUnaskedDecisionAsks";

/**
 * An open ask the OLD reactor raised, and nobody else touched. Pure.
 *
 * Its own shape — a `decision` slot whose `ref` IS its decision and whose
 * reason is `decision` (`decisionSlot`); a slot an answer filed a decision on
 * never points its `ref` at it. And never answered, never asked by anyone: a
 * slot with `answerHistory` was answered and then re-asked (by an agent's
 * block, or by the person's "Not what I said"), and one carrying `askedBy`
 * was asked by a named agent — either is a question somebody asked.
 */
function isLegacyReactorAsk(o: ExpectedOutput): o is ExpectedOutput & {
  decisionId: string;
} {
  const ref = o?.ref;
  return (
    !!o?.decisionId &&
    o.kind === "decision" &&
    o.blockedReason === "decision" &&
    !!ref &&
    "kind" in ref &&
    ref.kind === "entity" &&
    ref.id === o.decisionId &&
    !o.askedBy &&
    !o.answerHistory?.length &&
    isOpenDecisionAsk(o, o.decisionId)
  );
}

/**
 * Retire every open decision ask about one of `unasked`. Pure; `null` = no
 * change.
 */
function retireUnaskedAsks(
  outputs: ExpectedOutput[],
  unasked: ReadonlySet<string>,
  now: Date = new Date()
): { outputs: ExpectedOutput[]; retired: number } | null {
  let retired = 0;
  const next = outputs.map((o) => {
    if (!isLegacyReactorAsk(o) || !unasked.has(o.decisionId)) return o;
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
): Promise<{
  status: "already-complete" | "completed" | "pending-retries";
  retiredSlots: number;
  closedSessions: number;
}> {
  const marker = (await readPodSettingsKey(
    RETIRE_UNASKED_DECISION_ASKS_SETTINGS_KEY
  )) as { version?: unknown } | null;
  if (marker?.version === RETIRE_UNASKED_DECISION_ASKS_VERSION) {
    return { status: "already-complete", retiredSlots: 0, closedSessions: 0 };
  }
  let failures = 0;
  const finish = async (retiredSlots: number, closedSessions: number) => {
    if (failures === 0) {
      await writePodSettingsKey(RETIRE_UNASKED_DECISION_ASKS_SETTINGS_KEY, {
        version: RETIRE_UNASKED_DECISION_ASKS_VERSION,
        completedAt: now.toISOString(),
        retiredSlots,
        closedSessions,
      });
    }
    return {
      status:
        failures === 0 ? ("completed" as const) : ("pending-retries" as const),
      retiredSlots,
      closedSessions,
    };
  };
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
      if (isLegacyReactorAsk(o)) asked.add(o.decisionId);
    }
  }
  if (asked.size === 0) return finish(0, 0);

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
  if (unasked.length === 0) return finish(0, 0);
  const unaskedIds = new Set(unasked.map((d) => d.id));

  let retiredSlots = 0;
  for (const s of sessions) {
    // Lock only a session that holds one: most open sessions with a decision
    // slot have nothing to retire.
    const holds = (
      Array.isArray(s.expectedOutputs)
        ? (s.expectedOutputs as ExpectedOutput[])
        : []
    ).some((o) => isLegacyReactorAsk(o) && unaskedIds.has(o.decisionId));
    if (!holds) continue;
    try {
      await updateExpectedOutputsLocked(s.id, (current) => {
        const r = retireUnaskedAsks(current, unaskedIds, now);
        if (r) retiredSlots += r.retired;
        return r?.outputs ?? null;
      });
    } catch (err) {
      failures += 1;
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
      failures += 1;
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
  return finish(retiredSlots, closedSessions);
}
