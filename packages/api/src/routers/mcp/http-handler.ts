/**
 * MCP HTTP Handler
 *
 * Exposes the Synap Hub Protocol as an MCP (Model Context Protocol) server
 * over HTTP. External agents (ZeroClaw, OpenClaw, Claude Desktop, Cursor)
 * can use this endpoint to read/write Synap data with full governance.
 *
 * Protocol: MCP Streamable HTTP. The installed SDK (1.29.0) declares
 *           LATEST_PROTOCOL_VERSION = "2025-11-25" and negotiates down through
 *           2025-06-18 / 2025-03-26 / 2024-11-05 / 2024-10-07, falling back to
 *           2025-03-26 only when the client sends no version information. This
 *           handler is not pinned to any one revision.
 * Auth:     Hub Protocol API key in Authorization: Bearer <key>. The key may be
 *           minted directly by the pod's own OAuth authorization server (Path B,
 *           `routers/oauth/`) — an unauthenticated request answers 401 with the
 *           RFC 9728 `WWW-Authenticate: Bearer resource_metadata="…"` hop, which
 *           is how claude.ai discovers where to authenticate. Path A (control
 *           plane as AS, proxying to this endpoint) also remains supported.
 *           See MCP-OAUTH-AND-CONNECT-PLAN.md.
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
import { resolveIssuer } from "../oauth/config.js";
import {
  db,
  entities,
  projects,
  workspaceMembers,
  workspaces,
  eq,
  inArray,
  drizzleSql,
} from "@synap/database";

/** Workspaces named individually before collapsing to a summary count. */
const GROUNDING_WS_LIMIT = 12;

/**
 * Build a LIVE grounding snapshot for the authed user so the MCP `instructions`
 * arrive pre-grounded (the model knows the user's pod shape without having to
 * call synap_orient first). Best-effort; never throws (a hiccup must not block
 * the session).
 *
 * WHY THIS CARRIES IDs AND ENTITY COUNTS (2026-07-24, from live dogfood):
 * this previously emitted workspace NAMES only, and collapsed to a bare count
 * above 8 ("15 workspaces (operational domains)"). A real pod with 15
 * workspaces therefore told the model NOTHING actionable — no names, no ids —
 * so a write could not be aimed at a specific workspace without a separate
 * orient round-trip, and an agent that guessed wrote to the wrong place. That
 * is exactly what happened: a session had to RETRY to land prospects in "CRM".
 *
 * So: emit `name (id, N entities)`, ACTIVE (non-empty) workspaces first, and
 * state the write rule explicitly. Ranking by entity count also stops a pod
 * whose structure runs ahead of its content (10 empty workspaces) from burying
 * the 2-3 live ones — the model sees where work actually happens.
 */
/**
 * Render the grounding sentence. Pure (no DB) so the formatting rules that
 * actually matter — ids present, busiest first, the cap, the write rule — are
 * unit-testable without mocking three queries. Exported for tests only.
 */
export function formatGrounding(
  projPart: string,
  workspacesWithCounts: ReadonlyArray<{ id: string; name: string; n: number }>,
  hasProjects: boolean
): string {
  // Busiest first: where the user actually works leads, empty scaffolds trail.
  const ranked = [...workspacesWithCounts].sort(
    (a, b) => b.n - a.n || a.name.localeCompare(b.name)
  );
  const shown = ranked.slice(0, GROUNDING_WS_LIMIT);
  const hidden = ranked.length - shown.length;
  const list = shown
    .map((w) => `${w.name} (${w.id}, ${w.n} entities)`)
    .join("; ");
  const more = hidden > 0 ? ` …and ${hidden} more` : "";
  const emptyNote = ranked.some((w) => w.n === 0)
    ? " Workspaces with 0 entities are empty scaffolds — prefer an active one unless the user names another."
    : "";
  const compose = hasProjects
    ? " Projects organize; workspaces hold the data."
    : "";
  // The WRITE rule is stated explicitly: reads may go pod-wide, but a write with
  // no workspaceId lands against an arbitrary membership and is the #1 way data
  // ends up "somewhere else" from the user's point of view.
  return (
    `${projPart}Workspaces (operational domains), busiest first: ${list}${more}.${compose}${emptyNote}` +
    ` For READS omit workspaceId for pod-wide recall, or pass one to scope.` +
    ` For WRITES always pass the workspaceId of the matching domain — pass the id above verbatim,` +
    ` and only omit it when the fact is genuinely cross-cutting.`
  );
}

