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
import {
  channels,
  ChannelType,
  mcpServers,
  secrets,
  providerIntegrations,
  providers,
  links,
  entities,
} from "@synap/database/schema";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { getMessagingConnector } from "./index.js";
import { resolveNangoConnector } from "./index.js";
import type { NangoConnector } from "./NangoConnector.js";
import { resolveVaultSecret } from "../utils/vault-resolver.js";
import { resolveCapabilityGrant } from "@synap/database";
import { validateExternalUrl } from "../utils/validate-url.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { gateCapabilityExecution } from "../services/capabilities/gate-capability-execution.js";
import { createPendingProposal } from "../utils/permission-check.js";

/**
 * Resolve the configured Nango connector (or undefined when unconfigured).
 * Single lookup shared by every Nango-scheme handler so the registry key is
 * not hardcoded in multiple places.
 */
async function getNangoConnector(): Promise<NangoConnector | undefined> {
  // TODO(W3/W4): becomes a capability cast (Pushable — proxyRequest/triggerAction).
  const connector = await resolveNangoConnector();
  return connector && connector.isConfigured() ? connector : undefined;
}

/**
 * Resolve a tool's EFFECTIVE credentialRef per its `authBinding`.
 *   static     → the tool's own credentialRef (unchanged).
 *   per_user   → the acting user's bound credential.
 *   per_agent  → the acting agent-user's bound credential.
 *   per_entity → the run's subject entity's bound credential (e.g. per client).
 *
 * Dynamic bindings resolve a `provides_credential` link from the principal
 * (participant = user/agent id) or entity (subjectId) to a vault `secret`, scoped
 * to THIS tool via `metadata.toolId`. Returns `vault://<secretId>`. Throws when
 * the binding has no bound credential or the required principal is absent — the
 * caller turns the throw into a 400 (never silently falls back to a shared cred).
 */
