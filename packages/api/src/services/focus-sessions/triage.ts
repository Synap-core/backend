/**
 * TRIAGE — the lens for sessions somebody else opened for you.
 *
 * An agent or an automation can start a focus session. Until a person says "yes,
 * this is mine to work", such a session is a SUGGESTION, and mixing suggestions
 * into the working list is what makes a session list unreadable: the limit-50
 * page fills with drafts nobody asked for and the real work falls off the end.
 *
 * NO STORED STATUS, for the same reason `blocked` is not a status (see
 * `session-blocked-by.ts`): a triage session is still `active`/`forming`/
 * `scheduled`, and one column cannot hold both. Acceptance is therefore a
 * RECEIPT — `metadata.triage.acceptedAt` (+ `acceptedBy`) — and triage-pending
 * is DERIVED from it every time:
 *
 *   origin ∈ (agent, automation)  AND  metadata.triage.acceptedAt IS NULL
 *   AND status ∈ OPEN_SESSION_STATUSES
 *
 * The predicate exists exactly TWICE and both copies are here: once as SQL (the
 * `list` door's lens, so triage rows never crowd the default page's limit) and
 * once in TypeScript (`isTriagePending`, the row projection the frontend reads
 * instead of re-deriving). They are kept in one file on purpose — a hand-mirrored
 * copy in a router is how the two forks.
 *
 * DISCARD IS CANCEL. There is no "delete a session": discarding routes to the
 * existing terminal status `cancelled`, and — like a close — retires the
 * session's EPHEMERAL proposals, which were bound to work that is now not
 * happening. `focusSessions.update({ status: "cancelled" })`, the pre-existing
 * cancel path, does NOT do that; this door does, and the divergence is named in
 * the Wave B report rather than papered over here.
 */

import {
  db,
  and,
  eq,
  inArray,
  isNull,
  not,
  or,
  drizzleSql,
  focusSessions,
} from "@synap/database";
import type { FocusSession, SQL } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { logEvent } from "../../lib/event-helpers.js";
import { completeFocusSession } from "./complete-session.js";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import { mergeSessionMetadata } from "./session-metadata.js";
import { AGENT_PROPOSAL_PACKAGE_KIND } from "./session-kind.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_TRIAGE_ACCEPT_ACTION,
  FOCUS_SESSION_TRIAGE_ACCEPTED_EVENT_TYPE,
  FOCUS_SESSION_TRIAGE_DISCARD_ACTION,
  FOCUS_SESSION_TRIAGE_DISCARDED_EVENT_TYPE,
} from "./lifecycle-events.js";

/** The origins whose sessions land in triage — nobody triages their own work. */
const TRIAGE_ORIGINS = ["agent", "automation"] as const;

/**
 * SQL: rows that are triage-pending right now.
 *
 * A receipt (an agent's proposal package, `session-kind.ts`) is agent-origin
 * but is NOT a draft anyone accepts — its review happens on the proposals it
 * holds. Excluded here, and in `projectTriage`, so the inbox lists drafts only.
 */
export function triagePendingWhere(): SQL {
  return and(
    drizzleSql`${focusSessions.metadata} #>> '{kind}' IS DISTINCT FROM ${AGENT_PROPOSAL_PACKAGE_KIND}`,
    inArray(focusSessions.origin, [...TRIAGE_ORIGINS]),
    inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
    drizzleSql`${focusSessions.metadata} #>> '{triage,acceptedAt}' IS NULL`
  ) as SQL;
}

/**
 * SQL: rows that are NOT triage-pending — the default lens.
 *
 * `not(triagePendingWhere())` would be wrong on a NULL `origin` (an un-migrated
 * row): `NULL IN (...)` is NULL, and `NOT NULL` is NULL, so the row would vanish
 * from BOTH lenses. Spelled as an explicit OR so an unclassified session stays
 * in the working list, where it was before triage existed.
 */
export function notTriagePendingWhere(): SQL {
  return or(
    isNull(focusSessions.origin),
    not(inArray(focusSessions.origin, [...TRIAGE_ORIGINS])),
    not(inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])),
    drizzleSql`${focusSessions.metadata} #>> '{triage,acceptedAt}' IS NOT NULL`
  ) as SQL;
}

/** The row shape the derivation needs — anything session-like satisfies it. */
export interface TriageProjectable {
  origin?: string | null;
  status?: string | null;
  metadata?: unknown;
}

export interface TriageProjection {
  /** Waiting for a human to accept or discard it. */
  pending: boolean;
  /** When a human accepted it (ISO), or null. */
  acceptedAt: string | null;
  /** Who accepted it, or null. */
  acceptedBy: string | null;
}

function triageReceipt(metadata: unknown): {
  acceptedAt: string | null;
  acceptedBy: string | null;
} {
  const bag = (metadata ?? {}) as { triage?: unknown };
  const t = (bag.triage ?? {}) as {
    acceptedAt?: unknown;
    acceptedBy?: unknown;
  };
  return {
    acceptedAt: typeof t.acceptedAt === "string" ? t.acceptedAt : null,
    acceptedBy: typeof t.acceptedBy === "string" ? t.acceptedBy : null,
  };
}

/**
 * THE derivation, in TypeScript — the SQL above and this must agree, which is
 * why they live in one file. Projected onto every `list`/`get` row so no
 * consumer re-implements the predicate.
 */
