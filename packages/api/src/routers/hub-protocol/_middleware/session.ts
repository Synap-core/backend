/**
 * Hub Protocol focus-session middleware.
 *
 * The CLI (and any session-aware client) tags EVERY `/api/hub/*` call with an
 * `X-Session-Id` header naming the focus session the work belongs to. Before
 * this middleware only four route files read it by hand
 * (`rest/entities.ts`, `rest/documents.ts`, `rest/capture.ts`,
 * `rest/proposals.ts`); everywhere else it was dropped, so most Hub-authored
 * proposals landed with `sessionId = NULL` and could not be grouped back to the
 * intent that produced them.
 *
 * It is read ONCE here and lands on `c.set("sessionId", …)` → `getCaller`'s
 * default → `ctx.sessionId` → the proposal row.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * `X-Session-Id` is CLIENT-SUPPLIED and must never be trusted as-is: honoured
 * blind, any caller could forge session attribution and point another user's
 * session at their own writes. So the header is only promoted after BOTH:
 *   1. it parses as a UUID (the column is `uuid`), and
 *   2. a `focus_sessions` row with that id exists AND `userId` equals the
 *      authenticated principal (post-remap — the same floor the rest of the
 *      request runs on).
 *
 * This mirrors the check the MCP path already performs (`ownsFocusSession` in
 * `routers/mcp/adapter.ts`). Like that one, it is a SCOPE HINT and not an
 * authorization decision, so a mismatch DROPS the handle to `undefined` and
 * logs — it never throws. A stale header left over from a session that has
 * since closed must not break an unrelated write.
 */

import type { Context, Next } from "hono";
import { createLogger } from "@synap-core/core";
import { db, focusSessions, and, eq } from "@synap/database";

const logger = createLogger({ module: "hub-protocol-session" });

/** RFC-4122 shape check — cheap reject before paying for a DB round-trip. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Does this `focus_sessions` row belong to `userId`?
 *
 * Any status is accepted (including closed/stale): attribution is historical —
 * a write that finishes just after its session closed still belongs to it — and
 * the ownership floor, not the status, is what makes the handle safe.
 *
 * Fails CLOSED on a lookup error: an unverifiable handle is never promoted.
 */
export async function ownsFocusSession(
  userId: string,
  sessionId: string
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
      )
      .limit(1);
    return Boolean(row);
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "hub: focus-session ownership check failed — dropping handle"
    );
    return false;
  }
}

/**
 * Resolve `X-Session-Id` into a VERIFIED session id, or `undefined`.
 *
 * Exported separately from the middleware so it can be unit-tested without a
 * Hono request.
 */
export async function resolveHubSessionHeader(
  rawHeader: string | undefined,
  userId: string | undefined
): Promise<string | undefined> {
  const candidate = rawHeader?.trim();
  if (!candidate || !userId) return undefined;
  if (!UUID_RE.test(candidate)) {
    logger.warn(
      { userId, sessionId: candidate },
      "hub: X-Session-Id is not a uuid — ignoring"
    );
    return undefined;
  }
  if (await ownsFocusSession(userId, candidate)) return candidate;
  logger.warn(
    { userId, sessionId: candidate },
    "hub: X-Session-Id does not belong to the caller — ignoring"
  );
  return undefined;
}

/**
 * Hono middleware. Mount AFTER the auth middleware (it reads the resolved
 * `userId`) and before the route registrations.
 */
export async function sessionMiddleware(
  c: Context<{ Variables: { userId: string; sessionId?: string } }>,
  next: Next
): Promise<void> {
  const raw = c.req.header("x-session-id");
  // No header → no DB round-trip. The overwhelmingly common case.
  if (raw) {
    const userId = c.get("userId") as string | undefined;
    const resolved = await resolveHubSessionHeader(raw, userId);
    if (resolved) c.set("sessionId", resolved);
  }
  await next();
}

/**
 * Resolve the ONE session handle a request may be attributed to, from the two
 * places a caller can put it.
 *
 * The `X-Session-Id` header is already verified by the time it reaches a
 * handler (`resolveHubSessionHeader`, above). A handle on the request BODY is
 * not — and a body field is the only handle a body-only caller has, which is
 * exactly how the Relay app sends it on `capture.execute`. Left unchecked, a
 * caller can stamp ANOTHER USER'S session onto their own rows: that user's
 * session graph grows an edge to a foreign entity and their derived participant
 * list shows someone who never worked there.
 *
 * Same contract as the header path, deliberately: this is a SCOPE HINT, not an
 * authorization decision. A handle that fails ownership DROPS to `undefined`
 * and the write proceeds unattributed, because a stale or foreign session id
 * must never fail a write the user meant to make.
 */
export async function resolveVerifiedSessionId(
  userId: string,
  verifiedHandle: string | null | undefined,
  bodyHandle: string | null | undefined
): Promise<string | undefined> {
  // The header handle already passed `ownsFocusSession`; re-checking it would
  // buy nothing and cost a round-trip on every attributed write.
  if (verifiedHandle) return verifiedHandle;
  if (!bodyHandle) return undefined;
  if (!UUID_RE.test(bodyHandle)) return undefined;
  if (await ownsFocusSession(userId, bodyHandle)) return bodyHandle;
  logger.warn(
    { userId, sessionId: bodyHandle },
    "session handle on the request body does not belong to the caller — ignoring"
  );
  return undefined;
}
