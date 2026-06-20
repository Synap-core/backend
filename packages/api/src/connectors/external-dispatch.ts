/**
 * Shared external-action dispatcher — ONE implementation, two entry doors:
 *   1. Human-direct (immediate REST — operator IS the approval)
 *   2. Agent-approved (proposals.ts approve branch — proposal already past governance)
 *
 * Extracted here so the immediate hub paths and the proposal-approval path call
 * the SAME connector.sendMessage / connector.triggerAction — no duplicate sends,
 * no implementation drift.
 */

import { createHash } from "crypto";
import { and, asc, eq, isNull, or } from "@synap/database";
import {
  db,
  messages,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  tools,
} from "@synap/database";
import { channels, ChannelType, mcpServers } from "@synap/database/schema";
import { getMessagingConnector } from "./index.js";
import { syncConnectorRegistry } from "./SyncConnector.js";
import type { NangoConnector } from "./NangoConnector.js";
import { resolveVaultSecret } from "../utils/vault-resolver.js";
import { validateExternalUrl } from "../utils/validate-url.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";

/**
 * Resolve the configured Nango connector (or undefined when unconfigured).
 * Single lookup shared by every Nango-scheme handler so the registry key is
 * not hardcoded in multiple places.
 */
function getNangoConnector(): NangoConnector | undefined {
  const connector = syncConnectorRegistry.get("nango") as
    | NangoConnector
    | undefined;
  return connector && connector.isConfigured() ? connector : undefined;
}

// ── External messaging send ──────────────────────────────────────────────────

export interface SendExternalMessageInput {
  /** The conversation thread id (external platform id). */
  threadId: string;
  /** The account that sends (Unipile/Stalwart account id). */
  accountId: string;
  /** Message body. */
  body: string;
  /** The user performing the send. */
  userId: string;
}

export interface SendExternalMessageResult {
  success: boolean;
  /** The sent message row id, when successfully mirrored. */
  messageId?: string;
  /**
   * External platform message id — recorded by the proposal-approval path into
   * `proposal.data.materialized` so a retry is a no-op.
   */
  externalId?: string;
}

/**
 * Send a message through the correct messaging connector (Unipile for LinkedIn /
 * WhatsApp / Gmail, Stalwart for self-hosted email), then mirror the outbound
 * message into the DB inbox so the conversation history is complete.
 */
export async function sendExternalMessage(
  input: SendExternalMessageInput
): Promise<SendExternalMessageResult> {
  const { threadId, accountId, body, userId } = input;

  // Resolve the EXTERNAL channel to route to the correct connector provider
  // (stalwart vs unipile vs gmail). Same resolution the immediate REST path
  // already does.
  const linkedChannel = await db.query.channels.findFirst({
    where: and(
      eq(channels.channelType, ChannelType.EXTERNAL),
      eq(channels.externalId as any, threadId)
    ),
    columns: { id: true, externalSource: true },
  });

  const connector = await getMessagingConnector(
    linkedChannel?.externalSource ?? undefined
  );
  if (!connector) {
    return { success: false };
  }

  await connector.sendMessage(accountId, threadId, body);

  // Mirror the outbound message into the messages table.
  let messageId: string | undefined;
  if (linkedChannel) {
    const msgHash = createHash("sha256")
      .update(`outbound:${threadId}:${Date.now()}:${body}`)
      .digest("hex");

    const [msg] = await db
      .insert(messages)
      .values({
        channelId: linkedChannel.id,
        userId,
        role: MessageRole.USER,
        authorType: MessageAuthorType.HUMAN,
        messageCategory: MessageCategory.CHAT,
        content: body,
        hash: msgHash,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });

    messageId = msg?.id;
  }

  return { success: true, messageId };
}

// ── External connector action trigger (Nango) ───────────────────────────────

export interface TriggerConnectorActionInput {
  connectionId: string;
  providerConfigKey: string;
  actionName: string;
  input?: Record<string, unknown>;
}

