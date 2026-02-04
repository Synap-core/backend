/**
 * Agents Executor
 *
 * Handles validated agent events.
 */

import { inngest } from "../client.js";
import { AgentRepository } from "@synap/database";
import { getDb } from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const agentsExecutor = inngest.createFunction(
  {
    id: "agents-executor",
    name: "Agents Executor",
    retries: 3,
  },
  [
    { event: "agents.create.validated" },
    { event: "agents.update.validated" },
    { event: "agents.delete.validated" },
  ],
  async ({ event, step }) => {
    const eventInfo = extractEventInfo(event.name);
    const { action, phase } = eventInfo;
    const data = event.data as UnifiedEventData;

    // Ensure we're handling a validated event
    if (phase !== "validated") {
      console.warn(
        `[agentsExecutor] Received non-validated event: ${event.name}`
      );
      return { success: false, reason: "Not a validated event" };
    }

    return await step.run("execute-agent-operation", async () => {
      const db = await getDb();
      const repo = new AgentRepository(db);

      if (action === "create") {
        const agent = await repo.create(
          {
            id: data.id as string,
            name: data.name as string,
            description: data.description as string | undefined,
            createdBy: data.createdBy as string,
            userId: data.userId as string | undefined,
            llmProvider: data.llmProvider as
              | "claude"
              | "openai"
              | "ollama"
              | "gemini"
              | undefined,
            llmModel: data.llmModel as string,
            capabilities: data.capabilities as string[],
            systemPrompt: data.systemPrompt as string,
            toolsConfig: data.toolsConfig as
              | Record<string, unknown>
              | undefined,
            executionMode: data.executionMode as
              | "simple"
              | "react"
              | "langgraph"
              | undefined,
            maxIterations: data.maxIterations as number | undefined,
            timeoutSeconds: data.timeoutSeconds as number | undefined,
            weight: data.weight as string | undefined,
            performanceMetrics: data.performanceMetrics as
              | Record<string, unknown>
              | undefined,
            active: data.active as boolean | undefined,
          },
          data.userId as string
        );

        return {
          status: "completed",
          agentId: agent.id,
          message: "Agent created successfully",
        };
      }

      if (action === "update") {
        const agent = await repo.update(
          data.id as string,
          {
            name: data.name as string | undefined,
            description: data.description as string | undefined,
            llmProvider: data.llmProvider as
              | "claude"
              | "openai"
              | "ollama"
              | "gemini"
              | undefined,
            llmModel: data.llmModel as string | undefined,
            capabilities: data.capabilities as string[] | undefined,
            systemPrompt: data.systemPrompt as string | undefined,
            toolsConfig: data.toolsConfig as
              | Record<string, unknown>
              | undefined,
            executionMode: data.executionMode as
              | "simple"
              | "react"
              | "langgraph"
              | undefined,
            maxIterations: data.maxIterations as number | undefined,
            timeoutSeconds: data.timeoutSeconds as number | undefined,
            weight: data.weight as string | undefined,
            performanceMetrics: data.performanceMetrics as
              | Record<string, unknown>
              | undefined,
            active: data.active as boolean | undefined,
          },
          data.userId as string
        );

        return {
          status: "completed",
          agentId: agent.id,
          message: "Agent updated successfully",
        };
      }

      if (action === "delete") {
        await repo.delete(data.id as string, data.userId as string);

        return {
          status: "completed",
          agentId: data.id as string,
          message: "Agent deleted successfully",
        };
      }

      throw new Error(`Unknown action: ${action}`);
    });
  }
);
