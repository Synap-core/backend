/**
 * SESSION TARGETS — the things a session works on as a BATCH (work model
 * L4/L5; plan b38e5e64 §5.1 "works on": a session works on its subject, one
 * thing, or its targets, a batch).
 *
 * THE EDGE: `session --targets--> entity`, `links.metadata.role =
 * WORKER_TARGET_ROLE`, no `result` yet. One writer, {@link writeSessionTargets},
 * for every producer: a per-batch worker run (`run-playbook.ts`) and a session
 * that DECLARES its targets on any start or update door (MCP
 * `synap_start_session` / `synap_update_session`, Hub POST / PATCH
 * `/focus-sessions`, tRPC `focusSessions.create` / `.update`, and the approval
 * of a proposed start or update). Same edge, same role, so everything that
 * reads targets reads both: process-sync stamps each one's result when the
 * thing moves (own move `done`, anyone else's `skipped`; it never needs
 * `metadata.worker`, whose absence means any lifecycle move settles), the close
 * door stamps the open ones `skipped` and applies the process's `onEnd` to them
 * (`session-end-moves.ts`), `worked-by.ts` and the session page list them.
 *
 * ADD-ONLY. A door adds targets (idempotently: a target already declared is
 * reported `already`, never a second edge). There is no removal: a target's
 * end is its RESULT (done / skipped / failed), a mark the history keeps,
 * and no door removes a subject's past either. A thing the session should no
 * longer work is moved or skipped, not unlinked.
 *
 * FLOORS, before any governance (so a bad id is refused to the caller who
 * sent it, never laundered into a proposal): each id is an entity the caller
 * can already see (`isOutputRefVisible`, the floor the subject goes through),
 * and the session is still being worked (`WORKER_IN_FLIGHT_SESSION_STATUSES`:
 * a target added to an ended session would stay "being worked" forever, since
 * nothing stamps it after the close).
 *
 * AN INPUT BECOMES A TARGET. `session-inputs.ts` writes the SAME edge with
 * role `input` (context that arrived). The edge is unique per (session,
 * entity, `targets`), so declaring an input as a target promotes that edge's
 * role instead of being silently dropped by the conflict.
 */
import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  links,
  WORKER_IN_FLIGHT_SESSION_STATUSES,
} from "@synap/database";
import { WORKER_TARGET_ROLE } from "@synap-core/types/workers";
import { createLinks } from "../links/links-service.js";
import { isOutputRefVisible } from "./assert-output-ref-visible.js";
import { SESSION_TARGETS_MAX } from "./session-targets-wire.js";

export {
  SESSION_TARGETS_MAX,
  sessionTargetsSchema,
} from "./session-targets-wire.js";

/** What a write did with each id. */
export interface SessionTargetsWrite {
  /** Newly working on these (a new edge, or an input edge promoted). */
  added: string[];
  /** Already targets of this session: nothing written. */
  already: string[];
}

/** Trimmed, de-duplicated, order kept. */
export function normalizeSessionTargets(
  ids: readonly string[] | null | undefined
): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

/** Why a set of targets is refused, or null. `code` maps to each door's error. */
export type SessionTargetsRefusal = {
  code: "NOT_FOUND" | "BAD_REQUEST";
  message: string;
};

/**
 * The floors, asked BEFORE governance: the session is in flight (when one is
 * given: a new session is), not ending in this same call, and every id names
 * an entity `userId` can see. Null when the targets may be written.
 */
export async function checkSessionTargets(input: {
  userId: string;
  targets: readonly string[];
  /** The session's current status, for an update. Omitted for a start. */
  sessionStatus?: string;
  /** The same call also ends the session (a terminal status). */
  closing?: boolean;
}): Promise<SessionTargetsRefusal | null> {
  if (input.targets.length === 0) return null;
  if (input.targets.length > SESSION_TARGETS_MAX) {
    return {
      code: "BAD_REQUEST",
      message: `targets: at most ${SESSION_TARGETS_MAX} entity ids per call.`,
    };
  }
  if (
    input.closing ||
    (input.sessionStatus !== undefined &&
      !(WORKER_IN_FLIGHT_SESSION_STATUSES as readonly string[]).includes(
        input.sessionStatus
      ))
  ) {
    return {
      code: "BAD_REQUEST",
      message: `Targets are added only while the session is being worked (${WORKER_IN_FLIGHT_SESSION_STATUSES.join(", ")})${input.closing ? "; this call also ends it" : `; it is ${input.sessionStatus}`}. Nothing changed.`,
    };
  }
  const unseen: string[] = [];
  for (const id of input.targets) {
    if (
      !(await isOutputRefVisible({
        userId: input.userId,
        kind: "entity",
        refId: id,
      }))
    ) {
      unseen.push(id);
    }
  }
  if (unseen.length > 0) {
    return {
      code: "NOT_FOUND",
      message: `No entity you can access for target${unseen.length > 1 ? "s" : ""} ${unseen.join(", ")}. Nothing changed.`,
    };
  }
  return null;
}

/**
 * THE writer of a session's targets: one `session --targets--> entity` edge
 * per thing, role {@link WORKER_TARGET_ROLE}, no result. Idempotent; an input
 * edge to the same thing is promoted to a target. The caller has passed the
 * floors ({@link checkSessionTargets}) and its door's governance.
 */
export async function writeSessionTargets(input: {
  sessionId: string;
  workspaceId: string | null;
  entityIds: readonly string[];
}): Promise<SessionTargetsWrite> {
  const ids = normalizeSessionTargets(input.entityIds);
  if (ids.length === 0) return { added: [], already: [] };
  const created = await createLinks(
    ids.map((entityId) => ({
      workspaceId: input.workspaceId,
      fromType: "session" as const,
      fromId: input.sessionId,
      toType: "entity" as const,
      toId: entityId,
      linkType: "targets" as const,
      metadata: { role: WORKER_TARGET_ROLE },
    }))
  );
  const added = new Set(created.map((l) => l.toId));
  const rest = ids.filter((id) => !added.has(id));
  if (rest.length > 0) {
    const promoted = await db
      .update(links)
      .set({
        metadata: drizzleSql`${links.metadata} || ${JSON.stringify({ role: WORKER_TARGET_ROLE })}::jsonb`,
      })
      .where(
        and(
          eq(links.fromType, "session"),
          eq(links.fromId, input.sessionId),
          eq(links.toType, "entity"),
          eq(links.linkType, "targets"),
          inArray(links.toId, rest),
          drizzleSql`${links.metadata}->>'role' IS DISTINCT FROM ${WORKER_TARGET_ROLE}`
        )
      )
      .returning({ toId: links.toId });
    for (const p of promoted) added.add(p.toId);
  }
  return {
    added: ids.filter((id) => added.has(id)),
    already: ids.filter((id) => !added.has(id)),
  };
}