export interface TriggerConnectorActionResult {
  success: boolean;
  result?: unknown;
}

/**
 * Trigger a pre-defined Nango action (write to an integration through a user's
 * connected account). Actions are defined in the Nango integration config;
 * there is no generic proxy() — only named actions work.
 */
export async function triggerConnectorAction(
  input: TriggerConnectorActionInput
): Promise<TriggerConnectorActionResult> {
  const connector = getNangoConnector();
  if (!connector) {
    return { success: false };
  }

  const {
    connectionId,
    providerConfigKey,
    actionName,
    input: actionInput,
  } = input;
  const result = await connector.triggerAction({
    connectionId,
    providerConfigKey,
    actionName,
    input: actionInput ?? {},
  });

  return { success: true, result };
}

// ── Agnostic provider tool execution (Nango proxy) ──────────────────────────
//
// ONE implementation, two doors (mirrors sendExternalMessage):
//   1. POST /connectors/tool-execute (human/AI-bridge, immediate REST)
//   2. proposals.ts `provider.action` executor (proposal-approved external action)
//
// Resolves the pod-wide `tools` row by credentialRef (`nango://<provider>`),
// resolves the user's connection via Nango, and forwards through the generic
// `connector.proxyRequest(...)` — no per-provider branches in either caller.

export interface TriggerProviderActionInput {
  /** The user whose connection to resolve (Nango end_user_id). */
  userId: string;
  /**
   * Provider reference — EITHER a credentialRef (`nango://gmail`,
   * `vault://secret-id`, `mcp://server`) OR a bare tool NAME / id. A bare name is
   * resolved server-side to the tool row's credentialRef (pod-wide + the acting
   * `workspaceId` when supplied).
   */
  provider: string;
  /**
   * Optional acting workspace. Only used to widen the tool-NAME lookup to a
   * workspace-scoped tool in addition to pod-wide rows. Ignored for credentialRef
   * lookups (those stay pod-wide, byte-identical to before).
   */
  workspaceId?: string;
  /** HTTP method for the downstream request. */
  method: string;
  /** Path after the proxy root (e.g. "/gmail/v1/messages/send"). */
  path: string;
  /** Optional request body for POST/PUT/PATCH. */
  body?: Record<string, unknown>;
  /** Optional hint to pick a specific account when multiple connections exist. */
  accountHint?: string;
}

export interface TriggerProviderActionResult {
  success: boolean;
  /** HTTP-ish status to surface (the REST endpoint maps this to its response). */
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Machine-readable error key for the REST endpoint (404 / 400 / 501 / 503). */
  errorCode?: "not_found" | "bad_request" | "not_implemented" | "unavailable";
  /** Human-readable error message. */
  error?: string;
}

/** A resolved `tools` row, passed to each scheme handler. */
type ToolRow = typeof tools.$inferSelect;

/**
 * One handler per credentialRef scheme. The dispatcher parses `scheme://rest`,
 * looks up + kind-gates the tool row, then forwards to the matching handler.
 * Adding a new connector type = registering a new entry here, never editing the
 * callers or the dispatcher core.
 */
type SchemeHandler = (ctx: {
  input: TriggerProviderActionInput;
  tool: ToolRow;
}) => Promise<TriggerProviderActionResult>;

/** Kinds that may be executed for a given scheme (kind-gating per scheme). */
const SCHEME_ALLOWED_KINDS: Record<string, ReadonlyArray<string>> = {
  nango: ["provider", "external"],
  // An API-key tool is `kind:'api'` (or registered as `external`).
  vault: ["api", "provider", "external"],
  // `kind:'mcp'` is the natural kind for an `mcp://` tool; `provider`/`external`
  // are accepted too so a generic external-action tool can target an MCP server.
  mcp: ["mcp", "provider", "external"],
};