async function resolveBoundCredentialRef(
  tool: Pick<ToolRow, "id" | "name" | "authBinding" | "credentialRef">,
  ctx: {
    userId: string;
    agentUserId?: string | null;
    subjectId?: string | null;
  }
): Promise<string> {
  const binding = tool.authBinding ?? "static";
  if (binding === "static") {
    if (!tool.credentialRef)
      throw new Error(`Tool "${tool.name}" has no credential.`);
    return tool.credentialRef;
  }

  let principalType: "participant" | "entity";
  let principalId: string | null | undefined;
  if (binding === "per_user") {
    principalType = "participant";
    principalId = ctx.userId;
  } else if (binding === "per_agent") {
    principalType = "participant";
    principalId = ctx.agentUserId;
  } else if (binding === "per_entity") {
    principalType = "entity";
    principalId = ctx.subjectId;
  } else {
    // Unknown binding — never silently treat it as per_entity (defence against a
    // malformed/unmigrated value reaching the dynamic path).
    throw new Error(
      `Tool "${tool.name}" has an unknown auth binding "${binding}".`
    );
  }
  if (!principalId) {
    const need =
      principalType === "entity" ? "subject entity" : "acting principal";
    throw new Error(
      `Tool "${tool.name}" is bound "${binding}" but no ${need} is in context.`
    );
  }

  // per_entity resolves a SUBJECT-supplied id — verify the actor can actually see
  // that entity, so a caller can't point at an entity in a workspace they don't
  // belong to and have the dispatcher decrypt its credential.
  if (binding === "per_entity") {
    const [ent] = await db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.id, principalId),
          userVisibleWhere(entities.workspaceId, ctx.userId)
        )
      )
      .limit(1);
    if (!ent)
      throw new Error(
        `Tool "${tool.name}" subject entity is not accessible to the actor.`
      );
  }

  const edges = await db
    .select()
    .from(links)
    .where(
      and(
        eq(links.fromType, principalType),
        eq(links.fromId, principalId),
        eq(links.toType, "secret"),
        eq(links.linkType, "provides_credential")
      )
    );
  // Require a credential scoped to THIS tool (metadata.toolId). NEVER fall back to
  // an unrelated edge — a single bound secret for a different tool must not be
  // mis-routed here (cross-tool credential leak).
  const edge = edges.find(
    (e) => (e.metadata as { toolId?: string } | null)?.toolId === tool.id
  );
  if (!edge) {
    throw new Error(
      `No credential is bound to this ${
        binding === "per_entity" ? "entity" : "principal"
      } for "${tool.name}". Bind one in the capability's Authentication step.`
    );
  }
  return `vault://${edge.toId}`;
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
  /**
   * The AI-agent identity, when this send is agent-initiated. Threaded to the
   * capability-execution gate so an agent run (no owner-bypass) routes to
   * `propose` instead of dispatching. ABSENT (the long-standing case for every
   * caller today) → owner send → the gate is skipped and the send dispatches
   * directly, BYTE-IDENTICAL to before W3b.
   */
  agentUserId?: string | null;
  /** Acting workspace — routes a `propose` verdict's proposal + grant lookup. */
  workspaceId?: string | null;
  /** Optional session/playbook context for the gate's proposal payload + audit. */
  sessionId?: string | null;
  playbookId?: string | null;
  /**
   * The acting `grants`-link metadata (carrying the per-grant `execMode`), when
   * the caller resolved a grant for this run. Threaded to the gate.
   */
  grantMetadata?: Record<string, unknown> | null;
  /**
   * BYPASS CONTRACT (W3b): set ONLY by the `messaging.external.send` proposal
   * executor (the send is already past governance at proposal-approval time).
   * When `true`, the capability-execution gate is SKIPPED and the send dispatches
   * directly, exactly once — so an already-approved proposal never double-gates.
   * No external/untrusted caller may supply it.
   */
  alreadyApproved?: boolean;
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
  /**
   * Set when the capability-execution gate routed an AGENT send to a reviewable
   * proposal instead of dispatching it. The message was NOT sent; on approval the
   * `messaging.external.send` executor re-enters with `alreadyApproved`.
   */
  proposed?: boolean;
  /** The created `capability/run` proposal id when `proposed === true`. */
  proposalId?: string;
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

  const provider = linkedChannel?.externalSource ?? undefined;
  const connector = await getMessagingConnector(provider);
  if (!connector) {
    return { success: false };
  }

  // ── Capability-execution gate (W3b: messaging-send under the ONE gate) ────────
  // Messaging-send is now governed by the SAME `gateCapabilityExecution` that
  // governs `triggerProviderAction` (the provider-tool door). A messaging
  // connector has no `tools` row (it is resolved per-call from DB/vault/env), so
  // the gate is keyed off a `messaging://<provider>` capability identity resolved
  // here (see `gateMessagingSend`).
  //
  // BYPASS: an OWNER send (no `agentUserId`) or an already-approved proposal
  // re-entry (`alreadyApproved`) SKIPS the gate and dispatches directly, exactly
  // once — BYTE-IDENTICAL to pre-W3b behavior. Only an AGENT send (agentUserId
  // present) is gated: approved+grant+exec-mode → run, else → propose/deny.
  if (input.agentUserId && !input.alreadyApproved) {
    const gateResult = await gateMessagingSend({ ...input, provider });
    if (gateResult.kind === "deny") {
      return { success: false };
    }
    if (gateResult.kind === "propose") {
      return {
        success: false,
        proposed: true,
        proposalId: gateResult.proposalId,
      };
    }
    if (gateResult.kind === "dry-run") {
      // No external side effect — report success without sending or mirroring.
      return { success: true };
    }
    // gateResult.kind === "run" → fall through and dispatch.
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

/**
 * Verdict of the messaging-send capability gate (W3b). Mirrors the four
 * `gateCapabilityExecution` outcomes, with `propose` carrying the created
 * proposal id so the caller can surface it.
 */
type MessagingGateResult =
  | { kind: "run" }
  | { kind: "dry-run" }
  | { kind: "deny"; reason: string }
  | { kind: "propose"; proposalId: string };

/**
 * Gate an AGENT-initiated messaging send through `gateCapabilityExecution` — the
 * SAME gate `triggerProviderAction` uses for provider tools, so the messaging
 * door can no longer diverge from the governed provider door.
 *
 * Capability resolution: a messaging connector has no `tools` row (it is resolved
 * per-call from DB/vault/env), so the gate is keyed off a `messaging://<provider>`
 * pod-wide tool row WHEN one has been seeded; absent, we synthesize an unapproved,
 * owner-less `GateToolRow`. For an agent run with no active grant the gate routes
 * to `propose` either way (safe-by-default) — never an auto-run.
 *
 * Only reached for an AGENT send that is NOT an already-approved re-entry; the
 * owner door never calls this (it dispatches directly upstream).
 */
async function gateMessagingSend(
  input: SendExternalMessageInput & { provider?: string }
): Promise<MessagingGateResult> {
  const provider = input.provider ?? "unipile";
  const credentialRef = `messaging://${provider}`;

  // Resolve a seeded pod-wide messaging tool row (if any); else synthesize one.
  const [seeded] = await db
    .select({
      id: tools.id,
      approved: tools.approved,
      createdBy: tools.createdBy,
    })
    .from(tools)
    .where(
      and(eq(tools.credentialRef, credentialRef), isNull(tools.workspaceId))
    )
    .limit(1);

  const capabilityId = seeded?.id ?? credentialRef;
  const toolRow = {
    id: capabilityId,
    approved: seeded?.approved ?? false,
    createdBy: seeded?.createdBy ?? null,
  };

  const decision = await gateCapabilityExecution({
    capabilityKind: "tool",
    capabilityId,
    tool: toolRow,
    grantMetadata: input.grantMetadata ?? null,
    actorUserId: input.agentUserId ?? input.userId,
    agentUserId: input.agentUserId ?? null,
    workspaceId: input.workspaceId ?? null,
    sessionId: input.sessionId ?? null,
    playbookId: input.playbookId ?? null,
    issuer: "messaging.external.send",
  });

  if (decision.decision === "deny") {
    return { kind: "deny", reason: decision.reason };
  }
  if (decision.decision === "dry-run") {
    return { kind: "dry-run" };
  }
  if (decision.decision === "propose") {
    // Route to a reviewable proposal that, on approval, re-enters
    // `sendExternalMessage` via the `messaging.external.send` executor with
    // `alreadyApproved`. Proposals require a workspace; with none there is no
    // review surface → fail closed rather than silently send.
    const proposalWorkspaceId = input.workspaceId ?? null;
    if (!proposalWorkspaceId) {
      return {
        kind: "deny",
        reason:
          "Messaging send requires approval but no workspace was supplied to route the proposal.",
      };
    }
    const proposal = await createPendingProposal({
      userId: input.userId,
      workspaceId: proposalWorkspaceId,
      targetType: "messaging",
      targetId: input.threadId,
      proposalType: "messaging.external.send",
      data: {
        threadId: input.threadId,
        body: input.body,
        platform: provider,
        capabilityKind: "tool",
        capabilityId,
        workspaceId: proposalWorkspaceId,
        agentUserId: input.agentUserId ?? null,
        sessionId: input.sessionId ?? null,
        playbookId: input.playbookId ?? null,
      },
      agentUserId: input.agentUserId ?? undefined,
      sessionId: input.sessionId ?? null,
      notificationDescription: `Send message via ${provider}`,
    });
    return { kind: "propose", proposalId: proposal.id };
  }

  // decision === "run" → consume one grant use (the gate's lookup is
  // non-consuming), then dispatch. Mirrors triggerProviderAction's consume-on-run.
  // A seeded tool gives a real capabilityId to spend against; a synthesized
  // capabilityId would have routed to propose above (no grant), so a `run` verdict
  // for an agent here implies a seeded tool with an active grant.
  if (input.agentUserId) {
    const consumed = await resolveCapabilityGrant("tool", capabilityId, {
      agentUserId: input.agentUserId,
      workspaceId: input.workspaceId ?? null,
    });
    if (!consumed.ok) {
      return {
        kind: "deny",
        reason: `Capability grant could not be consumed (${consumed.code}).`,
      };
    }
  }
  return { kind: "run" };
}

// NOTE (W3b): `triggerConnectorAction` (the Nango named-action 3rd push path,
// `connector.triggerAction`) was RETIRED — it bypassed the capability gate and
// duplicated the agnostic provider door. Its real use is folded into
// `triggerProviderAction` below (Nango via the generic `proxyRequest`), which is
// the ONE governed external-action dispatcher.

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
  /**
   * Optional per-call proxy base-URL override (Nango `Base-Url-Override`). Lets a
   * single connection reach multiple API hosts — e.g. a `google` connection uses
   * gmail.googleapis.com for Gmail but the provider-default host for Calendar/Drive.
   */
  baseUrlOverride?: string;
  /**
   * The AI-agent identity, when this provider call is agent-initiated. Threaded
   * to the capability-execution gate so an agent run (no owner-bypass) routes to
   * `propose` instead of auto. Absent → resolved by the safe-by-default rule
   * below (a non-owner `userId` is treated as a delegated agent → propose).
   */
  agentUserId?: string | null;
  /**
   * The acting `grants`-link metadata (carrying the per-grant `execMode`), when
   * the caller resolved a grant for this run. Threaded to the gate.
   */
  grantMetadata?: Record<string, unknown> | null;
  /** Optional session/playbook context for the gate's proposal payload + audit. */
  sessionId?: string | null;
  playbookId?: string | null;
  /**
   * The run's SUBJECT entity id (the entity the work is "about" — e.g. a client).
   * Used ONLY to resolve a `per_entity`-bound tool's credential at execution. A
   * `static`/`per_user`/`per_agent` tool ignores it; absent when not in a
   * subject-bound run.
   */
  subjectId?: string | null;
  /**
   * BYPASS CONTRACT (Wave 3a/3b): set ONLY by the `capability/run` proposal
   * executor (and the auto `run` decision re-entry). When `true`, the
   * capability-execution gate is SKIPPED and the dispatch runs directly, exactly
   * once — so an already-approved proposal never loops back into a new proposal.
   * No external/untrusted caller may supply it.
   */
  alreadyApproved?: boolean;
  /** Audit linkage to the proposal that authorized an `alreadyApproved` run. */
  sourceProposalId?: string;
}

