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