// ── nango:// handler (Nango proxy — Connection-Id + Provider-Config-Key) ──────
//
// Body is VERBATIM the original nango branch: same providerConfigKey resolution,
// listConnections, accountHint / most-recent pick, proxyRequest, result shape.
const nangoHandler: SchemeHandler = async ({ input, tool }) => {
  const { userId, method, path, body, accountHint } = input;

  const connector = getNangoConnector();
  if (!connector) {
    return {
      success: false,
      status: 503,
      errorCode: "unavailable",
      error: "Nango not configured",
    };
  }

  // Resolve provider config key from the tool row
  const toolConfig = (tool.config ?? {}) as Record<string, unknown>;
  const providerConfigKey =
    (toolConfig.providerConfigKey as string) ??
    tool.credentialRef!.replace(/^nango:\/\//, "");

  // Resolve user's connection for this provider
  const connections = await connector.listConnections(userId);
  const matchingConnections = connections.filter(
    (conn) => conn.provider === providerConfigKey
  );

  if (matchingConnections.length === 0) {
    return {
      success: false,
      status: 404,
      errorCode: "not_found",
      error: `No connection found for provider "${providerConfigKey}". Connect it via Settings → Connectors first.`,
    };
  }

  // Pick by accountHint (match connectionId prefix) or default to most recent
  let connection = matchingConnections[0]!;
  if (accountHint) {
    const hinted = matchingConnections.find((c) =>
      c.connectionId.includes(accountHint)
    );
    if (hinted) connection = hinted;
  } else {
    // Most recently created (latest first from Nango)
    connection = matchingConnections.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    )[0]!;
  }

  const result = await connector.proxyRequest({
    connectionId: connection.connectionId,
    providerConfigKey,
    method,
    path,
    body,
  });

  return {
    success: true,
    status: result.status,
    headers: result.headers,
    body: result.body,
  };
};

/**
 * Config-driven auth injection for vault:// tools. `tool.config` may carry:
 *   - `baseUrl`: string  — outbound base URL (required when `path` is not absolute)
 *   - `auth`: { in: 'header' | 'query', name: string, prefix?: string }
 *       default → { in: 'header', name: 'Authorization', prefix: 'Bearer ' }
 *   - `field`: string    — optional sub-field to pull out of a structured secret
 * Templates author `config` so a new API-key provider needs no code change.
 */
interface VaultAuthConfig {
  in: "header" | "query";
  name: string;
  prefix: string;
}

function resolveVaultAuthConfig(raw: unknown): VaultAuthConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const where = cfg.in === "query" ? "query" : "header";
  const name =
    typeof cfg.name === "string" && cfg.name.length > 0
      ? cfg.name
      : "Authorization";
  const prefix =
    typeof cfg.prefix === "string"
      ? cfg.prefix
      : where === "header" && name.toLowerCase() === "authorization"
        ? "Bearer "
        : "";
  return { in: where, name, prefix };
}

