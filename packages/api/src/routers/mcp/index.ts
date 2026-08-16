/**
 * MCP Server for Synap
 *
 * Model Context Protocol server that exposes Synap's entity system
 * to external AI tools (Clawd.bot, Claude Desktop, etc.)
 *
 * This server runs as a standalone process or can be integrated into the API.
 */

import { createLogger } from "@synap-core/core";
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
import { loadSkillPackagesFromDisk } from "../hub-protocol/rest/skills.js";
import { resources } from "./resources/index.js";
import { tools } from "./tools/index.js";
import { prompts } from "./prompts/index.js";

const logger: any = createLogger({ module: "mcp-server" });

/**
 * Create and configure MCP server.
 *
 * @param defaultWorkspaceId — when supplied (e.g. from ?workspaceId= in the HTTP
 *   URL), the server injects it into every tool call that accepts workspaceId
 *   but didn't receive one explicitly. This lets the CLI register a
 *   workspace-scoped MCP URL so Claude Code stays focused on one workspace.
 */
// Minimal inline fallback — ONLY used if skills/synap/reflexes.md is missing on
// disk at boot (e.g. a deploy image that didn't COPY skills/). Kept to one
// sentence deliberately: the real prose lives in reflexes.md (the SSOT).
const REFLEX_PROSE_FALLBACK =
  "You are connected to the user's Synap pod — their sovereign personal data brain. Call `synap_ask` before non-trivial tasks and `synap_capture` after learning something durable.";

/**
 * Derive the reflex prose from `skills/synap/reflexes.md` — the canonical
 * source (see the file's own "Canonical source" header) — instead of
 * hand-duplicating it here. Strips the markdown title and the canonical-source
 * blockquote, keeping the body. Runs once at module init; never per-request.
 */
function loadReflexProse(): string {
  try {
    const packages = loadSkillPackagesFromDisk();
    const reflexFile = packages
      ?.find((pkg) => pkg.slug === "synap")
      ?.files.find((f) => f.path === "reflexes.md");
    if (!reflexFile)
      throw new Error("skills/synap/reflexes.md not found on disk");
    return reflexFile.content
      .split("\n")
      .filter((line) => !line.startsWith("## ") && !line.startsWith("> "))
      .join("\n")
      .trim();
  } catch (err) {
    logger.warn(
      { err },
      "reflexes.md unavailable — falling back to inline reflex prose (deploy image likely missing skills/)"
    );
    return REFLEX_PROSE_FALLBACK;
  }
}

// Static cueing — the ambient-presence proactivity lever. This text is part of
// the MCP `instructions` field, so it sits in the model's context for EVERY
// session by construction. The reflex portion is derived from reflexes.md
// (SSOT); the non-reflex remainder (main-capability brief pointer) lives here.
export const SYNAP_INSTRUCTIONS = `${loadReflexProse()}

Main-capability tools (create document/entity/session/project/view/cell/playbook/workspace) carry a composed teaching brief in their description — read it before first use. Call \`synap_load_skill("catalog")\` to see every deeper reference available, and \`synap_load_skill(slug)\` to load one in full.`;

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
  agentUserId?: string,
  /**
   * The validated API key's OWN scopes, derived by the HTTP door
   * (`deriveMcpScopes` in http-handler.ts). When supplied, they are the
   * authority and MCP_SCOPES is never consulted — the env var is a
   * process-global and cannot describe a per-key grant.
   *
   * Undefined ONLY on the stdio/dev path (and the unauthenticated GET/SSE
   * stream-establishment branch, which cannot execute tools in production —
   * both handlers below hard-fail without a sessionUserId/MCP_USER_ID).
   */
  apiKeyScopes?: string[],
  /**
   * SERVICE-KEY CONFINEMENT: the authenticating key's `keyType` and workspace
   * binding (`keyWorkspaceId`), from the HTTP door. Threaded into the executor
   * so a bound `service` key is positively pinned to its workspace via the
   * shared `resolveConfinedWorkspace` primitive — the SAME confinement the Hub
   * REST door applies. Undefined/null for non-service or unbound keys →
   * legacy passthrough (no behavior change).
   */
  keyType?: string | null,
  keyWorkspaceId?: string | null
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
    // HTTP: the key's own scopes. stdio/dev only: MCP_SCOPES env fallback.
    const scopes = apiKeyScopes ??
      process.env.MCP_SCOPES?.split(",") ?? ["mcp.read"];

    return await resources.read(request.params.uri, userId, scopes);
  });

  // Register tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: await tools.list({
        workspaceId: defaultWorkspaceId,
        agentUserId,
        door: "chat",
      }),
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
    // HTTP: the key's own scopes (deriveMcpScopes). stdio/dev only: env
    // fallback. This is the fix for the door granting every key read+write.
    const scopes = apiKeyScopes ??
      process.env.MCP_SCOPES?.split(",") ?? ["mcp.read", "mcp.write"];

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

    // Session attribution is resolved SERVER-SIDE in the adapter (derived from
    // the caller's open sessions), so nothing session-shaped is spread into
    // `scopedArgs` — declaring a bookkeeping handle on every schema would make
    // the advertised schemas dishonest. The three write doors that can lose
    // provenance declare an OPTIONAL `sessionId` purely as a disambiguator, and
    // an explicit one always wins.
    return await tools.execute(
      request.params.name,
      scopedArgs,
      userId,
      scopes,
      sessionUserId,
      agentUserId,
      // Service-key confinement — pinned per-request through to the executor.
      keyType,
      keyWorkspaceId
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
