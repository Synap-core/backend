/**
 * GRANT_PRESETS — named, reusable permission lists. They are the seed of
 * ROLES: a role is `{ id, name, description, grant }`, the exact shape a
 * future `roles` store persists for an AI, a person or an app. A selector
 * shows presets and stored roles through the same `GrantRole` type, so moving
 * a preset into the store changes where it is read from, not how it renders.
 *
 * A preset carries PERMISSIONS (and, if it says so, narrowing). Applying one
 * keeps the draft's own lifetime and narrowing unless the preset sets them —
 * choosing "Read-only site" must not silently undo "only the Brand space".
 */

import { normalizeGrantPermissions, type GrantDraft } from "./draft.js";

export interface GrantRole {
  /** Stable id (a preset slug, or a stored role's uuid). */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly grant: GrantDraft;
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
  if (role.grant.workspaceIds !== undefined) next.workspaceIds = role.grant.workspaceIds;
  if (role.grant.projectIds !== undefined) next.projectIds = role.grant.projectIds;
  if (role.grant.entityIds !== undefined) next.entityIds = role.grant.entityIds;
  if (role.grant.expiresInDays !== undefined) next.expiresInDays = role.grant.expiresInDays;
  return next;
}

/** The role whose permissions equal the draft's (by value), if any. */
export function matchGrantRole(
  draft: GrantDraft,
  roles: readonly GrantRole[] = GRANT_PRESETS
): GrantRole | undefined {
  const mine = normalizeGrantPermissions(draft.permissions);
  return roles.find((r) => {
    const theirs = normalizeGrantPermissions(r.grant.permissions);
    return theirs.length === mine.length && theirs.every((p, i) => p === mine[i]);
  });
}
