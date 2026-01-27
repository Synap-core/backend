/**
 * MCP to Hub Protocol Adapter
 *
 * This adapter allows MCP to use the existing Hub Protocol API,
 * ensuring all operations go through the same event sourcing,
 * validation, security, and worker infrastructure.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hubProtocolRouter } from "../hub-protocol/index.js";
import { getDb } from "@synap/database";
import type { Context } from "../../types/context.js";

/**
 * Create a tRPC caller for Hub Protocol
 * This allows MCP to call Hub Protocol endpoints programmatically
 *
 * Uses the same context structure as API key middleware
 */
async function createHubProtocolCaller(userId: string, scopes: string[]) {
  const db = await getDb();

  // Create context matching API key middleware structure
  // Note: scopes, apiKeyId, apiKeyName are added by middleware but not in base Context type
  const ctx: Context & {
    scopes?: string[];
    apiKeyId?: string;
    apiKeyName?: string;
  } = {
    db,
    authenticated: true,
    userId,
    scopes,
    apiKeyId: "mcp", // Mark as MCP source
    apiKeyName: "MCP Server",
    req: null as any, // Not needed for programmatic calls
    user: null, // Not needed for MCP
    session: null, // Not needed for MCP
  };

  // Use tRPC's createCaller method
  return hubProtocolRouter.createCaller(ctx);
}

/**
 * Execute MCP tool by calling Hub Protocol API
 */
export async function executeMCPToolViaHubProtocol(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  apiKeyScopes: string[]
): Promise<CallToolResult> {
  const caller = await createHubProtocolCaller(userId, apiKeyScopes);

  // Map MCP tool names to Hub Protocol endpoints
  switch (toolName) {
    case "synap_create_entity":
      // Check scope
      if (!apiKeyScopes.includes("mcp.write")) {
        throw new Error("Insufficient permissions: mcp.write required");
      }

      const createResult = await caller.entities.createEntity({
        userId,
        type: args.type as string,
        title: args.title as string,
        description: args.description as string,
        aiMetadata: {
          model: "mcp",
          reasoning: `Tool: ${toolName}`,
        },
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(createResult),
          },
        ],
      };

    case "synap_update_entity":
      if (!apiKeyScopes.includes("mcp.write")) {
        throw new Error("Insufficient permissions: mcp.write required");
      }

      const updateResult = await caller.entities.updateEntity({
        entityId: args.entityId as string,
        userId,
        title: args.title as string,
        preview: args.description as string,
        metadata: args.metadata as Record<string, unknown>,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(updateResult),
          },
        ],
      };

    case "synap_search_entities":
      if (!apiKeyScopes.includes("mcp.read")) {
        throw new Error("Insufficient permissions: mcp.read required");
      }

      const validTypes = [
        "note",
        "task",
        "document",
        "project",
        "contact",
        "meeting",
        "idea",
      ] as const;
      const validType =
        args.type && validTypes.includes(args.type as any)
          ? (args.type as (typeof validTypes)[number])
          : undefined;

      const searchResult = await caller.search.searchEntities({
        userId,
        query: args.query as string,
        type: validType,
        limit: (args.limit as number) || 20,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              entities: searchResult.entities,
            }),
          },
        ],
      };

    case "synap_get_entities":
      if (!apiKeyScopes.includes("mcp.read")) {
        throw new Error("Insufficient permissions: mcp.read required");
      }

      const getResult = await caller.entities.getEntities({
        userId,
        type: args.type as string,
        limit: (args.limit as number) || 50,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(getResult),
          },
        ],
      };

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Read MCP resource by calling Hub Protocol API
 */
export async function readMCPResourceViaHubProtocol(
  uri: string,
  userId: string,
  apiKeyScopes: string[]
): Promise<{
  contents: Array<{
    uri: string;
    mimeType: string;
    text?: string;
  }>;
}> {
  if (!apiKeyScopes.includes("mcp.read")) {
    throw new Error("Insufficient permissions: mcp.read required");
  }

  const caller = await createHubProtocolCaller(userId, apiKeyScopes);

  // Parse URI: synap://entities/tasks or synap://entities/task/123
  const match = uri.match(/^synap:\/\/(\w+)(?:\/(.+))?$/);
  if (!match) {
    throw new Error(`Invalid resource URI: ${uri}`);
  }

  const [, resourceType, resourcePath] = match;

  if (resourceType === "entities") {
    const parts = resourcePath?.split("/") || [];
    const entityType = parts[0]?.replace(/s$/, "");
    const entityId = parts[1];

    if (entityId) {
      // Get specific entity - would need a new endpoint or use getEntities with filter
      const entities = await caller.entities.getEntities({
        userId,
        type: entityType as
          | "task"
          | "contact"
          | "project"
          | "note"
          | "meeting"
          | "idea"
          | undefined,
        limit: 1,
      });

      const entity = entities.find((e) => e.id === entityId);
      if (!entity) {
        throw new Error(`Entity not found: ${uri}`);
      }

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(entity),
          },
        ],
      };
    } else {
      // Get all entities of type
      const validTypes = [
        "task",
        "note",
        "document",
        "project",
        "contact",
        "meeting",
        "idea",
      ] as const;
      const validType = validTypes.includes(entityType as any)
        ? (entityType as (typeof validTypes)[number])
        : undefined;

      const entities = await caller.entities.getEntities({
        userId,
        type: validType,
        limit: 100,
      });

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(entities),
          },
        ],
      };
    }
  }

  if (resourceType === "threads") {
    const parts = resourcePath?.split("/") || [];
    const threadId = parts[0];

    if (!threadId) {
      throw new Error("Thread ID required: synap://threads/{id}/context");
    }

    const context = await caller.context.getThreadContext({
      threadId,
    });

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(context),
        },
      ],
    };
  }

  throw new Error(`Unknown resource type: ${resourceType}`);
}
