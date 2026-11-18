/**
 * `supersedes` at the Hub REST door (plan 8032a127 D3): the routes of
 * {@link SUPERSEDES_DOORS} file the request through `fileSuperseding`, the
 * SAME function the MCP adapter calls. The Intelligence Service reaches the
 * pod only through Hub REST, and Ask AI wakes it on a failed proposal it did
 * not author (it may not revise it): without this door it could only file
 * the fix beside the failure, an orphan the person has to clean up
 * (finding d6ac7003).
 *
 * ONE wrapper, mounted on each door's route in `hub-protocol-rest.ts`, not a
 * copy in each route: the routes stay as they are, and the filing they make
 * inside `next()` is what ends the failed proposal (the insert door reads it
 * from the request context). It reads the body Hono already caches, so the
 * route reads the same body after it.
 *
 * The reply: a refusal is a 409 `SUPERSEDES_REFUSED` and nothing was filed
 * (400 when the field is not an id). Otherwise the route's own JSON answer
 * gains `supersedes: { proposalId, replacedBy }`, plus a `note` when the call
 * filed nothing for review and the failed proposal is still failed.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import {
  fileSuperseding,
  leftFailedNote,
  readSupersedes,
} from "../../../services/proposals/supersedes-door.js";
import { actingUserIdFor } from "../rest/_shared.js";

/** The code of every `supersedes` refusal on the wire. */
export const SUPERSEDES_REFUSED = "SUPERSEDES_REFUSED";

/** The wrapper for one door's route, answering only its `method`. */
export function supersedesMiddleware(method: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (c.req.method !== method) return next();
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return next(); // the route answers a body it cannot read
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("supersedes" in body)
    ) {
      return next();
    }
    const fields = body as Record<string, unknown>;
    const read = readSupersedes(fields.supersedes);
    if (!read.ok) {
      return c.json({ error: read.problem, code: SUPERSEDES_REFUSED }, 400);
    }
    if (!read.id) return next();
    // The person the filing acts for, bound as every one of these routes
    // binds it (`actingUserIdFor`, directly or through `resolveActingContext`).
    const owner = actingUserIdFor(
      { get: (key: string) => c.get(key as never) },
      typeof fields.userId === "string" ? fields.userId : undefined
    );
    if (!owner) {
      return c.json(
        { error: "userId does not match the authenticated session" },
        403
      );
    }
    const run = await fileSuperseding(read.id, owner, () => next());
    if (run.refused !== null) {
      return c.json({ error: run.refused, code: SUPERSEDES_REFUSED }, 409);
    }
    if (run.slot) await withSupersedesReply(c, run.slot);
  };
}

/** The route's JSON answer, with what became of the failed proposal. */
async function withSupersedesReply(
  c: Context,
  slot: { proposalId: string; replacedBy: string | null }
): Promise<void> {
  if (!(c.res.headers.get("content-type") ?? "").includes("application/json"))
    return;
  let answer: unknown;
  try {
    answer = await c.res.clone().json();
  } catch {
    return;
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return;
  const ok = c.res.status < 300;
  const told = {
    ...(answer as Record<string, unknown>),
    supersedes: {
      proposalId: slot.proposalId,
      replacedBy: slot.replacedBy,
      ...(ok && !slot.replacedBy ? { note: leftFailedNote(slot) } : {}),
    },
  };
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  const status = c.res.status;
  // Cleared first: Hono's `res` setter otherwise copies the old response's
  // headers onto the new one (a stale content-length among them).
  c.res = undefined;
  c.res = new Response(JSON.stringify(told), { status, headers });
}
