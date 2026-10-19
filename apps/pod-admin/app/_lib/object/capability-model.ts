/**
 * The pure half of the capability object page (`views/capability-object.tsx`,
 * drawn by `/open/capability/:id`): the one pill its state reads as, and who
 * the page offers the verb switches to. The page only fetches and draws.
 */

import type { AppRouter } from "@synap-core/api-types";
import type { inferRouterOutputs } from "@trpc/server";
import type { StatusKind } from "../../(admin)/components/status-pill";

/** A catalog card's state, typed off the router so a new state fails here. */
export type CapabilityStatus =
  inferRouterOutputs<AppRouter>["capabilities"]["catalog"][number]["status"];

/**
 * The pill a capability's state reads as. The sentence beside it is the pod's
 * own (`nextAction.hint`), so this only names the state in a word or two.
 */
export function capabilityStatusPill(status: CapabilityStatus): {
  kind: StatusKind;
  label: string;
} {
  switch (status) {
    case "ready":
      return { kind: "healthy", label: "Ready" };
    case "partial":
      return { kind: "stale", label: "Some actions off" };
    case "connected":
    case "draft":
      return { kind: "stale", label: "Actions off" };
    case "needs_connection":
      return { kind: "down", label: "Needs an account" };
    case "unavailable":
      return { kind: "unknown", label: "Not offered" };
    case "available":
      return { kind: "unknown", label: "Not installed" };
  }
}

/**
 * Whether the page offers the verb switches. Mirrors the pod's ONE gate
 * (`setSkillApproved`, packages/api `set-skill-approved.ts`): a space's verb
 * needs that space's OWNER, a pod-wide verb needs a pod admin. Offer only —
 * the pod re-checks every switch and its refusal is shown under the verb.
 */
export function mayTurnVerbsOn(input: {
  /** The capability's space; null = pod-wide. */
  workspaceId: string | null;
  /** The viewer's role in that space (`workspaces.list`), if a member. */
  roleInSpace: string | null | undefined;
  viewerIsPodAdmin: boolean;
}): boolean {
  if (!input.workspaceId) return input.viewerIsPodAdmin;
  return input.roleInSpace === "owner";
}

/** Who can turn them on, said to someone who can't. */
export function whoTurnsVerbsOn(spaceName: string | null): string {
  return spaceName
    ? `Only an owner of ${spaceName} can turn its actions on or off.`
    : "Only a pod admin can turn its actions on or off — it is shared by the whole pod.";
}
