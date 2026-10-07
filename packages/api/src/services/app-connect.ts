/**
 * App Connect — the ONE service behind every door that asks for, approves or
 * issues an Application's access (Hub REST `/api/hub/apps*` for the CLI, tRPC
 * `apps.*` for a signed-in person).
 */

import type { AppApprovedRequest } from "@synap/database/schema";
import type { GrantInput } from "./key-grant.js";

/**
 * The grants an app's key carries for what its owner approved: ONE grant per
 * workspace, holding exactly the permissions approved IN that workspace.
 *
 * Never one grant of (all permissions × all workspaces): approving "create
 * People in Sales" and "read Notes in Finance" would then also allow creating
 * People in Finance — a reach nobody approved. The key may act where ANY one
 * grant permits (`KeyGrant`), so each pair stays bounded to its own workspace.
 */
export function grantsForApprovedRequests(
  approved: readonly AppApprovedRequest[]
): GrantInput[] {
  const byWorkspace = new Map<string, Set<string>>();
  for (const r of approved) {
    const perms = byWorkspace.get(r.workspaceId) ?? new Set<string>();
    perms.add(r.permission);
    byWorkspace.set(r.workspaceId, perms);
  }
  return [...byWorkspace].map(([workspaceId, perms]) => ({
    permissions: [...perms],
    workspaceIds: [workspaceId],
  }));
}
