/**
 * ROLES — named, reusable grants: `{ id, name, description, grant }`. The
 * built-in ones are GRANT_PRESETS; a person's own are stored (`grantRoles.*`,
 * `stored: true`). Every picker reads both through the same `GrantRole` type,
 * so a preset and a stored role render, apply and mint the same way.
 *
 * A preset carries PERMISSIONS (and, if it says so, narrowing). Applying one
 * keeps the draft's own lifetime and narrowing unless the preset sets them —
 * choosing "Read-only site" must not silently undo "only the Brand space".
 */

import {
  EMPTY_GRANT_DRAFT,
  normalizeGrantPermissions,
  toGrantMintInput,
  type GrantDraft,
  type GrantMintInput,
} from "./draft.js";

export interface GrantRole {
  /** Stable id (a preset slug, or a stored role's uuid). */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly grant: GrantDraft;
  /** True for a role the person saved (`grantRoles.*`); absent for a preset. */
  readonly stored?: boolean;
}

export const GRANT_PRESETS: readonly GrantRole[] = [
  {
    id: "read-only-site",
    name: "Read-only site",
    description: "Reads your records, documents and views. Changes nothing.",
    grant: { permissions: ["entity.*.read", "document.read", "view.read"] },
  },
  {
    id: "agent-read-propose",
    name: "Agent — read & propose",
    description:
      "Reads everything an agent needs and drafts records, documents and links. Writes still go through your review rules; it can never delete.",
    grant: {
      permissions: [
        "entity.*.read",
        "entity.*.create",
        "entity.*.update",
        "document.read",
        "document.create",
        "document.update",
        "relation.read",
        "relation.create",
        "view.read",
        "project.read",
        "session.read",
        "session.create",
        "session.update",
        "proposal.read",
      ],
    },
  },
  {
    id: "full-access",
    name: "Full access",
    description:
      "Everything you can do yourself, including deleting. Still bounded by your own access.",
    grant: { permissions: ["*"] },
  },
];

/** Apply a role: its permissions, plus any narrowing/lifetime it sets itself. */
export function applyGrantRole(draft: GrantDraft, role: GrantRole): GrantDraft {
  const next: { -readonly [K in keyof GrantDraft]: GrantDraft[K] } = {
    ...draft,
    permissions: normalizeGrantPermissions(role.grant.permissions),
  };
  if (role.grant.workspaceIds !== undefined)
    next.workspaceIds = role.grant.workspaceIds;
  if (role.grant.projectIds !== undefined)
    next.projectIds = role.grant.projectIds;
  if (role.grant.entityIds !== undefined) next.entityIds = role.grant.entityIds;
  if (role.grant.expiresInDays !== undefined)
    next.expiresInDays = role.grant.expiresInDays;
  return next;
}

/**
 * The stored role a mint should record as its lineage (`grant.roleId`): the
 * person's own role whose permissions the draft still equals. A preset, or a
 * draft edited away from every role, records none.
 */
export function grantRoleLineage(
  draft: GrantDraft,
  roles: readonly GrantRole[]
): string | undefined {
  const role = matchGrantRole(draft, roles);
  return role?.stored ? role.id : undefined;
}

/** The role whose permissions equal the draft's (by value), if any. */
export function matchGrantRole(
  draft: GrantDraft,
  roles: readonly GrantRole[] = GRANT_PRESETS
): GrantRole | undefined {
  const mine = normalizeGrantPermissions(draft.permissions);
  return roles.find((r) => {
    const theirs = normalizeGrantPermissions(r.grant.permissions);
    return (
      theirs.length === mine.length && theirs.every((p, i) => p === mine[i])
    );
  });
}

/** The `grantRoles.create` / `.update` input (`id` added for an update). */
export interface GrantRoleInput {
  name: string;
  description?: string;
  grant: Omit<GrantMintInput["grant"], "label" | "roleId"> & {
    /** Omitted → the role sets no lifetime; a number → days; null → never. */
    expiresInDays?: number | null;
  };
}

/**
 * A draft saved as a role: its permissions, narrowing and lifetime choice —
 * the same projection a mint of it gets (`toGrantMintInput`), minus the
 * per-key label and lineage.
 */
export function toGrantRoleInput(
  name: string,
  description: string,
  draft: GrantDraft
): GrantRoleInput {
  const { grant, expiresInDays } = toGrantMintInput(draft);
  const { label: _label, ...rest } = grant;
  return {
    name: name.trim(),
    ...(description.trim() ? { description: description.trim() } : {}),
    grant: {
      ...rest,
      ...(expiresInDays !== undefined ? { expiresInDays } : {}),
    },
  };
}

/**
 * The full mint input for a key made from a role, as-is: its permissions AND
 * its narrowing and lifetime, plus `roleId` lineage for the person's own
 * stored role (never for a preset).
 */
export function grantMintFromRole(role: GrantRole): GrantMintInput {
  const input = toGrantMintInput(applyGrantRole(EMPTY_GRANT_DRAFT, role));
  if (role.stored) input.grant.roleId = role.id;
  return input;
}
