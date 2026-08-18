/**
 * Service-key workspace confinement (Item 3 — Option B).
 *
 * A `service` key can carry a `workspace_id` binding (minted workspace-bound by
 * the `/setup/service` door). This helper turns that binding into a real
 * boundary: a service key is POSITIVELY PINNED to its bound workspace.
 *
 * Contract (the helper IS the contract):
 *   - Non-service key (any other keyType), OR a service key with NO binding
 *     (`keyWorkspaceId == null`) → return `requested` UNCHANGED. This is the
 *     ONLY behavior for those keys — legacy passthrough with ZERO back-compat
 *     impact. No existing key type ever changes behavior.
 *
 *     POD-WIDE BRIDGE MODEL: an UNBOUND service key (`keyType === "service"` &&
 *     `keyWorkspaceId == null`) is DELIBERATELY pod-wide — it never 403s on a
 *     pod-wide (null) request, so a single bridge/bot key can land inbound
 *     traffic across every workspace and let role-routing derive placement.
 *     This is NOT a hole: pod-wide ≠ unattributed. The ATTRIBUTION floor is a
 *     separate, orthogonal guard — a write with no acting user (null
 *     `linkedUserId` on a bare user_pat/hub_inbound key) is still hard-rejected
 *     upstream by `shouldRejectUnattributedWrite` (MCP) / `resolveActingContext`
 *     (Hub REST, which 403s when `c.get("userId")` is absent). Confinement
 *     answers "which workspace"; attribution answers "who". Both must hold; the
 *     tripwire `__tripwires__/pod-wide-bridge-attribution.test.ts` locks it.
 *   - service key WITH a binding (`keyType === "service"` && `keyWorkspaceId`):
 *       · `requested == null`          → return `keyWorkspaceId` (positive pin:
 *                                         default to the bound workspace, never
 *                                         open pod-wide).
 *       · `requested === keyWorkspaceId` → return it (agreement).
 *       · `requested !== keyWorkspaceId` → THROW 403 (confined to another ws).
 *
 * Pure function — no DB, no I/O. Throws the hub's canonical auth-failure shape
 * (`TRPCError` code `FORBIDDEN`, mapped to HTTP 403 by the REST handlers).
 */

import { TRPCError } from "@trpc/server";
import type { Context } from "hono";

export function resolveConfinedWorkspace(
  keyType: string | null | undefined,
  keyWorkspaceId: string | null | undefined,
  requested: string | null | undefined
): string | null | undefined {
  // Legacy passthrough — confinement applies ONLY to bound service keys.
  if (keyType !== "service" || keyWorkspaceId == null) {
    return requested;
  }

  // Bound service key → positive pin.
  if (requested == null) return keyWorkspaceId;
  if (requested === keyWorkspaceId) return keyWorkspaceId;

  throw new TRPCError({
    code: "FORBIDDEN",
    message: `Service key is confined to workspace ${keyWorkspaceId}`,
  });
}

/**
 * Ergonomic per-site clamp for Hub REST handlers (Item 3 — Part 3, Model 2).
 *
 * The door ctx-clamp is defeated whenever a handler re-supplies `workspaceId`
 * as a tRPC input (`input.workspaceId ?? ctx.workspaceId` → input wins) or
 * writes directly, so confinement must be applied AT THE POINT OF READ. Call
 * this on the RESOLVED workspace value (including any `x-workspace-id` header
 * fallback) BEFORE it flows to a caller/ctx, a tRPC input, a repository, a
 * service, a `db` write, or `checkPermissionOrPropose`. Assign the result to a
 * local and route every downstream use through that local.
 *
 *   const workspaceId = getConfinedWorkspace(c, body.workspaceId);
 *
 * Reads `keyType`/`keyWorkspaceId` set by the hub auth middleware. Pure w.r.t.
 * I/O; throws 403 (FORBIDDEN) for a bound service key targeting another ws.
 * Structural context type — avoids importing `_shared` (circular).
 */
export function getConfinedWorkspace<
  E extends { Variables: { keyType?: string; keyWorkspaceId?: string | null } },
>(
  c: Context<E>,
  requested: string | null | undefined
): string | null | undefined {
  // Hono's Context is INVARIANT in its Env (the `set` method), so a concrete
  // `Context<{Variables: HubVariables}>` is not assignable to a structural
  // subset param. A generic constrained to "Variables includes keyType/
  // keyWorkspaceId" is a covariant `extends` check that HubVariables satisfies,
  // so every hub REST handler's `c` is accepted without coupling to _shared.
  return resolveConfinedWorkspace(
    c.get("keyType" as never) as string | null | undefined,
    c.get("keyWorkspaceId" as never) as string | null | undefined,
    requested
  );
}
