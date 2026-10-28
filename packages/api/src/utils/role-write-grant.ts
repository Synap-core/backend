/**
 * The space a key's grant is checked in for a ROLE write — THE rule, for every
 * door that writes a role facet: entities.attachFacet / updateFacet /
 * detachFacet (`facet.create|update|delete`) and moveStatus on a role target
 * (`entity.<kind>.update`, the status move being an update, #239).
 *
 * The role IS the space lens (D1, #134; founder decision 812ee060,
 * 2026-10-28): a role write is checked where the role lives, never on the
 * parent's own (often pod-wide, null) workspace. D2 (S7, 2026-10-20) is
 * superseded for role writes.
 *
 *  - A role STAMPED in space S (facet row stored in S): the grant must permit
 *    the write in S, and — under a scope limited to spaces — the record must
 *    be readable by the key and already in S's reach (stored in S, or wearing
 *    a live role there). A role never pulls a record S could not see into it.
 *  - A SHARED role (row stored NULL: one row, seen in every space the role is
 *    granted to — a `profile_workspace_access` row or its home space):
 *      · change (update, stage move): checked in ONE key space the role is
 *        granted to, where the key reads that row (#239, founder decision 1,
 *        2026-10-26; THE read predicate `sharedRoleRowsInSpacesWhere`: a
 *        pod-wide record, or one stored in that space), and the record in
 *        that space's reach;
 *      · add / remove: changes where the record shows, so EVERY space the
 *        role is granted to must be in the grant with the write permitted
 *        there (none at all = refused), and the record readable by the key
 *        and in the reach of those spaces, the role's own: never of another
 *        key space. Adding a role never shows a record in a space the person
 *        did not grant the app, nor one that space could not see.
 *  - A scope NOT limited to spaces that permits the write at the row's own
 *    workspace passes with no reach clause.
 *
 * Every role write is checked in the role's own space(s) and needs the record
 * in their reach: a key's other spaces never lend it. A role row outside every
 * space of the key is not found (`roleRowInKeyReach`), never refused by name.
 *
 * The returned `space` is what the governed gate's grant rung re-checks
 * (`grantWorkspaceId`), and the space a proposal is filed in when the role
 * row names none. The record's own fields are never written by a role write,
 * so nothing here places or re-places the entity row. No grant on the
 * request (a signed-in session, an approval replayed by the person) = no-op.
 */

import {
  and,
  db,
  eq,
  getRequestGrant,
  inArray,
  isNull,
  or,
  type KeyGrant,
} from "@synap/database";
import {
  entities,
  entityFacets,
  profiles,
  profileWorkspaceAccess,
} from "@synap/database/schema";
import { grantRequestKey } from "@synap/governance-policy";
import {
  keyGrantReadClause,
  sharedRoleRowsInSpacesWhere,
} from "../access/grant-read.js";
import { grantWriteDenial, type GrantWriteInput } from "./grant-write-check.js";
import { roleInSpacesWhere } from "./project-scope.js";

/** Which facet door: add, change (incl. a stage move) or remove the role. */
export type RoleWriteDoor = "attach" | "update" | "detach";

export interface RoleWriteTarget {
  /** The record wearing (or about to wear) the role. */
  entityId: string;
  /** The facet row; null for an attach (no row yet). */
  facetId: string | null;
  /** The role-profile id; null when it does not resolve. */
  profileId: string | null;
  /** Where the facet row is (or will be) STORED; null = a shared role. */
  storedWorkspaceId: string | null;
}

export type RoleWriteGrant = { space: string | null } | { denied: string };

/**
 * The space `write` is granted in for this role write, or the reason it is
 * denied. `write` is the gate's own request (subject/action/data) without a
 * workspace: `facet/attach|update|detach`, or `entity/transition`.
 */
