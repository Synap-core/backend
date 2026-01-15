/**
 * Agents Executor
 * 
 * Handles validated agent events.
 */

import { inngest } from "../client.js";
import { AgentRepository } from "@synap/database";
import { getDb } from "@synap/database";

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
    const eventType = event.name;
    const data = event.data;

    return await step.run("execute-agent-operation", async () => {
      const db = await getDb();
      const repo = new AgentRepository(db as any);

      if (eventType === "agents.create.validated") {
        const agent = await repo.create({
          id: data.id,
          name: data.name,
          description: data.description,
          createdBy: data.createdBy,
          userId: data.userId,
          llmProvider: data.llmProvider,
          llmModel: data.llmModel,
          capabilities: data.capabilities,
          systemPrompt: data.systemPrompt,
          toolsConfig: data.toolsConfig,
          executionMode: data.executionMode,
          maxIterations: data.maxIterations,
          timeoutSeconds: data.timeoutSeconds,
          weight: data.weight,
          performanceMetrics: data.performanceMetrics,
          active: data.active,
        }, data.userId);

        return {
          status: "completed",
          agentId: agent.id,
          message: "Agent created successfully",
        };
      }

      if (eventType === "agents.update.validated") {
        const agent = await repo.update(data.id, {
          name: data.name,
          description: data.description,
          llmProvider: data.llmProvider,
          llmModel: data.llmModel,
          capabilities: data.capabilities,
          systemPrompt: data.systemPrompt,
          toolsConfig: data.toolsConfig,
          executionMode: data.executionMode,
          maxIterations: data.maxIterations,
          timeoutSeconds: data.timeoutSeconds,
          weight: data.weight,
          performanceMetrics: data.performanceMetrics,
          active: data.active,
        }, data.userId);

        return {
          status: "completed",
          agentId: agent.id,
          message: "Agent updated successfully",
        };
      }

      if (eventType === "agents.delete.validated") {
        await repo.delete(data.id, data.userId);

        return {
          status: "completed",
          agentId: data.id,
          message: "Agent deleted successfully",
        };
      }

      throw new Error(`Unknown event type: ${eventType}`);
    });
  }
);
