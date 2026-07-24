/**
 * Hub-Protocol identity floor.
 *
 * The hub-protocol tRPC procedures (`/api/hub/trpc/*`) are the EXTERNAL-agent
 * (BYOA) door: a caller authenticates with an API key and may act ONLY as that
 * key's owner. Several procedures accept a body-supplied `userId` (legacy
 * transport) and feed it verbatim into `createHubProtocolCallerContext(userId,
 * …)`, which floors the delegated call by that identity. Without this check any
 * user could mint a `hub-protocol.*` PAT (keyType `user_pat`) tied to their own
 * account and pass `userId=<victim>` to read/write the victim's data across the
 * pod — the W0.5 cross-tenant impersonation hole.
 *
 * Invariant: the requested acting identity MUST equal the authenticated key
 * owner (`ctx.userId`, set by api-key-auth middleware). For legitimate BYOA/CLI
 * traffic this always holds — the caller passes its own id. First-party IS
 * traffic never reaches this surface: it uses the Hono REST `/api/hub/*` door,
 * not tRPC.
 *
 * NO `service`-key exception. On this pod a `service` key is NOT operator-only —
 * any user holding a `hub-protocol.write` key can mint a self-owned, workspace-
 * bound `service` key via `/setup/service` (setup.ts Path 4). A
 * `keyType === "service"` bypass would therefore re-open the exact hole (mint a
 * service key, then act as a victim). Identity here is ALWAYS strict equality;
 * the only thing service-binding buys is WORKSPACE confinement
 * (resolveConfinedWorkspace), which is orthogonal to WHO the caller may act as.
 * Never gate the check on `apiKeyId` presence — every hub caller has one.
 */

import { TRPCError } from "@trpc/server";

export function assertMayActAs(
  ctx: { userId?: string | null },
  requestedUserId: string
): void {
  if (!ctx.userId || requestedUserId !== ctx.userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "userId does not match the authenticated identity",
    });
  }
}
