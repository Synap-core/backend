/**
 * Thought Processor - Creates entities from AI-analyzed thoughts
 *
 * This projector listens to 'ai/thought.analyzed' and creates the appropriate entities
 */

import { inngest } from "../client.js";
import { db, events } from "@synap/database";
import { randomUUID } from "crypto";

/**
 * Handle AI-analyzed thoughts and create entities
 */
export const processAnalyzedThought = inngest.createFunction(
  {
    id: "process-analyzed-thought",
    name: "Process Analyzed Thought",
  },
  {
    event: "ai/thought.analyzed",
  },
  async ({ event, step }) => {
    const { content, analysis, userId } = event.data;

    if (!userId) {
      throw new Error("userId is required in ai/thought.analyzed event");
    }

    console.log(
      `📝 Creating entity from analyzed thought for user ${userId}...`,
    );

    // Step 1: Create entity.created event
    const entityId = randomUUID();

    await step.run("create-entity-event", async () => {
      await db.insert(events).values({
        type: "entity.created",
        subjectId: entityId, // ✅ Entity being created
        subjectType: "entity", // ✅ Type of subject
        data: {
          entityId,
          type: analysis.intent,
          title: analysis.title,
          content,
          tagNames: analysis.tags,
          dueDate: analysis.dueDate,
          priority: analysis.priority,
          userId, // ✅ Include userId in event data for projector
        },
        source: "automation",
        userId, // ✅ User isolation
      });

      return { entityId };
    });

    // Step 2: The entity.created event will trigger the main projector
    // which will actually create the entity in the database

    console.log(
      `✅ Entity creation event logged: ${entityId} for user ${userId}`,
    );

    return {
      success: true,
      entityId,
      analysis,
    };
  },
);
