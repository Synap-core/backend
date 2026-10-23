/**
 * resolveWorkSession — the ONE answer to "which session does this AI call
 * belong to", for every door that has no session named in hand.
 *
 * Precedence:
 *   1. EXPLICIT — the caller named a session (MCP `sessionId` arg, Hub
 *      `X-Session-Id`). Ownership-checked; a handle that is not the caller's is
 *      DROPPED and reported, never promoted and never an error.
 *   2. CLIENT — the session bound to THIS client (`findClientSession`, keyed on
 *      the request's client key = the CONVERSATION, `clientKeyForApiKey`): one
 *      it started itself, else the one the governance gate auto-opened for it
 *      while that is still in its window. A KEY-scoped client (option A: the
 *      door knows no conversation) only ever gets the key's auto-opened one.
 *   3. UNCLAIMED — exactly ONE open WORK session that no client has claimed (a
 *      session the person opened) and that was TOUCHED in the last
 *      {@link UNCLAIMED_TOUCHED_WITHIN_HOURS} hours. More than one ⇒ NO guess,
 *      and the caller is told the exact number. SKIPPED for a
 *      key-scoped client: with no conversation to tell callers apart, every
 *      conversation on the key would land in it (option A = named or own
 *      auto-opened only).
 *   4. none. The write path then auto-opens at the governance gate
 *      (`resolveOrCreateAgentProposalSession` via `checkPermissionOrPropose`,
 *      grouped by the same client key), so a tool call that ends up writing
 *      nothing never leaves an empty session behind, and there is one mint
 *      point, not one per door.
 *
 * What this replaced: MCP attributed to "the newest open work session
 * pod-wide", so two agents working in parallel filed each other's writes, and
 * an agent's write landed in whatever the person had last opened in the
 * browser. A client never inherits another client's session now.
 *
 * DEFAULT, never enforcement: nothing here refuses a write.
 */
import {
  db,
  focusSessions,
  and,
  eq,
  inArray,
  desc,
  drizzleSql,
  findClientSession,
  getRequestClientKey,
  clientKeyScope,
  sessionLastActivitySql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import { ambientWorkWhere } from "./session-kind.js";

const logger = createLogger({ module: "focus-sessions/resolve-work-session" });

export type WorkSessionSource = "explicit" | "client" | "unclaimed" | "none";

export interface WorkSessionResolution {
  sessionId?: string;
  source: WorkSessionSource;
  /** `client` only: the gate auto-opened it (not started by the client). */
  autoOpened?: boolean;
  /**
   * `client` + auto-opened only: the receipt's project (its key half, B4). The
   * gate files a write of ANOTHER project under that project's receipt.
   */
  receiptProjectId?: string | null;
  /**
   * Open UNCLAIMED work sessions counted on rung 3. `null` = not counted (an
   * earlier rung answered, or the read failed — a failed read is not zero).
   */
  unclaimedOpenCount: number | null;
  /** The explicit handle the resolver DROPPED (rung 1 miss). */
  ignoredSession?: {
    sessionId: string;
    reason: "not-owned" | "ownership-check-failed";
  };
}

export interface ResolveWorkSessionInput {
  userId: string;
  explicitSessionId?: string | null;
  /** Absent ⇒ the request's key-auth client (`getRequestClientKey`). */
  clientKey?: string | null;
}

/**
 * The client key this request groups under, or undefined when the door knows
 * no client (a human session, stdio MCP). Mirrors the packager's fallback so
 * the lookup here and the auto-open at the gate key the same client.
 */
export function requestClientKey(
  agentUserId: string | undefined
): string | undefined {
  return (
    getRequestClientKey() ?? (agentUserId ? `agent:${agentUserId}` : undefined)
  );
}

async function checkOwnership(
  userId: string,
  sessionId: string
): Promise<"owned" | "not-owned" | "ownership-check-failed"> {
  try {
    const [row] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
      )
      .limit(1);
    return row ? "owned" : "not-owned";
  } catch (err) {
    // "Could not check" is its own outcome, never widened into "owned".
    logger.warn({ err, sessionId }, "session ownership check failed");
    return "ownership-check-failed";
  }
}

/**
 * How recently a session must have been touched to count as one the person is
 * working in (B4 2026-10-21). The pile of open sessions nobody closed (93 on
 * the founder's pod, 30 untouched for days) made every write say "several
 * sessions are open" — a number that meant nothing. "Touched" is the receipt
 * window's own definition (`sessionLastActivitySql`).
 */
export const UNCLAIMED_TOUCHED_WITHIN_HOURS = 24;

