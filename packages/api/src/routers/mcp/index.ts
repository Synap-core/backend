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
import { filterToolsForAccess } from "./tool-profiles.js";
import { loadKeyToolAccess } from "./tool-access.js";
import { ENTRY_REFLEX_PROSE } from "./entry-instructions.js";
import {
  UI_NOT_SERVABLE,
  withToolUiMeta,
  type IsUiServable,
} from "./ui-tools.js";

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

const REFLEX_PROSE = loadReflexProse();

/**
 * Ceiling for the MCP `instructions` field — reflexes (reflexes.md) plus the
 * live grounding, composed. Clients may truncate this field (a secondary source
 * reports 2 KB for Claude Code; unverified), so the tail must never be what
 * matters. Pinned by `instructions-budget.test.ts`.
 */
export const INSTRUCTIONS_BUDGET_BYTES = 2048;

const SEPARATOR = "\n\n";

/**
 * Which reflexes a connection gets: `entry` keys (V1 D4) get the entry-worded
 * text (`entry-instructions.ts`), every other key the full `reflexes.md`.
 */
export type InstructionsProfile = "entry" | "full";

function reflexProseFor(profile: InstructionsProfile): string {
  return profile === "entry" ? ENTRY_REFLEX_PROSE : REFLEX_PROSE;
}

/**
 * Bytes left for grounding once the reflexes are placed. Defaults to the FULL
 * reflexes — the longer text — so a grounding fitted to it fits either one.
 */
export function groundingBudgetBytes(
  profile: InstructionsProfile = "full"
): number {
  return Math.max(
    0,
    INSTRUCTIONS_BUDGET_BYTES -
      Buffer.byteLength(reflexProseFor(profile)) -
      Buffer.byteLength(SEPARATOR)
  );
}

/** Reflexes first (most important), then the live grounding when it fits. */
export function composeInstructions(
  grounding?: string,
  profile: InstructionsProfile = "full"
): string {
  const prose = reflexProseFor(profile);
  if (
    grounding &&
    Buffer.byteLength(grounding) <= groundingBudgetBytes(profile)
  ) {
    return `${prose}${SEPARATOR}${grounding}`;
  }
  return prose;
}

export const SYNAP_INSTRUCTIONS = composeInstructions();

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
  keyWorkspaceId?: string | null,
  /**
   * The authenticating key's id, from the HTTP door. When set, `tools/list`
   * is narrowed to the key's tool profile (`tool-profiles.ts`) and
   * `synap_load_skill` may unlock deeper groups on it. Undefined (stdio/dev,
   * the unauthenticated GET/SSE branch) → every tool, as before.
   */
  toolAccessKeyId?: string,
  /**
   * Which reflexes the `instructions` carry (`entry` for an entry-profile
   * key, read by the HTTP door at `initialize`). Default `full`.
   */
  instructionsProfile: InstructionsProfile = "full",
  /**
   * MCP Apps: may a renderer for this object kind be served to this caller?
   * Gates `_meta.ui` on the tagged tools (`ui-tools.ts`). Defaults to "never",
   * so an unwired server's `tools/list` is unchanged.
   */
  isUiServable: IsUiServable = UI_NOT_SERVABLE
) {
  const server = new Server(
    {
      name: "synap-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        resources: {},
        // `listChanged`: `synap_load_skill` can widen an entry key's tool list.
        tools: { listChanged: true },
        prompts: {},
      },
      // Auto-grounding: the static reflexes + (when the HTTP handler resolved the
      // authed user) a live one-line snapshot of their pod, so the model is
      // grounded without having to call anything first.
      instructions: composeInstructions(grounding, instructionsProfile),
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
    const all = await tools.list({
      workspaceId: defaultWorkspaceId,
      agentUserId,
      door: "chat",
    });
    const visible = toolAccessKeyId
      ? filterToolsForAccess(all, await loadKeyToolAccess(toolAccessKeyId))
      : all;
    return {
      tools: await withToolUiMeta(visible, isUiServable, {
        userId: sessionUserId,
        agentUserId,
        workspaceId: defaultWorkspaceId,
      }),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
      keyWorkspaceId,
      toolAccessKeyId
        ? {
            keyId: toolAccessKeyId,
            // Related to THIS request, so a streaming transport carries it on
            // the call's own response stream. NOTE: the HTTP door runs the
            // stateless transport with `enableJsonResponse`, which DROPS
            // request-related notifications — `synap_load_skill` therefore
            // also returns the unlocked tools' schemas inline.
            notifyToolsChanged: () =>
              extra.sendNotification({
                method: "notifications/tools/list_changed",
              }),
          }
        : undefined,
      // Cancelled request / closed connection — long waits stop on it.
      extra.signal
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
