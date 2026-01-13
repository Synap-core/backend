/**
 * Workspaces Worker
 *
 * Handles workspace CRUD operations (create, update, delete)
 * Security-critical: Workspaces are the primary security boundary
 */

import { inngest } from "../client.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "workspaces-worker" });

export const workspacesWorker = inngest.createFunction(
  {
    id: "workspaces-worker",
    name: "Workspaces CRUD Handler",
    retries: 3,
  },
  [
    { event: "workspaces.create.validated" },
    { event: "workspaces.update.validated" },
    { event: "workspaces.delete.validated" },
  ],
  async ({ event, step }) => {
    const eventName = event.name as string;
    const action = eventName.split(".")[1]; // 'create', 'update', 'delete'
    const userId = event.user?.id || event.data.userId;

    logger.info(
      { eventName, action, userId },
      "Processing workspace operation",
    );

    // ========================================================================
    // CREATE WORKSPACE
    // ========================================================================
    if (action === "create") {
      // Step 1: Create workspace
      const workspace = await step.run("create-workspace", async () => {
        const { getDb, workspaces } = await import("@synap/database");
        const db = await getDb();

        const [ws] = await db
          .insert(workspaces)
          .values({
            name: event.data.name,
            description: event.data.description,
            ownerId: userId,
            type: event.data.type || "personal",
            settings: event.data.settings || {},
            subscriptionTier: event.data.subscriptionTier || "free",
          })
          .returning();

        logger.info({ workspaceId: ws.id, name: ws.name }, "Workspace created");
        return ws;
      });

      // Step 2: Auto-add creator as owner member
      await step.run("add-owner-member", async () => {
        const { getDb, workspaceMembers } = await import("@synap/database");
        const db = await getDb();

        await db.insert(workspaceMembers).values({
          workspaceId: workspace.id,
          userId,
          role: "owner",
        });

        logger.info(
          { workspaceId: workspace.id, userId },
          "Owner member added",
        );
      });

      // Step 3: Emit completion event
      await step.run("emit-created", async () => {
        await inngest.send({
          name: "workspaces.create.completed",
          data: {
            workspaceId: workspace.id,
            workspace,
          },
          user: event.user,
        });

        logger.info(
          { workspaceId: workspace.id },
          "Create completed event emitted",
        );
      });

      return { success: true, workspaceId: workspace.id };
    }

    // ========================================================================
    // UPDATE WORKSPACE
    // ========================================================================
    if (action === "update") {
      const workspace = await step.run("update-workspace", async () => {
        const { getDb, workspaces, eq } = await import("@synap/database");
        const db = await getDb();

        const updateData: any = {};
        if (event.data.name) updateData.name = event.data.name;
        if (event.data.description !== undefined)
          updateData.description = event.data.description;
        if (event.data.settings) updateData.settings = event.data.settings;
        if (event.data.type) updateData.type = event.data.type;

        updateData.updatedAt = new Date();

        const [ws] = await db
          .update(workspaces)
          .set(updateData)
          .where(eq(workspaces.id, event.data.workspaceId))
          .returning();

        logger.info({ workspaceId: ws.id }, "Workspace updated");
        return ws;
      });

      // Emit completion
      await step.run("emit-updated", async () => {
        await inngest.send({
          name: "workspaces.update.completed",
          data: {
            workspaceId: workspace.id,
            workspace,
          },
          user: event.user,
        });
      });

      return { success: true, workspaceId: workspace.id };
    }

    // ========================================================================
    // DELETE WORKSPACE
    // ========================================================================
    if (action === "delete") {
      await step.run("delete-workspace", async () => {
        const { getDb, workspaces, eq } = await import("@synap/database");
        const db = await getDb();

        // Delete workspace (cascade will handle members, views, etc.)
        await db
          .delete(workspaces)
          .where(eq(workspaces.id, event.data.workspaceId));

        logger.info(
          { workspaceId: event.data.workspaceId },
          "Workspace deleted",
        );
      });

      // Emit completion
      await step.run("emit-deleted", async () => {
        await inngest.send({
          name: "workspaces.delete.completed",
          data: {
            workspaceId: event.data.workspaceId,
          },
          user: event.user,
        });
      });

      return { success: true, workspaceId: event.data.workspaceId };
    }

    logger.error({ action }, "Unknown workspace action");
    return { success: false, error: "Unknown action" };
  },
);
