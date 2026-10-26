/**
 * GUEST CONTAINMENT — the one refusal for a signed-in GUEST (a `project_members`
 * role `guest` with no pod participation, `podGuestWhere`).
 *
 * A guest was let in to READ what an owner shared with them. Every read floor
 * already narrows a guest to the exposure branch, but the write doors did not
 * know guests exist: `workspaces.create` wrote an owned workspace, which IS
 * participation (`podParticipantWhere`: "owns a workspace"), so one call turned
 * a guest into a pod reader. Refusing per router would leave the next door
 * open, so the refusal sits on the base procedures and on the two non-tRPC
 * authenticated doors:
 *
 *   - tRPC: `guestContainmentMiddleware` on `publicProcedure` (every procedure
 *     is built from it) and again after `apiKeyMiddleware` (which sets the
 *     principal later in the chain). Every MUTATION a guest sends over tRPC HTTP
 *     is refused unless its path is in `GUEST_MUTATION_ALLOWLIST`. Queries pass:
 *     they read through the access-layer floors, which are guest-correct on
 *     their own.
 *   - Hub REST (`hubAuthMiddleware`) and MCP (`POST /mcp`): a guest is refused
 *     on EVERY route. Those doors serve agents, the IS and tooling; a guest has
 *     no use for them, and their ~50 sub-routers were never audited for guests.
 *   - Every other Hono door that signs a person in with the session
 *     `authMiddleware` (`/api/chat`, `/api/files`, `/api/capture`, the WebSocket
 *     ticket, …): {@link refuseGuestSession} right after it. The chat and
 *     capture doors run agents as the caller and the upload door writes
 *     documents, none of which a guest may do. The set is derived by the
 *     `session-doors-refuse-guests` tripwire (apps/api).
 *
 * The audience comes from `AccessContext.audience()`, i.e. the SAME SQL
 * predicates the floors embed, never a JS re-statement. It is resolved only for
 * a mutation (tRPC) or once per request (REST / MCP), and memoized per tRPC
 * request so a batch of mutations costs one probe.
 *
 * The same doors carry the POD-ACCESS floor (`access/pod-access.ts`): a
 * signed-in principal that is not a guest and holds no access to the pod at
 * all. Wave B1 REPORTS it (`reportNoPodAccess`) at every site that refuses a
 * guest, and on every served tRPC procedure that needs a signed-in caller
 * ({@link podAccessReportMiddleware}); wave B3 refuses it there.
 */

import { TRPCError } from "@trpc/server";
import type { MiddlewareHandler } from "hono";
import { t } from "../init-trpc.js";
import { podAudienceOf, reportNoPodAccess } from "./pod-access.js";

/**
 * The tRPC mutations a guest may call. Each entry must name a registered
 * mutation (the containment tripwire fails on a stale entry).
 *
 *   - `shares.redeemLink`: joining a project through a link is how a person
 *     BECOMES a guest, and a guest may redeem a second link. It writes a guest
 *     `project_members` row only, never a workspace or `pod_members` row.
 *   - `workspaces.acceptInvite` / `rejectInvite`: answering an owner's invite
 *     is the one sanctioned way a guest becomes a participant. The invite is
 *     owner-issued and email-bound.
 */
export const GUEST_MUTATION_ALLOWLIST: readonly string[] = [
  "shares.redeemLink",
  "workspaces.acceptInvite",
  "workspaces.rejectInvite",
];

/** The one message every guest refusal carries, on every door. */
export const GUEST_REFUSED_MESSAGE =
  "Guests can view what was shared with them but cannot make changes or use this door.";

/** The tRPC shape of the refusal. */
export function guestRefusedError(): TRPCError {
  return new TRPCError({ code: "FORBIDDEN", message: GUEST_REFUSED_MESSAGE });
}

/** The JSON body of the refusal on the REST doors (sent with status 403). */
export const GUEST_REFUSED_BODY = {
  error: GUEST_REFUSED_MESSAGE,
  code: "FORBIDDEN",
} as const;

/**
 * Is `userId` a guest? `requestKey` (the incoming `Request`) memoizes the probe
 * for the rest of that request, per principal (`podAudienceOf`, shared with the
 * pod-access floor). A failed probe throws and is not memoized: it never reads
 * as "not a guest".
 */
export async function isGuestPrincipal(
  userId: string,
  requestKey?: object | null
): Promise<boolean> {
  return (await podAudienceOf(userId, requestKey)) === "guest";
}

/**
 * The requests that arrived over tRPC HTTP. `createContext` (the one context
 * factory both tRPC mounts use) marks each one; the guard judges exactly those.
 *
 * A context built INSIDE the server (`createCaller` from an approval, a form
 * submission, a hub REST handler) carries no marked request and is not probed:
 * its principal was already vetted by the door that built it (the hub and MCP
 * refuse guests themselves; approvals and form submissions run as the owner).
 * That also keeps the probe off unit tests that drive a router with a
 * hand-built context and a stubbed database.
 */
const servedRequests = new WeakSet<object>();

/** Mark `req` as an incoming tRPC request (called by `createContext`). */
export function markServedRequest(req: object): void {
  servedRequests.add(req);
}

/**
 * tRPC middleware: refuse a guest's mutation unless allowlisted. Runs before
 * input parsing, so a refused call never reaches the procedure body.
 */
export const guestContainmentMiddleware = t.middleware(
  async ({ ctx, type, path, next }) => {
    if (type !== "mutation") return next();
    if (ctx.authenticated !== true || !ctx.userId) return next();
    if (!ctx.req || !servedRequests.has(ctx.req)) return next();
    if (GUEST_MUTATION_ALLOWLIST.includes(path)) return next();
    // Memoized per request: the request object is shared by every call of a
    // tRPC batch.
    if (await isGuestPrincipal(ctx.userId, ctx.req)) {
      throw guestRefusedError();
    }
    return next();
  }
);

/**
 * tRPC middleware: the pod-access floor on every served procedure that needs a
 * signed-in caller (`protectedProcedure`, and `apiKeyProcedure` once the key
 * set the principal). REPORT mode (B1): it logs, never refuses. The admission
 * mutations a guest may call (`GUEST_MUTATION_ALLOWLIST`: accept an invite,
 * redeem a link) are how a person with no access gets in, so they are not
 * reported.
 */
export const podAccessReportMiddleware = t.middleware(
  async ({ ctx, path, next }) => {
    if (ctx.authenticated !== true || !ctx.userId) return next();
    if (!ctx.req || !servedRequests.has(ctx.req)) return next();
    if (GUEST_MUTATION_ALLOWLIST.includes(path)) return next();
    await reportNoPodAccess(ctx.userId, ctx.req, `trpc:${path}`);
    return next();
  }
);

/**
 * Hono middleware for a session-authenticated door: mount it right after
 * `authMiddleware` (which sets `userId`). A guest gets the one refusal, 403. A
 * failed audience probe throws (a 5xx), never a pass. A principal with no pod
 * access is REPORTED (B1, `access/pod-access.ts`).
 */
export const refuseGuestSession: MiddlewareHandler = async (c, next) => {
  const userId = (c.get as (key: string) => unknown)("userId");
  if (typeof userId === "string" && userId) {
    if (await isGuestPrincipal(userId, c.req.raw)) {
      return c.json(GUEST_REFUSED_BODY, 403);
    }
    await reportNoPodAccess(userId, c.req.raw, `session:${c.req.path}`);
  }
  return next();
};
