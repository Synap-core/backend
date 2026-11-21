/**
 * THE rule for "can this object be used in that space?": an object with no
 * home (`workspace_id` NULL) is pod-wide and usable everywhere; an object
 * homed in a space is usable there, and in every space a `space_access` row
 * grants it to. A project never widens it (its `uses` link is an index, not a
 * permission). Checked by the same function at filing, at approval and at run.
 *
 * `workspaceId` null means "outside any space": only pod-wide objects qualify.
 * Object types that cannot be granted (automations, relation defs) read the
 * home rule alone through {@link usableWith}.
 */
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../client-pg.js";
import { spaceAccess, type SpaceAccessObjectType } from "../schema/profiles.js";
import { userVisibleWhere } from "./user-visible-where.js";

export interface HomedObject {
  id: string;
  workspaceId: string | null;
}

/** The home rule, plus the spaces `granted` names (pure; no read). */
export function usableWith(
  object: Pick<HomedObject, "workspaceId">,
  workspaceId: string | null,
  granted?: ReadonlySet<string>
): boolean {
  if (!object.workspaceId || object.workspaceId === workspaceId) {
    return true;
  }
  return workspaceId !== null && (granted?.has(workspaceId) ?? false);
}

/** The spaces each object is granted to, in one read. */
export async function spaceGrantsOf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  objectType: SpaceAccessObjectType,
  ids: readonly string[]
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (ids.length === 0) return out;
  const rows = (await database
    .select({
      objectId: spaceAccess.objectId,
      workspaceId: spaceAccess.workspaceId,
    })
    .from(spaceAccess)
    .where(
      and(
        eq(spaceAccess.objectType, objectType),
        inArray(spaceAccess.objectId, [...new Set(ids)])
      )
    )) as Array<{ objectId: string; workspaceId: string }>;
  for (const row of rows) {
    const set = out.get(row.objectId) ?? new Set<string>();
    set.add(row.workspaceId);
    out.set(row.objectId, set);
  }
  return out;
}

/** {@link usableWith} with the object's grants read when the home rule says no. */
export async function usableInSpace(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  objectType: SpaceAccessObjectType,
  object: HomedObject,
  workspaceId: string | null
): Promise<boolean> {
  if (usableWith(object, workspaceId)) return true;
  if (workspaceId === null) return false;
  const grants = await spaceGrantsOf(database, objectType, [object.id]);
  return usableWith(object, workspaceId, grants.get(object.id));
}

/**
 * {@link usableInSpace} as SQL, for a list read. With `readerId`, a homed or
 * granted object also needs a space that person can see (`userVisibleWhere`).
 */
export function usableInSpaceWhere(
  objectType: SpaceAccessObjectType,
  idColumn: AnyPgColumn,
  homeColumn: AnyPgColumn,
  workspaceId: string | null,
  readerId?: string
): SQL {
  if (workspaceId === null) return isNull(homeColumn);
  return or(
    isNull(homeColumn),
    and(
      eq(homeColumn, workspaceId),
      readerId ? userVisibleWhere(homeColumn, readerId) : undefined
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(spaceAccess)
        .where(
          and(
            eq(spaceAccess.objectType, objectType),
            eq(spaceAccess.objectId, idColumn),
            eq(spaceAccess.workspaceId, workspaceId),
            readerId
              ? userVisibleWhere(spaceAccess.workspaceId, readerId)
              : undefined
          )
        )
    )
  )!;
}

/**
 * Why `object` cannot be used in `workspaceId`, naming the fixes: run it where
 * it lives, or share it with this space. Keeps the words "not visible in",
 * which tests and agents match on.
 */
export function notUsableInSpaceReason(
  noun: string,
  object: HomedObject & { name: string },
  workspaceId: string | null
): string {
  const where = workspaceId
    ? `space ${workspaceId}`
    : "a run outside its space";
  const share = workspaceId ? `, or share it with space ${workspaceId}` : "";
  return (
    `${noun} "${object.name}" (${object.id}) lives in space ${object.workspaceId}, ` +
    `so it is not visible in ${where}: run it in space ${object.workspaceId}${share}.`
  );
}