export async function roleWriteGrantSpace(
  door: RoleWriteDoor,
  target: RoleWriteTarget,
  write: Omit<GrantWriteInput, "workspaceId">,
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<RoleWriteGrant> {
  if (!grant) return { space: target.storedWorkspaceId };
  const stored = target.storedWorkspaceId;
  const denial = await grantWriteDenial(
    { ...write, workspaceId: stored },
    grant
  );

  if (stored !== null) {
    if (denial) return { denied: denial };
    if (await permittedUnlimited(write, stored, grant))
      return { space: stored };
    if (await inReachOf(target.entityId, [stored], grant)) {
      return { space: stored };
    }
    return { denied: outOfReach(write, [stored]) };
  }

  // A shared role. A scope not limited to spaces may write it pod scope.
  if (!denial) return { space: null };

  if (door === "update") {
    const space = target.facetId
      ? await reachedFacetGrantSpace(target.facetId, write, grant)
      : null;
    if (space && (await inReachOf(target.entityId, [space], grant))) {
      return { space };
    }
    return {
      denied: `${denial} A shared role is stored pod-wide: a key limited to spaces may change it only where the role is granted to one of the key's spaces and the record is pod-wide or stored in that space.`,
    };
  }

  // A role that does not resolve is not known to be shared: the plain refusal.
  if (!target.profileId) return { denied: denial };
  const spaces = await roleGrantedSpaces(target.profileId);
  if (spaces.length === 0) {
    return {
      denied: `${denial} The role is shared and granted to no space, so a key limited to spaces cannot ${door === "attach" ? "add" : "remove"} it.`,
    };
  }
  for (const space of spaces) {
    const there = await grantWriteDenial(
      { ...write, workspaceId: space },
      grant
    );
    if (there) {
      return {
        denied: `${there} The shared role is granted to that space too: ${door === "attach" ? "adding" : "removing"} it changes what that space sees, so the key must be allowed in every space the role is granted to.`,
      };
    }
  }
  if (!(await inReachOf(target.entityId, spaces, grant))) {
    return { denied: outOfReach(write, spaces) };
  }
  return { space: spaces[0]! };
}

/**
 * A key limited to spaces finds a role row only in their reach: stamped in one
 * of them, or a shared row they read (`sharedRoleRowsInSpacesWhere`). Outside
 * it the row is not found, as an attach onto a record the key cannot read is,
 * never a refusal that names another space. No grant, or a scope not limited
 * to spaces: every row the person's floor finds.
 */
export async function roleRowInKeyReach(
  facetId: string,
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<boolean> {
  if (!grant || grant.scopes.some((scope) => !scope.workspaceIds)) return true;
  const spaces = keySpaces(grant);
  if (spaces.length === 0) return false;
  const [row] = await db
    .select({ id: entityFacets.id })
    .from(entityFacets)
    .where(
      and(
        eq(entityFacets.id, facetId),
        or(
          inArray(entityFacets.workspaceId, spaces),
          sharedRoleRowsInSpacesWhere(spaces)
        )
      )
    )
    .limit(1);
  return Boolean(row);
}

/** Every space the key's scopes are limited to. */
function keySpaces(grant: KeyGrant): string[] {
  return [
    ...new Set(grant.scopes.flatMap((scope) => scope.workspaceIds ?? [])),
  ];
}

/** A scope with no space limit permits `write` in `space` on its own. */
async function permittedUnlimited(
  write: Omit<GrantWriteInput, "workspaceId">,
  space: string,
  grant: KeyGrant
): Promise<boolean> {
  const unlimited = grant.scopes.filter((scope) => !scope.workspaceIds);
  if (unlimited.length === 0) return false;
  return (
    (await grantWriteDenial(
      { ...write, workspaceId: space },
      { ...grant, scopes: unlimited }
    )) === null
  );
}

/**
 * The record is live, readable by the key, and in the reach of `spaces`:
 * stored in one of them, or wearing a live role there (`roleInSpacesWhere`,
 * the member read rule).
 */
async function inReachOf(
  entityId: string,
  spaces: readonly string[],
  grant: KeyGrant
): Promise<boolean> {
  if (spaces.length === 0) return false;
  const [row] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        isNull(entities.deletedAt),
        keyGrantReadClause(entities, grant),
        or(
          inArray(entities.workspaceId, [...spaces]),
          roleInSpacesWhere(entities.workspaceId, entities.id, [...spaces])
        )
      )
    )
    .limit(1);
  return Boolean(row);
}

function outOfReach(
  write: Omit<GrantWriteInput, "workspaceId">,
  spaces: readonly string[]
): string {
  const { subject, action } = grantRequestKey(write.subjectType, write.action);
  const where =
    spaces.length === 1
      ? `workspace ${spaces[0]}`
      : `workspaces ${spaces.join(", ")}`;
  return `This key's grant does not allow "${subject}.${action}" on a record outside ${where}: a role goes only on a record that space already reaches (stored in it, or wearing a role there).`;
}

/**
 * The spaces a role is granted to: its `profile_workspace_access` rows and
 * its home space (`profiles.workspace_id`) — the set `grantedRoleIdsForSpaces`
 * reads from the other side, sorted so the refusal is deterministic.
 */
async function roleGrantedSpaces(profileId: string): Promise<string[]> {
  const [access, home] = await Promise.all([
    db
      .select({ id: profileWorkspaceAccess.workspaceId })
      .from(profileWorkspaceAccess)
      .where(eq(profileWorkspaceAccess.profileId, profileId)),
    db
      .select({ id: profiles.workspaceId })
      .from(profiles)
      .where(eq(profiles.id, profileId))
      .limit(1),
  ]);
  return [
    ...new Set(
      [...access, ...home]
        .map((r) => r.id)
        .filter((id): id is string => typeof id === "string")
    ),
  ].sort();
}

/**
 * #239's rule for CHANGING a shared role: the first key space, in the grant's
 * order, that reads this LIVE pod-wide facet on a live record (THE read
 * predicate `sharedRoleRowsInSpacesWhere`, the facets `spaceReach` of
 * access/grant-read.ts, for that one space: its role granted there, the record
 * pod-wide or stored there) and where the grant permits `write`. null
 * otherwise.
 */
async function reachedFacetGrantSpace(
  facetId: string,
  write: Omit<GrantWriteInput, "workspaceId">,
  grant: KeyGrant
): Promise<string | null> {
  for (const space of keySpaces(grant)) {
    const [reached] = await db
      .select({ id: entityFacets.id })
      .from(entityFacets)
      .innerJoin(entities, eq(entities.id, entityFacets.entityId))
      .where(
        and(
          eq(entityFacets.id, facetId),
          isNull(entityFacets.deletedAt),
          sharedRoleRowsInSpacesWhere([space]),
          isNull(entities.deletedAt)
        )
      )
      .limit(1);
    if (
      reached &&
      (await grantWriteDenial({ ...write, workspaceId: space }, grant)) === null
    )
      return space;
  }
  return null;
}
