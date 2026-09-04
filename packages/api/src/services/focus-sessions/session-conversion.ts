/**
 * SESSION → CONFIG CONVERSIONS: the rename, the receipt, and the undo.
 *
 * Two verbs turn a finished piece of work into reusable structure: promote
 * (session → playbook) and spawn (session → project). Both are STRUCTURE-ONLY —
 * goal shape and expected outputs travel, layout does not.
 *
 * WHY THE SOURCE IS RENAMED. Linear's "Convert to project" is the shipped prior
 * art: after a conversion the source object is retitled so the list it still
 * lives in says what happened to it. Without that, a session list shows a goal
 * that reads exactly like unfinished work, and the person re-opens it. The new
 * goal is `"<original goal> → playbook <name>"`, and the receipt names BOTH
 * sides so the caller can say "Promoted 'X' to playbook 'Y'" without a second
 * lookup.
 *
 * WHY THE UNDO IS AN INVERSE VERB, NOT A DELAYED EFFECT. Gmail's undo-send is
 * the nicer shape — hold the effect for N seconds, then commit — and pg-boss's
 * `startAfter` could carry it. It is the wrong shape HERE: a conversion's whole
 * point is that the caller gets the new object's id back immediately (the client
 * navigates to it), so the effect cannot be held. What is honest at this size is
 * the inverse verb: `revertConversion` restores the session's goal, retires the
 * created object, and drops the lineage edge — refusing once the object has been
 * touched or the window has passed.
 *
 * RETIRE, NOT DELETE. Revert ARCHIVES the created playbook/project rather than
 * hard-deleting it. Both kinds already have an `archived` status, archiving frees
 * the name (the playbooks unique index is on non-archived rows), and an undo that
 * destroys rows is a worse failure mode than one that hides them.
 */

import {
  db,
  and,
  eq,
  ne,
  not,
  count,
  focusSessions,
  playbooks,
  playbookRuns,
  projects,
  links,
} from "@synap/database";
import type { FocusSession } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { logEvent } from "../../lib/event-helpers.js";
import { mergeSessionMetadata } from "./session-metadata.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_REVERT_ACTION,
  FOCUS_SESSION_CONVERSION_REVERTED_EVENT_TYPE,
} from "./lifecycle-events.js";

/** The kinds a session can be converted INTO. */
export type ConversionKind = "playbook" | "project";

/**
 * How long the inverse verb stays available. 15 minutes, not 30 seconds: this
 * is not a send you regret in the same breath, it is a structural change whose
 * wrongness shows up when you open the thing you just made. The window is a
 * REFUSAL rule, not a scheduler — nothing expires it in the background.
 */
export const CONVERSION_UNDO_WINDOW_MS = 15 * 60 * 1000;

/** The receipt every conversion verb returns. Frontend renders it verbatim. */
export interface ConversionReceipt {
  created: { kind: ConversionKind; id: string; name: string };
  /** The session's goal BEFORE the rename (null when the rename was skipped). */
  renamedFrom: string | null;
  /** The session's goal AFTER the rename. */
  renamedTo: string;
  /** ISO deadline after which `revertConversion` refuses. */
  undoUntil: string;
}

/** What is persisted on `focus_sessions.metadata.conversion`. */
interface StoredConversion {
  kind: ConversionKind;
  id: string;
  name: string;
  renamedFrom: string | null;
  at: string;
  by: string;
  revertedAt?: string;
}

/** `focus_sessions.goal` is capped at 2000 by every write door. */
const GOAL_MAX = 2000;

/**
 * The renamed goal. Idempotent: re-converting an already-renamed session does
 * not stack arrows, because the suffix is matched before it is appended.
 */
export function conversionGoal(
  goal: string,
  kind: ConversionKind,
  name: string
): string {
  const suffix = ` → ${kind} ${name}`;
  if (goal.endsWith(suffix)) return goal;
  const head = goal.slice(0, Math.max(0, GOAL_MAX - suffix.length));
  return `${head}${suffix}`;
}

function readConversion(metadata: unknown): StoredConversion | null {
  const bag = (metadata ?? {}) as { conversion?: unknown };
  const c = bag.conversion as StoredConversion | undefined;
  if (!c || typeof c !== "object") return null;
  if (c.kind !== "playbook" && c.kind !== "project") return null;
  if (typeof c.id !== "string" || typeof c.at !== "string") return null;
  return c;
}

/**
 * Rename the session and stamp the conversion receipt. Called by BOTH verbs, so
 * promote and spawn can never disagree about the shape.
 */
export async function recordConversion(params: {
  session: Pick<FocusSession, "id" | "goal">;
  kind: ConversionKind;
  createdId: string;
  createdName: string;
  userId: string;
}): Promise<ConversionReceipt> {
  const { session, kind, createdId, createdName, userId } = params;
  const renamedTo = conversionGoal(session.goal, kind, createdName);
  const renamed = renamedTo !== session.goal;
  const at = new Date();
  const stored: StoredConversion = {
    kind,
    id: createdId,
    name: createdName,
    renamedFrom: renamed ? session.goal : null,
    at: at.toISOString(),
    by: userId,
  };

  await db
    .update(focusSessions)
    .set({
      goal: renamedTo,
      metadata: mergeSessionMetadata({ conversion: stored }),
      updatedAt: at,
    })
    .where(eq(focusSessions.id, session.id));

  return {
    created: { kind, id: createdId, name: createdName },
    renamedFrom: stored.renamedFrom,
    renamedTo,
    undoUntil: new Date(at.getTime() + CONVERSION_UNDO_WINDOW_MS).toISOString(),
  };
}

