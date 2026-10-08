/**
 * PROCESS SYNC — the two event-driven halves of the process engine that run
 * off the ONE trigger hop (`automation-trigger-match`), with no new queue:
 *
 *  1. SUBJECT → RUN (stage follows status). When a subject entity's
 *     `statusProperty` CHANGES (`entity.update.completed` carries
 *     `changed.<k>` + the new value + `previous.<k>`), every OPEN session whose
 *     subject is that entity and whose playbook has a stage declaring that
 *     `subjectStatus` is advanced to it — through the ONE advance door
 *     (`advanceSessionStageViaSlot` → api `advanceSessionStage`), so the gate,
 *     the `stage_changed` emit and the forward status write all run exactly as
 *     for any other advance.
 *
 *     LOOP GUARD — the subject is the source of truth on this path, so:
 *       - the follow re-reads the subject's CURRENT value and acts only when it
 *         still equals the event's value. A stale event (the person moved the
 *         post B then C before B was processed) is ignored: C's own event
 *         follows. Acting on B would drag the run back behind the subject.
 *       - a follow-advance NEVER writes the status back (`skipSubjectWrite`): it
 *         only moves the run. Without both halves, two quick edits ping-ponged
 *         forever (each stale follow re-wrote its value, firing a new event).
 *       - a run already AT the mapped stage is not advanced.
 *
 *     AGENT WRITES do not walk a human gate. When an AGENT produced the event
 *     (`producerAgentUserId`, `users.user_type = 'agent'`), a forward follow
 *     stops AT the first human-gated stage it would cross — entering it through
 *     the door files that gate — and a run already held at its human gate does
 *     not move. The advance is attributed to that agent. A person's own edit is
 *     their decision and is followed as written.
 *
 *     BACKWARDS: the advance door allows any declared stage, so a subject moved
 *     back to an earlier status moves its run back too. That is followed — the
 *     subject is the source of truth for where the work stands — and LOGGED as
 *     a backward move rather than done silently.
 *
 *  2. REJECTED HUMAN GATE → `onFail`. When a `playbook.stage_gate` proposal on a
 *     session is REJECTED and the gated stage declares `onFail.toStage`, the run
 *     is returned there: un-paused (the gate's pause), then advanced through the
 *     ONE door — whose own gate on the target stage can pause it again. Without
 *     `onFail` the run stays paused, exactly as before.
 *
 * Non-fatal per session: one session's failure is reported and never stops the
 * others, nor the automation matching that follows in the same hop.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  entities,
  focusSessions,
  proposals,
  users,
  eq,
  and,
  inArray,
  isNotNull,
} from "@synap/database";
import {
  resolveStageGate,
  resolveStageRef,
  stageForSubjectStatus,
  STAGE_GATE_PROPOSAL_TYPES,
} from "@synap/playbooks";
import { advanceSessionStageViaSlot } from "./stage-advance.js";
import { loadSessionProcess } from "./session-process.js";

const logger = createLogger({ module: "process-sync" });

/** Sessions a subject's status may move: in flight, and not a mere appointment. */
const FOLLOWING_SESSION_STATUSES = ["active", "paused", "forming"] as const;

export interface ProcessSyncEvent {
  eventType: string;
  subjectId: string;
  userId: string;
  workspaceId?: string | null;
  data?: Record<string, unknown> | null;
  /**
   * Who PRODUCED the event (the trigger hop's `producerAgentUserId`). Only an
   * id whose user is an agent changes anything: the follow is then attributed
   * to that agent and never carries a run past a human gate.
   */
  producerAgentUserId?: string | null;
}

export type ProcessSyncOutcome =
  | {
      kind: "followed";
      sessionId: string;
      fromStage: string | null;
      toStage: string;
      backward: boolean;
      paused: boolean;
      /** Set when an agent's write was stopped at this human-gated stage. */
      heldAtGate?: string;
    }
  | {
      kind: "ignored";
      sessionId: string;
      reason: "stale_event" | "held_at_human_gate";
    }
  | { kind: "on_fail"; sessionId: string; fromStage: string; toStage: string }
  | { kind: "failed"; sessionId: string; reason: string };

/** Entry point, called once per matched event by the trigger hop. */
export async function syncProcessOnEvent(
  ev: ProcessSyncEvent
): Promise<ProcessSyncOutcome[]> {
  if (ev.eventType === "entity.update.completed") {
    return followSubjectStatus(ev);
  }
  if (ev.eventType === "proposal.rejected.completed") {
    return applyRejectedGateOnFail(ev);
  }
  return [];
}

