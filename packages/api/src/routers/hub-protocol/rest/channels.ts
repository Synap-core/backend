/**
 * Hub Protocol REST — channels (resolve channel by context, personal channel, AI trigger)
 */

import { z } from "@hono/zod-openapi";
import {
  db,
  agents,
  channels as channelsTable,
  entities as entitiesTable,
  messages as messagesTable,
  entityIdentitySignals,
  focusSessions,
  automations as automationsTable,
  playbooks as playbooksTable,
  eq,
  and,
  desc,
  isNull,
  inArray,
  max,
  drizzleSql,
  enqueueChannelEgress,
  setChannelBranchPurpose,
  getEffectiveFacets,
  ChannelFirewallImmutableError,
} from "@synap/database";
import { openLink } from "../../../utils/deep-links.js";
import { relationsRouter } from "../../relations.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { resolveFacetVisibilityScope } from "../../../utils/workspace-membership.js";
import {
  composeKnownUrls,
  pickClientStatus,
  pickGrantSubmissionStage,
  projectDealsFromConnections,
  type ConnectionLike,
} from "../../../utils/context-card.js";
// Note: channelsTable.externalId is the canonical dedup field — same as externalChannelId at insert time.

import { resolveOrCreateExternalChannel } from "../../../services/connectors/inbound-recorder.js";
import { channelVisibilityWhere } from "../../../utils/channel-visibility.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  ChannelByContextRequestSchema,
  ChannelByContextResponseSchema,
  PersonalChannelQuerySchema,
  TriggerAiRequestSchema,
  WireChannelSchema,
} from "./_codecs/channel.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getCaller,
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import {
  proposeChannelBind,
  derivePodWideBindWorkspace,
} from "../../../utils/propose-channel-bind.js";

/**
 * Shared gate for Discord channel write operations (rename, pin).
 *
 * Runs in order:
 *   1. hub-protocol.write scope check → 403
 *   2. Channel lookup by (externalSource=discord, externalId) → 404
 *   3. channel.workspaceId present → 403
 *   4. resolveActingContext on the loaded workspace → 400/403
 *
 * Returns `{ ok: true, workspaceId }` when all gates pass, or
 * `{ ok: false, status, body }` to return directly to the caller. The routes
 * then ENQUEUE an agnostic egress intent (the bridge delivers it); no Discord
 * call happens here, so there is no bot-token/connector-config gate anymore.
 *
 * The caller is responsible for the provider gate (discord-only guard)
 * BEFORE invoking this helper.
 */
async function resolveDiscordChannelForWrite(
  c: { get: (k: string) => unknown },
  externalChannelId: string,
  action: string
): Promise<
  | { ok: true; workspaceId: string }
  | { ok: false; status: number; body: { error: string } }
> {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return {
      ok: false,
      status: 403,
      body: { error: "Insufficient scope: hub-protocol.write required" },
    };
  }

  const channel = await db.query.channels.findFirst({
    where: and(
      eq(channelsTable.externalSource, "discord"),
      eq(channelsTable.externalId, externalChannelId)
    ),
  });
  if (!channel) {
    return {
      ok: false,
      status: 404,
      body: { error: `No discord channel with id ${externalChannelId}` },
    };
  }

  // Gate the WRITE on the loaded row's workspace (never request-supplied).
  // A null-workspace channel has no workspace to gate against — passing
  // `undefined` would let resolveActingContext fall back to the caller's
  // FIRST workspace and pass regardless of the channel. Refuse outright.
  if (!channel.workspaceId) {
    return {
      ok: false,
      status: 403,
      body: { error: `Channel has no workspace; ${action} not permitted` },
    };
  }

  const acting = await resolveActingContext(c, {
    workspaceId: channel.workspaceId,
  });
  if (!acting.ok) {
    return { ok: false, status: acting.status, body: { error: acting.error } };
  }

  return { ok: true, workspaceId: channel.workspaceId };
}