export interface TriggerProviderActionResult {
  success: boolean;
  /** HTTP-ish status to surface (the REST endpoint maps this to its response). */
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Machine-readable error key for the REST endpoint (404 / 400 / 503). */
  errorCode?: "not_found" | "bad_request" | "unavailable";
  /** Human-readable error message. */
  error?: string;
  /**
   * Set when the capability-execution gate routed this run to a reviewable
   * proposal instead of executing it (the ungoverned-door + propose-each ≡
   * governed-door mechanism). The call did NOT reach the provider; on approval
   * the `capability/run` executor re-enters this impl with `alreadyApproved`.
   */
  proposed?: boolean;
  /** The created `capability/run` proposal id when `proposed === true`. */
  proposalId?: string;
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
  const { userId, method, path, body, accountHint, baseUrlOverride } = input;

  const connector = await getNangoConnector();
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
    baseUrlOverride,
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

/**
 * Vault-delegated handler — routes a vault:// secret with a
 * `provider_integration_id` to the correct credential backend.
 *
 * This is the runtime heart of Approach B: the vault becomes the UNIFIED routing
 * intermediary. When a secret carries `provider_integration_id`, its credential
 * is NOT a static key — it lives on the linked provider (Nango OAuth) and must
 * be resolved through that provider's connection lifecycle (proxy, token refresh).
 *
 * Current delegation paths:
 *   nango   → look up the user's Nango connection, proxy the HTTP call
 *   vault   → should never reach here (provider_integration_id would be null)
 *   unipile → not yet delegated through vault (still uses messaging connector)
 *
 * As new provider types are added, add a case here — no caller changes needed.
 */
async function vaultDelegatedHandler(ctx: {
  input: TriggerProviderActionInput;
  tool: ToolRow;
  vaultId: string;
  secretRow: { userId: string; providerIntegrationId: string };
  providerIntegrationId: string;
}): Promise<TriggerProviderActionResult> {
  const { input } = ctx;
  const { userId, method, path, body, accountHint, baseUrlOverride } = input;

  // Resolve the provider integration + its parent provider.
  const integration = await db.query.providerIntegrations.findFirst({
    where: eq(providerIntegrations.id, ctx.providerIntegrationId),
    columns: { id: true, slug: true, providerId: true, backendConfig: true },
  });
  if (!integration) {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error: `Provider integration "${ctx.providerIntegrationId}" not found (deleted?).`,
    };
  }

