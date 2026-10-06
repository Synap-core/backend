/**
 * GrantRoleRepository — the ONE write door for `grant_roles`.
 *
 * A role is a person's reusable, named permission list. Every write validates
 * its permissions with the shared grammar, so a stored role can always be
 * applied. Roles are archived, never hard-deleted: a key minted from a role
 * keeps its lineage (`grants.role_id`).
 *
 * A role is a template, never a live binding — see `schema/grant-roles.ts`.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { assertPermissions } from "@synap/governance-policy/grants";
import { db } from "../client-pg.js";
import { grantRoles, type GrantRoleRecord } from "../schema/grant-roles.js";

export interface GrantRoleInput {
  name: string;
  description?: string;
  permissions: string[];
  workspaceIds?: string[] | null;
  projectIds?: string[] | null;
  entityIds?: string[] | null;
  /** A number of days, null = never, undefined = the role sets no lifetime. */
  expiresInDays?: number | null;
}

const emptyToNull = (v?: string[] | null) =>
  v && v.length > 0 ? [...new Set(v)] : null;

function columns(input: GrantRoleInput) {
  assertPermissions(input.permissions);
  return {
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    permissions: [...new Set(input.permissions.map((p) => p.trim()))],
    workspaceIds: emptyToNull(input.workspaceIds),
    projectIds: emptyToNull(input.projectIds),
    entityIds: emptyToNull(input.entityIds),
    expiresInDays:
      typeof input.expiresInDays === "number" ? input.expiresInDays : null,
    neverExpires: input.expiresInDays === null,
  };
}

export class GrantRoleRepository {
  private readonly db: PostgresJsDatabase<any>;

  constructor(dbInstance: PostgresJsDatabase<any> = db) {
    this.db = dbInstance;
  }

  /** A person's active roles, by name. */
  async listForUser(userId: string): Promise<GrantRoleRecord[]> {
    return this.db
      .select()
      .from(grantRoles)
      .where(and(eq(grantRoles.userId, userId), isNull(grantRoles.archivedAt)))
      .orderBy(asc(grantRoles.name));
  }

  /** One of the person's active roles, or null (another person's = null). */
  async findOwned(userId: string, id: string): Promise<GrantRoleRecord | null> {
    const [row] = await this.db
      .select()
      .from(grantRoles)
      .where(
        and(
          eq(grantRoles.id, id),
          eq(grantRoles.userId, userId),
          isNull(grantRoles.archivedAt)
        )
      )
      .limit(1);
    return row ?? null;
  }

  async create(
    userId: string,
    input: GrantRoleInput
  ): Promise<GrantRoleRecord> {
    const [row] = await this.db
      .insert(grantRoles)
      .values({ userId, ...columns(input) })
      .returning();
    return row;
  }

  /** Replace an owned role's content; null when it is not the person's. */
  async update(
    userId: string,
    id: string,
    input: GrantRoleInput
  ): Promise<GrantRoleRecord | null> {
    const [row] = await this.db
      .update(grantRoles)
      .set({ ...columns(input), updatedAt: new Date() })
      .where(
        and(
          eq(grantRoles.id, id),
          eq(grantRoles.userId, userId),
          isNull(grantRoles.archivedAt)
        )
      )
      .returning();
    return row ?? null;
  }

  /** Archive an owned role; false when it is not the person's. */
  async archive(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(grantRoles)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(grantRoles.id, id),
          eq(grantRoles.userId, userId),
          isNull(grantRoles.archivedAt)
        )
      )
      .returning({ id: grantRoles.id });
    return rows.length > 0;
  }
}
