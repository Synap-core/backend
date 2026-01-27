/**
 * MCP Server for Synap
 *
 * Model Context Protocol server that exposes Synap's entity system
 * to external AI tools (Clawd.bot, Claude Desktop, etc.)
 *
 * This server runs as a standalone process or can be integrated into the API.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resources } from "./resources/index.js";
import { tools } from "./tools/index.js";
import { prompts } from "./prompts/index.js";

/**
 * Create and configure MCP server
 */
export function createMCPServer() {
  const server = new Server(
    {
      name: "synap-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    }
  );

  // Register resource handlers
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: await resources.list(),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return await resources.read(request.params.uri);
  });

  // Register tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: await tools.list(),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await tools.execute(
      request.params.name,
      request.params.arguments ?? {}
    );
  });

  // Register prompt handlers
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: await prompts.list(),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    return await prompts.get(request.params.name, request.params.arguments);
  });

  return server;
}

/**
 * Start MCP server (for standalone usage)
 */
export async function startMCPServer() {
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Synap MCP Server running on stdio");
}

// If run directly, start the server
if (import.meta.url === `file://${process.argv[1]}`) {
  startMCPServer().catch(console.error);
}
