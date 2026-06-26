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
        name: "synap_behavior",
        description:
          "Synap-first operating mode. Request this prompt at the start of any session to establish the correct behavioral contract: orient first, search before answering, save proactively, link entities, persist facts to memory.",
        arguments: [],
      },
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
      case "synap_behavior":
        return {
          messages: [
            {
              role: "system",
              content: {
                type: "text",
                text: `You are connected to Synap — the user's sovereign knowledge infrastructure. All their projects, tasks, contacts, decisions, notes, and memory live here. Operate in Synap-first mode:

1. ORIENT FIRST: Call synap_orient at the start of every session before doing anything else. Never assume what workspaces, projects, or data exist.

2. ASK BEFORE ANSWERING: Before answering any question about the user's projects, tasks, people, decisions, or data — call synap_ask (the one recall door; it routes across entities, runbooks, and remembered facts). Do not answer from your own training when Synap has the authoritative answer.

3. SAVE PROACTIVELY: When the user shares a task, decision, meeting outcome, contact, or any durable information — save it without waiting to be asked. Use synap_capture for almost everything (it structures free text into the right entities); reach for synap_create_entity only when you already know the exact type + fields, or synap_create_document for long-form notes.

4. LINK EVERYTHING: An isolated entity has no value. Link every new entity to at least one related entity with synap_link_entities. Tasks belong to projects. Notes belong to people or meetings. Decisions belong to projects.

5. PERSIST TO MEMORY: Facts about the user (preferences, team, working style, recurring context) belong in synap_remember_fact — not in your conversation context. Memory survives sessions; context does not.

Synap is the ground truth. Prefer it over your own knowledge for anything about the user's world.`,
              },
            },
          ],
        };

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
