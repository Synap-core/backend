/**
 * AI Analyzer - Thought Analysis with Anthropic (Claude)
 *
 * Analyzes raw thoughts and extracts structured data:
 * - Title
 * - Tags
 * - Intent (note, task, event, etc.)
 * - Due date (for tasks)
 */

import { inngest } from "../client.js";
import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

// Schema for AI-extracted data
const thoughtAnalysisSchema = z.object({
  title: z
    .string()
    .describe("A concise title for this thought (max 100 chars)"),
  tags: z.array(z.string()).describe("Relevant tags (3-5 tags)"),
  intent: z
    .enum(["note", "task", "event", "idea"])
    .describe("What type of entity is this?"),
  dueDate: z
    .string()
    .optional()
    .describe('ISO date if this is a task (e.g., "2025-11-06")'),
  priority: z
    .number()
    .min(0)
    .max(3)
    .optional()
    .describe("Priority for tasks: 0=none, 1=low, 2=medium, 3=high"),
});

/**
 * Analyze captured thought with AI
 */
export const analyzeCapturedThought = inngest.createFunction(
  {
    id: "ai-analyze-thought",
    name: "Analyze Captured Thought",
  },
  {
    event: "api/thought.captured",
  },
  async ({ event, step }) => {
    const { content, context, userId } = event.data;

    if (!userId) {
      throw new Error("userId is required in api/thought.captured event");
    }

    console.log(
      `🤖 Analyzing thought for user ${userId}: "${content.substring(0, 50)}..."`,
    );

    // Step 1: AI Analysis
    const analysis = await step.run("analyze-with-ai", async () => {
      try {
        const result = await generateObject({
          model: anthropic("claude-3-haiku-20240307"),
          schema: thoughtAnalysisSchema,
          prompt: `Analyze this thought and extract structured data:

"${content}"

Context: ${JSON.stringify(context)}

Instructions:
- Generate a clear, concise title
- Suggest 3-5 relevant tags
- Determine the intent (note, task, event, or idea)
- If it's a task, extract the due date if mentioned
- If it's a task, estimate priority (0-3)
`,
        });

        return result.object;
      } catch (error) {
        console.error("AI analysis failed:", error);
        // Fallback to simple extraction
        return {
          title: content.substring(0, 100),
          tags: ["unprocessed"],
          intent: "note" as const,
        };
      }
    });

    console.log(`✅ Analysis complete for user ${userId}:`, analysis);

    // Step 2: Emit analyzed event with userId
    await step.sendEvent("emit-analyzed-event", {
      name: "ai/thought.analyzed",
      data: {
        content,
        analysis,
        context,
        userId, // ✅ Pass userId through the pipeline
      },
    });

    return { status: "analyzed", analysis };
  },
);
