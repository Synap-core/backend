/**
 * Workspace Member Repository
 *
 * Handles workspace membership with event emission
 */

import type { EventRepository } from "./event-repository.js";
import { workspaceMembers, workspaceInvites } from "../schema/index.js";
import { eq, and } from "drizzle-orm";

export interface AddMemberInput {
  workspaceId: string;
  userId: string;
  role: "owner" | "editor" | "viewer";
  inviteId?: string;
}

export interface RemoveMemberInput {
  workspaceId: string;
  userId: string;
}

export interface UpdateRoleInput {
  workspaceId: string;
  userId: string;
  newRole: "owner" | "editor" | "viewer";
}

export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;

export class WorkspaceMemberRepository {
  constructor(private db: any, private eventRepo: EventRepository) {}

  async add(input: AddMemberInput, actingUserId: string): Promise<WorkspaceMemberRow> {
    const [member] = await this.db
      .insert(workspaceMembers)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
      })
      .returning();

    // Delete invite if provided
    if (input.inviteId) {
      await this.db
        .delete(workspaceInvites)
        .where(eq(workspaceInvites.id, input.inviteId));
    }

    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: "workspaceMembers.add.completed",
      subjectId: member.id,
      subjectType: "workspaceMember",
      userId: actingUserId,
      source: "api",
      timestamp: new Date(),
      data: { 
        workspaceId: input.workspaceId, 
        userId: input.userId,
        role: input.role,
        memberId: member.id 
      },
      metadata: {},
    });

    return member;
  }

  async remove(input: RemoveMemberInput, actingUserId: string): Promise<void> {
    await this.db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      );

    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: "workspaceMembers.remove.completed",
      subjectId: input.userId,
      subjectType: "workspaceMember",
      userId: actingUserId,
      source: "api",
      timestamp: new Date(),
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
      },
      metadata: {},
    });
  }

  async updateRole(input: UpdateRoleInput, actingUserId: string): Promise<WorkspaceMemberRow> {
    const [member] = await this.db
      .update(workspaceMembers)
      .set({ role: input.newRole })
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .returning();

    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: "workspaceMembers.updateRole.completed",
      subjectId: member.id,
      subjectType: "workspaceMember",
      userId: actingUserId,
      source: "api",
      timestamp: new Date(),
      data: { 
        workspaceId: input.workspaceId, 
        userId: input.userId,
        newRole: input.newRole,
        memberId: member.id 
      },
      metadata: {},
    });

    return member;
  }
}
