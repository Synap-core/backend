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
import { and, eq, isNull } from "@synap/database";
import {
  db,
  messages,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  tools,
} from "@synap/database";
import { channels, ChannelType } from "@synap/database/schema";
import { getMessagingConnector } from "./index.js";
import { syncConnectorRegistry } from "./SyncConnector.js";
import type { NangoConnector } from "./NangoConnector.js";

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
  const connector = syncConnectorRegistry.get("nango") as
    | NangoConnector
    | undefined;
  if (!connector || !connector.isConfigured()) {
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
  /** Provider reference (e.g. "nango://gmail", "vault://secret-id"). */
  provider: string;
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

/**
 * Execute an agnostic provider tool through the Nango proxy.
 *
 * Provider schemes:
 *   - `nango://` → resolved via Nango proxy (Connection-Id + Provider-Config-Key)
 *   - `vault://` → credential resolved but generic HTTP proxy not yet implemented (501)
 *
 * Returns a structured result so both the REST endpoint (needs status codes for
 * its HTTP response) and the proposal-approval executor (needs success/result)
 * can consume the same code path.
 */
export async function triggerProviderAction(
  input: TriggerProviderActionInput
): Promise<TriggerProviderActionResult> {
  const { userId, provider, method, path, body, accountHint } = input;

  // ── Validate provider scheme ───────────────────────────────────────────────
  if (!provider.startsWith("nango://") && !provider.startsWith("vault://")) {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error: `Unsupported provider scheme. Supported: nango://, vault://. Got: ${provider.split("://")[0]}://`,
    };
  }

  // ── Look up the tool row ───────────────────────────────────────────────────
  const [tool] = await db
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

  if (tool.kind !== "provider" && tool.kind !== "external") {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error: `Tool kind "${tool.kind}" is not executable via this endpoint. Expected "provider" or "external".`,
    };
  }

  // ── Route by provider scheme ───────────────────────────────────────────────
  if (provider.startsWith("nango://")) {
    const connector = syncConnectorRegistry.get("nango") as
      | NangoConnector
      | undefined;
    if (!connector || !connector.isConfigured()) {
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
  }

  // vault:// — credential resolution exists, generic HTTP proxy does not
  return {
    success: false,
    status: 501,
    errorCode: "not_implemented",
    error:
      "TODO: vault:// provider execution is not yet implemented. " +
      "The credential is stored in the vault but there is no generic HTTP proxy " +
      "for vault-resolved secrets yet. Implement a bridge that uses the resolved " +
      "credential (e.g. API key) to make the HTTP call directly.",
  };
}