// ── vault:// handler (API-key / non-Nango tools — direct guarded HTTP) ────────
//
// (a) resolve the credential via grant-gated resolveVaultSecret;
// (b) build the outbound call from `config.baseUrl` + `path` + `method`/`body`,
//     injecting the secret per `config.auth` (header or query, configurable);
// (c) fetch behind the shared validateExternalUrl SSRF guard (blocks loopback /
//     private / link-local / cloud-metadata) and return the SAME structured
//     shape the nango branch returns. The secret is NEVER logged.
const vaultHandler: SchemeHandler = async ({ input, tool }) => {
  const { userId, provider, method, path, body } = input;

  const vaultId = provider.replace(/^vault:\/\//, "");
  const toolConfig = (tool.config ?? {}) as Record<string, unknown>;
  const field =
    typeof toolConfig.field === "string" ? toolConfig.field : undefined;

  // (a) Resolve the credential (grant-gated, atomic consume-after-decrypt).
  let secret: string | null;
  try {
    secret = await resolveVaultSecret(vaultId, userId, field, {
      requireGrant: true,
      redeemer: { agentUserId: userId },
    });
  } catch (err) {
    return {
      success: false,
      status: 403,
      errorCode: "bad_request",
      error: `Vault grant check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!secret) {
    return {
      success: false,
      status: 404,
      errorCode: "not_found",
      error: `Vault secret "${vaultId}" could not be resolved (missing, deleted, or not server-resolvable).`,
    };
  }

  // (b) Build the outbound URL. SECURITY: when `config.baseUrl` is configured
  //     the destination host is FIXED at proposal-time — a call-time absolute
  //     `path` must NEVER override it (that would let a caller redirect a
  //     credentialed request to an arbitrary host = SSRF / credential-exfil).
  //     An absolute path is only honoured when NO baseUrl is set, and it still
  //     passes through validateExternalUrl below.
  const baseUrl =
    typeof toolConfig.baseUrl === "string" ? toolConfig.baseUrl : undefined;
  let rawUrl: string;
  if (baseUrl) {
    // baseUrl wins: always compose host + path, ignoring any absolute scheme in
    // `path`. Strip a leading scheme+host from `path` so it can't smuggle a host.
    const relPath = path.replace(/^https?:\/\/[^/]+/i, "");
    rawUrl = `${baseUrl.replace(/\/$/, "")}/${relPath.replace(/^\//, "")}`;
  } else if (/^https?:\/\//i.test(path)) {
    rawUrl = path;
  } else {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error:
        'vault:// tool requires either an absolute path or `config.baseUrl`. Set tool.config.baseUrl (e.g. "https://api.example.com").',
    };
  }

  // (c) SSRF guard — reuse the shared validator (blocks loopback/private/metadata).
  const checked = validateExternalUrl(rawUrl);
  if (!checked.valid) {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error: `Outbound URL rejected: ${checked.reason}`,
    };
  }

  const url = checked.url;
  const auth = resolveVaultAuthConfig(toolConfig.auth);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  // Inject the secret per config — header or query. Never logged.
  if (auth.in === "query") {
    url.searchParams.set(auth.name, `${auth.prefix}${secret}`);
  } else {
    headers[auth.name] = `${auth.prefix}${secret}`;
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      success: false,
      status: 502,
      errorCode: "unavailable",
      error: `Outbound request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep as text if not JSON.
  }
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  return {
    success: res.ok,
    status: res.status,
    headers: respHeaders,
    body: parsed,
  };
};

// ── MCP env hardening (defense-in-depth, mirrors the IS-side guard) ──────────
//
// Strip environment variables that can hijack process execution before they are
// forwarded to the IS to spawn the MCP server. Blocks exact (case-insensitive)
// loader/runtime keys and dangerous prefixes (LD_* / DYLD_* injection, NODE_*).
const MCP_ENV_BLOCKLIST_EXACT = new Set(
  ["PATH", "HOME", "USER", "SHELL", "NODE_OPTIONS", "PYTHONPATH", "IFS"].map(
    (k) => k.toUpperCase()
  )
);
const MCP_ENV_BLOCKLIST_PREFIXES = ["LD_", "DYLD_", "NODE_"];

function isBlockedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (MCP_ENV_BLOCKLIST_EXACT.has(upper)) return true;
  return MCP_ENV_BLOCKLIST_PREFIXES.some((p) => upper.startsWith(p));
}

function stripDangerousEnv(
  env: Record<string, string>
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isBlockedEnvKey(k)) safe[k] = v;
  }
  return safe;
}

// ── mcp:// handler (Model Context Protocol tool call, bridged via the IS) ─────
//
// Architecture: the live MCP *client* (process spawn / HTTP transport / pooled
// connections) lives ONLY in the Intelligence Service — `mcp-client-manager.ts`
// owns every `@modelcontextprotocol/sdk` `Client`. The backend deliberately
// never holds MCP connections; it DELEGATES to the IS over HTTP, exactly like
// the `mcpServers.ping` / `mcpServers.listTools` tRPC routes already do
// (`fetch(${hubUrl}/api/mcp/...)`). This handler is the third such delegation —
// it REUSES the IS client rather than re-implementing one here.
//
// Flow:
//   (1) resolve `mcp://<server-slug>` → an `mcpServers` row (pod-wide, mirroring
//       the dispatcher's pod-wide `tools` lookup);
//   (2) resolve the MCP tool name (`tool.config.toolName`, else `input.path`)
//       and its arguments (`input.body`);
//   (3) optionally inject a vault-resolved secret into the server `env` — same
//       grant-gated `resolveVaultSecret` the vault handler uses;
//   (4) POST the call to the IS `/api/mcp/call` endpoint (it owns the client);
//   (5) map `{ content, isError }` back into the shared result shape.
const mcpHandler: SchemeHandler = async ({ input, tool }) => {
  const { userId, provider, path, body } = input;

  const serverSlug = provider.replace(/^mcp:\/\//, "").trim();
  if (!serverSlug) {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error: 'mcp:// ref is missing a server slug (expected "mcp://<server>").',
    };
  }

  const toolConfig = (tool.config ?? {}) as Record<string, unknown>;

  // (1) Resolve the MCP server config — SCOPED + DETERMINISTIC.
  //     Scope to pod-wide rows (null workspaceId, always allowed) OR a row
  //     belonging to the acting workspace ONLY. This blocks the cross-workspace
  //     match the old `or(isNull(workspaceId), enabled=true)` predicate allowed
  //     (which matched ANY enabled workspace's server). Order nulls-first so the
  //     pick is deterministic when both a pod-wide and a workspace row share the
  //     slug, then enforce enabled + approved below.
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.slug, serverSlug),
        input.workspaceId
          ? or(
              isNull(mcpServers.workspaceId),
              eq(mcpServers.workspaceId, input.workspaceId)
            )
          : isNull(mcpServers.workspaceId)
      )
    )
    .orderBy(asc(mcpServers.workspaceId))
    .limit(1);

  if (!server || !server.enabled) {
    return {
      success: false,
      status: 404,
      errorCode: "not_found",
      error: `No MCP server found for "${serverSlug}". Register it under Settings → MCP Servers first.`,
    };
  }
  // Supply-chain gate: an MCP server must be explicitly approved before its
  // (potentially RCE-capable) tools can be executed. `approved` defaults false.
  if (!server.approved) {
    return {
      success: false,
      status: 403,
      errorCode: "bad_request",
      error: `MCP server "${serverSlug}" is not approved. An owner must approve it under Settings → MCP Servers before its tools can run.`,
    };
  }

  // (2) Which tool on that server, and with what arguments.
  const mcpToolName =
    (typeof toolConfig.toolName === "string" && toolConfig.toolName) ||
    (path ? path.replace(/^\//, "") : "");
  if (!mcpToolName) {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error:
        "mcp:// tool requires a tool name — set tool.config.toolName (or pass it as the path).",
    };
  }
  const toolArguments = (body ?? {}) as Record<string, unknown>;

  // (3) Optional vault-resolved secret, injected into the server env under the
  //     configured key. Grant-gated exactly like the vault handler — never logged.
  const env: Record<string, string> = { ...(server.env ?? {}) };
  const vaultRef =
    typeof toolConfig.vaultRef === "string" ? toolConfig.vaultRef : undefined;
  const vaultEnvKey =
    typeof toolConfig.vaultEnvKey === "string"
      ? toolConfig.vaultEnvKey
      : undefined;
  // Reject a vault injection that targets a process-hijacking env key.
  if (vaultEnvKey && isBlockedEnvKey(vaultEnvKey)) {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error: `vaultEnvKey "${vaultEnvKey}" is a disallowed environment variable and cannot receive an injected secret.`,
    };
  }
  if (vaultRef && vaultEnvKey) {
    const vaultId = vaultRef.replace(/^vault:\/\//, "");
    const field =
      typeof toolConfig.field === "string" ? toolConfig.field : undefined;
    let secret: string | null;
    try {
      secret = await resolveVaultSecret(vaultId, userId, field, {
        requireGrant: true,
        redeemer: { agentUserId: userId },
      });
    } catch (err) {
      return {
        success: false,
        status: 403,
        errorCode: "bad_request",
        error: `Vault grant check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!secret) {
      return {
        success: false,
        status: 404,
        errorCode: "not_found",
        error: `Vault secret "${vaultId}" could not be resolved for MCP server "${serverSlug}".`,
      };
    }
    env[vaultEnvKey] = secret;
  }

  // (4) Delegate to the IS — it owns the MCP client/connection pool.
  let hubUrl: string;
  let hubApiKey: string;
  try {
    const resolved = await resolveIntelligenceService({
      userId,
      workspaceId: server.workspaceId ?? undefined,
    });
    hubUrl = resolved.endpoint;
    hubApiKey = resolved.serviceApiKey;
  } catch (err) {
    return {
      success: false,
      status: 503,
      errorCode: "unavailable",
      error: `Intelligence Service unavailable for MCP execution: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Defense-in-depth: strip process-hijacking env keys from the MERGED env
  // (server-configured + vault-injected) before it crosses to the IS spawner.
  const safeEnv = stripDangerousEnv(env);

  let res: Response;
  try {
    res = await fetch(`${hubUrl}/api/mcp/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": hubApiKey,
      },
      body: JSON.stringify({
        server: {
          id: server.slug,
          name: server.name,
          transport: server.transport,
          command: server.command,
          args: server.args,
          url: server.url,
          env: safeEnv,
          enabled: server.enabled,
        },
        name: mcpToolName,
        arguments: toolArguments,
      }),
    });
  } catch (err) {
    return {
      success: false,
      status: 502,
      errorCode: "unavailable",
      error: `MCP call to the Intelligence Service failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The IS now exposes POST /api/mcp/call (it owns the MCP client). A 404 from
  // it is therefore a genuine "tool/endpoint not found at the IS" — surface it
  // as an upstream-unavailable 502, NOT the old misleading 501-not-implemented.
  if (res.status === 404) {
    return {
      success: false,
      status: 502,
      errorCode: "unavailable",
      error: `Intelligence Service returned 404 for MCP tool "${mcpToolName}" on server "${serverSlug}" (tool or endpoint not found).`,
    };
  }

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep as text if not JSON
  }

  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `Intelligence Service returned ${res.status}`;
    return {
      success: false,
      status: res.status,
      errorCode: res.status >= 500 ? "unavailable" : "bad_request",
      error: errMsg,
    };
  }

  // (5) Map the MCP CallToolResult. The IS returns the SDK result shape:
  //     { content: [...], isError?: boolean }. An MCP-level error (isError)
  //     is a failed call surfaced with its content (so the caller sees why).
  const result = (parsed ?? {}) as { content?: unknown; isError?: boolean };
  if (result.isError === true) {
    return {
      success: false,
      status: 502,
      errorCode: "unavailable",
      body: result.content ?? result,
      error: `MCP tool "${mcpToolName}" returned an error result.`,
    };
  }

  return {
    success: true,
    status: 200,
    body: result.content ?? result,
  };
};

/** scheme → handler. Adding a connector type = one entry here. */
const SCHEME_HANDLERS: Record<string, SchemeHandler> = {
  nango: nangoHandler,
  vault: vaultHandler,
  mcp: mcpHandler,
};

/**
 * Execute an agnostic provider tool, dispatching by the tool's credentialRef
 * SCHEME (`scheme://rest`):
 *   - `nango://` → Nango proxy (Connection-Id + Provider-Config-Key)
 *   - `vault://` → vault-resolved API key, injected into a config-driven HTTP call
 *   - `mcp://`   → bridged to the resolved MCP server's tool call (mcpHandler)
 *
 * Returns a structured result so both the REST endpoint (needs status codes for
 * its HTTP response) and the proposal-approval executor (needs success/result)
 * can consume the same code path.
 */
export async function triggerProviderAction(
  input: TriggerProviderActionInput
): Promise<TriggerProviderActionResult> {
  const { provider, workspaceId } = input;

  // ── Resolve the tool row + its credentialRef ───────────────────────────────
  // `provider` is EITHER a credentialRef (`scheme://rest`, the original form) OR
  // a bare tool NAME (or id). A scheme is what makes a string a credentialRef, so
  // the same regex that picks the handler also disambiguates the two cases:
  //   - matches `^scheme://` → credentialRef, resolve as before (BYTE-IDENTICAL)
  //   - no scheme            → tool name/id, load the row and use ITS credentialRef
  // Either way we end with a `tool` row whose `credentialRef` drives the existing
  // scheme dispatch unchanged.
  let tool: ToolRow | undefined;
  let credentialRef: string;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(provider)) {
    // credentialRef path — exactly as before.
    credentialRef = provider;
    [tool] = await db
      .select()
      .from(tools)
      .where(and(eq(tools.credentialRef, provider), isNull(tools.workspaceId)))
      .limit(1);

    if (!tool) {
      return {
        success: false,
        status: 404,
        errorCode: "not_found",
        error: `Tool not found for provider: ${provider}`,
      };
    }
  } else {
    // Tool name/id path — load by `name` (or `id`) scoped pod-wide, plus the
    // acting workspace when supplied, then continue with the row's credentialRef.
    const scope = workspaceId
      ? or(isNull(tools.workspaceId), eq(tools.workspaceId, workspaceId))
      : isNull(tools.workspaceId);
    // `tools.id` is a uuid column — comparing it to a non-uuid string throws a
    // Postgres cast error (22P02), so only match by id when `provider` IS a uuid.
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        provider
      );
    const nameOrId = isUuid
      ? or(eq(tools.name, provider), eq(tools.id, provider))
      : eq(tools.name, provider);
    const matches = await db.select().from(tools).where(and(nameOrId, scope));

    if (matches.length === 0) {
      return {
        success: false,
        status: 404,
        errorCode: "not_found",
        error: `Tool not found for name: ${provider}`,
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        status: 400,
        errorCode: "bad_request",
        error: `Tool name "${provider}" is not unique (${matches.length} matches). Use the tool's credentialRef or id.`,
      };
    }
    tool = matches[0]!;
    if (!tool.credentialRef) {
      return {
        success: false,
        status: 400,
        errorCode: "bad_request",
        error: `Tool "${provider}" has no credentialRef and cannot be executed.`,
      };
    }
    credentialRef = tool.credentialRef;
  }

  // ── Parse scheme://rest from the resolved credentialRef and pick the handler ─
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(credentialRef);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  const handler = scheme ? SCHEME_HANDLERS[scheme] : undefined;
  if (!scheme || !handler) {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error: `Unsupported provider scheme. Supported: ${Object.keys(
        SCHEME_HANDLERS
      )
        .map((s) => `${s}://`)
        .join(", ")}. Got: ${credentialRef}`,
    };
  }

  // ── Kind-gate per scheme (applied to the resolved tool) ────────────────────
  const allowedKinds = SCHEME_ALLOWED_KINDS[scheme] ?? ["provider", "external"];
  if (!allowedKinds.includes(tool.kind)) {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error: `Tool kind "${tool.kind}" is not executable for ${scheme}://. Expected one of: ${allowedKinds.join(", ")}.`,
    };
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  // The handlers parse `provider` from the credentialRef scheme — so when the
  // caller passed a bare tool name, forward the resolved credentialRef instead
  // (handlers strip the scheme prefix off `input.provider`). When the caller
  // already passed a credentialRef, `credentialRef === provider`, so this is a
  // no-op for the existing path.
  const dispatchInput: TriggerProviderActionInput =
    credentialRef === provider ? input : { ...input, provider: credentialRef };
  return handler({ input: dispatchInput, tool });
}
