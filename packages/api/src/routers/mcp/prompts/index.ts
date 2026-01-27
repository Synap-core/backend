/**
 * MCP Prompts
 *
 * Exposes prompt templates for AI agents
 */

import type { Prompt } from "@modelcontextprotocol/sdk/types.js";

export const prompts = {
  /**
   * List all available prompts
   */
  async list(): Promise<Prompt[]> {
    return [
      {
        name: "create_project_structure",
        description:
          "Template for creating a project structure with tasks and milestones",
        arguments: [
          {
            name: "projectName",
            description: "Name of the project",
            required: true,
          },
          {
            name: "description",
            description: "Project description",
            required: false,
          },
        ],
      },
      {
        name: "analyze_entity_relationships",
        description: "Template for analyzing relationships between entities",
        arguments: [
          {
            name: "entityId",
            description: "ID of the entity to analyze",
            required: true,
          },
        ],
      },
    ];
  },

  /**
   * Get a prompt template
   */
  async get(
    name: string,
    args?: Record<string, unknown>
  ): Promise<{
    messages: Array<{
      role: "user" | "assistant" | "system";
      content: {
        type: "text";
        text: string;
      };
    }>;
  }> {
    switch (name) {
      case "create_project_structure":
        return {
          messages: [
            {
              role: "system",
              content: {
                type: "text",
                text: "You are a project management assistant. Help create a structured project with tasks and milestones.",
              },
            },
            {
              role: "user",
              content: {
                type: "text",
                text: `Create a project structure for: ${args?.projectName || "Untitled Project"}\n\nDescription: ${args?.description || "No description provided"}\n\nPlease create:\n1. A project entity\n2. Initial tasks with milestones\n3. Relationships between tasks`,
              },
            },
          ],
        };

      case "analyze_entity_relationships":
        return {
          messages: [
            {
              role: "system",
              content: {
                type: "text",
                text: "You are a data analysis assistant. Analyze entity relationships and provide insights.",
              },
            },
            {
              role: "user",
              content: {
                type: "text",
                text: `Analyze relationships for entity: ${args?.entityId || "unknown"}\n\nPlease provide:\n1. Direct relationships\n2. Indirect relationships (through other entities)\n3. Relationship patterns and insights`,
              },
            },
          ],
        };

      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  },
};
