/**
 * Project Members Worker
 *
 * Handles project membership operations (add, remove, update role)
 * Mirrors workspace-members worker but for project-level access control
 */

import { inngest } from "../client.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "project-members-worker" });

export const projectMembersWorker = inngest.createFunction(
  {
    id: "project-members-worker",
    name: "Project Members Handler",
    retries: 3,
  },
  [
    { event: "projectMembers.add.validated" },
    { event: "projectMembers.remove.validated" },
    { event: "projectMembers.updateRole.validated" },
  ],
  async ({ event, step }) => {
    const eventName = event.name as string;
    const action = eventName.split(".")[1]; // 'add', 'remove', 'updateRole'
    const userId = event.user?.id || event.data.userId;

    logger.info(
      { eventName, action, userId },
      "Processing project member operation",
    );

    // ========================================================================
    // ADD MEMBER
    // ========================================================================
    if (action === "add") {
      const member = await step.run("add-project-member", async () => {
        const { getDb, projectMembers } = await import("@synap/database");
        const db = await getDb();

        const [member] = await db
          .insert(projectMembers)
          .values({
            projectId: event.data.projectId,
            userId: event.data.targetUserId,
            role: event.data.role || "viewer",
            invitedBy: event.data.invitedBy,
          })
          .returning();

        logger.info(
          {
            projectId: event.data.projectId,
            targetUserId: event.data.targetUserId,
            role: member.role,
          },
          "Project member added",
        );

        return member;
      });

      // Emit completion
      await step.run("emit-added", async () => {
        await inngest.send({
          name: "projectMembers.add.completed",
          data: {
            projectId: event.data.projectId,
            member,
          },
          user: event.user,
        });
      });

      // Optional: Send notification to new member
      await step.run("notify-member", async () => {
        await inngest.send({
          name: "notifications.projectMemberAdded",
          data: {
            projectId: event.data.projectId,
            targetUserId: event.data.targetUserId,
            addedBy: userId,
          },
        });
      });

      return { success: true, memberId: member.id };
    }

    // ========================================================================
    // REMOVE MEMBER
    // ========================================================================
    if (action === "remove") {
      await step.run("remove-project-member", async () => {
        const { getDb, projectMembers, and, eq } =
          await import("@synap/database");
        const db = await getDb();

        await db
          .delete(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, event.data.projectId),
              eq(projectMembers.userId, event.data.targetUserId),
            ),
          );

        logger.info(
          {
            projectId: event.data.projectId,
            targetUserId: event.data.targetUserId,
          },
          "Project member removed",
        );
      });

      // Emit completion
      await step.run("emit-removed", async () => {
        await inngest.send({
          name: "projectMembers.remove.completed",
          data: {
            projectId: event.data.projectId,
            targetUserId: event.data.targetUserId,
          },
          user: event.user,
        });
      });

      // Optional: Notify removed member
      await step.run("notify-removed", async () => {
        await inngest.send({
          name: "notifications.projectMemberRemoved",
          data: {
            projectId: event.data.projectId,
            targetUserId: event.data.targetUserId,
            removedBy: userId,
          },
        });
      });

      return { success: true };
    }

    // ========================================================================
    // UPDATE ROLE
    // ========================================================================
    if (action === "updateRole") {
      const member = await step.run("update-project-role", async () => {
        const { getDb, projectMembers, and, eq } =
          await import("@synap/database");
        const db = await getDb();

        const [member] = await db
          .update(projectMembers)
          .set({
            role: event.data.newRole,
          })
          .where(
            and(
              eq(projectMembers.projectId, event.data.projectId),
              eq(projectMembers.userId, event.data.targetUserId),
            ),
          )
          .returning();

        logger.info(
          {
            projectId: event.data.projectId,
            targetUserId: event.data.targetUserId,
            newRole: event.data.newRole,
          },
          "Project member role updated",
        );

        return member;
      });

      // Emit completion
      await step.run("emit-role-updated", async () => {
        await inngest.send({
          name: "projectMembers.updateRole.completed",
          data: {
            projectId: event.data.projectId,
            member,
          },
          user: event.user,
        });
      });

      // Optional: Notify member of role change
      await step.run("notify-role-change", async () => {
        await inngest.send({
          name: "notifications.projectMemberRoleChanged",
          data: {
            projectId: event.data.projectId,
            targetUserId: event.data.targetUserId,
            newRole: event.data.newRole,
            changedBy: userId,
          },
        });
      });

      return { success: true, memberId: member.id };
    }

    logger.error({ action }, "Unknown project member action");
    return { success: false, error: "Unknown action" };
  },
);
