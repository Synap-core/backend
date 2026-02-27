/**
 * MCP Tools — Synap Hub Protocol
 *
 * Exposes Synap data operations as MCP tools.
 * All writes go through checkPermissionOrPropose() governance.
 *
 * Tool naming convention: synap_{operation}
 * Scopes: mcp.read (reads), mcp.write (writes)
 */

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const tools = {
  /**
   * List all available tools
   */
  async list(): Promise<Tool[]> {
    return [
      // ── Read / Search ───────────────────────────────────────────────────────
      {
        name: "synap_search",
        description:
          "Unified search across all Synap data (entities, documents, channels, agents). Use for broad queries.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            workspaceId: {
              type: "string",
              description: "Workspace ID to scope the search",
            },
            collections: {
              type: "array",
              items: {
                type: "string",
                enum: ["entities", "documents", "views", "projects", "agents"],
              },
              description: "Limit to specific collections (optional)",
            },
            limit: {
              type: "number",
              description: "Max results (default: 20)",
              default: 20,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "synap_search_entities",
        description:
          "Search for entities in Synap by query and optional type filter.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            type: {
              type: "string",
              enum: ["task", "contact", "project", "note", "meeting", "idea"],
              description: "Filter by entity type (optional)",
            },
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional)",
            },
            limit: { type: "number", default: 20 },
          },
          required: ["query"],
        },
      },
      {
        name: "synap_get_entities",
        description:
          "List entities of a specific type (tasks, contacts, projects, etc.)",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["task", "contact", "project", "note", "meeting", "idea"],
              description: "Entity type to list",
            },
            workspaceId: {
              type: "string",
              description: "Workspace ID (optional)",
            },
            limit: { type: "number", default: 50 },
          },
          required: [],
        },
      },
      {
        name: "synap_get_document",
        description: "Retrieve the full content of a document by ID.",
        inputSchema: {
          type: "object",
          properties: {
            documentId: { type: "string", description: "Document UUID" },
          },
          required: ["documentId"],
        },
      },
      {
        name: "synap_recall_facts",
        description:
          "Search long-term memory (knowledge facts) for information relevant to a query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to recall" },
            userId: { type: "string", description: "User ID to recall for" },
            workspaceId: { type: "string" },
            limit: { type: "number", default: 10 },
          },
          required: ["query", "userId"],
        },
      },
      {
        name: "synap_get_thread_context",
        description:
          "Get the context of a channel/thread (messages, linked entities, linked documents).",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string", description: "Channel/thread UUID" },
          },
          required: ["threadId"],
        },
      },
      {
        name: "synap_list_proposals",
        description: "List pending AI proposals awaiting user approval.",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string" },
            workspaceId: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "approved", "rejected"],
              default: "pending",
            },
            limit: { type: "number", default: 20 },
          },
          required: ["userId"],
        },
      },

      // ── Writes (governed — may create proposals) ───────────────────────────
      {
        name: "synap_create_entity",
        description:
          "Create a new entity in Synap (task, contact, project, note, etc.). Requires mcp.write scope. May create a proposal for user approval depending on workspace AI governance policy.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["task", "contact", "project", "note", "meeting", "idea"],
            },
            title: { type: "string" },
            description: { type: "string" },
            metadata: { type: "object" },
          },
          required: ["type", "title"],
        },
      },
      {
        name: "synap_update_entity",
        description:
          "Update an existing entity. Requires mcp.write scope. May create a proposal.",
        inputSchema: {
          type: "object",
          properties: {
            entityId: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            metadata: { type: "object" },
          },
          required: ["entityId"],
        },
      },
      {
        name: "synap_create_document",
        description:
          "Create a new document in a workspace. Requires mcp.write scope. May create a proposal.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: {
              type: "string",
              description: "Document content (markdown or plain text)",
            },
            workspaceId: { type: "string" },
          },
          required: ["title", "workspaceId"],
        },
      },
      {
        name: "synap_remember_fact",
        description: "Store a fact in long-term memory for a user.",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string" },
            fact: { type: "string", description: "The fact to remember" },
            workspaceId: { type: "string" },
          },
          required: ["userId", "fact"],
        },
      },
      {
        name: "synap_send_message",
        description:
          "Send a message to a Synap channel. Use for agent-to-channel communication. Requires mcp.write scope.",
        inputSchema: {
          type: "object",
          properties: {
            channelId: {
              type: "string",
              description: "Channel/thread UUID to send to",
            },
            content: { type: "string", description: "Message content" },
            workspaceId: { type: "string" },
          },
          required: ["channelId", "content"],
        },
      },
    ];
  },

  /**
   * Execute a tool
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    userId: string,
    apiKeyScopes: string[]
  ): Promise<CallToolResult> {
    const { executeMCPToolViaHubProtocol } = await import("../adapter.js");
    return await executeMCPToolViaHubProtocol(name, args, userId, apiKeyScopes);
  },
};
