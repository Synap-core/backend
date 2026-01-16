/**
 * Project Member Repository
 *
 * Handles project membership with event emission
 */

import type { EventRepository } from "./event-repository.js";
import { projectMembers } from "../schema/index.js";
import { eq, and } from "drizzle-orm";

export interface AddProjectMemberInput {
  projectId: string;
  userId: string;
  role: "owner" | "editor" | "viewer";
}

export interface RemoveProjectMemberInput {
  projectId: string;
  userId: string;
}

export interface UpdateProjectRoleInput {
  projectId: string;
  userId: string;
  newRole: "owner" | "editor" | "viewer";
}

export type ProjectMemberRow = typeof projectMembers.$inferSelect;

export class ProjectMemberRepository {
  constructor(
    private db: any,
    private eventRepo: EventRepository
  ) {}

  async add(
    input: AddProjectMemberInput,
    actingUserId: string
  ): Promise<ProjectMemberRow> {
    const [member] = await this.db
      .insert(projectMembers)
      .values({
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
      })
      .returning();

    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: "projectMembers.add.completed",
      subjectId: member.id,
      subjectType: "projectMember",
      userId: actingUserId,
      source: "api",
      timestamp: new Date(),
      data: {
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
        memberId: member.id,
      },
      metadata: {},
    });

    return member;
  }

  async remove(
    input: RemoveProjectMemberInput,
    actingUserId: string
  ): Promise<void> {
    await this.db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.userId, input.userId)
        )
      );

    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: "projectMembers.remove.completed",
      subjectId: input.userId,
      subjectType: "projectMember",
      userId: actingUserId,
      source: "api",
      timestamp: new Date(),
      data: {
        projectId: input.projectId,
        userId: input.userId,
      },
      metadata: {},
    });
  }

  async updateRole(
    input: UpdateProjectRoleInput,
    actingUserId: string
  ): Promise<ProjectMemberRow> {
    const [member] = await this.db
      .update(projectMembers)
      .set({ role: input.newRole })
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.userId, input.userId)
        )
      )
      .returning();

    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: "projectMembers.updateRole.completed",
      subjectId: member.id,
      subjectType: "projectMember",
      userId: actingUserId,
      source: "api",
      timestamp: new Date(),
      data: {
        projectId: input.projectId,
        userId: input.userId,
        newRole: input.newRole,
        memberId: member.id,
      },
      metadata: {},
    });

    return member;
  }
}
