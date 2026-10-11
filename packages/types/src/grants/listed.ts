/**
 * A LISTED grant (a key list's `grants[]`) back into the editor and the write
 * door, losing nothing: its narrowing, its label and its role lineage
 * (`roleId`). Its lifetime is the key's, so the draft carries none.
 */
import {
  toGrantMintInput,
  type GrantDraft,
  type GrantMintInput,
} from "./draft.js";
import type { KeyAccessGrant } from "./summary.js";

export interface ListedGrantDraft extends GrantDraft {
  readonly roleId?: string;
}

export function grantToDraft(g: KeyAccessGrant): ListedGrantDraft {
  return {
    permissions: [...g.permissions],
    workspaceIds: g.workspaceIds ?? undefined,
    projectIds: g.projectIds ?? undefined,
    entityIds: g.entityIds ?? undefined,
    label: g.label ?? undefined,
    ...(g.roleId ? { roleId: g.roleId } : {}),
  };
}

/** A draft's `apiKeys.setGrants` entry, keeping its role lineage. */
export function draftToGrantInput(
  d: ListedGrantDraft
): GrantMintInput["grant"] {
  const { grant } = toGrantMintInput({ ...d, expiresInDays: undefined });
  return d.roleId ? { ...grant, roleId: d.roleId } : grant;
}
