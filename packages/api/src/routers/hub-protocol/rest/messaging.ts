/**
 * Hub Protocol REST — messaging
 *
 * Provider-agnostic messaging connector routes (Unipile-backed).
 *
 * Architecture:
 *   External channels (channelType="external") are the canonical link between
 *   a CRM entity and an external conversation thread. Each external channel
 *   stores: externalSource (provider), externalChannelId (Unipile chat ID),
 *   and metadata.accountId (which messaging_accounts row owns the thread).
 *
 *   Multi-user access: when the current user has their own account for the
 *   same provider they can reply; otherwise they get read-only view through
 *   the channel owner's account.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { sql as drizzleSql, desc } from "drizzle-orm";
import {
  db,
  eq,
  and,
  isNull,
  messagingAccounts,
  channels,
  entities,
  ChannelType,
  ensureExternalChannel,
  getRequestGrant,
} from "@synap/database";
import {
  hasScope,
  resolveActingContext,
  httpStatusForTrpcError,
} from "./_shared.js";
import type { MessagingAccount as DbMessagingAccount } from "@synap/database";

import { getMessagingConnector } from "../../../connectors/index.js";
import {
  describeMessagingService,
  UNIPILE_NOT_CONFIGURED_MESSAGE,
} from "../../../connectors/unipile-connection.js";
import { sendExternalMessage } from "../../../connectors/external-dispatch.js";
import { landInboundMessage } from "../../../services/connectors/land-inbound-message.js";
import {
  findOwnMessagingAccount,
  queueOwnerHistoryImport,
} from "../../../services/connectors/owner-history-import.js";
import { recordChannelOrigin } from "../../../services/channels/channel-origin.js";
import { ErrorSchema, trpcErrorResponses } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { logger, type HubHono, type HubVariables } from "./_shared.js";
import { isFencedGrant } from "../../../access/grant-door-fence.js";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../../utils/permission-check.js";
import type { Context } from "hono";
import {
  canUserSeeChannel,
  channelVisibilityWhere,
} from "../../../utils/channel-visibility.js";
import {
  deleteLinkedExternalChannel,
  disconnectOwnMessagingAccount,
  findVisibleLinkedExternalChannel,
} from "../../../services/connectors/owner-messaging-writes.js";
import { isUuid } from "@synap-core/types/property-render";
import { jsonGoverned } from "../proposal-response.js";

/**
 * The pod has no messaging service: the "Unipile — Messaging & LinkedIn"
 * capability (`unipile-linkedin`) is not installed, or holds no v2 API key
 * (`connectors/unipile-connection.ts`). That is a configuration state, not an
 * outage: a retry never changes it, so it is a 409 with a code, never a 503 (a
 * 5xx body is redacted before egress, which left apps unable to tell it from a
 * failed live read and telling people to try again). Set it up by installing
 * the capability and connecting the key.
 */
const MESSAGING_NOT_CONFIGURED_DESCRIPTION =
  "No messaging service is set up on this pod (code MESSAGING_NOT_CONFIGURED)";
const MessagingNotConfiguredSchema = z
  .object({
    error: z.string(),
    code: z.literal("MESSAGING_NOT_CONFIGURED"),
  })
  .openapi("MessagingNotConfigured");
function messagingNotConfigured(c: Context) {
  return c.json(
    {
      error: UNIPILE_NOT_CONFIGURED_MESSAGE,
      code: "MESSAGING_NOT_CONFIGURED" as const,
    },
    409
  );
}
import { accessScopeWhere } from "../../../utils/project-scope.js";

// ── Shared response schemas ────────────────────────────────────────────────

const MessagingAccountSchema = z
  .object({
    id: z.string(),
    externalId: z.string(),
    provider: z.string(),
    displayName: z.string(),
    status: z.enum(["connected", "reconnection_required", "disconnected"]),
  })
  .openapi("MessagingAccount");

const LinkedConversationSchema = z
  .object({
    channelId: z.string(),
    externalThreadId: z.string(),
    provider: z.string(),
    participantName: z.string(),
    participantExternalId: z.string(),
    lastMessageAt: z.string(),
    lastMessagePreview: z.string(),
    unread: z.boolean(),
    accountId: z.string(),
    readOnly: z.boolean(),
  })
  .openapi("LinkedConversation");

const BrowseConversationSchema = z
  .object({
    externalThreadId: z.string(),
    provider: z.string(),
    participantName: z.string(),
    participantExternalId: z.string(),
    lastMessageAt: z.string(),
    lastMessagePreview: z.string(),
    unread: z.boolean(),
    accountId: z.string(),
    accountDisplayName: z.string(),
  })
  .openapi("BrowseConversation");

const MessageSchema = z
  .object({
    externalMessageId: z.string(),
    threadId: z.string(),
    senderName: z.string(),
    body: z.string(),
    sentAt: z.string(),
    direction: z.enum(["inbound", "outbound"]),
    attachments: z
      .array(z.object({ name: z.string(), url: z.string() }))
      .optional(),
  })
  .openapi("MessagingMessage");

/** A governed messaging write an agent asked for: proposed, not done. */
const GovernedProposedSchema = z
  .object({
    status: z.literal("proposed"),
    proposalId: z.string(),
    reviewUrl: z.string().optional(),
    message: z.string(),
  })
  .openapi("MessagingWriteProposed");

// ── Helpers ────────────────────────────────────────────────────────────────

type ChannelMetadata = {
  accountId?: string;
  participantName?: string;
  linkedByUserId?: string;
  // Cached by webhook handler on every inbound message (avoids Unipile calls in linked-unread)
  lastMessageAt?: string;
  lastMessagePreview?: string;
  unread?: boolean;
};

