/**
 * Skills Executor
 *
 * Handles validated skill events.
 * Stores skills in the database for the Intelligence Service to fetch.
 */

import { inngest } from "../client.js";
import { db, skills, eq } from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const skillsExecutor = inngest.createFunction(
  {
    id: "skills-executor",
    name: "Skills Executor",
    retries: 3,
  },
  { event: "skill.*" },
  async ({ event, step }) => {
    const eventInfo = extractEventInfo(event.name);
    const { action, phase } = eventInfo;
    const data = event.data as UnifiedEventData;

    // Ensure we're handling a validated event
    if (phase !== "validated") {
      console.warn(
        `[skillsExecutor] Received non-validated event: ${event.name}`
      );
      return { success: false, reason: "Not a validated event" };
    }

    return await step.run("execute-skill-operation", async () => {
      if (action === "create") {
        const [skill] = await db
          .insert(skills)
          .values({
            userId: data.userId as string,
            workspaceId: (data.workspaceId as string | undefined) || null,
            name: data.name as string,
            description: (data.description as string | undefined) || null,
            code: data.code as string,
            parameters:
              (data.parameters as Record<string, unknown> | undefined) || null,
            category: (data.category as string | undefined) || null,
            executionMode:
              (data.executionMode as "sync" | "async" | undefined) || "sync",
            timeoutSeconds: (data.timeoutSeconds as number | undefined) || 30,
            status: "active",
            metadata: {},
          })
          .returning();

        return {
          status: "completed",
          skillId: skill.id,
          message: "Skill created successfully",
        };
      }

      if (action === "update") {
        const updateData: Record<string, unknown> = {};

        if (data.name !== undefined) updateData.name = data.name as string;
        if (data.description !== undefined)
          updateData.description = data.description as string;
        if (data.code !== undefined) updateData.code = data.code as string;
        if (data.parameters !== undefined)
          updateData.parameters = data.parameters as Record<string, unknown>;
        if (data.category !== undefined)
          updateData.category = data.category as string;
        if (data.executionMode !== undefined)
          updateData.executionMode = data.executionMode as "sync" | "async";
        if (data.timeoutSeconds !== undefined)
          updateData.timeoutSeconds = data.timeoutSeconds as number;

        // Reset error status if code is updated
        if (data.code !== undefined) {
          updateData.status = "active";
          updateData.errorMessage = null;
        }

        updateData.updatedAt = new Date();

        const [skill] = await db
          .update(skills)
          .set(updateData)
          .where(eq(skills.id, data.skillId as string))
          .returning();

        if (!skill) {
          throw new Error(`Skill not found: ${data.skillId}`);
        }

        return {
          status: "completed",
          skillId: skill.id,
          message: "Skill updated successfully",
        };
      }

      if (action === "delete") {
        await db.delete(skills).where(eq(skills.id, data.skillId as string));

        return {
          status: "completed",
          skillId: data.skillId as string,
          message: "Skill deleted successfully",
        };
      }

      throw new Error(`Unknown action: ${action}`);
    });
  }
);