export function projectTriage(row: TriageProjectable): TriageProjection {
  const receipt = triageReceipt(row.metadata);
  const bag = (row.metadata ?? {}) as Record<string, unknown>;
  const pending =
    bag["kind"] !== AGENT_PROPOSAL_PACKAGE_KIND &&
    !!row.origin &&
    (TRIAGE_ORIGINS as readonly string[]).includes(row.origin) &&
    !!row.status &&
    (OPEN_SESSION_STATUSES as readonly string[]).includes(row.status) &&
    receipt.acceptedAt === null;
  return { pending, ...receipt };
}

/** Attach the projection to a page of rows (no extra query — pure). */
export function attachTriage<T extends TriageProjectable>(
  rows: readonly T[]
): Array<T & { triage: TriageProjection }> {
  return rows.map((r) => ({ ...r, triage: projectTriage(r) }));
}

export interface TriageDecisionInput {
  sessionId: string;
  /** Owner floor — triage is a decision only the session's owner can make. */
  userId: string;
}

export type TriageDecisionResult =
  | { ok: true; session: FocusSession }
  | { ok: false; reason: "not_found" | "not_pending" };

/** Load with the owner floor. `focus_sessions` is owner-private. */
async function loadOwned(
  sessionId: string,
  userId: string
): Promise<FocusSession | null> {
  const row = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
  });
  return (row as FocusSession | undefined) ?? null;
}

/**
 * "Accept as ready" — a human takes ownership of a session an agent or an
 * automation opened. Stamps the receipt; changes NO status (the session was
 * already active, and pretending otherwise would destroy its real state).
 */
export async function acceptFromTriage(
  input: TriageDecisionInput
): Promise<TriageDecisionResult> {
  const session = await loadOwned(input.sessionId, input.userId);
  if (!session) return { ok: false, reason: "not_found" };
  if (!projectTriage(session).pending) {
    return { ok: false, reason: "not_pending" };
  }

  const acceptedAt = new Date().toISOString();
  const [updated] = await db
    .update(focusSessions)
    .set({
      metadata: mergeSessionMetadata({
        triage: { acceptedAt, acceptedBy: input.userId },
      }),
      updatedAt: new Date(),
    })
    .where(eq(focusSessions.id, session.id))
    .returning();

  const data = {
    sessionId: updated.id,
    workspaceId: updated.workspaceId,
    projectId: updated.projectId,
    userId: input.userId,
    origin: updated.origin,
    goal: updated.goal,
    acceptedAt,
  };
  // BOTH halves, for the reason close-event.ts spells out: `logEvent` is the
  // persisted history row a later reader can see; `emitSideEffects` is the
  // transient reactor hop an automation can fire on. Neither substitutes.
  await logEvent(input.userId, FOCUS_SESSION_TRIAGE_ACCEPTED_EVENT_TYPE, data, {
    subjectId: updated.id,
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    source: "api",
  });
  await emitSideEffects({
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    action: FOCUS_SESSION_TRIAGE_ACCEPT_ACTION,
    subjectId: updated.id,
    userId: input.userId,
    workspaceId: updated.workspaceId,
    sessionId: updated.id,
    data,
  });

  return { ok: true, session: updated as FocusSession };
}

export type TriageDiscardResult =
  | { ok: true; session: FocusSession; expiredEphemerals: number }
  | { ok: false; reason: "not_found" | "not_pending" };

/**
 * Discard — the negative half. Routes to the existing terminal status
 * `cancelled` (nothing is deleted: the session, its channel and its history
 * stay readable), stamps who discarded it and when, and retires the ephemeral
 * proposals that were bound to work now not happening.
 */
export async function discardFromTriage(
  input: TriageDecisionInput
): Promise<TriageDiscardResult> {
  const session = await loadOwned(input.sessionId, input.userId);
  if (!session) return { ok: false, reason: "not_found" };
  if (!projectTriage(session).pending) {
    return { ok: false, reason: "not_pending" };
  }

  // ONE close door: discard is a terminal exit like any other, so it runs the
  // pack + run close + ephemeral expiry + close event (the unblock reactor and
  // the automation matcher only listen there). A bare `status: "cancelled"`
  // write here was the dual path the tRPC/Hub doors were just cured of.
  const discardedAt = new Date();
  const closed = await completeFocusSession({
    sessionId: session.id,
    userId: input.userId,
    terminalStatus: "cancelled",
  });
  if (!closed) return { ok: false, reason: "not_found" };
  const expiredEphemerals = closed.counts.expiredEphemerals;
  const [updated] = await db
    .update(focusSessions)
    .set({
      metadata: mergeSessionMetadata({
        triage: {
          discardedAt: discardedAt.toISOString(),
          discardedBy: input.userId,
        },
      }),
      updatedAt: discardedAt,
    })
    .where(eq(focusSessions.id, session.id))
    .returning();

  const data = {
    sessionId: updated.id,
    workspaceId: updated.workspaceId,
    projectId: updated.projectId,
    userId: input.userId,
    origin: updated.origin,
    goal: updated.goal,
    status: updated.status,
    expiredEphemerals,
  };
  await logEvent(
    input.userId,
    FOCUS_SESSION_TRIAGE_DISCARDED_EVENT_TYPE,
    data,
    {
      subjectId: updated.id,
      subjectType: FOCUS_SESSION_SUBJECT_TYPE,
      source: "api",
    }
  );
  await emitSideEffects({
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    action: FOCUS_SESSION_TRIAGE_DISCARD_ACTION,
    subjectId: updated.id,
    userId: input.userId,
    workspaceId: updated.workspaceId,
    sessionId: updated.id,
    data,
  });

  return { ok: true, session: updated as FocusSession, expiredEphemerals };
}
