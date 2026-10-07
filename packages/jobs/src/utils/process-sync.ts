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
 *     LOOP GUARD, by construction: the advance door's forward write
 *     (`writeStageSubjectStatus`) skips when the subject already holds the
 *     value — and here it always does, it just entered it. A run already AT the
 *     mapped stage is not advanced (the door's own no-op too). And the forward
 *     write's own update event lands here with the run already at the stage.
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
  focusSessions,
  proposals,
  eq,
  and,
  inArray,
  isNotNull,
} from "@synap/database";
import { resolveStageRef, stageForSubjectStatus } from "@synap/playbooks";
import { STAGE_GATE_PROPOSAL_TYPES } from "@synap/playbooks";
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
}

export type ProcessSyncOutcome =
  | {
      kind: "followed";
      sessionId: string;
      fromStage: string | null;
      toStage: string;
      backward: boolean;
      paused: boolean;
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
      const target = stageForSubjectStatus(proc.stages, value);
      if (!target || target === s.currentStage) continue;
      const keys = proc.stages.map((st) => st?.key);
      const backward =
        s.currentStage !== null &&
        keys.indexOf(target) < keys.indexOf(s.currentStage);
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
        stageWrite: "door",
      });
      out.push({
        kind: "followed",
        sessionId: s.id,
        fromStage: s.currentStage,
        toStage: target,
        backward,
        paused: res.paused,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err, sessionId: s.id }, "subject status follow failed");
      out.push({ kind: "failed", sessionId: s.id, reason });
    }
  }
  return out;
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
  const stageKey = typeof payload.stageKey === "string" ? payload.stageKey : null;
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
    const target = proc ? resolveStageRef(proc.stages, stage?.onFail?.toStage) : null;
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
    return [{ kind: "on_fail", sessionId: s.id, fromStage: stageKey, toStage: target }];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, sessionId: s.id }, "onFail after a rejected gate failed");
    return [{ kind: "failed", sessionId: s.id, reason }];
  }
}