async function buildGrounding(userId: string): Promise<string | undefined> {
  try {
    const memberRows = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));
    const wsIds = memberRows.map((r) => r.workspaceId);
    // Best-effort project names — grounding is cheap (one extra query, no join).
    // Projects lead: a project is a company/initiative (the primary lens).
    const projRows = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.userId, userId));
    const projNames = projRows.map((p) => p.name).filter(Boolean);
    const projPart =
      projNames.length === 0
        ? ""
        : projNames.length <= 6
          ? `Projects (companies/initiatives): ${projNames.join(", ")}. `
          : `${projNames.length} projects (companies/initiatives). `;
    if (wsIds.length === 0) {
      if (projNames.length === 0) return undefined;
      return `${projPart}No workspaces yet. Tools default to pod-wide scope.`;
    }
    const wsRows = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(inArray(workspaces.id, wsIds));
    const named = wsRows.filter((w) => Boolean(w.name));
    if (named.length === 0) {
      if (projNames.length === 0) return undefined;
      return `${projPart}No workspaces yet. Tools default to pod-wide scope.`;
    }

    // Entity counts per workspace, so the model can tell a LIVE workspace from
    // an empty scaffold. One grouped query — `entities.workspaceId` is nullable
    // (null = pod-wide/global), and those rows simply don't group into any
    // workspace bucket, which is the behaviour we want here.
    const countRows = await db
      .select({
        workspaceId: entities.workspaceId,
        n: drizzleSql<number>`count(*)::int`,
      })
      .from(entities)
      .where(inArray(entities.workspaceId, wsIds))
      .groupBy(entities.workspaceId);
    const counts = new Map<string, number>();
    for (const r of countRows) {
      if (r.workspaceId) counts.set(r.workspaceId, Number(r.n) || 0);
    }

    return formatGrounding(
      projPart,
      named.map((w) => ({ ...w, n: counts.get(w.id) ?? 0 })),
      projNames.length > 0
    );
  } catch {
    return undefined;
  }
}

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Derive the MCP scopes a validated key actually grants, from the key's OWN
 * `scope` column (schema: `api_keys.scope`, text[] — singular, which is why a
 * grep for `.scopes` found nothing here).
 *
 * Before this, the HTTP door handed every authenticated key a hardcoded
 * `["mcp.read","mcp.write"]` (index.ts), so `requireScope()` could never fail
 * over HTTP and a read-only key silently got write. That was privilege
 * inflation, not data loss — governance still forces agent writes to propose —
 * but the key's own scopes are the authority and must be honoured.
 *
 * Equivalences below are NOT invented: adapter.ts:61-72 already declares
 * `mcp.read ⇒ hub-protocol.read` and `mcp.write ⇒ hub-protocol.read+write` when
 * translating outward to Hub Protocol. This reads that same equivalence inward.
 * `data.read`/`data.write` ("Read/Write entities, documents, relations" —
 * api-keys.ts schema) cover exactly what the MCP tools expose, and are what the
 * workspace-settings and connections UIs actually mint. `hub-protocol.admin` is
 * documented as full entity/workspace control, so it implies both.
 *
 * Deliberately NOT a fallback-to-full: a key whose scope array grants none of
 * these gets NEITHER mcp scope and its tool calls fail closed via
 * requireScope() — which is the point of the fix.
 */
export function deriveMcpScopes(keyScopes: string[] | null): string[] {
  const has = (s: string) => (keyScopes ?? []).includes(s);
  const admin = has("hub-protocol.admin");
  const out: string[] = [];
  if (admin || has("mcp.read") || has("hub-protocol.read") || has("data.read"))
    out.push("mcp.read");
  if (
    admin ||
    has("mcp.write") ||
    has("hub-protocol.write") ||
    has("data.write")
  ) {
    // A writer is implicitly a reader — mirrors adapter.ts's outward mapping,
    // where mcp.write expands to hub-protocol.read + hub-protocol.write.
    if (!out.includes("mcp.read")) out.push("mcp.read");
    out.push("mcp.write");
  }
  return out;
}

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * The RFC 9728 discovery hop.
 *
 * An unauthenticated MCP request must answer 401 WITH
 * `WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource"`.
 * That header is the ONLY thing that tells claude.ai where to begin OAuth — a
 * bare 401 just reads as "denied" and the connector cannot self-configure. It is
 * what makes Path B (pod-as-authorization-server, no control plane) reachable at
 * all; the CP's own /mcp has emitted it since Path A.
 *
 * `resolveIssuer()` returns null when the pod has no canonical PUBLIC_URL, in
 * which case we emit a bare 401 rather than advertise a malformed discovery URL.
 */