async function followSubjectStatus(
  ev: ProcessSyncEvent
): Promise<ProcessSyncOutcome[]> {
  const data = ev.data ?? {};
  const changed = Array.isArray(data.changedKeys)
    ? (data.changedKeys as unknown[]).filter(
        (k): k is string => typeof k === "string"
      )
    : [];
  if (changed.length === 0) return [];

  const sessions = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      status: focusSessions.status,
      currentStage: focusSessions.currentStage,
      workspaceId: focusSessions.workspaceId,
      projectId: focusSessions.projectId,
      channelId: focusSessions.channelId,
      playbookId: focusSessions.playbookId,
      subjectEntityId: focusSessions.subjectEntityId,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.subjectEntityId, ev.subjectId),
        inArray(focusSessions.status, [...FOLLOWING_SESSION_STATUSES]),
        isNotNull(focusSessions.playbookId)
      )
    );

  if (sessions.length === 0) return [];

  // The subject's CURRENT properties, read once: the event's value is only
  // acted on while the subject still holds it (see LOOP GUARD).
  const [subject] = await db
    .select({ properties: entities.properties })
    .from(entities)
    .where(eq(entities.id, ev.subjectId))
    .limit(1);
  const current = (subject?.properties ?? {}) as Record<string, unknown>;
  const agentUserId = await agentProducer(ev.producerAgentUserId);

  const out: ProcessSyncOutcome[] = [];
  for (const s of sessions) {
    try {
      const proc = await loadSessionProcess({
        sessionId: s.id,
        playbookId: s.playbookId,
      });
      if (!proc?.statusProperty || !changed.includes(proc.statusProperty))
        continue;
      const value = data[proc.statusProperty];
      if (current[proc.statusProperty] !== value) {
        out.push({ kind: "ignored", sessionId: s.id, reason: "stale_event" });
        continue;
      }
      let target = stageForSubjectStatus(proc.stages, value);
      if (!target || target === s.currentStage) continue;
      const keys = proc.stages.map((st) => st?.key);
      const from = s.currentStage === null ? -1 : keys.indexOf(s.currentStage);
      const backward = s.currentStage !== null && keys.indexOf(target) < from;
      let heldAtGate: string | undefined;
      if (agentUserId && !backward) {
        // An agent's write never carries a run past a person's gate.
        if (s.status === "paused" && isHumanGated(proc.stages[from])) {
          out.push({
            kind: "ignored",
            sessionId: s.id,
            reason: "held_at_human_gate",
          });
          continue;
        }
        const to = keys.indexOf(target);
        for (let i = from + 1; i < to; i++) {
          if (isHumanGated(proc.stages[i])) {
            target = keys[i] as string;
            heldAtGate = target;
            break;
          }
        }
      }
      if (backward) {
        logger.info(
          { sessionId: s.id, from: s.currentStage, to: target, value },
          "subject moved back to an earlier status — the run follows it back"
        );
      }
      const res = await advanceSessionStageViaSlot({
        session: s,
        toStage: target,
        userId: s.userId,
        agentUserId,
        stageWrite: "door",
        skipSubjectWrite: true,
      });
      out.push({
        kind: "followed",
        sessionId: s.id,
        fromStage: s.currentStage,
        toStage: target,
        backward,
        paused: res.paused,
        ...(heldAtGate ? { heldAtGate } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err, sessionId: s.id }, "subject status follow failed");
      out.push({ kind: "failed", sessionId: s.id, reason });
    }
  }
  return out;
}

/** A stage a PERSON must agree to enter: any gate that is not a check. */
function isHumanGated(stage: unknown): boolean {
  const gate = resolveStageGate(stage);
  return !!gate && gate.kind !== "check";
}

/** The producer's id when it is an AGENT user, else null (a person, or none). */
async function agentProducer(
  producerId: string | null | undefined
): Promise<string | null> {
  if (!producerId) return null;
  const [row] = await db
    .select({ userType: users.userType })
    .from(users)
    .where(eq(users.id, producerId))
    .limit(1);
  return row?.userType === "agent" ? producerId : null;
}

async function applyRejectedGateOnFail(
  ev: ProcessSyncEvent
): Promise<ProcessSyncOutcome[]> {
  const [p] = await db
    .select({
      targetType: proposals.targetType,
      targetId: proposals.targetId,
      proposalType: proposals.proposalType,
      data: proposals.data,
    })
    .from(proposals)
    .where(eq(proposals.id, ev.subjectId))
    .limit(1);
  if (
    !p ||
    p.targetType !== "focus_session" ||
    !(STAGE_GATE_PROPOSAL_TYPES as readonly string[]).includes(p.proposalType)
  ) {
    return [];
  }
  const payload = (p.data ?? {}) as { stageKey?: unknown };
  const stageKey =
    typeof payload.stageKey === "string" ? payload.stageKey : null;
  if (!stageKey) return [];

  const [s] = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      status: focusSessions.status,
      currentStage: focusSessions.currentStage,
      workspaceId: focusSessions.workspaceId,
      projectId: focusSessions.projectId,
      channelId: focusSessions.channelId,
      playbookId: focusSessions.playbookId,
      subjectEntityId: focusSessions.subjectEntityId,
    })
    .from(focusSessions)
    .where(eq(focusSessions.id, p.targetId))
    .limit(1);
  // Only the run the gate is still holding: paused, on the gated stage.
  if (!s || s.status !== "paused" || s.currentStage !== stageKey) return [];

  try {
    const proc = await loadSessionProcess({
      sessionId: s.id,
      playbookId: s.playbookId,
    });
    const stage = proc?.stages.find((st) => st?.key === stageKey);
    const target = proc
      ? resolveStageRef(proc.stages, stage?.onFail?.toStage)
      : null;
    if (!target || target === stageKey) return [];
    // Un-pause FIRST (guarded on `paused`), so a gate on the target stage can
    // pause the run again — the gate only ever pauses an ACTIVE session.
    const resumed = await db
      .update(focusSessions)
      .set({ status: "active", updatedAt: new Date() })
      .where(
        and(eq(focusSessions.id, s.id), eq(focusSessions.status, "paused"))
      )
      .returning({ id: focusSessions.id });
    if (resumed.length === 0) return [];
    await advanceSessionStageViaSlot({
      session: s,
      toStage: target,
      userId: s.userId,
      stageWrite: "door",
    });
    logger.info(
      { sessionId: s.id, from: stageKey, to: target },
      "stage gate rejected — run returned to its onFail stage"
    );
    return [
      {
        kind: "on_fail",
        sessionId: s.id,
        fromStage: stageKey,
        toStage: target,
      },
    ];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, sessionId: s.id },
      "onFail after a rejected gate failed"
    );
    return [{ kind: "failed", sessionId: s.id, reason }];
  }
}