// ── POST /messaging/inbound — provider-agnostic inbound sensor door ─────────
// The ONE generic door external bridges (Discord, Proton, future connectors)
// POST an inbound message to. Scope-gated `hub-protocol.write`, NON-governed
// (a sensor write — never routed through channel.ingest / capabilities.execute,
// which would turn each message into an unapprovable proposal). Delegates the
// subject-fold + email-identity-resolve + dedup-record to `landInboundMessage`.
const MessagingInboundRequestSchema = z
  .object({
    provider: z.string().min(1),
    // Empty allowed: a subject-only or attachment-only message is valid; the
    // refine below rejects a wholly empty (no text AND no subject) inbound.
    text: z.string().max(50_000).optional().default(""),
    messageId: z.string().min(1),
    // Channel key. When absent, participantEmail is resolved to one.
    externalId: z.string().min(1).optional(),
    participantEmail: z.string().email().optional(),
    participant: z.string().min(1).optional(),
    participantExternalId: z.string().min(1).optional(),
    subject: z.string().max(2_000).optional(),
    sentAt: z.string().optional(),
    workspaceId: z.string().uuid().optional(),
    // Cross-cutting project lens (independent of workspace). Absent → not
    // project-scoped; absent workspace too → pod-wide.
    projectId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    // Inbound attachments (mirrors the Discord {type,url,name?} shape). Fetched
    // OFF the request path (background job) → stored via the governed file door →
    // linked to the channel + message. Bounded to 8. Stays out of the message
    // idempotency/tamper hash (metadata-only).
    attachments: z
      .array(
        z.object({
          type: z.string().min(1),
          url: z.string().url(),
          name: z.string().optional(),
        })
      )
      .max(8)
      .optional(),
    // RFC reply-threading headers (email) — carried + stored under
    // metadata.emailHeaders so the send side can thread by Message-Id /
    // In-Reply-To / References. No threading logic here.
    headerMessageId: z.string().max(998).optional(),
    inReplyTo: z.string().max(998).optional(),
    references: z.array(z.string().max(998)).max(50).optional(),
  })
  .refine((d) => Boolean(d.externalId || d.participantEmail), {
    message: "externalId or participantEmail is required",
  })
  .refine((d) => Boolean((d.text && d.text.trim()) || d.subject), {
    message: "text or subject required",
  })
  .openapi("MessagingInboundRequest");

const MessagingInboundResponseSchema = z
  .object({
    recorded: z.boolean(),
    channelId: z.string(),
    deduped: z.boolean(),
  })
  .openapi("MessagingInboundResponse");

/**
 * Every messaging write needs `hub-protocol.write`. These doors send external
 * messages, overwrite the connector credentials, delete accounts and channels —
 * a read-only key reached all of them (only `/messaging/inbound` checked).
 */
function writeScopeDenied(
  c: Context<{ Variables: HubVariables }>
): Response | null {
  if (hasScope(c.get("scopes") as string[], "hub-protocol.write")) return null;
  return c.json(
    { error: "Insufficient scope: hub-protocol.write required" },
    403
  );
}