export type RevertResult =
  | {
      ok: true;
      /** The goal the session was restored to. */
      goal: string;
      /** The created object, archived (a used object refuses with `object_in_use`). */
      retired: { kind: ConversionKind; id: string; name: string };
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "no_conversion"
        | "already_reverted"
        | "window_expired"
        | "object_in_use";
    };

/** Has the created object been used since? Then the undo must refuse. */
async function objectIsUntouched(
  kind: ConversionKind,
  id: string,
  sessionId: string,
  /**
   * The session's subject entity, when it had one. `spawnProjectFromSession`
   * carries it onto the new project as `project --targets--> entity`, so that
   * edge is the SPAWN'S OWN and must not count as somebody else using the
   * project — counting it made revert refuse `object_in_use` for every spawn
   * from a subject-bound session, i.e. the undo never worked at all there.
   */
  subjectEntityId: string | null
): Promise<boolean> {
  if (kind === "playbook") {
    // A playbook that has RUN is somebody's history — never retire it.
    const [runs] = await db
      .select({ n: count() })
      .from(playbookRuns)
      .where(eq(playbookRuns.playbookId, id));
    if ((runs?.n ?? 0) > 0) return false;
    const row = await db.query.playbooks.findFirst({
      where: eq(playbooks.id, id),
      columns: { id: true, status: true },
    });
    // Still the draft the promote minted, and still present.
    return !!row && row.status === "draft";
  }

  // A project is in use the moment anything ELSE points at it: another session
  // scoped to it, or any link that is not our own lineage edge.
  const [otherSessions] = await db
    .select({ n: count() })
    .from(focusSessions)
    .where(
      and(eq(focusSessions.projectId, id), ne(focusSessions.id, sessionId))
    );
  if ((otherSessions?.n ?? 0) > 0) return false;
  const [otherLinks] = await db
    .select({ n: count() })
    .from(links)
    .where(
      and(
        eq(links.toType, "project"),
        eq(links.toId, id),
        ne(links.linkType, "promoted_to")
      )
    );
  if ((otherLinks?.n ?? 0) > 0) return false;
  const outboundConditions = [
    eq(links.fromType, "project"),
    eq(links.fromId, id),
  ];
  if (subjectEntityId) {
    // Exclude the subject edge the spawn itself wrote (see the parameter).
    outboundConditions.push(
      not(
        and(
          eq(links.linkType, "targets"),
          eq(links.toType, "entity"),
          eq(links.toId, subjectEntityId)
        )!
      )
    );
  }
  const [outbound] = await db
    .select({ n: count() })
    .from(links)
    .where(and(...outboundConditions));
  if ((outbound?.n ?? 0) > 0) return false;
  const row = await db.query.projects.findFirst({
    where: eq(projects.id, id),
    columns: { id: true, status: true },
  });
  return !!row && row.status === "active";
}

/**
 * THE inverse verb — one door for both conversions. Restores the goal, archives
 * the created object when it is still untouched, and drops the lineage edge.
 *
 * Refuses (never partially applies) when the object has been used: a promotion
 * whose playbook already ran is history, and silently archiving it would be a
 * destructive undo wearing a friendly name.
 */
export async function revertConversion(params: {
  sessionId: string;
  userId: string;
}): Promise<RevertResult> {
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, params.sessionId),
      eq(focusSessions.userId, params.userId)
    ),
  });
  if (!session) return { ok: false, reason: "not_found" };

  const conversion = readConversion(session.metadata);
  if (!conversion) return { ok: false, reason: "no_conversion" };
  if (conversion.revertedAt) return { ok: false, reason: "already_reverted" };
  if (Date.now() - Date.parse(conversion.at) > CONVERSION_UNDO_WINDOW_MS) {
    return { ok: false, reason: "window_expired" };
  }

  const untouched = await objectIsUntouched(
    conversion.kind,
    conversion.id,
    session.id,
    session.subjectEntityId ?? null
  );
  if (!untouched) return { ok: false, reason: "object_in_use" };

  // Archive the created object.
  if (conversion.kind === "playbook") {
    await db
      .update(playbooks)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(playbooks.id, conversion.id));
  } else {
    await db
      .update(projects)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(projects.id, conversion.id));
  }

  // Drop the lineage edge — the conversion did not happen.
  await db
    .delete(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.fromId, session.id),
        eq(links.toType, conversion.kind),
        eq(links.toId, conversion.id),
        eq(links.linkType, "promoted_to")
      )
    );

  const restoredGoal = conversion.renamedFrom ?? session.goal;
  const revertedAt = new Date();
  await db
    .update(focusSessions)
    .set({
      goal: restoredGoal,
      metadata: mergeSessionMetadata({
        conversion: { ...conversion, revertedAt: revertedAt.toISOString() },
      }),
      updatedAt: revertedAt,
    })
    .where(eq(focusSessions.id, session.id));

  const data = {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    userId: params.userId,
    goal: restoredGoal,
    revertedKind: conversion.kind,
    revertedId: conversion.id,
    revertedName: conversion.name,
  };
  await logEvent(
    params.userId,
    FOCUS_SESSION_CONVERSION_REVERTED_EVENT_TYPE,
    data,
    {
      subjectId: session.id,
      subjectType: FOCUS_SESSION_SUBJECT_TYPE,
      source: "api",
    }
  );
  await emitSideEffects({
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    action: FOCUS_SESSION_REVERT_ACTION,
    subjectId: session.id,
    userId: params.userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    data,
  });

  return {
    ok: true,
    goal: restoredGoal,
    retired: {
      kind: conversion.kind,
      id: conversion.id,
      name: conversion.name,
    },
  };
}
