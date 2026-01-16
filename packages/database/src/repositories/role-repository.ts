/**
 * Role Repository
 *
 * Handles custom role CRUD with event emission for audit trail.
 * Supports workspace-scoped and global roles.
 */

import { eq } from "drizzle-orm";
import { roles } from "../schema/index.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";

export interface CreateRoleInput {
  name: string;
  description?: string;
  workspaceId?: string; // NULL for global roles
  permissions: Record<string, unknown>;
  filters?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateRoleData {
  name?: string;
  description?: string;
  permissions?: Record<string, unknown>;
  filters?: Record<string, unknown>;
}

export class RoleRepository extends BaseRepository<
  any,
  CreateRoleInput,
  UpdateRoleData
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "role", pluralName: "roles" });
  }

  /**
   * Create a new role
   * Emits: roles.create.completed
   */
  async create(data: CreateRoleInput, userId: string): Promise<any> {
    const [role] = await this.db
      .insert(roles)
      .values({
        name: data.name,
        description: data.description,
        workspaceId: data.workspaceId,
        permissions: data.permissions,
        filters: data.filters || {},
        createdBy: data.createdBy,
      })
      .returning();

    await this.emitCompleted("create", role, userId);
    return role;
  }

  /**
   * Update a role
   * Emits: roles.update.completed
   */
  async update(id: string, data: UpdateRoleData, userId: string): Promise<any> {
    const [role] = await this.db
      .update(roles)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(roles.id, id))
      .returning();

    if (!role) {
      throw new Error("Role not found");
    }

    await this.emitCompleted("update", role, userId);
    return role;
  }

  /**
   * Delete a role
   * Emits: roles.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(roles)
      .where(eq(roles.id, id))
      .returning();

    if (result.length === 0) {
      throw new Error("Role not found");
    }

    await this.emitCompleted("delete", { id }, userId);
  }

  /**
   * Find roles by workspace
   */
  async findByWorkspace(workspaceId: string): Promise<any[]> {
    return this.db.query.roles.findMany({
      where: eq(roles.workspaceId, workspaceId),
    });
  }

  /**
   * Find global roles (workspaceId is NULL)
   */
  async findGlobalRoles(): Promise<any[]> {
    const { isNull } = await import("drizzle-orm");
    return this.db.query.roles.findMany({
      where: isNull(roles.workspaceId),
    });
  }
}
