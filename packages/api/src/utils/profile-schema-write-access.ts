/**
 * assertProfileSchemaWrite — the ownership gate for every write to a profile's
 * SCHEMA (the profile row, its property links, its relation links, its access
 * grants).
 *
 * THE HOLE THIS CLOSES. The profile write procedures resolved a caller-supplied
 * profile UUID and then wrote, never asking whose profile it was. Worse, a
 * `profile_properties` / `profile_relations` row carries no workspace of its
 * own, so a link onto a SYSTEM kind (e.g. `task`) applies to EVERY workspace at
 * once — a `required: true` field linked there by any member broke every create
 * of that kind, pod-wide.
 *
 * THE RULE — decided on the LOADED profile row, never on `ctx.workspaceId` /
 * `input.workspaceId`. Ownership is sorted by the one existing dispatcher,
 * `profileOwnershipRequirement`; this file only maps each answer onto the
 * existing doors (`assertWorkspaceWrite`, `assertPodAdmin`):
 *
 *   • owning-workspace (workspace-scoped, or shared with a home workspace)
 *       → `assertWorkspaceWrite` on THAT workspace (editor+ member).
 *         `level: "admin"` additionally requires owner/admin of it — kept for
 *         the unlink doors, which carried that bar already (but read it from
 *         the request's workspace, not the row's).
 *   • owning-user (user-scoped) → `assertWorkspaceWrite` with `ownerId`.
 *   • pod-admin (system, or shared with no home workspace) — NEVER through
 *     `assertWorkspaceWrite` on the row: its no-owner branch denies everyone,
 *     which would close the intended "extend a system kind" path.
 *       → `level: "additive"` (a NEW optional link: no `required`, no default)
 *         is open to an editor+ of the workspace the caller acts in;
 *       → anything else (required/default, changing an existing link,
 *         reorder, unlink, grants) → `assertPodAdmin`.
 */

import { TRPCError } from "@trpc/server";
import { getWorkspaceMembership } from "@synap/database";
import { assertPodAdmin } from "../trpc.js";
import { assertWorkspaceWrite } from "./workspace-write-access.js";
import { profileOwnershipRequirement } from "./profile-pod-wide-fields.js";

/**
 * How much a write changes an existing schema:
 *   • `additive` — adds a new optional link and changes nothing already there.
 *   • `editor`   — any other change.
 *   • `admin`    — a removal behind an owner/admin bar.
 */
export type ProfileSchemaWriteLevel = "additive" | "editor" | "admin";

const ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * A property link is additive only when it asks nothing of existing entities
 * (not required, no default) AND no link for that pair exists yet — the link
 * repository UPSERTS, so re-linking an existing pair silently rewrites its
 * `required` / `defaultValue` / `displayOrder`.
 */
export function propertyLinkLevel(link: {
  required?: boolean;
  defaultValue?: unknown;
  alreadyLinked: boolean;
}): ProfileSchemaWriteLevel {
  const asksNothing =
    link.required !== true &&
    (link.defaultValue === undefined || link.defaultValue === null);
  return asksNothing && !link.alreadyLinked ? "additive" : "editor";
}

export async function assertProfileSchemaWrite(
  db: unknown,
  userId: string | null | undefined,
  profile: { workspaceId?: string | null; userId?: string | null },
  opts: {
    level: ProfileSchemaWriteLevel;
    /** The workspace the caller acts in — used ONLY for an additive write onto a pod-admin-owned profile. */
    actingWorkspaceId: string | null | undefined;
  }
): Promise<void> {
  if (!userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }

  const requirement = profileOwnershipRequirement(profile);

  if (requirement.kind === "owning-workspace") {
    await assertWorkspaceWrite(db, userId, {
      workspaceId: requirement.workspaceId,
    });
    if (opts.level === "admin") {
      const membership = await getWorkspaceMembership(
        db,
        requirement.workspaceId,
        userId
      );
      if (!membership || !ADMIN_ROLES.has(membership.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only owners/admins of this profile's workspace can remove from its schema.",
        });
      }
    }
    return;
  }

  if (requirement.kind === "owning-user") {
    await assertWorkspaceWrite(db, userId, {
      workspaceId: null,
      ownerId: requirement.userId,
    });
    return;
  }

  // Pod-admin-owned (system / unowned shared).
  if (opts.level === "additive" && opts.actingWorkspaceId) {
    await assertWorkspaceWrite(db, userId, {
      workspaceId: opts.actingWorkspaceId,
    });
    return;
  }
  await assertPodAdmin(userId);
}
