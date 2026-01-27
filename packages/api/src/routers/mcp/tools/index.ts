/**
 * MCP Tools
 *
 * Exposes actions as MCP tools
 */

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const tools = {
  /**
   * List all available tools
   */
  async list(): Promise<Tool[]> {
    return [
      {
        name: "synap_create_entity",
        description:
          "Create a new entity in Synap (task, contact, project, note, etc.)",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["task", "contact", "project", "note", "meeting", "idea"],
              description: "Type of entity to create",
            },
            title: {
              type: "string",
              description: "Title of the entity",
            },
            description: {
              type: "string",
              description: "Optional description or preview text",
            },
            metadata: {
              type: "object",
              description: "Optional metadata object",
            },
          },
          required: ["type", "title"],
        },
      },
      {
        name: "synap_update_entity",
        description: "Update an existing entity in Synap",
        inputSchema: {
          type: "object",
          properties: {
            entityId: {
              type: "string",
              description: "ID of the entity to update",
            },
            title: {
              type: "string",
              description: "New title (optional)",
            },
            description: {
              type: "string",
              description: "New description (optional)",
            },
            metadata: {
              type: "object",
              description: "New metadata (optional)",
            },
          },
          required: ["entityId"],
        },
      },
      {
        name: "synap_search_entities",
        description: "Search for entities in Synap",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
            type: {
              type: "string",
              enum: ["task", "contact", "project", "note", "meeting", "idea"],
              description: "Filter by entity type (optional)",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default: 20)",
              default: 20,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "synap_create_relationship",
        description: "Create a relationship between two entities",
        inputSchema: {
          type: "object",
          properties: {
            fromEntityId: {
              type: "string",
              description: "Source entity ID",
            },
            toEntityId: {
              type: "string",
              description: "Target entity ID",
            },
            relationshipType: {
              type: "string",
              description: "Type of relationship",
            },
          },
          required: ["fromEntityId", "toEntityId", "relationshipType"],
        },
      },
    ];
  },

  /**
   * Execute a tool
   *
   * Uses Hub Protocol API to ensure all operations go through
   * event sourcing, validation, security, and workers
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    userId: string,
    apiKeyScopes: string[]
  ): Promise<CallToolResult> {
    // Use adapter to call Hub Protocol API
    const { executeMCPToolViaHubProtocol } = await import("../adapter.js");
    return await executeMCPToolViaHubProtocol(name, args, userId, apiKeyScopes);
  },
};