/** The rung-3 population: open, unclaimed WORK sessions touched recently. */
function unclaimedOpenWorkWhere(userId: string) {
  return and(
    eq(focusSessions.userId, userId),
    // `scheduled` is a future appointment, never where a present write goes.
    inArray(
      focusSessions.status,
      OPEN_SESSION_STATUSES.filter((s) => s !== "scheduled")
    ),
    // A session the PERSON is in — `work`, plus a work session they
    // later attached to a playbook (which reads `run` by design).
    ambientWorkWhere(),
    drizzleSql`${focusSessions.metadata} ->> 'clientKey' IS NULL`,
    drizzleSql`${sessionLastActivitySql()} > now() - (${UNCLAIMED_TOUCHED_WITHIN_HOURS}::int * interval '1 hour')`
  );
}

/** Open sessions the person is in, unclaimed (newest first, at most `limit`). */
export async function listUnclaimedOpenWorkSessions(
  userId: string,
  limit = 2
): Promise<Array<{ id: string }>> {
  return (
    db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(unclaimedOpenWorkWhere(userId))
      // SESSION-KIND-LENS-EXEMPT: an attribution resolver, not a list door — it
      // NARROWS via `ambientWorkWhere` above and returns ids only.
      .orderBy(desc(focusSessions.startedAt))
      .limit(limit)
  );
}

/** How many of them there are — exact, never capped (ui-composition §11). */
export async function countUnclaimedOpenWorkSessions(
  userId: string
): Promise<number> {
  const [row] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(focusSessions)
    // SESSION-KIND-LENS-EXEMPT: a count for the attribution note, same rung-3
    // population as the list above.
    .where(unclaimedOpenWorkWhere(userId));
  return Number(row?.n);
}

export async function resolveWorkSession(
  input: ResolveWorkSessionInput
): Promise<WorkSessionResolution> {
  const explicit = input.explicitSessionId?.trim();
  if (explicit) {
    const ownership = await checkOwnership(input.userId, explicit);
    if (ownership === "owned") {
      return {
        sessionId: explicit,
        source: "explicit",
        unclaimedOpenCount: null,
      };
    }
    logger.warn(
      { userId: input.userId, sessionId: explicit, ownership },
      "session handle does not belong to the caller — ignoring"
    );
    // A dropped explicit handle does NOT fall through to a guess: the caller
    // named a session, and filing into a different one would be worse than none.
    return {
      source: "none",
      unclaimedOpenCount: null,
      ignoredSession: { sessionId: explicit, reason: ownership },
    };
  }

  const clientKey = input.clientKey ?? getRequestClientKey();
  if (clientKey) {
    try {
      const bound = await findClientSession(input.userId, clientKey);
      if (bound) {
        return {
          sessionId: bound.id,
          source: "client",
          autoOpened: bound.autoOpened,
          ...(bound.autoOpened ? { receiptProjectId: bound.projectId } : {}),
          unclaimedOpenCount: null,
        };
      }
    } catch (err) {
      // A FAILED lookup is not "this client has no session". Falling through
      // would hand the caller the one unclaimed session on the pod — the
      // cross-client mis-attribution this door exists to end. Same policy as
      // the dropped explicit handle above and the unclaimed read below.
      logger.warn({ err, clientKey }, "client session lookup failed");
      return { source: "none", unclaimedOpenCount: null };
    }
  }

  // Option A: a key shared by several conversations never guesses rung 3.
  if (clientKey && clientKeyScope(clientKey) === "key") {
    return { source: "none", unclaimedOpenCount: null };
  }

  let unclaimed: Array<{ id: string }>;
  let unclaimedCount: number;
  try {
    // Two are enough to tell "exactly one" from "several"; the count of
    // several is read exactly, never stopped at a page size (it used to print
    // "10 of your sessions" for 27).
    unclaimed = await listUnclaimedOpenWorkSessions(input.userId, 2);
    unclaimedCount =
      unclaimed.length > 1
        ? await countUnclaimedOpenWorkSessions(input.userId)
        : unclaimed.length;
  } catch (err) {
    logger.warn({ err, userId: input.userId }, "open session read failed");
    return { source: "none", unclaimedOpenCount: null };
  }
  if (unclaimed.length === 1) {
    return {
      sessionId: unclaimed[0].id,
      source: "unclaimed",
      unclaimedOpenCount: 1,
    };
  }
  if (unclaimed.length > 1) {
    logger.info(
      { userId: input.userId, openCount: unclaimedCount },
      "several open work sessions and none bound to this client — not guessing"
    );
  }
  return { source: "none", unclaimedOpenCount: unclaimedCount };
}
