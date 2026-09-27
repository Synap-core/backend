/**
 * Governed SPACE operations — the ONE rule for "which proposal is a space op"
 * and "which member roles may write / manage a space" (FX-F3, RV3 S5 + S10).
 *
 * Before this leaf the rule lived three times: the pod's summary builder
 * (`permission-check.ts` `buildSpaceOpSummary` / `resolveSpaceOpNames`), the
 * review-card presenter (`useProposalPresentation` `isSpaceOperation`), and the
 * role sets in the pod's write gate (`workspace-write-access.ts`) mirrored by
 * the browser's space pickers (`space-ops-model.ts`) with no tripwire. Every
 * consumer now imports these; there is nothing left to keep in sync.
 *
 * Pure and dependency-free: safe in the pod, the browser, relay and the CLI.
 */

/** Member roles the pod lets WRITE into a space (the write gate's floor). */
export const SPACE_WRITE_ROLES = ["owner", "admin", "editor"] as const;
/** Member roles that MANAGE a space (rename, archive, admin-only acts). */
export const SPACE_MANAGE_ROLES = ["owner", "admin"] as const;

export function isSpaceWriteRole(role: string | null | undefined): boolean {
  return (SPACE_WRITE_ROLES as readonly string[]).includes(role ?? "");
}

export function isSpaceManageRole(role: string | null | undefined): boolean {
  return (SPACE_MANAGE_ROLES as readonly string[]).includes(role ?? "");
}

export type SpaceOperation =
  "archive" | "restore" | "share" | "move" | "rename";

/**
 * True for a `workspace` UPDATE payload that changes the NAME and nothing else
 * (a settings/description/definition change is a plain update, not a rename).
 */
export function isSpaceRenamePayload(data: Record<string, unknown>): boolean {
  return (
    typeof data.name === "string" &&
    data.name.trim() !== "" &&
    data.description === undefined &&
    data.settings === undefined &&
    data.definition === undefined &&
    data.operation === undefined
  );
}

/**
 * Which governed space operation a proposal is, or `null`. Keyed on the
 * SINGULAR target type the pod stores (`workspace`, `profile`, `entity`) and
 * the gate's action / change type:
 *
 *   workspace × archive | restore          → archive | restore
 *   profile   × grant_access               → share   (a kind with a space)
 *   entity    × update + `toWorkspaceId`   → move    (an object into a space)
 *   workspace × update, name only          → rename
 */
export function classifySpaceOperation(
  targetType: string | null | undefined,
  changeType: string | null | undefined,
  data: Record<string, unknown>
): SpaceOperation | null {
  if (
    targetType === "workspace" &&
    (changeType === "archive" || changeType === "restore")
  ) {
    return changeType;
  }
  if (targetType === "profile" && changeType === "grant_access") return "share";
  if (
    targetType === "entity" &&
    changeType === "update" &&
    typeof data.toWorkspaceId === "string"
  ) {
    return "move";
  }
  if (
    targetType === "workspace" &&
    changeType === "update" &&
    isSpaceRenamePayload(data)
  ) {
    return "rename";
  }
  return null;
}
