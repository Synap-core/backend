/**
 * A pod app (spec 17 PB4) as the person's app surfaces read it: an app that
 * connected to this pod at its OAuth door, identified by its DOMAIN. The pod
 * sends `pod_app` on the app row (`apps.list` / `apps.get`): domain, tier,
 * what was approved per space, and how its changes land. Pure, so the narrow
 * rule (only ever take a pair away, never the last one) is tested here.
 */

import { permissionLabel } from "../../oauth/consent/consent-model";

/** One approved (permission, space) pair, with the space's name. */
export interface PodAppPair {
  permission: string;
  workspaceId: string;
  workspaceName: string | null;
}

/** What `pod_app` carries on an app row (`PodAppView` on the pod). */
export interface PodAppInfo {
  client_id: string;
  domain: string;
  verified: boolean;
  approved: PodAppPair[];
  connected_at: string | Date | null;
  last_used_at: string | Date | null;
  write_mode: {
    applyAutomatically: boolean;
    writeMode: string;
    line: string;
  };
}

/** The `pod_app` half of an app row the proxy served, or null (a key app). */
export function podAppOf(row: object): PodAppInfo | null {
  return (row as { pod_app?: PodAppInfo | null }).pod_app ?? null;
}

/** "Synap app" for an exact first-party origin, else "Unverified app". */
export function tierLabel(verified: boolean): string {
  return verified ? "Synap app" : "Unverified app";
}

/** A space's name, or a stand-in when the pod no longer has it. */
function spaceName(pair: PodAppPair): string {
  return pair.workspaceName ?? "a space you no longer see";
}

/** The approval, one entry per space, each with the permissions given there. */
export function approvalBySpace(approved: readonly PodAppPair[]): Array<{
  workspaceId: string;
  workspaceName: string;
  permissions: Array<{ permission: string; label: string }>;
}> {
  const out = new Map<
    string,
    {
      workspaceId: string;
      workspaceName: string;
      permissions: Array<{ permission: string; label: string }>;
    }
  >();
  for (const pair of approved) {
    const space = out.get(pair.workspaceId) ?? {
      workspaceId: pair.workspaceId,
      workspaceName: spaceName(pair),
      permissions: [],
    };
    space.permissions.push({
      permission: pair.permission,
      label: permissionLabel(pair.permission),
    });
    out.set(pair.workspaceId, space);
  }
  return [...out.values()].sort((a, b) =>
    a.workspaceName.localeCompare(b.workspaceName)
  );
}

/** One line for a list row: "Read posts, Create posts in Brand · Read posts in Shared". */
export function approvalSentence(approved: readonly PodAppPair[]): string {
  if (approved.length === 0) return "No access.";
  return approvalBySpace(approved)
    .map(
      (s) => `${s.permissions.map((p) => p.label).join(", ")} in ${s.workspaceName}`
    )
    .join(" · ");
}

/**
 * What the app KEEPS when the person removes `drop` (one pair, or every pair
 * of one space): the narrow door's input. The last pair cannot be removed
 * here — taking everything away is Revoke — so that returns null.
 */
export function keepWithout(
  approved: readonly PodAppPair[],
  drop: { permission?: string; workspaceId: string }
): Array<{ permission: string; workspaceId: string }> | null {
  const keep = approved
    .filter(
      (p) =>
        p.workspaceId !== drop.workspaceId ||
        (drop.permission !== undefined && p.permission !== drop.permission)
    )
    .map((p) => ({ permission: p.permission, workspaceId: p.workspaceId }));
  if (keep.length === approved.length || keep.length === 0) return null;
  return keep;
}
