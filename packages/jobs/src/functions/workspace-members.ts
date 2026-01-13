/**
 * Workspace Members Worker
 *
 * Handles workspace membership operations (add, remove, update role)
 * Security-critical: Controls access to workspace resources
 */

import { inngest } from "../client.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "workspace-members-worker" });

export const workspaceMembersWorker = inngest.createFunction(
  {
    id: "workspace-members-worker",
    name: "Workspace Members Handler",
    retries: 3,
  },
  [
    { event: "workspaceMembers.add.validated" },
    { event: "workspaceMembers.remove.validated" },
    { event: "workspaceMembers.updateRole.validated" },
  ],
  async ({ event, step }) => {
    const eventName = event.name as string;
    const action = eventName.split(".")[1]; // 'add', 'remove', 'updateRole'
    const userId = event.user?.id || event.data.userId;

    logger.info(
      { eventName, action, userId },
      "Processing workspace member operation",
    );

    // ========================================================================
    // ADD MEMBER
    // ========================================================================
    if (action === "add") {
      const member = await step.run("add-member", async () => {
        const { getDb, workspaceMembers } = await import("@synap/database");
        const db = await getDb();

        const [member] = await db
          .insert(workspaceMembers)
          .values({
            workspaceId: event.data.workspaceId,
            userId: event.data.targetUserId,
            role: event.data.role || "viewer",
          })
          .returning();

        logger.info(
          {
            workspaceId: event.data.workspaceId,
            targetUserId: event.data.targetUserId,
            role: member.role,
          },
          "Member added",
        );

        return member;
      });

      // Delete invite if this was from invite acceptance
      if (event.data.inviteId) {
        await step.run("delete-invite", async () => {
          const { getDb, workspaceInvites, eq } =
            await import("@synap/database");
          const db = await getDb();

          await db
            .delete(workspaceInvites)
            .where(eq(workspaceInvites.id, event.data.inviteId));
          logger.info({ inviteId: event.data.inviteId }, "Invite deleted");
        });
      }

      // Emit completion
      await step.run("emit-added", async () => {
        await inngest.send({
          name: "workspaceMembers.add.completed",
          data: {
            workspaceId: event.data.workspaceId,
            member,
          },
          user: event.user,
        });
      });

      // Optional: Send notification to new member
      await step.run("notify-member", async () => {
        await inngest.send({
          name: "notifications.workspaceMemberAdded",
          data: {
            workspaceId: event.data.workspaceId,
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
      await step.run("remove-member", async () => {
        const { getDb, workspaceMembers, and, eq } =
          await import("@synap/database");
        const db = await getDb();

        await db
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, event.data.workspaceId),
              eq(workspaceMembers.userId, event.data.targetUserId),
            ),
          );

        logger.info(
          {
            workspaceId: event.data.workspaceId,
            targetUserId: event.data.targetUserId,
          },
          "Member removed",
        );
      });

      // Emit completion
      await step.run("emit-removed", async () => {
        await inngest.send({
          name: "workspaceMembers.remove.completed",
          data: {
            workspaceId: event.data.workspaceId,
            targetUserId: event.data.targetUserId,
          },
          user: event.user,
        });
      });

      // Optional: Notify removed member
      await step.run("notify-removed", async () => {
        await inngest.send({
          name: "notifications.workspaceMemberRemoved",
          data: {
            workspaceId: event.data.workspaceId,
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
      const member = await step.run("update-role", async () => {
        const { getDb, workspaceMembers, and, eq } =
          await import("@synap/database");
        const db = await getDb();

        const [member] = await db
          .update(workspaceMembers)
          .set({
            role: event.data.newRole,
          })
          .where(
            and(
              eq(workspaceMembers.workspaceId, event.data.workspaceId),
              eq(workspaceMembers.userId, event.data.targetUserId),
            ),
          )
          .returning();

        logger.info(
          {
            workspaceId: event.data.workspaceId,
            targetUserId: event.data.targetUserId,
            newRole: event.data.newRole,
          },
          "Member role updated",
        );

        return member;
      });

      // Emit completion
      await step.run("emit-role-updated", async () => {
        await inngest.send({
          name: "workspaceMembers.updateRole.completed",
          data: {
            workspaceId: event.data.workspaceId,
            member,
          },
          user: event.user,
        });
      });

      // Optional: Notify member of role change
      await step.run("notify-role-change", async () => {
        await inngest.send({
          name: "notifications.workspaceMemberRoleChanged",
          data: {
            workspaceId: event.data.workspaceId,
            targetUserId: event.data.targetUserId,
            newRole: event.data.newRole,
            changedBy: userId,
          },
        });
      });

      return { success: true, memberId: member.id };
    }

    logger.error({ action }, "Unknown workspace member action");
    return { success: false, error: "Unknown action" };
  },
);