export function registerMessagingRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/messaging/inbound",
    tags: ["Messaging"],
    summary: "Land a provider-agnostic inbound message into the pod",
    description:
      "Provider-agnostic inbound sensor door. Resolves-or-creates the EXTERNAL " +
      "channel and dedup-records the inbound message (folding a subject line into " +
      "the body and resolving a participant email to an existing entity when no " +
      "externalId is given), then fires external_message.received. NON-governed " +
      "(a sensor write). Used by external bridges (Discord, Proton, …).",
    request: { body: MessagingInboundRequestSchema },
    responses: {
      200: {
        description: "Record result",
        schema: MessagingInboundResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/messaging/inbound", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    let body: z.infer<typeof MessagingInboundRequestSchema>;
    try {
      body = MessagingInboundRequestSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid request body" },
        400
      );
    }

    // Resolve the acting identity + workspace via the SAME door the discord
    // route uses (service key may act-as body.userId; workspace membership-checked).
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: body.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const { recorded, channelId, deduped } = await landInboundMessage({
        provider: body.provider,
        text: body.text,
        messageId: body.messageId,
        externalId: body.externalId,
        participantEmail: body.participantEmail,
        participant: body.participant,
        participantExternalId: body.participantExternalId,
        subject: body.subject,
        sentAt: body.sentAt,
        workspaceId: acting.workspaceId,
        projectId: body.projectId,
        userId: acting.userId,
        attachments: body.attachments,
        headerMessageId: body.headerMessageId,
        inReplyTo: body.inReplyTo,
        references: body.references,
      });
      return c.json({ recorded, channelId, deduped }, 200);
    } catch (err) {
      logger.error(
        { err, provider: body.provider },
        "POST /messaging/inbound failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  // ── GET /messaging/accounts ───────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/accounts",
      tags: ["Messaging"],
      summary: "List connected messaging accounts for the current user",
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "List of connected accounts",
          content: {
            "application/json": { schema: z.array(MessagingAccountSchema) },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        409: {
          description: MESSAGING_NOT_CONFIGURED_DESCRIPTION,
          content: {
            "application/json": { schema: MessagingNotConfiguredSchema },
          },
        },
        503: {
          description:
            "Your accounts' live status could not be read from the messaging service",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector) return messagingNotConfigured(c);
      const userId = c.get("userId") as string;
      try {
        let dbAccounts = await db.query.messagingAccounts.findMany({
          where: eq(messagingAccounts.userId, userId),
        });
        // A failed live read is an error, never the stored rows: those carry
        // the LAST known status, and "connected" from a dead read is the
        // calm, wrong answer an app would act on (task 23d9915a).
        const liveAccounts = await connector
          .getAccounts(userId)
          .catch((err: unknown) => {
            logger.warn(
              { err, userId },
              "GET /messaging/accounts: live read failed"
            );
            return null;
          });
        if (!liveAccounts) {
          return c.json(
            {
              error:
                "Could not read your accounts' status from the messaging service. Try again.",
            },
            503
          );
        }

        const liveByExternalId = new Map(
          liveAccounts.map((a) => [a.externalId, a])
        );
        // Auto-seed: when none of this user's rows is a live account (none
        // yet, or only rows of accounts the provider no longer has, e.g. a
        // retired v1 Unipile account), claim the live accounts no one else
        // holds.
        // write-gate: ungated by design — mirrors the provider's live account list into the caller's own rows (only accounts no one holds); no content, nothing a proposal could ask the person about.
        if (
          liveAccounts.length > 0 &&
          !dbAccounts.some((row) => liveByExternalId.has(row.externalId))
        ) {
          const held = new Set(
            (
              await db.query.messagingAccounts.findMany({
                columns: { externalId: true },
              })
            ).map((row) => row.externalId)
          );
          for (const account of liveAccounts) {
            if (held.has(account.externalId)) continue;
            await db
              .insert(messagingAccounts)
              .values({
                userId,
                provider: account.provider,
                externalId: account.externalId,
                displayName: account.displayName,
                status: account.status,
              })
              .onConflictDoNothing();
          }
          dbAccounts = await db.query.messagingAccounts.findMany({
            where: eq(messagingAccounts.userId, userId),
          });
        }

        // Unipile is the source of truth for live status.
        // Merge live status first, then filter — so a DB-"disconnected" row
        // that Unipile still has running gets revived rather than hidden, and
        // a row Unipile no longer lists (the read succeeded) is gone.
        const result = dbAccounts
          .map((row: DbMessagingAccount) => {
            const live = liveByExternalId.get(row.externalId);
            return {
              id: row.id,
              externalId: row.externalId,
              provider: row.provider,
              displayName: live?.displayName ?? row.displayName,
              status: (live?.status ?? "disconnected") as
                "connected" | "reconnection_required" | "disconnected",
            };
          })
          .filter((row) => row.status !== "disconnected");
        return c.json(result, 200);
      } catch (err) {
        logger.error({ err, userId }, "GET /messaging/accounts failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── GET /messaging/auth-url ───────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/auth-url",
      tags: ["Messaging"],
      summary: "Get hosted auth URL for connecting a new account",
      request: {
        query: z.object({
          redirectUrl: z.string(),
          provider: z.string().optional(),
        }),
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Auth URL",
          content: {
            "application/json": {
              schema: z.object({ url: z.string() }).openapi("MessagingAuthUrl"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        409: {
          description: MESSAGING_NOT_CONFIGURED_DESCRIPTION,
          content: {
            "application/json": { schema: MessagingNotConfiguredSchema },
          },
        },
      },
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector) return messagingNotConfigured(c);
      const userId = c.get("userId") as string;
      const { redirectUrl, provider } = c.req.valid("query");
      const providers = provider ? [provider] : undefined;
      try {
        const url = await connector.getAuthUrl(userId, redirectUrl, providers);
        return c.json({ url }, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        logger.error(
          { err, userId, message },
          "GET /messaging/auth-url failed"
        );
        c.header("Cache-Control", "no-store");
        return c.json({ error: message }, httpStatusForTrpcError(err)) as never;
      }
    }
  );

  // ── POST /messaging/accounts/sync ────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/messaging/accounts/sync",
      tags: ["Messaging"],
      summary: "Sync live accounts from the connector into the database",
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Sync result",
          content: {
            "application/json": {
              schema: z
                .object({ synced: z.number() })
                .openapi("MessagingAccountsSyncResult"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        409: {
          description: MESSAGING_NOT_CONFIGURED_DESCRIPTION,
          content: {
            "application/json": { schema: MessagingNotConfiguredSchema },
          },
        },
      },
    }),
    async (c) => {
      const denied = writeScopeDenied(c);
      if (denied) return denied as never;
      const connector = await getMessagingConnector();
      if (!connector) return messagingNotConfigured(c);
      const userId = c.get("userId") as string;
      try {
        const liveAccounts = await connector.getAccounts(userId);
        if (liveAccounts.length === 0) return c.json({ synced: 0 }, 200);

        // The provider lists every account of the pod's key, whoever connected
        // it (`getAccounts` ignores the user). An account another member holds
        // stays theirs: claiming it gave the caller a row to send and import
        // as that member (the same rule as the auto-seed in GET
        // /messaging/accounts).
        const heldByOthers = new Set(
          (
            await db.query.messagingAccounts.findMany({
              columns: { externalId: true, userId: true },
            })
          )
            .filter((row) => row.userId !== userId)
            .map((row) => row.externalId)
        );
        const mine = liveAccounts.filter(
          (account) => !heldByOthers.has(account.externalId)
        );

        // write-gate: ungated by design — mirrors the provider's status and name of the caller's own accounts into their rows and claims only accounts no one holds; no content, the GET above does the same on every read.
        for (const account of mine) {
          await db
            .insert(messagingAccounts)
            .values({
              userId,
              provider: account.provider,
              externalId: account.externalId,
              displayName: account.displayName,
              status: account.status,
            })
            .onConflictDoUpdate({
              target: [
                messagingAccounts.userId,
                messagingAccounts.provider,
                messagingAccounts.externalId,
              ],
              set: {
                displayName: drizzleSql`excluded.display_name`,
                status: drizzleSql`excluded.status`,
                updatedAt: new Date(),
              },
            });
        }

        // Ensure Unipile message-event webhooks are registered so inbound
        // messages reach our endpoint. Non-fatal: sync succeeds even if this fails.
        const publicUrl = process.env.PUBLIC_URL;
        if (publicUrl) {
          connector.ensureWebhooksRegistered(publicUrl).catch((err) => {
            logger.warn(
              { err },
              "POST /messaging/accounts/sync: webhook registration failed (non-fatal)"
            );
          });
        }

        return c.json({ synced: mine.length }, 200);
      } catch (err) {
        logger.error({ err, userId }, "POST /messaging/accounts/sync failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── GET /messaging/service-config ─────────────────────────────────────────
  // Whether the pod has a messaging service, and through which connection. The
  // ONE connection is the installed Unipile v2 capability: its key is set on
  // the capability, never here (there is no write door).
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/service-config",
      tags: ["Messaging"],
      summary: "Get the messaging service's connection state (no secret)",
      responses: {
        200: {
          description: "Connection state",
          content: {
            "application/json": {
              schema: z
                .object({
                  configured: z.boolean(),
                  capabilityKey: z.string(),
                  capabilityId: z.string().nullable(),
                  problem: z
                    .enum(["not-installed", "no-key", "unreadable"])
                    .nullable(),
                  message: z.string().nullable(),
                  // Whether inbound messages reach the pod: the last
                  // `messaging-webhook-ensure` check (hourly, after boot, on
                  // a new account). checkedAt null = not checked yet.
                  webhook: z
                    .object({
                      state: z.enum([
                        "registered",
                        "missing",
                        "missing-events",
                        "no-public-url",
                        "unknown",
                      ]),
                      url: z.string().nullable(),
                      missingEvents: z.array(z.string()),
                      error: z.string().nullable(),
                      checkedAt: z.string().nullable(),
                    })
                    .openapi("MessagingWebhookState"),
                })
                .openapi("MessagingServiceConfig"),
            },
          },
        },
      },
    }),
    async (c) => c.json(await describeMessagingService(), 200)
  );

  // ── POST /messaging/accounts/:accountId/import-history ────────────────────
  // The owner asks for an account's past conversations with the people
  // already in the pod, landed silently in their channels (the
  // `messaging-history-import` job; it also runs when an account connects).
  // An agent ASKS (founder, 2026-11-03): its call passes the gate
  // (`messaging/import_history`, disruptive) and becomes a proposal the
  // person approves; approving queues the import as them
  // (`proposals/executors/messaging.ts`). A narrowed key that is not an
  // agent's is refused: no grant narrows what the import reads.
  app.openapi(
    createRoute({
      method: "post",
      path: "/messaging/accounts/{accountId}/import-history",
      tags: ["Messaging"],
      summary:
        "Import an account's history with people already in the pod (an agent's call becomes a proposal)",
      request: {
        params: z.object({ accountId: z.string() }),
      },
      responses: {
        ...trpcErrorResponses,
        202: {
          description:
            "Import queued — or, for an agent, proposed for the person's review (`{ status: 'proposed', proposalId, reviewUrl }`)",
          content: {
            "application/json": {
              schema: z.union([
                z
                  .object({
                    queued: z.boolean(),
                    accountId: z.string(),
                    /** The last run's progress, when one ran. */
                    progress: z
                      .object({
                        status: z.enum(["running", "paused", "done"]),
                        cursor: z.string().nullable(),
                        updatedAt: z.string(),
                        chatsImported: z.number(),
                        messagesRecorded: z.number(),
                        reason: z.string().optional(),
                      })
                      .nullable(),
                  })
                  .openapi("MessagingImportHistoryResult"),
                z
                  .object({
                    status: z.literal("proposed"),
                    proposalId: z.string(),
                    reviewUrl: z.string().optional(),
                    message: z.string(),
                    accountId: z.string(),
                  })
                  .openapi("MessagingImportHistoryProposed"),
              ]),
            },
          },
        },
        403: {
          description:
            "Refused by the key's grant or the review rules, or a narrowed key that is not an agent's",
          content: { "application/json": { schema: ErrorSchema } },
        },
        404: {
          description: "No such account",
          content: { "application/json": { schema: ErrorSchema } },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const denied = writeScopeDenied(c);
      if (denied) return denied as never;
      const agentUserId = c.get("agentUserId") as string | undefined;
      // A narrowed key that is not an agent's cannot ask: the import reads
      // every conversation of the account, which no space, project or kind
      // limit narrows, and only an agent's ask becomes a proposal.
      if (!agentUserId && isFencedGrant(getRequestGrant())) {
        return c.json(
          {
            error:
              "Importing an account's history reads every conversation of it, so a key limited to a space, project or kind cannot run it. Ask through your agent: it files a proposal you approve.",
            code: "GRANT_DOOR_UNSUPPORTED",
          },
          403
        ) as never;
      }
      const userId = c.get("userId") as string;
      const { accountId } = c.req.valid("param");
      const row = await findOwnMessagingAccount(userId, accountId);
      if (!row) return c.json({ error: "Account not found" }, 404);
      try {
        // The gate decides for every caller: a person imports directly; an
        // agent's ask is a proposal by default (disruptive door), and one its
        // key's grant does not name is still filed for the person's approval
        // (`proposeBeyondGrant`, founder 2026-11-03: "it creates a proposal"),
        // never run on its own.
        const perm = await checkPermissionOrPropose({
          userId,
          agentUserId,
          workspaceId: null,
          subjectType: "messaging",
          action: "import_history",
          proposeBeyondGrant: true,
          reasoning:
            "Import this account's past conversations with people already in the pod into their channels, within the daily lookup budget. No one new is created.",
          data: {
            id: row.id,
            accountId: row.id,
            provider: row.provider,
            name: row.displayName || row.provider,
          },
        });
        if ("denied" in perm && perm.denied) {
          return c.json({ error: perm.reason ?? "Not permitted" }, 403);
        }
        if ("proposalId" in perm && perm.proposalId) {
          return jsonGoverned(c, {
            status: "proposed" as const,
            proposalId: perm.proposalId,
            reviewUrl: perm.reviewUrl,
            // A workspace-join gate files a join INSTEAD of the import: the
            // sentence is derived from the proposal's type, never assumed.
            message: proposedMessageFor(
              perm.proposalType,
              "History import proposed: it runs once the account's owner approves it."
            ),
            accountId: row.id,
            // The route answers 202 on both paths: jsonGoverned's 200 branch
            // (a non-proposed body) is never taken here.
          }) as never;
        }
        return c.json(await queueOwnerHistoryImport(userId, row), 202);
      } catch (err) {
        logger.error(
          { err, accountId },
          "POST /messaging/accounts/:accountId/import-history failed"
        );
        return c.json(
          { error: "The import could not be queued" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── DELETE /messaging/accounts/:accountId ─────────────────────────────────
  // Disconnects the person's account at the provider: reconnecting needs their
  // own login, so an agent ASKS (2026-11-04, finding 6a6bcb5f): its call passes
  // the gate (`messaging/delete_account`, a destructive verb) and becomes a
  // proposal the person approves (`proposals/executors/messaging.ts`). A
  // person disconnects directly, as before. The fence keeps the route
  // owner-wide (an unbounded key only).
  app.openapi(
    createRoute({
      method: "delete",
      path: "/messaging/accounts/{accountId}",
      tags: ["Messaging"],
      summary:
        "Disconnect a messaging account (an agent's call becomes a proposal)",
      request: {
        params: z.object({ accountId: z.string() }),
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Account disconnected",
          content: {
            "application/json": {
              schema: z
                .object({ success: z.boolean() })
                .openapi("MessagingDeleteResult"),
            },
          },
        },
        202: {
          description:
            "An agent's call, proposed for the person's review (`{ status: 'proposed', proposalId, reviewUrl }`)",
          content: {
            "application/json": { schema: GovernedProposedSchema },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        409: {
          description: MESSAGING_NOT_CONFIGURED_DESCRIPTION,
          content: {
            "application/json": { schema: MessagingNotConfiguredSchema },
          },
        },
      },
    }),
    async (c) => {
      const denied = writeScopeDenied(c);
      if (denied) return denied as never;
      const connector = await getMessagingConnector();
      if (!connector) return messagingNotConfigured(c);
      const userId = c.get("userId") as string;
      const { accountId } = c.req.valid("param");
      try {
        // Look up the externalId before deleting the DB row
        const row = await db.query.messagingAccounts.findFirst({
          where: and(
            eq(messagingAccounts.id, accountId),
            eq(messagingAccounts.userId, userId)
          ),
        });

        if (!row) return c.json({ success: true }, 200);

        // The gate decides for every caller: a person disconnects directly;
        // an agent's ask is always a proposal (`delete` is a destructive verb).
        const perm = await checkPermissionOrPropose({
          userId,
          agentUserId: c.get("agentUserId") as string | undefined,
          workspaceId: null,
          subjectType: "messaging",
          action: "delete_account",
          reasoning:
            "Disconnect this messaging account: it is removed at the provider, and reconnecting it needs the owner's own login.",
          data: {
            id: row.id,
            accountId: row.id,
            provider: row.provider,
            name: row.displayName || row.provider,
          },
        });
        if ("denied" in perm && perm.denied) {
          return c.json({ error: perm.reason ?? "Not permitted" }, 403);
        }
        if ("proposalId" in perm && perm.proposalId) {
          return jsonGoverned(c, {
            status: "proposed" as const,
            proposalId: perm.proposalId,
            reviewUrl: perm.reviewUrl,
            message: proposedMessageFor(
              perm.proposalType,
              "Disconnecting this account was proposed: it happens once its owner approves it."
            ),
          }) as never;
        }

        await disconnectOwnMessagingAccount(connector, row);
        return c.json({ success: true }, 200);
      } catch (err) {
        logger.error(
          { err, accountId },
          "DELETE /messaging/accounts/:accountId failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── GET /messaging/conversations ──────────────────────────────────────────
  // When entityId is provided: returns conversations linked to that entity
  //   via EXTERNAL channels (with readOnly flag for cross-user access).
  // When entityId is omitted: browse mode — all conversations from the
  //   current user's connected accounts (for use in the link picker).
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/conversations",
      tags: ["Messaging"],
      summary: "List conversations — entity-linked or browse mode",
      request: {
        query: z.object({
          entityId: z.string().optional(),
          // Legacy param — treated as entityId alias
          contactEntityId: z.string().optional(),
        }),
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Conversations",
          content: {
            "application/json": {
              schema: z
                .object({
                  conversations: z.array(
                    z.union([
                      LinkedConversationSchema,
                      BrowseConversationSchema,
                    ])
                  ),
                })
                .openapi("ConversationsResult"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        409: {
          description: MESSAGING_NOT_CONFIGURED_DESCRIPTION,
          content: {
            "application/json": { schema: MessagingNotConfiguredSchema },
          },
        },
      },
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector) return messagingNotConfigured(c);
      const userId = c.get("userId") as string;
      const { entityId, contactEntityId } = c.req.valid("query");
      const resolvedEntityId = entityId ?? contactEntityId;

      try {
        // ── Entity mode: return conversations linked via EXTERNAL channels ──
        if (resolvedEntityId) {
          // SECURITY — floor the resolved entity by the caller's read
          // visibility before using it as a channel filter. Without this, a
          // caller could pass any entityId and enumerate the conversations
          // linked to another user's entity. Invisible entity → no match.
          const visibleEntity = await db.query.entities.findFirst({
            where: and(
              eq(entities.id, resolvedEntityId),
              isNull(entities.deletedAt),
              // `entities` is ownerPrivate — floor on the entity READ scope so a
              // caller can't pass a NULL-workspace entity id owned by another
              // user and enumerate its linked conversations. Mirrors entities.list.
              accessScopeWhere({
                workspaceIdColumn: entities.workspaceId,
                entityIdColumn: entities.id,
                ownerColumn: entities.userId,
                userId,
                facetLens: true,
              })
            ),
            columns: { id: true },
          });
          if (!visibleEntity) {
            return c.json({ conversations: [] }, 200);
          }

          const entityChannels = await db.query.channels.findMany({
            where: and(
              eq(channels.channelType, ChannelType.EXTERNAL),
              eq(channels.contextObjectType, "entity"),
              eq(channels.contextObjectId as any, resolvedEntityId)
            ),
          });

          // Current user's accounts by provider for readOnly check
          const userAccounts = await db.query.messagingAccounts.findMany({
            where: and(
              eq(messagingAccounts.userId, userId),
              eq(messagingAccounts.status, "connected")
            ),
          });
          const userAccountByProvider = new Map(
            userAccounts.map((a) => [a.provider, a])
          );

          // Build per-channel metadata; determine effective account per channel
          type ConvSummary = {
            externalThreadId: string;
            participantName: string;
            participantExternalId: string;
            lastMessageAt: string;
            lastMessagePreview: string;
            unread: boolean;
          };
          type Entry = {
            ch: (typeof entityChannels)[0];
            meta: ChannelMetadata;
            provider: string;
            effectiveAccountId: string;
            readOnly: boolean;
          };
          const entries: Entry[] = entityChannels.map((ch) => {
            const meta = (ch.metadata ?? {}) as ChannelMetadata;
            const provider = ch.externalSource ?? "";
            const ownAccount = userAccountByProvider.get(provider);
            const effectiveAccountId =
              ownAccount?.externalId ?? meta.accountId ?? "";
            return {
              ch,
              meta,
              provider,
              effectiveAccountId,
              readOnly: !ownAccount,
            };
          });

          // Batch: fetch conversations once per unique effective account
          const uniqueAccountIds = [
            ...new Set(
              entries.map((e) => e.effectiveAccountId).filter(Boolean)
            ),
          ];
          const convCache = new Map<string, ConvSummary[]>();
          await Promise.all(
            uniqueAccountIds.map(async (accountId) => {
              try {
                const { items } = await connector.getConversations(accountId);
                convCache.set(accountId, items);
              } catch {
                convCache.set(accountId, []);
              }
            })
          );

          const results = entries.map(
            ({ ch, meta, provider, effectiveAccountId, readOnly }) => {
              const threadId = ch.externalChannelId ?? "";
              const match = (convCache.get(effectiveAccountId) ?? []).find(
                (i) => i.externalThreadId === threadId
              );
              return {
                channelId: ch.id,
                externalThreadId: threadId,
                provider,
                participantName:
                  match?.participantName ?? meta.participantName ?? "Unknown",
                participantExternalId: match?.participantExternalId ?? "",
                lastMessageAt: match?.lastMessageAt ?? new Date().toISOString(),
                lastMessagePreview: match?.lastMessagePreview ?? "",
                unread: match?.unread ?? false,
                accountId: effectiveAccountId,
                readOnly,
              };
            }
          );

          return c.json({ conversations: results }, 200);
        }

        // ── Browse mode: all conversations from current user's accounts ─────
        // Don't filter by DB status — Unipile is the source of truth for live
        // connection state. The /accounts endpoint merges live status before
        // displaying, so DB rows often lag. Unipile returns [] for dead accounts.
        const connectedAccounts = await db.query.messagingAccounts.findMany({
          where: eq(messagingAccounts.userId, userId),
        });

        const browse: Array<{
          externalThreadId: string;
          provider: string;
          participantName: string;
          participantExternalId: string;
          lastMessageAt: string;
          lastMessagePreview: string;
          unread: boolean;
          accountId: string;
          accountDisplayName: string;
        }> = [];

        await Promise.all(
          connectedAccounts.map(async (account: DbMessagingAccount) => {
            try {
              const { items } = await connector.getConversations(
                account.externalId
              );
              browse.push(
                ...items.map((i) => ({
                  ...i,
                  accountId: account.externalId,
                  accountDisplayName: account.displayName,
                }))
              );
            } catch (err) {
              logger.warn(
                { err, accountId: account.id },
                "getConversations failed for account"
              );
            }
          })
        );

        return c.json({ conversations: browse }, 200);
      } catch (err) {
        logger.error({ err, userId }, "GET /messaging/conversations failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── POST /messaging/channels/connect ─────────────────────────────────────
  // Creates or upgrades an EXTERNAL channel for an external conversation thread.
  //
  // entityId is OPTIONAL:
  //   - Provided  → link the thread to that entity (upgrade existing if needed)
  //   - Omitted   → "follow/track" mode: just ensure a Synap channel row exists
  //                  so inbound webhooks are captured and automations can fire.
  //
  // Dedup key: (channelType=EXTERNAL, externalId=externalThreadId).
  // If a row already exists (from a prior follow or webhook auto-create) it is
  // reused — never duplicated. If entityId is supplied and the row has no entity
  // yet, we upgrade it in-place rather than inserting a second row.
  app.openapi(
    createRoute({
      method: "post",
      path: "/messaging/channels/connect",
      tags: ["Messaging"],
      summary: "Track or link an external conversation thread",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  entityId: z.string().optional(),
                  externalThreadId: z.string(),
                  accountId: z.string(),
                  provider: z.string(),
                  participantName: z.string().optional(),
                })
                .openapi("ConnectChannelRequest"),
            },
          },
        },
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Channel created, upgraded, or already exists",
          content: {
            "application/json": {
              schema: z
                .object({ channelId: z.string() })
                .openapi("ConnectChannelResult"),
            },
          },
        },
        400: {
          description: "Account not found or not owned by current user",
          content: { "application/json": { schema: ErrorSchema } },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const denied = writeScopeDenied(c);
      if (denied) return denied as never;
      const userId = c.get("userId") as string;
      const {
        entityId,
        externalThreadId,
        accountId,
        provider,
        participantName,
      } = c.req.valid("json");

      try {
        // Verify the account belongs to the current user
        const account = await db.query.messagingAccounts.findFirst({
          where: and(
            eq(messagingAccounts.userId, userId),
            eq(messagingAccounts.externalId, accountId)
          ),
        });
        if (!account) {
          return c.json(
            { error: "Account not found or not owned by current user" },
            400
          );
        }

        // Resolve-or-create the external channel through the ONE race-safe door
        // (dedups on (externalSource, externalId), upgrades a NULL subject binding,
        // never repoints an already-linked channel). Replaces the hand-rolled 4th
        // copy of external resolve — and hardens the dedup key to include provider.
        const { channelId, created } = await ensureExternalChannel({
          provider,
          externalId: externalThreadId,
          userId,
          title: participantName ?? provider,
          contextObjectType: entityId ? "entity" : null,
          contextObjectId: entityId ?? null,
          metadata: {
            accountId: account.externalId,
            participantName: participantName ?? "",
            linkedByUserId: userId,
          },
        });
        // ORIGIN at birth — the messaging bridge has no registry row, so the
        // producer is the provider slug under the `source` kind. Stamped by the
        // CALLER because the @synap/database door can't reach `createLinks`.
        if (created) {
          await recordChannelOrigin({
            channelId,
            workspaceId: null,
            origin: {
              producerType: "source",
              producerId: provider,
              producerName: provider,
            },
          });
        }

        return c.json({ channelId }, 200);
      } catch (err) {
        logger.error(
          { err, userId, entityId, externalThreadId },
          "POST /messaging/channels/connect failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── DELETE /messaging/channels/:channelId ─────────────────────────────────
  // Unlinks an external channel from an entity: deletes the channel row and,
  // by cascade, every mirrored message. Only a channel the caller can see (the
  // channel floor every channel write door uses; it reached any member's
  // channel by id before). An agent ASKS (2026-11-04, finding 6a6bcb5f): its
  // call passes the gate (`channel/delete_external`, a destructive verb) and
  // becomes a proposal the person approves; a person unlinks directly.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/messaging/channels/{channelId}",
      tags: ["Messaging"],
      summary:
        "Unlink an external conversation from a CRM entity (an agent's call becomes a proposal)",
      request: {
        params: z.object({ channelId: z.string() }),
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Channel unlinked",
          content: {
            "application/json": {
              schema: z
                .object({ success: z.boolean() })
                .openapi("UnlinkChannelResult"),
            },
          },
        },
        202: {
          description:
            "An agent's call, proposed for the person's review (`{ status: 'proposed', proposalId, reviewUrl }`)",
          content: {
            "application/json": { schema: GovernedProposedSchema },
          },
        },
        404: {
          description: "Channel not found",
          content: { "application/json": { schema: ErrorSchema } },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const denied = writeScopeDenied(c);
      if (denied) return denied as never;
      const userId = c.get("userId") as string;
      const { channelId } = c.req.valid("param");
      if (!isUuid(channelId))
        return c.json({ error: "Channel not found" }, 404) as never;
      try {
        // 404 for a channel the caller cannot see: no existence oracle.
        const channel = await findVisibleLinkedExternalChannel(
          userId,
          channelId
        );
        if (!channel) return c.json({ error: "Channel not found" }, 404);

        const agentUserId = c.get("agentUserId") as string | undefined;
        const perm = await checkPermissionOrPropose({
          userId,
          agentUserId,
          workspaceId: channel.workspaceId,
          subjectType: "channel",
          action: "delete_external",
          // An agent's ask its key's grant does not name is still filed for
          // the person (as the history import's, founder 2026-11-03).
          proposeBeyondGrant: true,
          reasoning:
            "Unlink this external conversation from its record: the channel and the messages mirrored into it are deleted from the pod (the conversation stays at the provider).",
          data: { id: channel.id, channelId: channel.id },
        });
        if ("denied" in perm && perm.denied) {
          return c.json({ error: perm.reason ?? "Not permitted" }, 403);
        }
        if ("proposalId" in perm && perm.proposalId) {
          return jsonGoverned(c, {
            status: "proposed" as const,
            proposalId: perm.proposalId,
            reviewUrl: perm.reviewUrl,
            message: proposedMessageFor(
              perm.proposalType,
              "Unlinking this conversation was proposed: it happens once the person approves it."
            ),
          }) as never;
        }

        const deleted = await deleteLinkedExternalChannel(channel.id);
        if (!deleted) return c.json({ error: "Channel not found" }, 404);
        return c.json({ success: true }, 200);
      } catch (err) {
        logger.error(
          { err, userId, channelId },
          "DELETE /messaging/channels/:channelId failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── POST /messaging/channels/:channelId/mark-read ─────────────────────────
  // Clears the unread flag in channel metadata. Called when the user opens
  // a thread in CommunicationsTab. Keeps linked-unread count accurate.
  app.openapi(
    createRoute({
      method: "post",
      path: "/messaging/channels/{channelId}/mark-read",
      tags: ["Messaging"],
      summary: "Clear unread flag for a linked channel",
      request: { params: z.object({ channelId: z.string() }) },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Marked as read",
          content: {
            "application/json": {
              schema: z
                .object({ success: z.boolean() })
                .openapi("MarkReadResult"),
            },
          },
        },
        404: {
          description: "Channel not found",
          content: { "application/json": { schema: ErrorSchema } },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const denied = writeScopeDenied(c);
      if (denied) return denied as never;
      const userId = c.get("userId") as string;
      const { channelId } = c.req.valid("param");
      if (!isUuid(channelId))
        return c.json({ error: "Channel not found" }, 404) as never;
      try {
        // Only a channel the caller can see (it flipped any member's channel
        // by id before); 404, no existence oracle.
        if (!(await canUserSeeChannel(db, channelId, userId)))
          return c.json({ error: "Channel not found" }, 404);
        // write-gate: ungated by design — the caller's own read state of a conversation they can see (one flag, set again by the next inbound message); a proposal to mark a message read would ask the person nothing.
        const [updated] = await db
          .update(channels)
          .set({
            metadata: drizzleSql`${channels.metadata} || '{"unread":false}'::jsonb`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(channels.id as any, channelId),
              eq(channels.channelType, ChannelType.EXTERNAL)
            )
          )
          .returning({ id: channels.id });
        if (!updated) return c.json({ error: "Channel not found" }, 404);
        return c.json({ success: true }, 200);
      } catch (err) {
        logger.error(
          { err, channelId },
          "POST /messaging/channels/:channelId/mark-read failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── GET /messaging/linked-unread ─────────────────────────────────────────
  // Returns all unread conversations linked to entities via EXTERNAL channels.
  // Pure DB query using channel metadata cache — no Unipile calls.
  // Cache is updated by the webhook handler on every inbound message.
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/linked-unread",
      tags: ["Messaging"],
      summary: "All unread conversations linked to entities",
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Unread linked conversations",
          content: {
            "application/json": {
              schema: z
                .object({
                  items: z.array(
                    z
                      .object({
                        entityId: z.string(),
                        channelId: z.string(),
                        externalThreadId: z.string(),
                        provider: z.string(),
                        participantName: z.string(),
                        lastMessagePreview: z.string(),
                        lastMessageAt: z.string(),
                      })
                      .openapi("LinkedUnreadItem")
                  ),
                })
                .openapi("LinkedUnreadResult"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        409: {
          description: MESSAGING_NOT_CONFIGURED_DESCRIPTION,
          content: {
            "application/json": { schema: MessagingNotConfiguredSchema },
          },
        },
      },
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector) return messagingNotConfigured(c);
      const userId = c.get("userId") as string;

      try {
        const allLinked = await db.query.channels.findMany({
          where: and(
            eq(channels.channelType, ChannelType.EXTERNAL),
            eq(channels.contextObjectType, "entity"),
            // SECURITY — scope the scan to channels the caller can see instead
            // of a pod-wide read of every user's linked channels.
            channelVisibilityWhere(userId)
          ),
        });
        if (allLinked.length === 0) return c.json({ items: [] }, 200);

        const userAccounts = await db.query.messagingAccounts.findMany({
          where: and(
            eq(messagingAccounts.userId, userId),
            eq(messagingAccounts.status, "connected")
          ),
        });
        // The caller's OWN provider account ids — authorize each channel by an
        // exact `meta.accountId` ↔ own-`externalId` match, NOT a provider-string
        // match (which admitted any channel that merely carried an accountId,
        // including other users' linked channels).
        const ownExternalIds = new Set(userAccounts.map((a) => a.externalId));

        type ChEntry = {
          ch: (typeof allLinked)[0];
          meta: ChannelMetadata;
        };
        const entries: ChEntry[] = allLinked
          .map((ch) => ({
            ch,
            meta: (ch.metadata ?? {}) as ChannelMetadata,
          }))
          .filter((e) => {
            const accountId = e.meta.accountId ?? "";
            return accountId !== "" && ownExternalIds.has(accountId);
          });

        // Use channel metadata cache (populated by webhook handler on every inbound message).
        // No Unipile calls needed — O(1) DB query instead of O(N accounts) API calls.
        const items = entries
          .map(({ ch, meta }) => {
            if (!meta.unread) return null;
            return {
              entityId: (ch.contextObjectId ?? "") as string,
              channelId: ch.id,
              externalThreadId: ch.externalChannelId ?? "",
              provider: ch.externalSource ?? "",
              participantName: meta.participantName ?? "Unknown",
              lastMessagePreview: meta.lastMessagePreview ?? "",
              lastMessageAt: meta.lastMessageAt ?? new Date().toISOString(),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        return c.json({ items }, 200);
      } catch (err) {
        logger.error({ err, userId }, "GET /messaging/linked-unread failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── GET /messaging/conversations/:threadId/messages ───────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/conversations/{threadId}/messages",
      tags: ["Messaging"],
      summary: "Get messages in a conversation thread",
      request: {
        params: z.object({ threadId: z.string() }),
        query: z.object({ accountId: z.string() }),
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Messages",
          content: { "application/json": { schema: z.array(MessageSchema) } },
        },
        404: {
          description: "Account not found",
          content: { "application/json": { schema: ErrorSchema } },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        409: {
          description: MESSAGING_NOT_CONFIGURED_DESCRIPTION,
          content: {
            "application/json": { schema: MessagingNotConfiguredSchema },
          },
        },
      },
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector) return messagingNotConfigured(c);
      const userId = c.get("userId") as string;
      const { threadId } = c.req.valid("param");
      const { accountId } = c.req.valid("query");
      // SECURITY — verify the requested provider account belongs to the caller
      // before streaming its live messages. Without this, any caller could read
      // another user's conversation by passing that account's id (IDOR).
      const ownAccount = await db.query.messagingAccounts.findFirst({
        where: and(
          eq(messagingAccounts.userId, userId),
          eq(messagingAccounts.externalId, accountId)
        ),
        columns: { id: true },
      });
      if (!ownAccount) {
        return c.json({ error: "Account not found" }, 404);
      }
      try {
        const messages = await connector.getMessages(accountId, threadId);
        return c.json(messages, 200);
      } catch (err) {
        logger.error({ err, threadId, accountId }, "GET messages failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── POST /messaging/conversations/:threadId/send ──────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/messaging/conversations/{threadId}/send",
      tags: ["Messaging"],
      summary: "Send a message in a conversation thread",
      request: {
        params: z.object({ threadId: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ accountId: z.string(), body: z.string() })
                .openapi("SendMessageRequest"),
            },
          },
        },
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Message sent",
          content: {
            "application/json": {
              schema: z
                .object({ success: z.boolean() })
                .openapi("SendMessageResult"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
        409: {
          description: MESSAGING_NOT_CONFIGURED_DESCRIPTION,
          content: {
            "application/json": { schema: MessagingNotConfiguredSchema },
          },
        },
        503: {
          description:
            "The message could not be sent through the messaging service",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const denied = writeScopeDenied(c);
      if (denied) return denied as never;
      const userId = c.get("userId") as string;
      const { threadId } = c.req.valid("param");
      const { accountId, body } = c.req.valid("json");

      // Resolve the EXTERNAL channel first so we can route to the connector for
      // its provider (stalwart, gmail, …) rather than always the default.
      const linkedChannel = await db.query.channels.findFirst({
        where: and(
          eq(channels.channelType, ChannelType.EXTERNAL),
          eq(channels.externalId as any, threadId)
        ),
        columns: { id: true, externalSource: true, workspaceId: true },
      });
      // SECURITY — a thread the pod mirrors must be the caller's to write to
      // (the channel floor every channel write door uses). Without this an
      // account-less connector (Discord / Proton enqueue to their bridge and
      // ignore `accountId`) sent into ANY mirrored thread by id. A thread with
      // no mirrored channel is floored by the account check below. 404 — no
      // existence oracle.
      if (linkedChannel) {
        const [visible] = await db
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.id, linkedChannel.id),
              channelVisibilityWhere(userId)
            )
          )
          .limit(1);
        if (!visible)
          return c.json({ error: "Conversation not found" }, 404) as never;
      }

      const connector = await getMessagingConnector(
        linkedChannel?.externalSource ?? undefined
      );
      if (!connector) return messagingNotConfigured(c);
      // SECURITY — the caller must OWN the account it sends as. `accountId` is
      // the provider account (`messaging_accounts.external_id`) and went
      // straight to the connector: any write key could send as another user's
      // LinkedIn / WhatsApp / mail account. Same predicate as the sibling read
      // `GET .../messages`. A connector that sends as no account
      // (`requiresAccount()` false) ignores the id, so none is demanded.
      if (connector.requiresAccount()) {
        const ownAccount = await db.query.messagingAccounts.findFirst({
          where: and(
            eq(messagingAccounts.userId, userId),
            eq(messagingAccounts.externalId, accountId)
          ),
          columns: { id: true },
        });
        if (!ownAccount)
          return c.json({ error: "Account not found" }, 404) as never;
      }
      try {
        // Delegated to the shared dispatcher — one implementation, two doors
        // (human-direct here, agent-approved via proposals.ts). The acting
        // agent MUST travel: the dispatcher gates only an agent send
        // (`gateMessagingSend`), and this door used to drop it, so an agent
        // key's send went out as an ungoverned owner send. The dispatcher
        // also checks the key's grant (`messaging.send`) in the channel's
        // space, which is where a proposed send is filed.
        const agentUserId = c.get("agentUserId") as string | undefined;
        const result = await sendExternalMessage({
          threadId,
          accountId,
          body,
          userId,
          ...(agentUserId ? { agentUserId } : {}),
          workspaceId: linkedChannel?.workspaceId ?? null,
        });
        if (result.proposed && result.proposalId) {
          return jsonGoverned(c, {
            status: "proposed",
            proposalId: result.proposalId,
          }) as never;
        }
        if (!result.success) {
          // A refusal (the key's grant, or the gate's refusal of an agent
          // send: a reason, no failure class) says why; anything else keeps
          // the door's previous 503.
          return (
            result.error && !result.errorClass
              ? c.json({ error: result.error }, 403)
              : c.json(
                  {
                    error: result.error ?? "Messaging connector not configured",
                  },
                  503
                )
          ) as never;
        }
        return c.json({ success: true }, 200);
      } catch (err) {
        logger.error({ err, threadId, accountId }, "POST send failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── GET /messaging/channels ───────────────────────────────────────────────
  // DB-backed list of all EXTERNAL channels for the current user.
  // Returns threads stored from webhooks — no Unipile calls.
  // Used by the CRM Channels inbox page.
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/channels",
      tags: ["Messaging"],
      summary: "List all external channels (DB-backed inbox)",
      request: {
        query: z.object({
          provider: z.string().optional(),
          unreadOnly: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "External channels list",
          content: {
            "application/json": {
              schema: z
                .object({
                  channels: z.array(
                    z
                      .object({
                        channelId: z.string(),
                        provider: z.string(),
                        threadId: z.string(),
                        title: z.string(),
                        participantName: z.string(),
                        lastMessageAt: z.string(),
                        lastMessagePreview: z.string(),
                        unread: z.boolean(),
                        entityId: z.string().nullable(),
                        messageCount: z.number(),
                      })
                      .openapi("ExternalChannelItem")
                  ),
                })
                .openapi("ExternalChannelsResult"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId") as string;
      const { provider, unreadOnly } = c.req.valid("query");

      try {
        const rows = await db.query.channels.findMany({
          where: and(
            eq(channels.channelType, ChannelType.EXTERNAL),
            channelVisibilityWhere(userId),
            ...(provider ? [eq(channels.externalSource as any, provider)] : [])
          ),
          orderBy: [desc(channels.updatedAt)],
        });

        const result = rows
          .map((ch) => {
            const meta = (ch.metadata ?? {}) as ChannelMetadata;
            if (unreadOnly === "true" && !meta.unread) return null;
            return {
              channelId: ch.id,
              provider: ch.externalSource ?? "",
              threadId: ch.externalChannelId ?? "",
              title: ch.title ?? meta.participantName ?? "Unknown",
              participantName: meta.participantName ?? ch.title ?? "Unknown",
              lastMessageAt: meta.lastMessageAt ?? ch.updatedAt.toISOString(),
              lastMessagePreview: meta.lastMessagePreview ?? "",
              unread: meta.unread ?? false,
              entityId: ch.contextObjectId ?? null,
              messageCount: 0,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        return c.json({ channels: result }, 200);
      } catch (err) {
        logger.error({ err, userId }, "GET /messaging/channels failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );
}