function jsonRpcError(id: unknown, code: number, message: string) {
  const issuer = resolveIssuer();
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    {
      status: 401,
      ...(issuer
        ? {
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
            },
          }
        : {}),
    }
  );
}

/**
 * A NON-auth JSON-RPC error — HTTP 429, NO `WWW-Authenticate`.
 *
 * The auth `jsonRpcError` above emits the RFC 9728 discovery hop, which
 * claude.ai reads as "your token is bad, re-authenticate". Rate limiting is NOT
 * an auth failure, so it must NOT carry that header: a rate-limited client
 * should BACK OFF, not bounce into OAuth. This also breaks a live cascade — the
 * CP proxy treats ANY pod 401 on a proxied call as a stale key and REVOKES the
 * grant (connect-mcp), so a rate-limit-as-401 would silently disconnect a
 * healthy connection and force re-authorization. A 429 is passed through, not
 * mistaken for a dead key.
 */
function jsonRpcRateLimited(id: unknown, message: string) {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code: -32000, message } },
    { status: 429 }
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
    return jsonRpcRateLimited(null, "Rate limit exceeded. Please slow down.");
  }

  // ── 2. Hand off to the SDK transport ─────────────────────────────────────
  // A new server + transport per request is correct for stateless mode.
  // The SDK server already has all tool/resource/prompt handlers registered
  // via createMCPServer() — we only replace the transport layer.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no Mcp-Session-Id header
    enableJsonResponse: true, // prefer SSE when client accepts it, fall back to JSON otherwise
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
  // `?sessionId=` — a `focus_sessions` row id used as an out-of-band SCOPE
  // HINT. It is NOT transport session state (this handler is stateless and
  // sets no `Mcp-Session-Id`), and downstream governance still authorizes
  // independently of it. (Do NOT re-label this a SEP-2567 state handle — that
  // is a model-visible tool ARGUMENT; this rides the URL and is never
  // advertised on a schema. The two are unrelated.)
  const defaultSessionId = c.req.query("sessionId") ?? undefined;
  // Live grounding is only consumed by the client at the `initialize` handshake
  // (it lands in the server's `instructions`). Fetch it ONLY for initialize — a
  // tools/call request would otherwise pay 2 DB queries for instructions no one
  // re-reads. (Stateless mode rebuilds the server per request, hence the gate.)
  const isInitialize =
    (parsedBody as { method?: string } | null)?.method === "initialize";
  // Agent-key identity remap (mirrors the Hub REST auth middleware): when the
  // key has a linkedUserId (= the human the agent acts on behalf of), the DATA
  // FLOOR is the operator (so the agent reads the user's second brain), while the
  // agent itself is tracked as `agentUserId` so WRITES still route through the
  // governance membrane (propose, never auto-apply as the operator).
  const effectiveUserId = keyRecord.linkedUserId ?? keyRecord.userId;
  const agentUserId = keyRecord.linkedUserId ? keyRecord.userId : undefined;
  const grounding = isInitialize
    ? await buildGrounding(effectiveUserId)
    : undefined;
  const server = createMCPServer(
    defaultWorkspaceId,
    effectiveUserId,
    grounding,
    defaultProjectId,
    agentUserId,
    // The validated key's OWN scopes — never the process-global MCP_SCOPES env
    // var, which is meaningless per-key over HTTP.
    deriveMcpScopes(keyRecord.scope),
    defaultSessionId,
    // SERVICE-KEY CONFINEMENT: a bound `service` key is positively pinned to its
    // workspace. Threaded into the executor so `resolveConfinedWorkspace` (the
    // SAME primitive the REST door uses) 403s a bound key that targets another
    // workspace and pins pod-wide calls to the bound ws. Non-service/unbound
    // keys (`keyWorkspaceId == null`) pass through unchanged.
    keyRecord.keyType,
    keyRecord.workspaceId
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
