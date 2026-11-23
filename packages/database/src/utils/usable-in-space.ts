/**
 * The rule for "can this object be used in that space?": an object with no
 * home (`workspace_id` NULL) is pod-wide and usable everywhere; an object homed
 * in a space is usable there and in every space it is shared with (a
 * `space_access` row). A project never widens it (its `uses` link is an index,
 * not a permission). Checked by the same function at filing, at approval and
 * at run.
 *
 * `workspaceId` null means "outside any space": only pod-wide objects qualify.
 * A share also makes the object READABLE by the members of the space it is
 * shared with ({@link sharedReadableWhere}); editing stays with its home's
 * writers.
 * Kinds read their grants through the kind floor (`kindVisibleWhere`) and the
 * facet floor (`grantedRoleIdsForSpaces`).
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, type db as Db } from "../client-pg.js";
import { spaceAccess, type SpaceAccessObjectType } from "../schema/profiles.js";
import { workspaceLensWhere, type WorkspaceLens } from "./user-visible-where.js";

/** A shareable object's type in `space_access` and its id column. */
export interface SharedAs {
  type: SpaceAccessObjectType;
  id: AnyPgColumn;
}

export function usableInSpace(
  object: { workspaceId: string | null; sharedWith?: readonly string[] },
  workspaceId: string | null
): boolean {
  return (
    !object.workspaceId ||
    object.workspaceId === workspaceId ||
    (workspaceId !== null && (object.sharedWith ?? []).includes(workspaceId))
  );
}

/** {@link usableInSpace} as SQL, for a list read; `shared` adds the grants. */
export function usableInSpaceWhere(
  homeColumn: AnyPgColumn,
  workspaceId: string | null,
  shared?: SharedAs
): SQL {
  if (workspaceId === null) return isNull(homeColumn);
  return or(
    isNull(homeColumn),
    eq(homeColumn, workspaceId),
    shared
      ? sql`exists (select 1 from space_access sa where sa.object_type = ${shared.type} and sa.object_id = ${shared.id} and sa.workspace_id = ${workspaceId})`
      : undefined
  )!;
}

/**
 * {@link usableInSpace} for one object, reading its grants only when its home
 * does not already answer.
 */
export async function isUsableInSpace(
  db: Pick<typeof Db, "select">,
  type: SpaceAccessObjectType,
  object: { id: string; workspaceId: string | null },
  workspaceId: string | null
): Promise<boolean> {
  if (usableInSpace(object, workspaceId)) return true;
  if (workspaceId === null) return false;
  const [grant] = await db
    .select({ objectId: spaceAccess.objectId })
    .from(spaceAccess)
    .where(
      and(
        eq(spaceAccess.objectType, type),
        eq(spaceAccess.objectId, object.id),
        eq(spaceAccess.workspaceId, workspaceId)
      )
    );
  return grant !== undefined;
}

/**
 * Rows shared (`space_access`) with a space `userId` can see, narrowed by
 * `lens` the way the home is: what a share adds to an object's readers. The
 * access registry ORs it into the home rule of a shareable table.
 */
export function sharedReadableWhere(
  shared: SharedAs,
  userId: string,
  lens?: WorkspaceLens
): SQL {
  return inArray(
    shared.id,
    db
      .select({ id: spaceAccess.objectId })
      .from(spaceAccess)
      .where(
        and(
          eq(spaceAccess.objectType, shared.type),
          workspaceLensWhere(spaceAccess.workspaceId, userId, lens)
        )
      )
  );
}

/** `rows` with the spaces each is shared with (`sharedWith`), in one read. */
export async function withSpaceGrants<T extends { id: string }>(
  db: Pick<typeof Db, "select">,
  type: SpaceAccessObjectType,
  rows: T[]
): Promise<Array<T & { sharedWith: string[] }>> {
  const grants = rows.length
    ? await db
        .select({
          objectId: spaceAccess.objectId,
          workspaceId: spaceAccess.workspaceId,
        })
        .from(spaceAccess)
        .where(
          and(
            eq(spaceAccess.objectType, type),
            inArray(
              spaceAccess.objectId,
              rows.map((r) => r.id)
            )
          )
        )
    : [];
  return rows.map((r) => ({
    ...r,
    sharedWith: grants
      .filter((g) => g.objectId === r.id)
      .map((g) => g.workspaceId),
  }));
}

/** Share an object with a space (idempotent). The door decides who may. */
export async function grantSpaceAccess(
  db: Pick<typeof Db, "insert">,
  grant: {
    objectType: SpaceAccessObjectType;
    objectId: string;
    workspaceId: string;
    grantedBy?: string | null;
  }
): Promise<void> {
  await db
    .insert(spaceAccess)
    .values({ ...grant, grantedBy: grant.grantedBy ?? null })
    .onConflictDoNothing();
}

/** Stop sharing an object with a space, or with every space when none is named. */
export async function revokeSpaceAccess(
  db: Pick<typeof Db, "delete">,
  grant: {
    objectType: SpaceAccessObjectType;
    objectId: string;
    workspaceId?: string;
  }
): Promise<void> {
  await db
    .delete(spaceAccess)
    .where(
      and(
        eq(spaceAccess.objectType, grant.objectType),
        eq(spaceAccess.objectId, grant.objectId),
        grant.workspaceId
          ? eq(spaceAccess.workspaceId, grant.workspaceId)
          : undefined
      )
    );
}

/** Why `object` cannot be used in `workspaceId`, naming where it can run. */
export function notUsableInSpaceReason(
  noun: string,
  object: { id: string; name: string; workspaceId: string | null },
  workspaceId: string | null
): string {
  return (
    `${noun} "${object.name}" (${object.id}) lives in space ${object.workspaceId}, ` +
    `so it is not visible in ${workspaceId ? `space ${workspaceId}` : "a run outside its space"}: ` +
    `run it in space ${object.workspaceId}.`
  );
}
