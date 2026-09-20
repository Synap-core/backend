/**
 * resolveWorkSession — the ONE answer to "which session does this AI call
 * belong to", for every door that has no session named in hand.
 *
 * Precedence:
 *   1. EXPLICIT — the caller named a session (MCP `sessionId` arg, Hub
 *      `X-Session-Id`). Ownership-checked; a handle that is not the caller's is
 *      DROPPED and reported, never promoted and never an error.
 *   2. CLIENT — the session bound to THIS client (`findClientSession`, keyed on
 *      the request's client key): one it started itself, else the one the
 *      governance gate auto-opened for it while that is still in its window.
 *   3. UNCLAIMED — exactly ONE open WORK session that no client has claimed (a
 *      session the person opened). More than one ⇒ NO guess.
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

/** Open sessions the person is in, unclaimed (newest first, at most `limit`). */
export async function listUnclaimedOpenWorkSessions(
  userId: string,
  limit = 2
): Promise<Array<{ id: string }>> {
  return (
    db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          // `scheduled` is a future appointment, never where a present write goes.
          inArray(
            focusSessions.status,
            OPEN_SESSION_STATUSES.filter((s) => s !== "scheduled")
          ),
          // A session the PERSON is in — `work`, plus a work session they
          // later attached to a playbook (which reads `run` by design).
          ambientWorkWhere(),
          drizzleSql`${focusSessions.metadata} ->> 'clientKey' IS NULL`
        )
      )
      // SESSION-KIND-LENS-EXEMPT: an attribution resolver, not a list door — it
      // NARROWS via `ambientWorkWhere` above and returns ids only.
      .orderBy(desc(focusSessions.startedAt))
      .limit(limit)
  );
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

  let unclaimed: Array<{ id: string }>;
  try {
    unclaimed = await listUnclaimedOpenWorkSessions(input.userId, 10);
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
      { userId: input.userId, openCount: unclaimed.length },
      "several open work sessions and none bound to this client — not guessing"
    );
  }
  return { source: "none", unclaimedOpenCount: unclaimed.length };
}
