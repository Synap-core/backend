/**
 * THE RULE that a session's stage is one its process declares (finding
 * 8c08b138), and that a session an orchestrator holds changes no stage
 * before the person answers its plan (decision D-O1). A run with stages moves only between the keys its definition
 * names; a key it does not name is refused, by every door, with the keys it
 * does name. A session with no stages (ad-hoc work, a playbook without
 * stages) keeps its free stage label, as before.
 *
 * ONE rule, read where the process is read (`loadSessionProcess`: the run's
 * frozen snapshot first, the live playbook second). It lives in @synap/jobs
 * because both packages need it and jobs cannot import api:
 *   - api's ONE advance door (`advanceSessionStage`) refuses before it writes;
 *   - the doors that write the stage inside their own multi-field UPDATE (MCP
 *     `updateFocusSession`, tRPC `focusSessions.update`, Hub PATCH) ask it
 *     before that UPDATE, so nothing is stored or proposed;
 *   - the automation `session_update` verb asks it before governance, so a
 *     PROPOSED advance (applied later by the executor, outside the door) can
 *     never carry an undeclared key either.
 *
 * Never writes. A failed read THROWS (an unreadable process is not "no
 * stages").
 */

import type { PlaybookStage } from "@synap/playbooks";
import { loadSessionProcess } from "./session-process.js";
import {
  heldByOrchestratorReason,
  orchestratorHolding,
} from "./orchestrator-hold.js";

export interface UndeclaredStageRefusal {
  /**
   * `UNDECLARED_STAGE`: the key is not one the process declares.
   * `HELD_BY_ORCHESTRATOR`: the session waits on an orchestrator's plan
   * (decision D-O1, `orchestrator-hold.ts`); `stages` is then empty.
   */
  code: "UNDECLARED_STAGE" | "HELD_BY_ORCHESTRATOR";
  /** One sentence for the caller: what was refused and the keys it may use. */
  reason: string;
  /** The stage keys the session's process declares, in order. */
  stages: string[];
}

/** The declared keys of a process, in order. Pure. */
export function declaredStageKeys(
  stages: readonly (PlaybookStage | null | undefined)[] | null | undefined
): string[] {
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s) => s?.key)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
}

/**
 * The refusal for entering `toStage` given the process's stages, or `null`.
 * Pure: no stages at all → `null` (a stageless session keeps free keys).
 */
export function undeclaredStage(
  stages: readonly (PlaybookStage | null | undefined)[] | null | undefined,
  toStage: string
): UndeclaredStageRefusal | null {
  const keys = declaredStageKeys(stages);
  if (keys.length === 0 || keys.includes(toStage)) return null;
  return {
    code: "UNDECLARED_STAGE",
    reason: `"${toStage}" is not a stage of this session's process. Nothing was changed. Its stages: ${keys.join(", ")}.`,
    stages: keys,
  };
}

/**
 * The refusal for moving this session into `toStage`, or `null` when the move
 * may go on: the stage it already holds, or a key its process declares (any
 * key for a session with no stages) — and, whatever the key, never while an
 * orchestrator holds the session for the person's answer to its plan
 * (decision D-O1, `orchestrator-hold.ts`). Every door asks this before it
 * writes or files anything, so a held move is refused, never proposed.
 */
export async function refuseUndeclaredStage(
  session: {
    id: string;
    playbookId: string | null;
    currentStage: string | null;
  },
  toStage: string
): Promise<UndeclaredStageRefusal | null> {
  if (toStage === (session.currentStage ?? null)) return null;
  const holding = await orchestratorHolding(session.id);
  if (holding) {
    return {
      code: "HELD_BY_ORCHESTRATOR",
      reason: heldByOrchestratorReason(holding),
      stages: [],
    };
  }
  const proc = await loadSessionProcess({
    sessionId: session.id,
    playbookId: session.playbookId,
  });
  return proc ? undeclaredStage(proc.stages, toStage) : null;
}
