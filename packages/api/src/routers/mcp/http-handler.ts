/**
 * MCP HTTP Handler
 *
 * Exposes the Synap Hub Protocol as an MCP (Model Context Protocol) server
 * over HTTP. External agents (ZeroClaw, OpenClaw, Claude Desktop, Cursor)
 * can use this endpoint to read/write Synap data with full governance.
 *
 * Protocol: JSON-RPC 2.0 over HTTP POST (MCP Streamable HTTP transport spec 2025-03-26)
 * Auth:     Hub Protocol API key in Authorization: Bearer <key>
 * Endpoint: POST /mcp   (single request/response — stateless)
 *           GET  /mcp   (manifest / capabilities)
 *
 * All write tools go through checkPermissionOrPropose() — same governance as
 * any other Hub Protocol caller.
 */

import { Hono } from "hono";
import { apiKeyService } from "../../services/api-keys.js";
import { checkHubRateLimit } from "../../utils/hub-protocol-rate-limit.js";
import { tools } from "./tools/index.js";
import { resources } from "./resources/index.js";
import { prompts } from "./prompts/index.js";

// ── Auth helper ───────────────────────────────────────────────────────────────

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const mcpHttpApp = new Hono();

/**
 * GET /mcp — Capabilities manifest (no auth required)
 * Lets external agents discover this MCP server's capabilities.
 */
mcpHttpApp.get("/", async (c) => {
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
 * POST /mcp — JSON-RPC 2.0 endpoint for MCP messages
 */
mcpHttpApp.post("/", async (c) => {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const token = extractBearer(c.req.header("authorization") ?? null);
  if (!token) {
    return c.json(
      jsonRpcError(
        null,
        -32600,
        "Missing Authorization: Bearer <hub-protocol-api-key>"
      ),
      401
    );
  }

  const keyRecord = await apiKeyService.validateApiKey(token);
  if (!keyRecord || !keyRecord.userId) {
    return c.json(
      jsonRpcError(null, -32600, "Invalid or expired API key"),
      401
    );
  }

  const userId = keyRecord.userId;
  const scopes: string[] = (keyRecord.scope as string[]) ?? [];

  // ── 1b. Per-key rate limit (100 req/min) ─────────────────────────────────
  try {
    checkHubRateLimit(keyRecord.id, "mcp");
  } catch {
    return c.json(
      jsonRpcError(null, -32000, "Rate limit exceeded. Please slow down."),
      429
    );
  }

  // ── 2. Parse JSON-RPC body ───────────────────────────────────────────────
  let body: {
    jsonrpc: string;
    method: string;
    params?: unknown;
    id?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  if (body.jsonrpc !== "2.0" || !body.method) {
    return c.json(
      jsonRpcError(body.id ?? null, -32600, "Invalid JSON-RPC 2.0 request"),
      400
    );
  }

  const { id, method, params } = body;

  // ── 3. Route method ──────────────────────────────────────────────────────
  try {
    switch (method) {
      // ── Tool methods ───────────────────────────────────────────────────
      case "tools/list": {
        const toolList = await tools.list();
        return c.json(jsonRpcResult(id, { tools: toolList }));
      }

      case "tools/call": {
        const p = params as
          | { name: string; arguments?: Record<string, unknown> }
          | undefined;
        if (!p?.name) {
          return c.json(
            jsonRpcError(id, -32602, "tools/call requires params.name"),
            400
          );
        }
        const result = await tools.execute(
          p.name,
          p.arguments ?? {},
          userId,
          scopes
        );
        return c.json(jsonRpcResult(id, result));
      }

      // ── Resource methods ───────────────────────────────────────────────
      case "resources/list": {
        const resourceList = await resources.list();
        return c.json(jsonRpcResult(id, { resources: resourceList }));
      }

      case "resources/read": {
        const p = params as { uri: string } | undefined;
        if (!p?.uri) {
          return c.json(
            jsonRpcError(id, -32602, "resources/read requires params.uri"),
            400
          );
        }
        const result = await resources.read(p.uri, userId, scopes);
        return c.json(jsonRpcResult(id, result));
      }

      // ── Prompt methods ─────────────────────────────────────────────────
      case "prompts/list": {
        const promptList = await prompts.list();
        return c.json(jsonRpcResult(id, { prompts: promptList }));
      }

      case "prompts/get": {
        const p = params as
          | { name: string; arguments?: Record<string, string> }
          | undefined;
        if (!p?.name) {
          return c.json(
            jsonRpcError(id, -32602, "prompts/get requires params.name"),
            400
          );
        }
        const result = await prompts.get(p.name, p.arguments);
        return c.json(jsonRpcResult(id, result));
      }

      // ── Initialize (handshake) ─────────────────────────────────────────
      case "initialize": {
        return c.json(
          jsonRpcResult(id, {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false, subscribe: false },
              prompts: { listChanged: false },
            },
            serverInfo: { name: "Synap", version: "1.0.0" },
          })
        );
      }

      // ── ping ───────────────────────────────────────────────────────────
      case "ping": {
        return c.json(jsonRpcResult(id, {}));
      }

      default: {
        return c.json(
          jsonRpcError(id, -32601, `Method not found: ${method}`),
          404
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(jsonRpcError(id, -32603, `Internal error: ${msg}`), 500);
  }
});

export { mcpHttpApp };