export function registerChannelsRoutes(app: HubHono): void {
  // ── GET /channels ────────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/channels",
    tags: ["Channels"],
    summary: "List channels",
    description:
      "Returns channels the authenticated user has access to. Supports optional workspace and type filters.",
    request: {
      query: z.object({
        userId: z.string().optional(),
        workspaceId: z.string().optional(),
        channelType: z.string().optional(),
        contextObjectId: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Channel list",
        schema: z.object({ channels: z.array(WireChannelSchema) }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/channels", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const q = c.req.query();
    // Pin to the authenticated owner — ignore any caller-supplied q.userId
    // (it let an agent key list another user's channels).
    const userId = c.get("userId") as string;
    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }
    const workspaceId = q.workspaceId;
    const limit = q.limit ? Math.min(parseInt(q.limit, 10), 100) : 20;
    try {
      // Canonical channel visibility — see utils/channel-visibility.ts.
      const conditions = [channelVisibilityWhere(userId)];
      if (workspaceId) {
        conditions.push(eq(channelsTable.workspaceId, workspaceId));
      }
      if (q.channelType) {
        conditions.push(eq(channelsTable.channelType, q.channelType as never));
      }
      if (q.contextObjectId) {
        conditions.push(eq(channelsTable.contextObjectId, q.contextObjectId));
      }
      // Direct lookup by external (provider) channel id — lets callers resolve a
      // bound channel without scanning the (capped) list. Without this, /whois
      // client-scans up to `limit` rows and silently misses channels on pods
      // with more than `limit` external channels.
      if (q.externalId) {
        conditions.push(eq(channelsTable.externalId, q.externalId));
      }
      if (q.externalSource) {
        conditions.push(
          eq(channelsTable.externalSource, q.externalSource as never)
        );
      }
      const rows = await db
        .select()
        .from(channelsTable)
        .where(and(...conditions))
        .orderBy(desc(channelsTable.updatedAt))
        .limit(limit);
      return c.json({ channels: rows });
    } catch (err) {
      logger.error({ err, userId, workspaceId }, "channels.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500
      );
    }
  });

  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/channels",
    tags: ["Channels"],
    summary: "Create-or-link an EXTERNAL channel bound to an entity",
    description:
      "Idempotent find-or-link of the canonical EXTERNAL channel for " +
      "(externalSource, externalChannelId). Creates the channel if absent and, " +
      "when contextObjectId is supplied, binds it to that entity (e.g. a client " +
      "person/client entity mirrored as a Discord channel). Reuses the shared " +
      "inbound-recorder upsert so it dedups on the (externalSource, externalId) " +
      "partial unique index.",
    request: {
      body: z.object({
        workspaceId: z.string().optional(),
        externalSource: z.string().min(1),
        externalChannelId: z.string().min(1),
        contextObjectId: z.string().optional(),
        contextObjectType: z
          .enum(["entity", "document", "view", "proposal"])
          .optional(),
        title: z.string().optional(),
        // Thread-as-child support: when this linked channel is a thread inside a
        // room, parentChannelId points at the room's Synap channel id and
        // branchPurpose distinguishes the threads (e.g. "client-comms" / "team").
        // Both absent → unchanged room behaviour.
        parentChannelId: z.string().optional(),
        branchPurpose: z.string().optional(),
        // Explicit user re-link (e.g. /link-client run again): when true, move the
        // channel to `workspaceId` and OVERWRITE its context binding even if it was
        // already set — so a channel created in the wrong workspace (or bound to a
        // stale/dangling entity) self-heals. Default false keeps the idempotent,
        // never-clobber behaviour for automatic callers.
        relink: z.boolean().optional(),
        // Free-form channel metadata, shallow-merged into channels.metadata jsonb.
        // The Telegram↔Discord bridge sends `guildId` (the Discord guild this
        // channel lives in) and `mirrors` ([{ source, chatId, title, username }] —
        // the OTHER messaging surface the same conversation is bridged to) so the
        // app can render one clickable icon per side of a mirrored channel.
        metadata: z.record(z.string(), z.any()).optional(),
      }),
    },
    responses: {
      200: {
        description: "Created-or-linked channel",
        schema: z.object({
          channelId: z.string(),
          created: z.boolean(),
          linked: z.boolean(),
          channel: WireChannelSchema,
        }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/channels/by-context",
    tags: ["Channels"],
    summary: "Find or create a channel by context object",
    description:
      "Resolves (or creates) the AI channel scoped to a specific entity, document, or view.",
    request: {
      body: ChannelByContextRequestSchema,
    },
    responses: {
      200: {
        description: "Resolved channel",
        schema: ChannelByContextResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/channels/personal",
    tags: ["Channels"],
    summary: "Get the user's personal channel",
    description:
      "Returns the per-(user, workspace) personal AI channel, scoped to the orchestrator agent.",
    request: {
      query: PersonalChannelQuerySchema,
    },
    responses: {
      200: { description: "Channel", schema: WireChannelSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Orchestrator agent not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/channels/trigger-ai",
    tags: ["Channels", "Agents"],
    summary: "Trigger an AI response in a channel",
    description:
      "Posts a system-prompt-overridden message into the channel and dispatches the AI to respond. Used by skill triggers and proactive entry points.",
    request: {
      body: TriggerAiRequestSchema,
    },
    responses: {
      200: {
        description: "Trigger result (varies by skill/agent)",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /channels/by-context
   */
  app.post("/channels/by-context", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    // Validate at the boundary (was a raw `as` cast). The schema rejects
    // contextObjectType "proposal" — an IDOR surface on this service-key door —
    // and any other unknown type, returning 400 instead of forwarding it.
    const parsed = ChannelByContextRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return c.json(
        {
          error:
            "userId, contextObjectId, and contextObjectType (entity|document|view) are required",
        },
        400
      );
    }
    const body = parsed.data;
    // Item 3 Part 3: positively pin a bound service key to its workspace
    // BEFORE it reaches resolveActingContext. A mismatching bound key throws
    // FORBIDDEN → surface 403, not a blanket 500.
    let clampedWorkspaceId: string | undefined;
    try {
      clampedWorkspaceId =
        getConfinedWorkspace(c, body.workspaceId) ?? undefined;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }
    // SECURITY — acting identity MUST come from the verified auth context,
    // never `body.userId` directly (governed-agent-write → ungoverned-
    // operator-write IDOR). Mirrors POST /profiles / POST /property-defs.
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      ...(clampedWorkspaceId ? { workspaceId: clampedWorkspaceId } : {}),
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const workspaceId = acting.workspaceId ?? undefined;
    try {
      const caller = await getCaller(c, {
        workspaceId,
        userId: acting.userId,
      });
      const result = await caller.channels.resolveOrCreateChannel({
        userId: acting.userId,
        workspaceId,
        channelType: "thread",
        contextObjectId: body.contextObjectId,
        contextObjectType: body.contextObjectType,
      });
      return c.json({
        channelId: result.channel.id,
        title: result.channel.title,
        created: true,
        channel: result.channel,
      });
    } catch (err) {
      logger.error({ err, body }, "channels/by-context failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /channels/personal?userId=...&workspaceId=...
   */
  app.get("/channels/personal", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const userId = c.req.query("userId");
    const workspaceId = c.req.query("workspaceId");
    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }
    try {
      const caller = await getCaller(c, { workspaceId, userId });
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
        .limit(1);
      if (!agent) {
        return c.json({ error: "Orchestrator agent not found" }, 404);
      }
      const result = await caller.channels.resolveOrCreateChannel({
        userId,
        workspaceId,
        channelType: "personal",
        agentId: agent.id,
      });
      return c.json(result?.channel);
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "channels.ensurePersonal failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500
      );
    }
  });

  /**
   * POST /channels/trigger-ai
   */
  app.post("/channels/trigger-ai", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = (await c.req.json()) as {
      channelId: string;
      userId: string;
      workspaceId: string;
      systemPromptOverride: string;
      skillId?: string;
      entityId?: string;
    };

    if (
      !body.channelId ||
      !body.systemPromptOverride ||
      !body.userId ||
      !body.workspaceId
    ) {
      return c.json(
        {
          error:
            "channelId, userId, workspaceId, and systemPromptOverride are required",
        },
        400
      );
    }

    // Item 3 Part 3: positively pin a bound service key to its workspace
    // BEFORE it reaches resolveActingContext. body.workspaceId is a required
    // non-null string here (guarded above). A mismatching bound key throws
    // FORBIDDEN → surface 403, not a blanket 500.
    let clampedWorkspaceId: string;
    try {
      clampedWorkspaceId = getConfinedWorkspace(c, body.workspaceId) as string;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }
    // SECURITY — acting identity MUST come from the verified auth context,
    // never `body.userId` directly (governed-agent-write → ungoverned-
    // operator-write IDOR). Mirrors POST /profiles / POST /property-defs.
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: clampedWorkspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    if (!acting.workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }
    const workspaceId = acting.workspaceId;
    try {
      const caller = await getCaller(c, {
        workspaceId,
        userId: acting.userId,
      });
      const result = await caller.channels.triggerAI({
        channelId: body.channelId,
        userId: acting.userId,
        workspaceId,
        systemPromptOverride: body.systemPromptOverride,
        skillId: body.skillId,
        entityId: body.entityId,
      });
      return c.json(result);
    } catch (err) {
      logger.error(
        { err, channelId: body.channelId },
        "channels.triggerAI failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500
      );
    }
  });

  // ── POST /channels/:externalChannelId/pins/:messageId ────────────────────
  // Static suffix (/pins/) disambiguates from a bare /:id route.
  registerOpenApi(app, {
    method: "post",
    path: "/channels/:externalChannelId/pins/:messageId",
    tags: ["Channels"],
    summary: "Pin a message in a Discord channel",
    description:
      "Resolves the EXTERNAL channel by (externalSource='discord', externalId=:externalChannelId) and ENQUEUES an agnostic `pin_message` egress intent; the bridge performs the Discord pin.",
    request: {},
    responses: {
      200: {
        description: "Queued",
        schema: z.object({ ok: z.literal(true), queued: z.literal(true) }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Channel not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/channels/:externalChannelId/pins/:messageId", async (c) => {
    const externalChannelId = c.req.param("externalChannelId");
    const messageId = c.req.param("messageId");

    // Validate path params — Discord IDs must be non-empty strings.
    if (!externalChannelId || !messageId) {
      return c.json(
        { error: "externalChannelId and messageId must be non-empty strings" },
        400
      );
    }

    // Run all shared gates (scope, connector config, channel lookup, workspace).
    const gate = await resolveDiscordChannelForWrite(
      c,
      externalChannelId,
      "pin"
    );
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    try {
      await enqueueChannelEgress({
        externalSource: "discord",
        externalId: externalChannelId,
        kind: "pin_message",
        payload: { messageId },
        workspaceId: gate.workspaceId,
      });
      return c.json({ ok: true as const, queued: true as const }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error(
        { err, externalChannelId, messageId },
        "POST /channels/:externalChannelId/pins/:messageId enqueue failed"
      );
      return c.json({ error: msg }, 500);
    }
  });

  // ── POST /channels/:externalChannelId/rename ─────────────────────────────
  // Static suffix (/rename) disambiguates from a bare /:id route.
  registerOpenApi(app, {
    method: "post",
    path: "/channels/:externalChannelId/rename",
    tags: ["Channels"],
    summary: "Rename a Discord channel",
    description:
      "Resolves the EXTERNAL channel by (externalSource=provider||'discord', externalId=:externalChannelId) and ENQUEUES an agnostic `rename_channel` egress intent; the bridge performs the Discord rename (rate-limited ~2 renames per 10 min per channel).",
    request: {
      body: z.object({
        name: z.string().min(1).max(100),
        provider: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Queued",
        schema: z.object({ ok: z.literal(true), queued: z.literal(true) }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Channel not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/channels/:externalChannelId/rename", async (c) => {
    const externalChannelId = c.req.param("externalChannelId");
    let body: { name: string; provider?: string };
    try {
      body = z
        .object({
          name: z.string().min(1).max(100),
          provider: z.string().optional(),
        })
        .parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid request body" },
        400
      );
    }

    const provider = body.provider ?? "discord";

    // Provider gate BEFORE any DB lookup — don't leak channel existence for
    // unsupported providers.
    if (provider !== "discord") {
      return c.json(
        { error: `renameChannel is only supported for provider 'discord'` },
        400
      );
    }

    // Run all shared gates (scope, connector config, channel lookup, workspace).
    const gate = await resolveDiscordChannelForWrite(
      c,
      externalChannelId,
      "rename"
    );
    if (!gate.ok) return c.json(gate.body, gate.status as never);

    try {
      await enqueueChannelEgress({
        externalSource: "discord",
        externalId: externalChannelId,
        kind: "rename_channel",
        payload: { name: body.name },
        workspaceId: gate.workspaceId,
      });
      return c.json({ ok: true as const, queued: true as const }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error(
        { err, externalChannelId },
        "POST /channels/:externalChannelId/rename enqueue failed"
      );
      return c.json({ error: msg }, 500);
    }
  });

  // ── POST /channels/:channelId/bind ───────────────────────────────────────
  // Governed PROPOSE door — the IS classify-and-propose target. Files a
  // `channel/bind` proposal (via the shared proposeChannelBind helper, the tRPC
  // bindChannel twin) that, on approval, points an EXISTING channel at a context
  // object and optionally stamps the firewall role. Keys on the SYNAP channel
  // UUID (NOT the external id). ALWAYS proposes unless "channel.bind" is opted
  // into autoApproveFor; branchPurpose is human-confirmed, never default-forced.
  const bindBodySchema = z.object({
    userId: z.string(),
    // Optional (pod-wide bridge model): omit for a pod-wide bind — the home
    // workspace is DERIVED from the bound entity's role (item 5). A bound
    // service key still confines to its workspace via getConfinedWorkspace.
    workspaceId: z.string().uuid().optional(),
    contextObjectId: z.string().uuid(),
    contextObjectType: z.enum(["entity", "document", "view"]).optional(),
    branchPurpose: z.string().max(500).optional(),
    externalChannelId: z.string().optional(),
    reasoning: z.string().optional(),
  });
  registerOpenApi(app, {
    method: "post",
    path: "/channels/:channelId/bind",
    tags: ["Channels"],
    summary: "Propose binding a channel to a context object",
    description:
      "Files a governed `channel/bind` proposal (subjectType 'channel', action 'bind'). On approval, points an EXISTING channel (by Synap channel UUID) at a context object — usually a client entity — and optionally stamps the firewall role (branchPurpose). ALWAYS proposes unless a workspace opted 'channel.bind' into autoApproveFor. branchPurpose is human-confirmed, never default-forced (client-comms is immutable once set).",
    request: { body: bindBodySchema },
    responses: {
      200: {
        description: "Proposed / approved / denied",
        schema: z.object({ status: z.string() }).passthrough(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/channels/:channelId/bind", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const channelId = c.req.param("channelId");
    if (!z.string().uuid().safeParse(channelId).success) {
      return c.json({ error: "channelId (path) must be a valid uuid" }, 400);
    }
    let body: z.infer<typeof bindBodySchema>;
    try {
      body = bindBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid request body" },
        400
      );
    }
    // Confine the workspace to the bound service key (Item 3 — mismatch → 403)
    // BEFORE it reaches resolveActingContext. Pod-wide bridge model: an UNBOUND
    // key with no explicit workspace resolves to null (pod-wide) — that is NOT
    // an error here; the home workspace is DERIVED from the bound entity below.
    let confined: string | null | undefined;
    try {
      confined = getConfinedWorkspace(c, body.workspaceId);
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN") {
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      }
      throw err;
    }
    // SECURITY — acting identity MUST come from the verified auth context,
    // never `body.userId` directly (governed-agent-write → ungoverned-
    // operator-write IDOR). Mirrors POST /profiles / POST /property-defs.
    // workspaceId may be null (pod-wide) — resolveActingContext allows it.
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      ...(confined ? { workspaceId: confined } : {}),
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    // ROUTING ⊥ BINDING (item 5): the channel binds to the ENTITY; the
    // governance/home workspace is DERIVED. When no workspace was supplied
    // (pod-wide bridge key), resolve it from the bound entity's role via the ONE
    // placement door. Deterministic single winner → file there; ambiguous → 409
    // with candidates so the human PICKS a workspace (propose-on-ambiguity),
    // never a silent pod-wide misfile. Governance stays intact.
    let workspaceId = acting.workspaceId;
    if (!workspaceId) {
      const contextObjectType = body.contextObjectType ?? "entity";
      if (contextObjectType !== "entity") {
        return c.json(
          {
            error:
              "workspaceId is required for a pod-wide bind to a non-entity object",
          },
          400
        );
      }
      const derived = await derivePodWideBindWorkspace({
        userId: acting.userId,
        contextObjectId: body.contextObjectId,
      });
      if (!derived.ok) {
        return c.json(
          {
            status: "ambiguous",
            error:
              "Could not derive a single workspace for this pod-wide bind — specify workspaceId.",
            reason: derived.reason,
            candidates: derived.candidates,
          },
          409
        );
      }
      workspaceId = derived.workspaceId;
    }
    try {
      const result = await proposeChannelBind({
        userId: acting.userId,
        workspaceId,
        channelId,
        contextObjectType: body.contextObjectType ?? "entity",
        contextObjectId: body.contextObjectId,
        ...(body.branchPurpose !== undefined
          ? { branchPurpose: body.branchPurpose }
          : {}),
        ...(body.externalChannelId !== undefined
          ? { externalChannelId: body.externalChannelId }
          : {}),
        ...(body.reasoning !== undefined ? { reasoning: body.reasoning } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error({ err, channelId }, "POST /channels/:channelId/bind failed");
      return c.json({ error: msg }, 500);
    }
  });

  /**
   * POST /channels — create-or-link an EXTERNAL channel bound to an entity.
   *
   * The agency "/link-client" door: given a Discord channel id and a client
   * entity id, ensure there is ONE Synap EXTERNAL channel mirroring that Discord
   * channel and bound (contextObjectType="entity") to the client. Idempotent on
   * the (externalSource, externalId) partial unique index — calling it twice for
   * the same Discord channel returns the existing row.
   *
   * Reuses `resolveOrCreateExternalChannel` (the shared inbound-recorder upsert)
   * for the create/dedup half, then sets the entity link in a follow-up update
   * if the row isn't already bound. We do NOT duplicate channel-creation logic.
   */
  app.post("/channels", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      externalSource?: string;
      externalChannelId?: string;
      contextObjectId?: string;
      contextObjectType?: "entity" | "document" | "view" | "proposal";
      title?: string;
      parentChannelId?: string;
      branchPurpose?: string;
      relink?: boolean;
      metadata?: Record<string, unknown>;
    };
    if (!body.externalSource || !body.externalChannelId) {
      return c.json(
        { error: "externalSource and externalChannelId are required" },
        400
      );
    }
    if (body.contextObjectId && !body.contextObjectType) {
      return c.json(
        {
          error:
            "contextObjectType is required when contextObjectId is provided",
        },
        400
      );
    }

    // Bind the acting identity + workspace to the authenticated bearer (same
    // IDOR-closing path the Discord agent-turn door uses).
    const acting = await resolveActingContext(c, {
      workspaceId: body.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;
    // Item 3 Part 3: positively pin a bound service key to its workspace. The
    // `if (!workspaceId)` guard below narrows the clamped value to a string.
    // A mismatching bound key throws FORBIDDEN → surface 403, not a blanket 500.
    let workspaceId: string | null | undefined;
    try {
      workspaceId = getConfinedWorkspace(c, acting.workspaceId);
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }
    // Linking an EXTERNAL channel binds it to a workspace (and usually a client
    // entity); the shared upsert requires a workspace. A no-workspace link is not
    // supported on this door.
    if (!workspaceId) {
      return c.json(
        { error: "workspaceId is required to link an external channel" },
        400
      );
    }

    try {
      // 1. Create-or-find the canonical EXTERNAL channel (race-safe upsert on the
      //    (externalSource, externalId) partial unique index).
      const { channelId, contextObjectId: existingContextId } =
        await resolveOrCreateExternalChannel({
          provider: body.externalSource,
          externalId: body.externalChannelId,
          userId,
          workspaceId,
          title: body.title ?? `${body.externalSource} channel`,
        });

      // 1b. Explicit re-link (user ran /link-client again): move the channel to
      //     the requested workspace. resolveOrCreateExternalChannel matches by
      //     (externalSource, externalId) only, so a channel first created in the
      //     pod-primary before the operator chose CRM would otherwise be stuck
      //     there forever. Only on an explicit relink — never for auto callers.
      if (body.relink) {
        await db
          .update(channelsTable)
          .set({ workspaceId, updatedAt: new Date() })
          .where(eq(channelsTable.id, channelId));
      }

      // 2. Bind to the entity. Normally only when not already bound (idempotent,
      //    never-clobber). An explicit relink OVERWRITES a stale/dangling bind
      //    (e.g. a proposed-but-unapproved client id that never materialised).
      let linked = false;
      if (body.contextObjectId && (body.relink || !existingContextId)) {
        await db
          .update(channelsTable)
          .set({
            contextObjectType: body.contextObjectType,
            contextObjectId: body.contextObjectId,
            updatedAt: new Date(),
          })
          .where(
            body.relink
              ? eq(channelsTable.id, channelId)
              : and(
                  eq(channelsTable.id, channelId),
                  isNull(channelsTable.contextObjectId)
                )
          );
        linked = true;
      }

      // 3. Establish the parent/child (thread-in-room) shape when requested.
      //    Set parentChannelId only when it's still NULL so a re-link never
      //    clobbers or re-parents an existing thread (idempotent + additive).
      //    branchPurpose (the firewall role) is handled separately in 3b via the
      //    one-door — it is NEVER written here.
      if (body.parentChannelId) {
        await db
          .update(channelsTable)
          .set({
            parentChannelId: body.parentChannelId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(channelsTable.id, channelId),
              isNull(channelsTable.parentChannelId)
            )
          );
      }

      // 3b. Persist the channel's firewall role (branchPurpose) via the ONE door
      //     (setChannelBranchPurpose), which enforces client-comms immutability
      //     (and the DB trigger is the floor beneath it). Idempotent by default:
      //     a normal link only stamps when the role is unset (never clobbers an
      //     existing role). An EXPLICIT `relink` overwrites a NON-client-comms
      //     role (self-heal for a fat-fingered team/null) — but the one-door
      //     still refuses to flip a client-comms channel, returning 403.
      if (body.branchPurpose) {
        try {
          if (body.relink) {
            await setChannelBranchPurpose({
              channelId,
              branchPurpose: body.branchPurpose,
            });
          } else {
            const existing = await db.query.channels.findFirst({
              where: eq(channelsTable.id, channelId),
              columns: { branchPurpose: true },
            });
            if (existing?.branchPurpose == null) {
              await setChannelBranchPurpose({
                channelId,
                branchPurpose: body.branchPurpose,
              });
            }
          }
        } catch (err) {
          if (err instanceof ChannelFirewallImmutableError) {
            return c.json({ error: err.message }, 403);
          }
          throw err;
        }
      }

      // 3c. Shallow-merge caller-supplied metadata into channels.metadata. The
      //     bridge learns the Telegram↔Discord mirror + guild id only at
      //     mirror-create time and re-sends the full set for the channel, so an
      //     atomic jsonb `||` merge (incoming top-level keys win, existing keys
      //     survive) is both correct and race-free — no read-modify-write.
      if (body.metadata && typeof body.metadata === "object") {
        await db
          .update(channelsTable)
          .set({
            metadata: drizzleSql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(
              body.metadata
            )}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(channelsTable.id, channelId));
      }

      const channel = await db.query.channels.findFirst({
        where: eq(channelsTable.id, channelId),
      });

      return c.json({
        channelId,
        // `linked` = the channel is now bound to an entity (either we just bound
        // it, or it was already bound to one). The upsert helper doesn't surface
        // a create-vs-found flag, so `created` mirrors "no prior entity bind".
        created: !existingContextId,
        linked: linked || !!existingContextId,
        channel,
      });
    } catch (err) {
      logger.error(
        {
          err,
          externalSource: body.externalSource,
          externalChannelId: body.externalChannelId,
        },
        "POST /channels create-or-link failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /channels/:channelId/context-card ─────────────────────────────────
  // The discoverability projection: everything WIRED to a channel — its linked
  // entity, the automations targeting it, the sessions running in it, and the
  // playbooks you can start — in ONE payload the Discord bridge renders as a pinned
  // "what's on this channel" card. Read-only (no writes); each item carries an
  // `openUrl` deep-link (the pod /open bounce → the app). Client-comms channels get
  // a card too (they still have context), but the bridge never PINS one there.
  app.get("/channels/:channelId/context-card", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    // Pin to the authenticated bearer + enforce the caller's channel-visibility
    // floor (same as GET /channels) — an agent key must NOT read another user's
    // channel context (entity title, automations, sessions). Closes the IDOR.
    const userId = c.get("userId") as string;
    if (!userId) return c.json({ error: "userId is required" }, 400);
    const channelParam = c.req.param("channelId");
    // Accept EITHER the Synap channel UUID OR the provider (Discord) external id —
    // the bridge calls this with a Discord snowflake (matching /rename + /pins),
    // browser clients pass the UUID. A snowflake is all-digits, never a UUID, and
    // comparing it to the uuid `id` column would raise a Postgres cast error, so
    // dispatch on shape.
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        channelParam
      );
    const channelId = channelParam;
    try {
      const [channel] = await db
        .select({
          id: channelsTable.id,
          title: channelsTable.title,
          channelType: channelsTable.channelType,
          branchPurpose: channelsTable.branchPurpose,
          contextObjectType: channelsTable.contextObjectType,
          contextObjectId: channelsTable.contextObjectId,
          workspaceId: channelsTable.workspaceId,
        })
        .from(channelsTable)
        .where(
          and(
            isUuid
              ? eq(channelsTable.id, channelParam)
              : eq(channelsTable.externalId, channelParam),
            channelVisibilityWhere(userId)
          )
        )
        .limit(1);
      if (!channel) return c.json({ error: "Channel not found" }, 404);

      // 1. Linked subject entity.
      let linkedEntity: {
        id: string;
        type: string;
        title: string | null;
        openUrl: string;
      } | null = null;
      // Keep the full company row around for the company-only card fields below.
      let companyEntity: {
        id: string;
        properties: Record<string, unknown>;
      } | null = null;
      if (channel.contextObjectId && channel.contextObjectType === "entity") {
        const e = await db.query.entities.findFirst({
          where: and(
            eq(entitiesTable.id, channel.contextObjectId),
            isNull(entitiesTable.deletedAt)
          ),
        });
        if (e) {
          linkedEntity = {
            id: e.id,
            type: e.type,
            title: e.title,
            openUrl: openLink(e.id),
          };
          if (e.type === "company") {
            companyEntity = {
              id: e.id,
              properties:
                e.properties && typeof e.properties === "object"
                  ? (e.properties as Record<string, unknown>)
                  : {},
            };
          }
        }
      }

      // 2. Automations wired to this channel (trigger config's channelId).
      const autoRows = await db
        .select({
          id: automationsTable.id,
          name: automationsTable.name,
          trigger: automationsTable.triggerType,
          status: automationsTable.status,
        })
        .from(automationsTable)
        .where(
          drizzleSql`${automationsTable.triggerConfig} ->> 'channelId' = ${channel.id}`
        );
      const automations = autoRows.map((a) => ({
        id: a.id,
        name: a.name,
        trigger: a.trigger,
        enabled: a.status === "active",
      }));

      // 3. Active sessions running in this channel (+ playbook name + stage).
      const sessRows = await db
        .select({
          id: focusSessions.id,
          status: focusSessions.status,
          expectedOutputs: focusSessions.expectedOutputs,
          playbook: playbooksTable.name,
        })
        .from(focusSessions)
        .leftJoin(
          playbooksTable,
          eq(focusSessions.playbookId, playbooksTable.id)
        )
        .where(
          and(
            eq(focusSessions.channelId, channel.id),
            eq(focusSessions.status, "active")
          )
        );
      const sessions = sessRows.map((s) => {
        const items = Array.isArray(s.expectedOutputs)
          ? (s.expectedOutputs as Array<{ label?: string; status?: string }>)
          : [];
        const cur =
          items.find((it) => it && it.status !== "done") ??
          items[items.length - 1];
        return {
          id: s.id,
          playbook: s.playbook ?? null,
          stage: cur?.label ?? null,
          status: s.status,
          openUrl: openLink(s.id),
        };
      });

      // 4. Startable playbooks — active, in this channel's workspace or pod-wide.
      const pbRows = await db
        .select({ id: playbooksTable.id, name: playbooksTable.name })
        .from(playbooksTable)
        .where(
          channel.workspaceId
            ? and(
                eq(playbooksTable.status, "active"),
                drizzleSql`(${playbooksTable.workspaceId} = ${channel.workspaceId} OR ${playbooksTable.workspaceId} IS NULL)`
              )
            : eq(playbooksTable.status, "active")
        )
        .limit(25);

      // 5. Company-only client fields (contract for the bridge renderer). Every
      // field is null/empty-safe: a hollow company yields empty arrays / null,
      // never a throw. Computed only when the linked entity IS a company.
      let companyFields:
        | {
            status: string | null;
            knownUrls: string[];
            deals: Array<{
              id: string;
              title: string | null;
              stage: string | null;
              openUrl: string;
            }>;
            lastActivityAt: string | null;
            contextSummary: string | null;
          }
        | undefined;
      if (companyEntity) {
        // Neighbours via the canonical cross-workspace door: null lens = full
        // user floor, unions 5 sources, filters deletedAt (so soft-deleted
        // deals never appear). NOT getRelated — that returns soft-deleted rows.
        const relCtx = await createHubProtocolCallerContext(
          userId,
          c.get("scopes") as string[],
          undefined
        );
        const relCaller = relationsRouter.createCaller(
          relCtx as Parameters<typeof relationsRouter.createCaller>[0]
        );
        const connResult = await relCaller.getConnections({
          entityId: companyEntity.id,
          workspaceId: null,
        });
        const connections = connResult.connections as ConnectionLike[];

        // Identity signals: url / handle / linkedin_url / website (the
        // "known urls" for the company). Composed with company.website.
        const signals = await db
          .select({ signalValue: entityIdentitySignals.signalValue })
          .from(entityIdentitySignals)
          .where(
            and(
              eq(entityIdentitySignals.entityId, companyEntity.id),
              inArray(entityIdentitySignals.signalType, [
                "url",
                "handle",
                "linkedin_url",
                "website",
              ])
            )
          );

        // Client lifecycle facet status (full user floor).
        const facetScope = await resolveFacetVisibilityScope(userId, null);
        const effectiveFacets = await getEffectiveFacets(
          db,
          companyEntity.id,
          facetScope
        );

        // Last activity: MAX(messages.timestamp) over channels bound to this
        // entity (contextObjectId). NOT channels.metadata.lastMessageAt (fake).
        const [activityRow] = await db
          .select({ last: max(messagesTable.timestamp) })
          .from(messagesTable)
          .innerJoin(
            channelsTable,
            eq(messagesTable.channelId, channelsTable.id)
          )
          .where(
            and(
              // Same caller floor the rest of this handler applies (the IDOR
              // guard) — never MAX over a channel the caller can't see.
              channelVisibilityWhere(userId),
              eq(channelsTable.contextObjectType, "entity"),
              eq(channelsTable.contextObjectId, companyEntity.id)
            )
          );
        const lastActivityAt = activityRow?.last
          ? new Date(activityRow.last).toISOString()
          : null;

        companyFields = {
          status: pickClientStatus({
            grantSubmissionStage: pickGrantSubmissionStage(connections),
            facetStatuses: effectiveFacets.map((f) => ({
              slug: f.profile.slug,
              status: f.facet.status ?? null,
            })),
            companyStatus: companyEntity.properties.status,
          }),
          knownUrls: composeKnownUrls(
            companyEntity.properties.website,
            signals.map((s) => s.signalValue)
          ),
          deals: projectDealsFromConnections(connections, openLink),
          lastActivityAt,
          contextSummary:
            typeof companyEntity.properties.contextSummary === "string"
              ? (companyEntity.properties.contextSummary as string)
              : null,
        };
      }

      return c.json({
        channel: {
          id: channel.id,
          title: channel.title,
          channelType: channel.channelType,
          branchPurpose: channel.branchPurpose,
          contextObjectType: channel.contextObjectType,
          contextObjectId: channel.contextObjectId,
        },
        linkedEntity,
        automations,
        sessions,
        playbooks: pbRows.map((p) => ({ id: p.id, name: p.name })),
        openBase: openLink("").replace(/\/+$/, ""),
        ...(companyFields ?? {}),
      });
    } catch (err) {
      logger.error(
        { err, channelId },
        "GET /channels/:channelId/context-card failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