  const prov = await db.query.providers.findFirst({
    where: eq(providers.id, integration.providerId),
    columns: { slug: true, backendType: true },
  });
  if (!prov) {
    return {
      success: false,
      status: 400,
      errorCode: "bad_request",
      error: `Provider "${integration.providerId}" not found for integration "${integration.slug}".`,
    };
  }

  // ── Nango delegation ────────────────────────────────────────────────────
  // The secret points at a provider integration owned by Nango. Route through
  // the Nango proxy (same logic as the nangoHandler, but the providerConfigKey
  // comes from the integration's backendConfig, not the tool config).
  if (prov.backendType === "nango") {
    const connector = await getNangoConnector();
    if (!connector) {
      return {
        success: false,
        status: 503,
        errorCode: "unavailable",
        error: "Nango not configured",
      };
    }

    const bCfg = (integration.backendConfig ?? {}) as Record<string, unknown>;
    const providerConfigKey =
      (bCfg.providerConfigKey as string) ?? integration.slug;

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
        error: `No Nango connection found for provider "${providerConfigKey}". Connect it via Settings → Connectors first.`,
      };
    }

    // Pick by accountHint or default to most recent
    let connection = matchingConnections[0]!;
    if (accountHint) {
      const hinted = matchingConnections.find((c) =>
        c.connectionId.includes(accountHint)
      );
      if (hinted) connection = hinted;
    } else {
      connection = matchingConnections.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      )[0]!;
    }

    const result = await connector.proxyRequest({
      connectionId: connection.connectionId,
      providerConfigKey,
      method: method ?? "GET",
      path: path ?? "/",
      body,
      baseUrlOverride,
    });

    return {
      success: true,
      status: result.status,
      headers: result.headers,
      body: result.body,
    };
  }

  // ── Unknown backend type ─────────────────────────────────────────────────
  return {
    success: false,
    status: 400,
    errorCode: "bad_request",
    error: `Vault secret "${ctx.vaultId}" is linked to provider integration "${integration.slug}" whose backend type "${prov.backendType}" is not yet supported for delegated credential routing.`,
  };
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
  const { userId, provider, method, path, body, accountHint } = input;
  void accountHint; // used below in connection-selection
  const vaultId = provider.replace(/^vault:\/\//, "");
  const toolConfig = (tool.config ?? {}) as Record<string, unknown>;
  const field =
    typeof toolConfig.field === "string" ? toolConfig.field : undefined;

  // ── Phase 0: Provider-integration delegation ──────────────────────────────
  // When the secret has a `provider_integration_id`, the credential is NOT a
  // static API key — it routes through the linked provider's credential lifecycle
  // (OAuth flow, token refresh, proxy). Look up the secret row FIRST to check.
  //
  // This is the core of Approach B: `credentialRef = vault://<secretId>` is the
  // ONLY ref format; the `provider_integration_id` FK discriminates between
  // vault-direct (API key injection) and provider-delegated (Nango proxy, etc.).
  const secretRow = await db.query.secrets.findFirst({
    where: eq(secrets.id, vaultId),
    columns: { userId: true, providerIntegrationId: true },
  });
  if (!secretRow) {
    return {
      success: false,
      status: 404,
      errorCode: "not_found",
      error: `Vault secret "${vaultId}" could not be resolved (missing or deleted).`,
    };
  }

  // If this secret is linked to a provider integration, delegate to the
  // provider's credential handler instead of vault-direct injection.
  if (secretRow.providerIntegrationId) {
    return vaultDelegatedHandler({
      input,
      tool,
      vaultId,
      secretRow: {
        ...secretRow,
        providerIntegrationId: secretRow.providerIntegrationId!,
      },
      providerIntegrationId: secretRow.providerIntegrationId!,
    });
  }

  const ownerUserId = secretRow.userId;
  // SEC#1: the owner-bypass must key off the EFFECTIVE actor, not raw `userId`.
  // An agent running under the owner's hub identity (agentUserId present, userId =
  // secret owner) must STILL be grant-gated on the per-secret vault grant (TTL /
  // once / revoke) — otherwise the owner can't scope an agent's access to their
  // own secret. Only a GENUINE human-owner run (no agentUserId) bypasses the grant.
  const effectiveActor = input.agentUserId ?? userId;
  const callerIsOwner = ownerUserId === effectiveActor && !input.agentUserId;

  // (a) Resolve the credential. Owner → ungated. Delegated → grant-gated with a
  //     server-derived redeemer (atomic consume-after-decrypt inside resolver).
  let secret: string | null;
  try {
    secret = await resolveVaultSecret(
      vaultId,
      ownerUserId,
      field,
      callerIsOwner
        ? undefined
        : {
            requireGrant: true,
            redeemer: {
              // Bind to the EFFECTIVE actor (the genuine agent identity when
              // present, else the caller) so the grant's `granted_to` matches the
              // principal actually running — never the secret owner we decrypt under.
              agentUserId: effectiveActor,
              workspaceId: input.workspaceId ?? null,
            },
          }
    );
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
 *   - `vault://` → UNIFIED handler (Approach B). When the secret carries a
 *     `provider_integration_id`, routes through the linked provider's credential
 *     lifecycle (Nango OAuth proxy, etc.). When null, injects the decrypted API
 *     key into a config-driven HTTP call (existing behavior).
 *   - `nango://` → backward-compat shim (existing tool rows only). NEW tools
 *     use `vault://<secretId>` with the secret's `provider_integration_id`.
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
      // Scope precedence: a workspace-scoped tool OVERRIDES a pod-wide tool of
      // the same name (standard overlay semantics — the workspace row is the
      // deliberate, more-specific binding). Only a set that is still ambiguous
      // AFTER applying precedence (e.g. two pod-wide rows, or two rows in the
      // same workspace) is a genuine conflict the caller must disambiguate.
      const wsScoped = workspaceId
        ? matches.filter((m) => m.workspaceId === workspaceId)
        : [];
      const podWide = matches.filter((m) => m.workspaceId == null);
      if (wsScoped.length === 1) {
        tool = wsScoped[0]!;
      } else if (wsScoped.length === 0 && podWide.length === 1) {
        tool = podWide[0]!;
      } else {
        return {
          success: false,
          status: 400,
          errorCode: "bad_request",
          error: `Tool name "${provider}" is not unique (${matches.length} matches). Use the tool's credentialRef or id.`,
        };
      }
    } else {
      tool = matches[0]!;
    }
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

  // ── Dynamic auth binding — resolve the effective credential per principal ───
  // A non-static tool resolves its credential per the acting user/agent or the
  // run's subject entity (a `provides_credential` link). `static` tools keep the
  // ref resolved above, byte-identical. A binding with no bound credential 400s.
  if ((tool.authBinding ?? "static") !== "static") {
    try {
      credentialRef = await resolveBoundCredentialRef(tool, {
        userId: input.userId,
        agentUserId: input.agentUserId ?? null,
        subjectId: input.subjectId ?? null,
      });
    } catch (e) {
      return {
        success: false,
        status: 400,
        errorCode: "bad_request",
        error:
          e instanceof Error
            ? e.message
            : "Credential binding could not be resolved.",
      };
    }
  }

  // ── Capability-execution gate (Wave 3b chokepoint) ─────────────────────────
  // Both resolution paths converge here with a loaded `tool` row. This is THE
  // single point that consults (per-capability approval-state + grant + exec-mode)
  // so the ungoverned door (/connectors/tool-execute, IS callProvider) can no
  // longer diverge from the governed proposal door.
  //
  // BYPASS: an `alreadyApproved` run is the `capability/run` proposal executor
  // re-entering after a human clicked Approve — it is the governed door, so it
  // dispatches directly (exactly once). Only that executor (and the auto `run`
  // decision) may set the flag; no external caller supplies it. This preserves
  // the Door-2 `provider.action` behavior byte-for-byte (it never re-checked).
  if (!input.alreadyApproved) {
    // SAFE-BY-DEFAULT actor resolution: the gate's owner-bypass keys off the
    // EFFECTIVE actor vs the tool's owner (`createdBy`). When an `agentUserId` is
    // present the effective actor is the AGENT (mirrors checkPermissionOrPropose's
    // `effectiveUserId = agentUserId || userId`), so owner-bypass does NOT fire
    // for the human owner — an agent is always grant-gated, never owner-bypassed.
    // When the actor is NOT the owner — an agent, a hub service-key call, or any
    // uncertain principal — the gate routes to `propose`, never auto-run. We do
    // NOT trust a request-supplied identity to upgrade to auto; only an APPROVED
    // capability + an explicit `auto` grant (or genuine owner) yields `run`.
    const effectiveActorUserId = input.agentUserId ?? input.userId;
    const decision = await gateCapabilityExecution({
      capabilityKind: "tool",
      capabilityId: tool.id,
      tool: {
        id: tool.id,
        approved: tool.approved,
        createdBy: tool.createdBy,
      },
      grantMetadata: input.grantMetadata ?? null,
      actorUserId: effectiveActorUserId,
      agentUserId: input.agentUserId ?? null,
      workspaceId: input.workspaceId ?? null,
      sessionId: input.sessionId ?? null,
      playbookId: input.playbookId ?? null,
      issuer: "connector.tool-execute",
    });

    if (decision.decision === "deny") {
      return {
        success: false,
        status: 403,
        errorCode: "bad_request",
        error: decision.reason,
      };
    }

    if (decision.decision === "dry-run") {
      // Build nothing external — return a stub echoing the intended call so a
      // playbook/skill test sees the shape without a real side effect.
      return {
        success: true,
        status: 200,
        body: {
          dryRun: true,
          provider,
          method: input.method,
          path: input.path,
        },
      };
    }

    if (decision.decision === "propose") {
      // The previously-ungoverned door now PRODUCES a reviewable proposal that,
      // on approval, re-enters this same impl (Door 2) with `alreadyApproved`.
      // We carry the full provider call in `data` so the executor can replay it.
      // Proposals require a workspace (createPendingProposal inserts workspaceId);
      // when none is supplied there is no review surface — fail closed rather
      // than silently auto-run.
      const proposalWorkspaceId = input.workspaceId ?? null;
      if (!proposalWorkspaceId) {
        return {
          success: false,
          status: 403,
          errorCode: "bad_request",
          error:
            "Capability execution requires approval but no workspace was supplied to route the proposal. Provide a workspaceId or pre-approve the capability.",
        };
      }
      const proposal = await createPendingProposal({
        userId: input.userId,
        workspaceId: proposalWorkspaceId,
        targetType: "capability",
        targetId: tool.id,
        proposalType: "run",
        data: {
          capabilityKind: "tool",
          capabilityId: tool.id,
          provider,
          method: input.method,
          path: input.path,
          body: input.body ?? null,
          accountHint: input.accountHint ?? null,
          baseUrlOverride: input.baseUrlOverride ?? null,
          workspaceId: proposalWorkspaceId,
          agentUserId: input.agentUserId ?? null,
          sessionId: input.sessionId ?? null,
          playbookId: input.playbookId ?? null,
        },
        agentUserId: input.agentUserId ?? undefined,
        sessionId: input.sessionId ?? null,
        notificationDescription: `Run tool ${tool.name}`,
      });
      return {
        success: true,
        status: 202,
        proposed: true,
        proposalId: proposal.id,
      };
    }
    // decision.decision === "run" → consume one grant use, then dispatch.
    // CONSUME-ON-RUN: the gate's grant lookup is NON-CONSUMING, so a `run` verdict
    // for an AGENT (the gate already required a grant to exist — no grant routes to
    // propose) must spend one use here. This is the serialization point for capped
    // ('once') grants. The owner/operator door (no agentUserId) has no grant to
    // consume and is skipped. If the grant was exhausted in the race window,
    // fail closed rather than dispatch the credentialed call ungoverned.
    if (input.agentUserId) {
      const consumed = await resolveCapabilityGrant("tool", tool.id, {
        agentUserId: input.agentUserId,
        workspaceId: input.workspaceId ?? null,
      });
      if (!consumed.ok) {
        return {
          success: false,
          status: 403,
          errorCode: "bad_request",
          error: `Capability grant could not be consumed (${consumed.code}). The grant may have just expired, been revoked, or been exhausted.`,
        };
      }
    }
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
