/**
 * Shared external-action dispatcher — ONE implementation, two entry doors:
 *   1. Human-direct (immediate REST — operator IS the approval)
 *   2. Agent-approved (proposals.ts approve branch — proposal already past governance)
 *
 * Extracted here so the immediate hub paths and the proposal-approval path call
 * the SAME connector.sendMessage / connector.triggerAction — no duplicate sends,
 * no implementation drift.
 */

import { randomUUID } from "crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  isNotNull,
  or,
  drizzleSql,
} from "@synap/database";
import {
  db,
  messages,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  tools,
  computeMessageHash,
} from "@synap/database";
import {
  channels,
  ChannelType,
  mcpServers,
  secrets,
  CONNECTION_REAUTH_FAILURE_THRESHOLD,
  providerIntegrations,
  providers,
  links,
  entities,
} from "@synap/database/schema";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { getMessagingConnector } from "./index.js";
import { resolveNangoConnector } from "./index.js";
import type { NangoConnector } from "./NangoConnector.js";
import type { SyncConnectorConnection } from "./SyncConnector.js";
import { resolveVaultSecret } from "../utils/vault-resolver.js";
import { resolveCapabilityGrant } from "@synap/database";
import { validateExternalUrl, safeExternalFetch } from "@synap/shared-utils";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { gateCapabilityExecution } from "../services/capabilities/gate-capability-execution.js";
import { createPendingProposal } from "../utils/permission-check.js";
import { recordDomainMutation } from "../utils/domain-mutation.js";
import { isConnectionAuthError } from "../services/connection-health/notify-connector-unhealthy.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "external-dispatch" });

/**
 * Mirror a dispatched call's auth outcome onto the connection-health store
 * (`secrets.connection_state` keyed by `accountHint` = the Nango connectionId).
 *
 * This is the W-B1 reactive health signal — a REUSE of the dispatch
 * `errorClass:"auth"` classification, NOT a probe (providers give no proactive
 * expiry signal; you only learn on the next call). A single auth failure can be a
 * concurrent-refresh race, so we flip to `needs_reauth` only at the
 * CONNECTION_REAUTH_FAILURE_THRESHOLD consecutive failures; any success clears the
 * counter. Best-effort and non-blocking — health is eventually-consistent and must
 * never fail (or slow) the actual call. Only touches capability-connection rows.
 */
