/**
 * MCP HTTP Handler
 *
 * Exposes the Synap Hub Protocol as an MCP (Model Context Protocol) server
 * over HTTP. External agents (ZeroClaw, OpenClaw, Claude Desktop, Cursor)
 * can use this endpoint to read/write Synap data with full governance.
 *
 * Protocol: MCP Streamable HTTP transport spec 2025-03-26
 * Auth:     Hub Protocol API key in Authorization: Bearer <key>
 * Endpoint: POST /mcp   — JSON-RPC 2.0 request (SSE stream or JSON response)
 *           GET  /mcp   — SSE stream for server-initiated messages
 *           DELETE /mcp — End session
 *
 * Transport: WebStandardStreamableHTTPServerTransport (SDK 1.29.0, stateless mode)
 * Auth is checked before handing off to the SDK transport.
 *
 * All write tools go through checkPermissionOrPropose() — same governance as
 * any other Hub Protocol caller.
 */

import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { apiKeyService } from "../../services/api-keys.js";
import { checkHubRateLimit } from "../../utils/hub-protocol-rate-limit.js";
import { tools } from "./tools/index.js";
import { createMCPServer } from "./index.js";
import { db, workspaceMembers, workspaces, eq, inArray } from "@synap/database";

/**
 * Build a one-line LIVE grounding snapshot for the authed user — the workspaces
 * they can see — so the MCP `instructions` arrive pre-grounded (the model knows
 * the user's pod shape without calling synap_orient first). Cheap (one join);
 * never throws (grounding is best-effort — a hiccup must not block the session).
 */
async function buildGrounding(userId: string): Promise<string | undefined> {
  try {
    const memberRows = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));
    const wsIds = memberRows.map((r) => r.workspaceId);
    if (wsIds.length === 0) return undefined;
    const wsRows = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(inArray(workspaces.id, wsIds));
    const names = wsRows.map((w) => w.name).filter(Boolean);
    if (names.length === 0) return undefined;
    return names.length === 1
      ? `This pod has one workspace: ${names[0]}. Tools default to it.`
      : `This pod has ${names.length} workspaces: ${names.join(", ")}. Omit workspaceId for pod-wide recall, or pass one to scope.`;
  } catch {
    return undefined;
  }
}

// ── Auth helper ───────────────────────────────────────────────────────────────

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status: 401 }
  );
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const mcpHttpApp = new Hono();

/**
 * GET /mcp — Two roles depending on Accept header:
 *   - Accept: text/event-stream  → SSE stream for server-initiated messages (spec 2025-03-26)
 *   - Any other Accept           → Capabilities manifest (backward-compat discovery)
 *
 * The SDK transport handles the SSE branch. For non-SSE clients we fall through
 * to the legacy JSON manifest so existing integrations keep working.
 */
mcpHttpApp.get("/", async (c) => {
  const accept = c.req.header("accept") ?? "";

  if (accept.includes("text/event-stream")) {
    // SSE branch — hand off to the transport (no auth required per spec for GET)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    // GET/SSE is stream-establishment only (no auth/userId per spec); still carry
    // BOTH lenses so the stream's scope matches the POST tool-call path.
    const server = createMCPServer(
      c.req.query("workspaceId") ?? undefined,
      undefined,
      undefined,
      c.req.query("projectId") ?? undefined
    );
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  }

  // Legacy JSON capabilities manifest — no auth required
  const toolList = await tools.list();
  return c.json({
    name: "Synap",
    version: "1.0.0",
    description:
      "Synap workspace data — search entities, documents, channels, memory. All writes are governed by workspace AI policy.",
    capabilities: [
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/read",
      "prompts/list",
      "prompts/get",
    ],
    auth: {
      type: "bearer",
      description:
        "Generate a Hub Protocol API key in Synap workspace settings → Intelligence → API Keys",
    },
    toolCount: toolList.length,
  });
});

/**
 * POST /mcp — JSON-RPC 2.0 endpoint for MCP messages (spec 2025-03-26).
 *
 * If the client sends Accept: text/event-stream the SDK transport streams the
 * response as an SSE event. Otherwise it returns a single JSON-RPC response.
 * Both paths are handled transparently by WebStandardStreamableHTTPServerTransport.
 *
 * Auth is validated here before the SDK sees the request. On auth failure we
 * return a JSON-RPC error directly so MCP clients surface a useful message.
 *
 * Each request gets its own transport instance (stateless mode — no session ID).
 */
mcpHttpApp.post("/", async (c) => {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const token = extractBearer(c.req.header("authorization") ?? null);
  if (!token) {
    return jsonRpcError(
      null,
      -32600,
      "Missing Authorization: Bearer <hub-protocol-api-key>"
    );
  }

  const keyRecord = await apiKeyService.validateApiKey(token);
  if (!keyRecord || !keyRecord.userId) {
    return jsonRpcError(null, -32600, "Invalid or expired API key");
  }

  // ── 1b. Per-key rate limit (100 req/min) ─────────────────────────────────
  try {
    checkHubRateLimit(keyRecord.id, "mcp");
  } catch {
    return jsonRpcError(null, -32000, "Rate limit exceeded. Please slow down.");
  }

  // ── 2. Hand off to the SDK transport ─────────────────────────────────────
  // A new server + transport per request is correct for stateless mode.
  // The SDK server already has all tool/resource/prompt handlers registered
  // via createMCPServer() — we only replace the transport layer.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no Mcp-Session-Id header
    enableJsonResponse: false, // prefer SSE when client accepts it
  });

  // Pre-parse body so the transport doesn't have to consume the stream twice.
  let parsedBody: unknown;
  try {
    parsedBody = await c.req.json();
  } catch {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      { status: 400 }
    );
  }

  // Optional scoping from the URL: ?workspaceId= (workspace lens) and
  // ?projectId= (project focus lens). Both narrow tool calls; orthogonal.
  const defaultWorkspaceId = c.req.query("workspaceId") ?? undefined;
  const defaultProjectId = c.req.query("projectId") ?? undefined;
  // Live grounding is only consumed by the client at the `initialize` handshake
  // (it lands in the server's `instructions`). Fetch it ONLY for initialize — a
  // tools/call request would otherwise pay 2 DB queries for instructions no one
  // re-reads. (Stateless mode rebuilds the server per request, hence the gate.)
  const isInitialize =
    (parsedBody as { method?: string } | null)?.method === "initialize";
  const grounding = isInitialize
    ? await buildGrounding(keyRecord.userId)
    : undefined;
  const server = createMCPServer(
    defaultWorkspaceId,
    keyRecord.userId,
    grounding,
    defaultProjectId
  );
  await server.connect(transport);

  return transport.handleRequest(c.req.raw, { parsedBody });
});

/**
 * DELETE /mcp — End session (spec 2025-03-26, optional).
 *
 * In stateless mode there is no session to terminate, but the spec says
 * servers SHOULD support this method. We hand it to a fresh transport which
 * will return 200 OK per the spec.
 */
mcpHttpApp.delete("/", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createMCPServer();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export { mcpHttpApp };
