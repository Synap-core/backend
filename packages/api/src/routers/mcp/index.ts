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
 * Create and configure MCP server.
 *
 * @param defaultWorkspaceId — when supplied (e.g. from ?workspaceId= in the HTTP
 *   URL), the server injects it into every tool call that accepts workspaceId
 *   but didn't receive one explicitly. This lets the CLI register a
 *   workspace-scoped MCP URL so Claude Code stays focused on one workspace.
 */
/**
 * Static cueing — the ambient-presence proactivity lever. This text is part of
 * the MCP `instructions` field, so it sits in the model's context for EVERY
 * session by construction (no skill to launch, no CLAUDE.md to inject). It tells
 * the connected AI that a sovereign second brain is available and WHEN to reach
 * for it by reflex.
 */
const SYNAP_INSTRUCTIONS = `You are connected to the user's Synap pod — their sovereign personal data brain (the source of truth about their life, work, projects, people, and preferences).

Two reflexes, on every session:
- BEFORE any non-trivial task, or before answering anything about the user's own world, call \`synap_ask\` to recall what the pod already knows. Prefer it over your own assumptions. Also ask before creating, to avoid duplicates.
- AFTER you learn something durable (a fact, a decision, a new person/company/task, a stated preference), call \`synap_capture\` to write it back. Don't wait to be asked — this is how the second brain grows.

Use \`synap_orient\` once to see the available workspaces, projects, and entity types. Writes are governed: a 'proposed' response is normal (awaiting the user's review), never an error.`;

export function createMCPServer(
  defaultWorkspaceId?: string,
  sessionUserId?: string,
  grounding?: string,
  defaultProjectId?: string,
  /**
   * The acting agent's own userId, when `sessionUserId` is a remapped operator
   * (agent-key linkedUserId flow). Threaded to writes so governance proposes
   * instead of auto-applying as the operator. Undefined for operator keys.
   */
  agentUserId?: string
) {
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
      // Auto-grounding: the static reflexes + (when the HTTP handler resolved the
      // authed user) a live one-line snapshot of their pod, so the model is
      // grounded without having to call anything first.
      instructions: grounding
        ? `${SYNAP_INSTRUCTIONS}\n\n${grounding}`
        : SYNAP_INSTRUCTIONS,
    }
  );

  // Register resource handlers
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: await resources.list(),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    // HTTP transport: sessionUserId is injected by http-handler.ts (already auth-checked).
    // Stdio transport in production: requires MCP_USER_ID env var.
    if (
      process.env.NODE_ENV === "production" &&
      !sessionUserId &&
      !process.env.MCP_USER_ID
    ) {
      throw new Error(
        "MCP stdio server requires MCP_USER_ID in production. " +
          "Use the HTTP MCP endpoint (POST /mcp) with Authorization: Bearer <api-key> instead."
      );
    }
    const userId =
      sessionUserId ?? process.env.MCP_USER_ID ?? "dev-placeholder";
    const apiKeyScopes = process.env.MCP_SCOPES?.split(",") ?? ["mcp.read"];

    return await resources.read(request.params.uri, userId, apiKeyScopes);
  });

  // Register tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: await tools.list(),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // HTTP transport: sessionUserId is injected by http-handler.ts (already auth-checked).
    // Stdio transport in production: requires MCP_USER_ID env var.
    if (
      process.env.NODE_ENV === "production" &&
      !sessionUserId &&
      !process.env.MCP_USER_ID
    ) {
      throw new Error(
        "MCP stdio server requires MCP_USER_ID in production. " +
          "Use the HTTP MCP endpoint (POST /mcp) with Authorization: Bearer <api-key> instead."
      );
    }
    const userId =
      sessionUserId ?? process.env.MCP_USER_ID ?? "dev-placeholder";
    const apiKeyScopes = process.env.MCP_SCOPES?.split(",") ?? [
      "mcp.read",
      "mcp.write",
    ];

    const args = request.params.arguments ?? {};
    // Auto-inject the URL's scope (?workspaceId= / ?projectId=) into every tool
    // call when the model didn't pass one. This is how the agent's MCP URL pins
    // its focus: workspace lens + project lens, both orthogonal, both opt-in.
    const scopedArgs = {
      ...(defaultWorkspaceId && !args.workspaceId
        ? { workspaceId: defaultWorkspaceId }
        : {}),
      ...(defaultProjectId && !args.projectId
        ? { projectId: defaultProjectId }
        : {}),
      ...args,
    };

    return await tools.execute(
      request.params.name,
      scopedArgs,
      userId,
      apiKeyScopes,
      sessionUserId,
      agentUserId
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