async function mirrorConnectionAuthOutcome(
  connectionId: string,
  outcome: "ok" | "auth_fail"
): Promise<void> {
  try {
    if (outcome === "ok") {
      // Reset ONLY when there is something to clear — a no-op UPDATE on every
      // successful call would be needless write load. "Something to clear" is a
      // non-zero counter OR a `needs_reauth` state: the latter can be set with
      // authFailCount=0 by a source OTHER than this reactive path (e.g. a Nango
      // refresh-failure webhook / a reconcile that reads Nango's own error state),
      // so guarding on the counter alone would strand it — a successful call must
      // clear needs_reauth no matter who set it.
      await db
        .update(secrets)
        .set({
          authFailCount: 0,
          connectionState: "connected",
          updatedAt: new Date(),
        })
        .where(
          and(
            // `account_hint` is the FULL Nango connectionId, which is unique per
            // end-user — so keying on it already targets THIS user's row without a
            // userId scope (Nango OAuth connections are never pod-wide shared; only
            // vault keys are). Parity with the failure path's `deletedAt` guard.
            eq(secrets.accountHint, connectionId),
            isNotNull(secrets.capabilityId),
            isNull(secrets.deletedAt),
            or(
              gt(secrets.authFailCount, 0),
              eq(secrets.connectionState, "needs_reauth")
            )
          )
        );
      return;
    }
    // auth_fail: increment + flip to needs_reauth AT the threshold, atomically in
    // SQL (read-modify-write in JS would race concurrent calls on the same conn).
    await db
      .update(secrets)
      .set({
        authFailCount: drizzleSql`${secrets.authFailCount} + 1`,
        lastAuthErrorAt: new Date(),
        connectionState: drizzleSql`CASE WHEN ${secrets.authFailCount} + 1 >= ${CONNECTION_REAUTH_FAILURE_THRESHOLD} THEN 'needs_reauth' ELSE ${secrets.connectionState} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(secrets.accountHint, connectionId),
          isNotNull(secrets.capabilityId),
          isNull(secrets.deletedAt)
        )
      );
  } catch (err) {
    logger.warn(
      { err, connectionId },
      "connection-health mirror failed (non-fatal)"
    );
  }
}

/**
 * P1 "every failure carries a next action" — the machine-readable failure class a
 * dispatch failure is stamped with (alongside the human `error` string), so the
 * browser can derive a one-click action ("Reconnect Google", "Retry", "Connect X")
 * without re-parsing prose. Persisted on a failed proposal at
 * `proposal.data.failure = { errorClass, providerRef }`.
 *
 *   auth           — credential/token failure (expired, invalid_grant, 401) → RECONNECT
 *   no_connection  — enabled but never connected (no connection found)       → CONNECT
 *   transient      — timeout / rate-limit / upstream 5xx                     → RETRY
 *   permission     — an explicit grant/approval denial (vault grant, MCP approve)
 *   target_missing — a NOT_FOUND that is not a connection issue (tool/secret/endpoint)
 *   provider       — a genuine provider-side failure (business 4xx, malformed request)
 */
export type FailureErrorClass =
  | "auth"
  | "no_connection"
  | "transient"
  | "permission"
  | "target_missing"
  | "provider";

/**
 * SINGLE CLASSIFIER — map an already-known dispatch failure ({status, message,
 * errorCode}) to a `FailureErrorClass`. The AUTH decision reuses the SAME
 * `isConnectionAuthError` predicate the connection-health cron uses (never a
 * parallel regex), so "should this reconnect?" has ONE source of truth.
 *
 * Precedence is deliberate (isConnectionAuthError also matches the "no connection
 * found" affordance, so no_connection is split out FIRST; transient outranks auth
 * so a 5xx whose body mentions a token is a Retry, not a Reconnect).
 */
export function classifyDispatchFailure(args: {
  status: number;
  message?: string;
  errorCode?: string;
}): FailureErrorClass {
  const { status } = args;
  const message = args.message ?? "";

  // no_connection — the "enabled but never connected" affordance (a 404 whose
  // message is the connect nudge). Split out BEFORE the auth check because
  // isConnectionAuthError ALSO matches "no connection found".
  if (/no (?:nango )?connection found|connect it via/i.test(message)) {
    return "no_connection";
  }

  // permission — an explicit grant/approval denial (vault grant check, MCP server
  // not approved). A 403, but distinct from a provider auth 401/403 — so it must
  // precede the auth check (which also fires on 403).
  if (
    status === 403 &&
    /grant check failed|is not approved|must approve/i.test(message)
  ) {
    return "permission";
  }

  // transient — timeout / rate-limit / upstream server error → retryable. Outranks
  // auth so a 5xx/429 with an incidental credential word is not mis-read as reconnect.
  if (status === 408 || status === 429 || status >= 500) return "transient";

  // auth — credential/token failure. THE auth decision = isConnectionAuthError
  // (message-driven, status-agnostic by design — the live dead-connection shapes
  // arrive as 400/424, not only 401/403).
  if (isConnectionAuthError(message)) return "auth";

  // target_missing — a NOT_FOUND that is not a connection issue.
  if (status === 404 || args.errorCode === "not_found") return "target_missing";

  // provider — a genuine provider-side failure.
  return "provider";
}

/**
 * Teach-in-response affordance for the no-credential/no-connection error
 * family below. No stable deep link to Settings → Connectors exists yet
 * (verified: `synap-app/packages/core/deep-link-constants` has no
 * `settings/connectors` path) — point the agent at the user instead of
 * fabricating a URL.
 */
const CONNECT_AFFORDANCE =
  " Ask the user to connect it in Settings → Connectors.";

// Re-exported so existing importers of `EXTERNAL_DISPATCH_SOURCE` from this
// module keep working; the canonical definition lives in the dependency-free
// leaf module below (see its docstring for why it's split out).
export { EXTERNAL_DISPATCH_SOURCE } from "./external-dispatch-constants.js";
import { EXTERNAL_DISPATCH_SOURCE } from "./external-dispatch-constants.js";

/**
 * Record a completed external send to the run/event spine — the UNIVERSAL SINK
 * this wave closes: every outbound messaging send / provider proxy call that
 * reaches a real external system now leaves a `{channel}.{action}.completed`
 * event (audit log + best-effort automation/webhook fan-out via
 * `recordDomainMutation`), keyed by `correlationId` so `diagnose(correlationId)`
 * resolves it (see resolve-object-kind.ts's correlationId fallback).
 *
 * GUARANTEE (audit-is-best-effort discipline): this call is AWAITED — never
 * fire-and-forget — but its callers in this module catch a failed append and
 * log it loudly rather than letting it throw. A send this module already
 * performed is IRREVERSIBLE; some callers (`routers/hub-protocol/rest/
 * messaging.ts`, `utils/delivery-router.ts`) have NO at-most-once claim
 * around it, so a throw here would turn a completed send into a 500 that the
 * client retries — a real double-send. Only the proposal-approval path
 * (`dispatchExternalOnce`) holds a CAS `externalDispatchedAt` claim taken
 * BEFORE the send, so that path alone could safely treat an audit failure as
 * "ambiguous, keep the claim, surface APPROVAL_FAILED" — but this function is
 * shared by both, so it cannot assume the claim exists. A missing audit row
 * is recoverable (logged here, still visible via `recordDomainMutation`'s
 * caller-side error); a duplicate outbound message is not. The automation/
 * webhook fan-out inside `recordDomainMutation` stays fire-and-forget
 * (unchanged best-effort side-effect semantics).
 */
export async function recordExternalAction(opts: {
  /** e.g. "gmail" / "stalwart" / "discord" / "unipile" / "nango" / "vault" / "mcp". */
  channel: string;
  /** e.g. "send" / "action". */
  action: string;
  userId: string;
  workspaceId?: string | null;
  agentUserId?: string | null;
  /** Correlates this audit row to the caller's handle — `diagnose(correlationId)`. */
  correlationId: string;
  /** What the call targeted (threadId / provider+path / tool name). */
  target: string;
  status: "sent" | "failed";
  data?: Record<string, unknown>;
}): Promise<void> {
  await recordDomainMutation({
    subjectType: opts.channel,
    action: opts.action,
    subjectId: opts.correlationId,
    userId: opts.userId,
    workspaceId: opts.workspaceId ?? null,
    agentUserId: opts.agentUserId ?? null,
    correlationId: opts.correlationId,
    source: EXTERNAL_DISPATCH_SOURCE,
    data: {
      target: opts.target,
      status: opts.status,
      ...opts.data,
    },
    throwOnError: true,
  });
}

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
 * Pick the Nango connection for a provider from the user's live connections.
 * Honors an explicit `accountHint` (matched as a substring of the connectionId,
 * e.g. the exact connection a registry row pins); when a hint is given but
 * matches nothing, falls back to the first match; with no hint, the
 * most-recently-created. Returns null when the user has no connection for the
 * provider. Shared by `nangoHandler` and `vaultDelegatedHandler` so the 1-of-N
 * account pick stays identical on both routes.
 */
function pickNangoConnection(
  connections: SyncConnectorConnection[],
  providerConfigKey: string,
  accountHint: string | undefined
): SyncConnectorConnection | null {
  const matching = connections.filter((c) => c.provider === providerConfigKey);
  if (matching.length === 0) return null;
  if (accountHint) {
    return (
      matching.find((c) => c.connectionId.includes(accountHint)) ?? matching[0]!
    );
  }
  return [...matching].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )[0]!;
}

/**
 * Resolve a tool's EFFECTIVE credentialRef per its `authBinding`.
 *   static     → the tool's own credentialRef (unchanged).
 *   per_user   → the acting user's bound credential.
 *   per_agent  → the acting agent-user's bound credential.
 *   per_entity → the run's subject entity's bound credential (e.g. per client).
 *
 * Dynamic bindings resolve the tool's owning capability (`member_of` edge) then
 * read the `secrets` connection registry directly: a row for that capability whose
 * `context_type`/`context_id` match the principal (participant = user/agent id) or
 * entity (subjectId). Returns `vault://<secretId>`. Throws when the binding has no
 * bound credential or the required principal is absent — the caller turns the throw
 * into a 400 (never silently falls back to a shared cred).
 */
async function resolveBoundCredentialRef(
  tool: Pick<ToolRow, "id" | "name" | "authBinding" | "credentialRef">,
  ctx: {
    userId: string;
    agentUserId?: string | null;
    subjectId?: string | null;
    /**
     * Runtime 1-of-N connection pick (Wave 4). When present it is AUTHORITATIVE —
     * handled before the static/dynamic authBinding logic. A selector that
     * matches nothing THROWS (never silently falls back to a shared/default cred).
     */
    connectionSelector?: ConnectionSelector | null;
  }
): Promise<{ ref: string; accountHint?: string | null }> {
  // ── Runtime connection selector (Wave 4) ────────────────────────────────────
  // An explicit connection chosen at the execute door outranks the tool's own
  // authBinding. `connectionId` picks a specific connection (verified to be THIS
  // capability's, owned by the actor, live); `contextObjectId` picks the
  // capability's connection bound to that context object. Nothing matches → throw.
  const selector = ctx.connectionSelector;
  if (selector && (selector.connectionId || selector.contextObjectId)) {
    // Resolve THIS tool's owning capability (member_of edge → capability uuid).
    const [capEdge] = await db
      .select({ capabilityId: links.toId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "tool"),
          eq(links.fromId, tool.id),
          eq(links.linkType, "member_of"),
          eq(links.toType, "capability")
        )
      )
      .limit(1);
    if (!capEdge) {
      throw new Error(
        `Tool "${tool.name}" is not part of a capability; a connection selector cannot be resolved.`
      );
    }

    if (selector.connectionId) {
      // The selected secret must be THIS capability's connection and not deleted.
      // It resolves when it is the actor's OWN connection OR a POD-WIDE one (0211,
      // a shared VAULT key) — never another member's private key. Guards against a
      // caller pointing the dispatcher at an unrelated / private secret.
      const [row] = await db
        .select({
          id: secrets.id,
          accountHint: secrets.accountHint,
          userId: secrets.userId,
          isPodWide: secrets.isPodWide,
        })
        .from(secrets)
        .where(
          and(
            eq(secrets.id, selector.connectionId),
            eq(secrets.capabilityId, capEdge.capabilityId),
            or(eq(secrets.userId, ctx.userId), eq(secrets.isPodWide, true)),
            isNull(secrets.deletedAt)
          )
        )
        .limit(1);
      if (!row) {
        throw new Error(
          `Connection "${selector.connectionId}" is not a valid connection for "${tool.name}".${CONNECT_AFFORDANCE}`
        );
      }
      // A nango:// tool's connection is a Nango ACCOUNT: keep the tool's own
      // nango ref and pin the chosen account via its hint — routing stays on the
      // live nango:// path (no provider_integrations row required). A vault:// (or
      // other) tool's connection resolves to the picked secret directly.
      if (tool.credentialRef?.startsWith("nango://")) {
        // VAULT ONLY: a pod-wide (non-own) Nango account can't be resolved for
        // another member — a pod-wide OAuth would require run-as-owner proxying
        // (explicitly out of scope). Only vault keys are shareable pod-wide.
        if (row.userId !== ctx.userId) {
          throw new Error(
            `Connection "${selector.connectionId}" is a shared account/OAuth connection, which cannot be used pod-wide for "${tool.name}". Only vault keys can be shared pod-wide.`
          );
        }
        return { ref: tool.credentialRef, accountHint: row.accountHint };
      }
      return { ref: `vault://${row.id}` };
    }

    // contextObjectId → the capability's connection bound to that context object.
    // Resolve the actor's OWN connection first, else a POD-WIDE (0211) shared vault
    // key for the same context — never another member's private key. `desc(own)`
    // orders own-first so a member's own connection always wins over the pod-wide.
    const ownFirst = desc(drizzleSql`(${secrets.userId} = ${ctx.userId})`);
    const [row] = await db
      .select({
        id: secrets.id,
        accountHint: secrets.accountHint,
        userId: secrets.userId,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.capabilityId, capEdge.capabilityId),
          eq(secrets.contextId, selector.contextObjectId!),
          or(eq(secrets.userId, ctx.userId), eq(secrets.isPodWide, true)),
          isNull(secrets.deletedAt)
        )
      )
      .orderBy(ownFirst)
      .limit(1);
    if (!row) {
      throw new Error(
        `No connection bound to context object "${selector.contextObjectId}" for "${tool.name}".`
      );
    }
    if (tool.credentialRef?.startsWith("nango://")) {
      // VAULT ONLY: a pod-wide (non-own) Nango account is not resolvable for a
      // different member (pod-wide OAuth is out of scope).
      if (row.userId !== ctx.userId) {
        throw new Error(
          `The connection bound to context object "${selector.contextObjectId}" is a shared account/OAuth connection, which cannot be used pod-wide for "${tool.name}".`
        );
      }
      return { ref: tool.credentialRef, accountHint: row.accountHint };
    }
    return { ref: `vault://${row.id}` };
  }

  const binding = tool.authBinding ?? "static";
  if (binding === "static") {
    if (!tool.credentialRef)
      throw new Error(`Tool "${tool.name}" has no credential.`);
    return { ref: tool.credentialRef };
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

  // The credential now lives on `secrets` (the connection registry), keyed by the
  // owning CAPABILITY + the resolved context — NOT a `provides_credential` link
  // (retired in migration 0161). First resolve THIS tool's owning capability via
  // its `member_of` edge (to_id is the capability uuid, stored as text).
  const [memberEdge] = await db
    .select({ capabilityId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "tool"),
        eq(links.fromId, tool.id),
        eq(links.linkType, "member_of"),
        eq(links.toType, "capability")
      )
    )
    .limit(1);
  if (!memberEdge) {
    throw new Error(
      `No credential is bound to this ${
        binding === "per_entity" ? "entity" : "principal"
      } for "${tool.name}". Bind one in the capability's Authentication step.`
    );
  }

  // Map the binding's principal to the secret's context and look up the connection
  // scoped to THIS capability. Resolves the actor's OWN connection first, else a
  // POD-WIDE (0211) shared vault key for the same context — own wins (`desc(own)`).
  // NEVER falls back to an unrelated secret or another member's private key. This
  // branch always yields a `vault://` ref, so widening stays VAULT ONLY by design.
  const ownFirstBinding = desc(drizzleSql`(${secrets.userId} = ${ctx.userId})`);
  const [row] = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.capabilityId, memberEdge.capabilityId),
        eq(secrets.contextType, principalType),
        eq(secrets.contextId, principalId),
        or(eq(secrets.userId, ctx.userId), eq(secrets.isPodWide, true)),
        isNull(secrets.deletedAt)
      )
    )
    .orderBy(ownFirstBinding)
    .limit(1);
  if (!row) {
    throw new Error(
      `No credential is bound to this ${
        binding === "per_entity" ? "entity" : "principal"
      } for "${tool.name}". Bind one in the capability's Authentication step.`
    );
  }
  return { ref: `vault://${row.id}` };
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
  /**
   * The correlationId stamped on this send's `{channel}.send.completed` audit
   * event (see `recordExternalAction`) — pass to `diagnose(correlationId)` to
   * resolve the send. Set only on an actually-dispatched (non-gated) send.
   */
  correlationId?: string;
  /**
   * P1: machine-readable failure class, stamped alongside the human error on a
   * `success:false` result so the caller can derive a next action. Absent on
   * success / propose.
   */
  errorClass?: FailureErrorClass;
  /** P1: the provider/platform the failed send targeted (for the action label). */
  providerRef?: string;
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
    // No messaging connector resolved for this platform — the account is not
    // connected. P1: a `no_connection` next action ("Connect <provider>").
    return {
      success: false,
      errorClass: "no_connection",
      providerRef: provider,
    };
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
    // Canonical tamper-hash: computeMessageHash(id, content) — the ONE formula
    // (see message-hash.ts). Generate the id up front so the stored hash matches
    // the row's id.
    const msgId = randomUUID();
    const msgHash = computeMessageHash(msgId, body);

    const [msg] = await db
      .insert(messages)
      .values({
        id: msgId,
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

  // Universal-sink audit append (this wave): every confirmed dispatch (owner
  // send OR an approved-proposal re-entry) now leaves a `{channel}.send.
  // completed` event — the gap where an outbound message left no run/event
  // and was unresolvable by `diagnose`.
  // audit is best-effort: append failure is logged, never fails a completed send
  // (see `recordExternalAction`'s docstring).
  const correlationId = randomUUID();
  try {
    await recordExternalAction({
      channel: provider ?? "messaging",
      action: "send",
      userId,
      workspaceId: input.workspaceId ?? null,
      agentUserId: input.agentUserId ?? null,
      correlationId,
      target: threadId,
      status: "sent",
      data: { accountId, messageId: messageId ?? null },
    });
  } catch (err) {
    logger.error(
      {
        err,
        channel: provider ?? "messaging",
        action: "send",
        correlationId,
        target: threadId,
      },
      "recordExternalAction failed after a completed sendMessage — audit row missing, send was NOT retried"
    );
  }

  return { success: true, messageId, correlationId };
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
    // `alreadyApproved`. Proposals do NOT require a workspace — a null-workspace
    // proposal lands in the user's pod-wide review queue (workspace is an
    // optional lens, never a routing requirement).
    const proposalWorkspaceId = input.workspaceId ?? null;
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

/**
 * Runtime 1-of-N connection selection (Wave 4). Picks which of a capability's
 * connections a call uses: `connectionId` = a specific connection (secrets row);
 * `contextObjectId` = the connection bound to that context object (`context_id`).
 * Optional everywhere — absent → existing (default/authBinding) behavior.
 */
export interface ConnectionSelector {
  connectionId?: string;
  contextObjectId?: string;
}

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
   * Optional static custom request headers to merge into the outbound request
   * (e.g. Cal.com's `cal-api-version`). SECURITY: these are spread FIRST so the
   * handler's auth + structural headers (Nango Connection-Id / Provider-Config-Key
   * / Base-Url-Override, the vault auth header, Content-Type) always WIN — a custom
   * header can never override auth or smuggle a different connection.
   */
  headers?: Record<string, string>;
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
   * Runtime 1-of-N connection selector (Wave 4). When present, the effective
   * credential is resolved from the chosen connection instead of the tool's
   * static/authBinding credential. A selector that matches nothing THROWS
   * (surfaced as a 400) — never a silent fallback. Absent → behavior unchanged.
   */
  connectionSelector?: ConnectionSelector | null;
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
  /**
   * The correlationId stamped on this call's `{scheme}.action.completed` audit
   * event (see `recordExternalAction`) — pass to `diagnose(correlationId)` to
   * resolve the call. Set only on an actually-dispatched (non-gated) call.
   */
  correlationId?: string;
  /**
   * P1: machine-readable failure class, stamped alongside the human `error` on a
   * `success:false` result so the caller can derive a next action ("Reconnect
   * Google"). Absent on success / propose / dry-run.
   */
  errorClass?: FailureErrorClass;
  /**
   * P1: the provider/config-key the failed call targeted (from the tool's
   * `providerConfigKey` or the scheme-stripped credentialRef) — the action label's
   * subject. Absent on success.
   */
  providerRef?: string;
  /**
   * The connection (Nango connectionId) this call actually used. Set by the
   * nango handler so the dispatcher can mirror the call's auth outcome onto the
   * connection-health store (`secrets.connection_state` by `accountHint`): an
   * `errorClass:"auth"` failure increments toward `needs_reauth`, a success clears
   * it. Absent for non-connection schemes / when no connection was resolved.
   */
  connectionId?: string;
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

// Build the dispatch envelope from a Nango proxy result, HONORING the HTTP status.
// The Nango connector never throws on non-2xx (it returns {status, body}); if we
// blindly stamped success:true here, a provider 4xx/5xx (e.g. Google's 403
// "API not enabled") would be laundered into a fake success and then shaped to an
// empty result by applyResponseShape — the bug that silently made calendar_list /
// drive_* return {count:0} instead of surfacing the error. Mirror the vault://
// handler: success = status is 2xx, and carry the provider's error message so the
// caller's kind:"error" branch can report it.
function nangoProxyEnvelope(result: {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}) {
  const ok = result.status >= 200 && result.status < 300;
  if (ok) {
    return {
      success: true,
      status: result.status,
      headers: result.headers,
      body: result.body,
    };
  }
  return {
    success: false,
    status: result.status,
    headers: result.headers,
    body: result.body,
    errorCode: statusToErrorCode(result.status),
    error: extractProviderErrorMessage(result.status, result.body),
  };
}

// Map an upstream HTTP status onto the dispatch envelope's constrained errorCode.
// 408/429 are TRANSIENT (timeout / rate-limit) → "unavailable" so retry policies
// keying on errorCode retry them, not "bad_request" (which reads as permanent).
function statusToErrorCode(
  status: number
): "not_found" | "bad_request" | "unavailable" {
  if (status === 404) return "not_found";
  if (status === 408 || status === 429) return "unavailable";
  if (status >= 400 && status < 500) return "bad_request";
  return "unavailable";
}

// Pull a concise message from common provider error shapes:
//   Google → { error: { message } }; others → { error: string } | { message }.
function extractProviderErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const err = b.error;
    if (err && typeof err === "object") {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === "string" && m) return m;
    }
    if (typeof err === "string" && err) return err;
    if (typeof b.message === "string" && b.message) return b.message;
  }
  return `provider call failed (status ${status})`;
}

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

  // Resolve user's connection for this provider (honor accountHint if given).
  const connections = await connector.listConnections(userId);
  const connection = pickNangoConnection(
    connections,
    providerConfigKey,
    accountHint
  );
  if (!connection) {
    return {
      success: false,
      status: 404,
      errorCode: "not_found",
      error: `No connection found for provider "${providerConfigKey}".${CONNECT_AFFORDANCE}`,
    };
  }

  // SSRF guard — a caller/agent-supplied baseUrlOverride would otherwise redirect
  // this credentialed proxy call to an arbitrary host. Reuse the shared validator
  // (blocks loopback/private/metadata). Only validate when an override is present;
  // absent → Nango uses the provider's configured base URL.
  if (baseUrlOverride) {
    const checked = validateExternalUrl(baseUrlOverride);
    if (!checked.valid) {
      return {
        success: false,
        status: 400,
        errorCode: "bad_request",
        error: `Outbound baseUrlOverride rejected: ${checked.reason}`,
      };
    }
  }

  const result = await connector.proxyRequest({
    connectionId: connection.connectionId,
    providerConfigKey,
    method,
    path,
    body,
    baseUrlOverride,
    headers: input.headers,
  });

  // Carry the connection used so the dispatcher can mirror this call's auth
  // outcome onto the connection-health store (needs_reauth on a dead token).
  return {
    ...nangoProxyEnvelope(result),
    connectionId: connection.connectionId,
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
  secretRow: {
    userId: string;
    providerIntegrationId: string;
    accountHint?: string | null;
  };
  providerIntegrationId: string;
}): Promise<TriggerProviderActionResult> {
  const { input } = ctx;
  const { userId, method, path, body, baseUrlOverride } = input;
  // The connection row's OWN account_hint (which Nango connection it represents)
  // is authoritative for the 1-of-N pick; fall back to a caller-supplied hint.
  const accountHint = ctx.secretRow.accountHint ?? input.accountHint;

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

    // Resolve user's connection for this provider (honor accountHint if given).
    const connections = await connector.listConnections(userId);
    const connection = pickNangoConnection(
      connections,
      providerConfigKey,
      accountHint
    );
    if (!connection) {
      return {
        success: false,
        status: 404,
        errorCode: "not_found",
        error: `No Nango connection found for provider "${providerConfigKey}".${CONNECT_AFFORDANCE}`,
      };
    }

    const result = await connector.proxyRequest({
      connectionId: connection.connectionId,
      providerConfigKey,
      method: method ?? "GET",
      path: path ?? "/",
      body,
      baseUrlOverride,
    });

    return nangoProxyEnvelope(result);
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
    columns: {
      userId: true,
      providerIntegrationId: true,
      accountHint: true,
      isPodWide: true,
    },
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
  // provider's credential handler instead of vault-direct injection. The row's
  // own `account_hint` (which Nango connection this connection row represents)
  // is carried through so a 1-of-N account pick pins the RIGHT connection.
  if (secretRow.providerIntegrationId) {
    return vaultDelegatedHandler({
      input,
      tool,
      vaultId,
      secretRow: {
        ...secretRow,
        providerIntegrationId: secretRow.providerIntegrationId!,
        accountHint: secretRow.accountHint ?? null,
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

  // POD-WIDE bypass (0211): a pod-wide connection is a SHARED vault key any member
  // may use for this capability WITHOUT holding a per-user vault grant — it is
  // decrypted under the secret's owner. This removes ONLY the per-user vault-GRANT
  // requirement; the RUN is still governed by `gateCapabilityExecution` upstream in
  // `triggerProviderAction` (agent runs still route to propose/deny without an
  // approved capability + grant). VAULT ONLY: this path is reached only after the
  // provider-integration (Nango) delegation returned above, so the secret here is
  // always a direct vault key.
  const podWideBypass = secretRow.isPodWide === true;
  const ungated = callerIsOwner || podWideBypass;

  // (a) Resolve the credential. Owner / pod-wide → ungated. Delegated → grant-gated
  //     with a server-derived redeemer (atomic consume-after-decrypt inside resolver).
  let secret: string | null;
  try {
    secret = await resolveVaultSecret(
      vaultId,
      ownerUserId,
      field,
      ungated
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
  // SECURITY: spread caller-supplied custom headers FIRST so the fixed
  // Content-Type and the auth header set below always WIN — a custom header can
  // never override auth or the structural Content-Type.
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  // Inject the secret per config — header or query. Never logged.
  if (auth.in === "query") {
    url.searchParams.set(auth.name, `${auth.prefix}${secret}`);
  } else {
    headers[auth.name] = `${auth.prefix}${secret}`;
  }

  let res: Response;
  try {
    res = await safeExternalFetch(url.toString(), {
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

  if (res.ok) {
    return {
      success: true,
      status: res.status,
      headers: respHeaders,
      body: parsed,
    };
  }
  // Mirror nangoProxyEnvelope: a non-2xx must carry `errorCode` + a human
  // `error` message, not just `success: false` — otherwise the message the
  // provider actually sent back (e.g. Apify's "Invalid API token") is stuck
  // in `.body` and every caller up the chain (executeSingleCall's `message`
  // fallback, the CLI's `runResult.error ?? "Unknown error"`) has nothing to
  // show but "Unknown error".
  return {
    success: false,
    status: res.status,
    headers: respHeaders,
    body: parsed,
    errorCode: statusToErrorCode(res.status),
    error: extractProviderErrorMessage(res.status, parsed),
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
  // A runtime connection selector ALSO routes through the resolver (even for a
  // `static` tool) so an explicit 1-of-N pick can override the static credential.
  const hasConnectionSelector =
    !!input.connectionSelector &&
    (!!input.connectionSelector.connectionId ||
      !!input.connectionSelector.contextObjectId);
  // A selector that pins a Nango account resolves to the tool's own nango:// ref
  // PLUS an account hint (the chosen 1-of-N connection); thread it to the handler.
  let accountHintOverride: string | null = null;
  if ((tool.authBinding ?? "static") !== "static" || hasConnectionSelector) {
    try {
      const resolved = await resolveBoundCredentialRef(tool, {
        userId: input.userId,
        agentUserId: input.agentUserId ?? null,
        subjectId: input.subjectId ?? null,
        connectionSelector: input.connectionSelector ?? null,
      });
      credentialRef = resolved.ref;
      accountHintOverride = resolved.accountHint ?? null;
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
      // A workspace is NOT required — a null-workspace proposal routes to the
      // user's pod-wide review queue (workspace is an optional lens).
      const proposalWorkspaceId = input.workspaceId ?? null;
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
          // Persist the run-time connection pick so the approve replay resolves
          // the SAME credential the caller selected (else it silently falls back
          // to the capability's default connection).
          connectionSelector: input.connectionSelector ?? null,
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
    credentialRef === provider && accountHintOverride == null
      ? input
      : {
          ...input,
          provider: credentialRef,
          ...(accountHintOverride != null
            ? { accountHint: accountHintOverride }
            : {}),
        };
  const result = await handler({ input: dispatchInput, tool });

  // P1 — stamp the structured failure scalars at the SINGLE dispatcher exit, from
  // data already in scope: the classifier maps the result's own {status, error,
  // errorCode}; providerRef is the tool's providerConfigKey (else the scheme-
  // stripped credentialRef). One place, so every scheme handler's failure return
  // (nango/vault/mcp) carries them without touching each of its ~25 return sites.
  if (!result.success) {
    if (result.errorClass === undefined) {
      result.errorClass = classifyDispatchFailure({
        status: result.status,
        message: result.error,
        errorCode: result.errorCode,
      });
    }
    if (result.providerRef === undefined) {
      const cfgKey = (tool.config as Record<string, unknown> | null | undefined)
        ?.providerConfigKey;
      result.providerRef =
        typeof cfgKey === "string" && cfgKey
          ? cfgKey
          : credentialRef.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "") || undefined;
    }
  }

  // W-B1 — mirror this call's AUTH outcome onto the connection-health store so the
  // catalog's "connected" means USABLE. Only auth-class failures move the counter
  // (a provider/transient 500 is not a credential problem); a success clears it.
  // Fire-and-forget: health is eventually-consistent and must not add latency.
  if (result.connectionId) {
    if (result.success) {
      void mirrorConnectionAuthOutcome(result.connectionId, "ok");
    } else if (result.errorClass === "auth") {
      void mirrorConnectionAuthOutcome(result.connectionId, "auth_fail");
    }
  }

  // Universal-sink audit append (this wave): every actually-dispatched provider
  // call (nango/vault/mcp — covers Nango-backed connectors, direct API-key
  // providers, and MCP tool calls alike) that REACHED the external system
  // leaves a `{scheme}.action.completed` event, closing the gap where a
  // provider send/proxy call was unresolvable by `diagnose`. Only a
  // successful call is audited here — a failed call never left the pod state
  // this wave is closing (the caller's own error path is unchanged).
  // audit is best-effort: append failure is logged, never fails a completed send
  // (see `recordExternalAction`'s docstring).
  if (result.success) {
    const correlationId = randomUUID();
    try {
      await recordExternalAction({
        channel: scheme,
        action: "action",
        userId: input.userId,
        workspaceId: input.workspaceId ?? null,
        agentUserId: input.agentUserId ?? null,
        correlationId,
        target: `${provider} ${input.method} ${input.path}`,
        status: "sent",
        data: {
          provider,
          tool: tool.name,
          method: input.method,
          path: input.path,
          status: result.status,
          sourceProposalId: input.sourceProposalId ?? null,
        },
      });
    } catch (err) {
      logger.error(
        {
          err,
          channel: scheme,
          action: "action",
          correlationId,
          provider,
          tool: tool.name,
        },
        "recordExternalAction failed after a completed triggerProviderAction — audit row missing, send was NOT retried"
      );
    }
    return { ...result, correlationId };
  }
  return result;
}
