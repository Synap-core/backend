/**
 * Skills Executor
 *
 * Handles validated skill events.
 * Stores skills in the database for the Intelligence Service to fetch.
 */

import { inngest } from "../client.js";
import { db, skills, eq } from "@synap/database";
import { randomUUID } from "crypto";

export const skillsExecutor = inngest.createFunction(
  {
    id: "skills-executor",
    name: "Skills Executor",
    retries: 3,
  },
  [
    { event: "skills.create.validated" },
    { event: "skills.update.validated" },
    { event: "skills.delete.validated" },
  ],
  async ({ event, step }) => {
    const eventType = event.name;
    const data = event.data;

    return await step.run("execute-skill-operation", async () => {
      if (eventType === "skills.create.validated") {
        const skillId = randomUUID();

        const [skill] = await db
          .insert(skills)
          .values({
            id: skillId,
            userId: data.userId,
            workspaceId: data.workspaceId || null,
            name: data.name,
            description: data.description || null,
            code: data.code,
            parameters: data.parameters || null,
            category: data.category || null,
            executionMode: data.executionMode || "sync",
            timeoutSeconds: data.timeoutSeconds || 30,
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

      if (eventType === "skills.update.validated") {
        const updateData: Record<string, unknown> = {};

        if (data.name !== undefined) updateData.name = data.name;
        if (data.description !== undefined)
          updateData.description = data.description;
        if (data.code !== undefined) updateData.code = data.code;
        if (data.parameters !== undefined)
          updateData.parameters = data.parameters;
        if (data.category !== undefined) updateData.category = data.category;
        if (data.executionMode !== undefined)
          updateData.executionMode = data.executionMode;
        if (data.timeoutSeconds !== undefined)
          updateData.timeoutSeconds = data.timeoutSeconds;

        // Reset error status if code is updated
        if (data.code !== undefined) {
          updateData.status = "active";
          updateData.errorMessage = null;
        }

        updateData.updatedAt = new Date();

        const [skill] = await db
          .update(skills)
          .set(updateData)
          .where(eq(skills.id, data.skillId))
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

      if (eventType === "skills.delete.validated") {
        await db.delete(skills).where(eq(skills.id, data.skillId));

        return {
          status: "completed",
          skillId: data.skillId,
          message: "Skill deleted successfully",
        };
      }

      throw new Error(`Unknown event type: ${eventType}`);
    });
  }
);
