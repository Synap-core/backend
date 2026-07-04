/**
 * Hub Protocol REST — Discord agent bridge (V0 BYOA)
 *
 * ONE endpoint: POST /discord/agent-turn
 *
 * A Discord-side bot process (gateway listener) forwards each inbound message
 * here. This handler:
 *   1. Resolves-or-creates the Synap EXTERNAL channel bound to the Discord
 *      channel (externalSource:'discord', externalChannelId=discordChannelId).
 *   2. Records the inbound message (role=user, authorType=external) — same shape
 *      the Unipile webhook uses, so the inbox/automation pipeline sees it.
 *   3. Runs ONE orchestrator turn by calling the SAME Intelligence Service the
 *      channel chat path uses (resolveIntelligenceServiceByAgentId + a
 *      non-streaming client.sendMessage). The orchestrator (and its
 *      proposal-gating for external actions) lives in the IS — this is the thin
 *      dispatch wrapper, NOT a re-implementation of the agent.
 *   4. Persists the assistant reply and returns it synchronously as { reply }.
 *
 * Reply strategy = SYNCHRONOUS. The non-streaming IS call returns the reply text
 * in-band, so the bot can post it straight back to Discord without waiting on a
 * proactive mirror-out. Outbound is still available via DiscordConnector (for
 * proposal-approved external actions) — see connectors/DiscordConnector.ts.
 *
 * External actions stay proposal-gated: the IS reaches back into the pod via
 * Hub Protocol, where checkPermissionOrPropose() governs every mutation exactly
 * as it does for browser chat.
 */

import { z } from "@hono/zod-openapi";
import { getPodCallback } from "../../../utils/pod-callback.js";
import {
  db,
  agents,
  messages,
  eq,
  and,
  MessageRole,
  MessageCategory,
  persistAssistantReply,
} from "@synap/database";
import { resolveClientBinding } from "../../../utils/resolve-client-binding.js";
import type { HubResponse } from "@synap-core/types";
import { recordInboundMessage } from "../../../services/connectors/inbound-recorder.js";

import { resolveIntelligenceServiceByAgentId } from "../../../utils/intelligence-routing.js";
import { resolveExistingExternalUser } from "../../../services/external-user-mapping.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const IngestRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    discordChannelId: z.string().min(1),
    discordUserId: z.string().min(1),
    discordUsername: z.string().min(1).optional(),
    text: z.string().min(1).max(50_000),
    messageId: z.string().min(1),
  })
  .openapi("DiscordIngestRequest");

const IngestResponseSchema = z
  .object({ recorded: z.boolean() })
  .openapi("DiscordIngestResponse");

const AgentTurnRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    discordChannelId: z.string().min(1),
    discordUserId: z.string().min(1),
    discordUsername: z.string().min(1),
    text: z.string().min(1).max(50_000),
    messageId: z.string().min(1),
    // Optional: a skill the bot's `/skill <name>` command wants force-loaded into
    // this turn. Passed through to the IS as forcedSkillName; the agent runs WITH
    // that skill's know-how loaded — the "Claude-Code-with-a-skill" model.
    skillName: z.string().min(1).max(200).optional(),
  })
  .openapi("DiscordAgentTurnRequest");

const AgentTurnResponseSchema = z
  .object({
    reply: z.string(),
    // FIREWALL: when the @mention came from a client-comms channel, the bot must
    // not reply there. `deliverToExternalChannelId` = the team channel to post
    // the reply to instead; `suppressReply` = post nothing (no team channel to
    // redirect to). Absent on normal (team/unbound) channels → reply in place.
    deliverToExternalChannelId: z.string().optional(),
    suppressReply: z.boolean().optional(),
    // Set when the inbound Discord user is NOT yet linked to a Synap identity.
    // The agent ran as the operator (legacy behavior); the bridge can use this
    // signal + discordUserId to prompt the user through onboarding/linking.
    needsConnect: z.boolean().optional(),
    discordUserId: z.string().optional(),
  })
  .openapi("DiscordAgentTurnResponse");

export function registerDiscordRoutes(app: HubHono): void {
  // ── POST /discord/ingest (static; registered before /discord/agent-turn) ──
  registerOpenApi(app, {
    method: "post",
    path: "/discord/ingest",
    tags: ["Discord"],
    summary: "Record an inbound Discord message (no IS turn)",
    description:
      "Dedup-records the inbound message and fires external_message.received. " +
      "Does NOT dispatch the orchestrator. Use this for pure automation pipelines " +
      "where no AI reply is needed.",
    request: { body: IngestRequestSchema },
    responses: {
      200: { description: "Record result", schema: IngestResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/discord/ingest", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    let body: z.infer<typeof IngestRequestSchema>;
    try {
      body = IngestRequestSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid request body" },
        400
      );
    }

    const acting = await resolveActingContext(c, {
      workspaceId: body.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;
    // workspaceId is a required field on IngestRequestSchema, so the membership
    // branch of resolveActingContext returns it non-null.
    const workspaceId = body.workspaceId;

    const callerKeyId = c.get("apiKeyId") as string | undefined;

    try {
      const { recorded } = await recordInboundMessage({
        provider: "discord",
        externalId: body.discordChannelId,
        userId,
        workspaceId,
        text: body.text,
        participant: body.discordUsername,
        participantExternalId: body.discordUserId,
        title: `Discord · ${body.discordUsername ?? body.discordUserId}`,
        idempotencySeed: `${body.discordChannelId}:${body.messageId}`,
        senderExternalId: body.discordUserId,
        senderKeyId: callerKeyId,
        messageId: body.messageId,
      });
      return c.json({ recorded }, 200);
    } catch (err) {
      logger.error(
        { err, discordChannelId: body.discordChannelId },
        "POST /discord/ingest failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /discord/agent-turn ───────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/discord/agent-turn",
    tags: ["Discord", "Agents"],
    summary: "Run one orchestrator turn for an inbound Discord message",
    description:
      "Resolves-or-creates the Discord-bound channel, records the inbound message, runs ONE Intelligence Service orchestrator turn (external actions stay proposal-gated), and returns the agent's reply text synchronously.",
    request: { body: AgentTurnRequestSchema },
    responses: {
      200: { description: "Agent reply", schema: AgentTurnResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/discord/agent-turn", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    let body: z.infer<typeof AgentTurnRequestSchema>;
    try {
      body = AgentTurnRequestSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid request body" },
        400
      );
    }

    // Bind the acting identity + workspace to the authenticated bearer.
    const acting = await resolveActingContext(c, {
      workspaceId: body.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;
    // workspaceId is a required field on AgentTurnRequestSchema, so the membership
    // branch of resolveActingContext returns it non-null.
    const workspaceId = body.workspaceId;

    // ── Caller identity resolution (Option B) ──────────────────────────────────
    // The bridge authenticates with the OPERATOR key; `userId` above is the
    // operator. If THIS Discord user has been EXPLICITLY linked to a Synap user
    // (via POST /discord/identity/link), the agent should act AS them — so we
    // pass their Synap userId to the IS as the delegated identity. We use the
    // bearer's api_keys.id as the mapping's parentKeyId (same key the link was
    // created under). This is a READ-ONLY resolve — never auto-create here:
    // unlinked users keep the operator identity and get a `needsConnect` hint.
    const callerKeyId = c.get("apiKeyId") as string | undefined;
    // The acting AGENT (the bridge key's agent-user, e.g. the Discord agent) — a
    // real userType='agent' member. Writes this turn produces are attributed to
    // it so proposals are valid + governed. The IS service identity
    // (resolvedService.agentUserId) is "system" on self-hosted pods, which is NOT
    // an agent user and makes every write 400 (resolveActorId rejects it).
    const callerAgentUserId = c.get("agentUserId") as string | undefined;
    let actingUserId = userId; // identity the IS turn runs as
    let needsConnect = false;
    if (callerKeyId) {
      try {
        const link = await resolveExistingExternalUser(
          callerKeyId,
          body.discordUserId
        );
        if (link.linked && link.synapUserId) {
          actingUserId = link.synapUserId;
        } else {
          needsConnect = true;
        }
      } catch (err) {
        // Never fail the turn on a lookup error — fall back to the operator
        // identity (same fail-open contract as the auth-middleware sub-token path).
        logger.warn(
          { err, discordUserId: body.discordUserId },
          "Discord agent turn: identity resolve failed — acting as operator"
        );
      }
    }

    try {
      // ── 1+2. Resolve-or-create the Discord channel + dedup-record the inbound
      // message + fire `external_message.received` via the shared recorder.
      // Discord delivery is at-least-once (gateway retries), so a duplicate POST
      // must NOT re-run the IS turn or post a second reply: the recorder reports
      // `recorded: false` for a duplicate, and we replay the prior assistant
      // reply (chained off the same inbound hash) instead of doing the work again.
      const { channelId, contextObjectId, inboundHash, recorded } =
        await recordInboundMessage({
          provider: "discord",
          externalId: body.discordChannelId,
          userId,
          workspaceId,
          text: body.text,
          participant: body.discordUsername,
          participantExternalId: body.discordUserId,
          title: `Discord · ${body.discordUsername}`,
          // Discord exposes a native message id — deterministic over (channel, id).
          idempotencySeed: `${body.discordChannelId}:${body.messageId}`,
          // Attribution: resolve whether this Discord user is linked to a Synap
          // user so the message row carries a sender block in metadata.
          senderExternalId: body.discordUserId,
          senderKeyId: callerKeyId,
          messageId: body.messageId,
        });

      if (!recorded) {
        // Duplicate delivery. Return the prior assistant reply if it exists;
        // otherwise the first turn is still in flight — return an empty reply so
        // the bot posts nothing twice.
        const priorReply = await db.query.messages.findFirst({
          where: and(
            eq(messages.previousHash, inboundHash),
            eq(messages.role, MessageRole.ASSISTANT)
          ),
          columns: { content: true },
        });
        return c.json({ reply: priorReply?.content ?? "" }, 200);
      }

      // ── 3. Run ONE orchestrator turn via the Intelligence Service ───────────
      // Reuse the channel chat path's IS dispatch: resolve the orchestrator, then
      // a non-streaming sendMessage (the same call channels.sendMessage falls
      // back to). The agent + its proposal-gating run inside the IS.
      const [orchestrator] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
        .limit(1);
      if (!orchestrator) {
        // Mirror the channel-chat path: a missing orchestrator is a real
        // misconfiguration, not something to paper over with a fabricated id.
        return c.json(
          { error: "Orchestrator agent not synced — run agent sync" },
          503
        );
      }
      const agentId = orchestrator.id;

      const resolvedService = await resolveIntelligenceServiceByAgentId(
        agentId,
        { userId, workspaceId, capability: "chat" }
      );

      // `reply` is what we return to the bot; `assistantContent` is the genuine
      // IS turn output that we persist to channel history. They diverge only when
      // the IS errors: we return a friendly apology but persist NOTHING, so a
      // transient outage doesn't write a permanent "unavailable" turn (and a later
      // retry can produce the real reply).
      let reply = "";
      let assistantContent = "";
      try {
        const hubResponse: Partial<HubResponse> =
          await resolvedService.client.sendMessage({
            query: body.text,
            threadId: channelId,
            // Run the turn AS the linked caller (or the operator when unlinked).
            // The IS delegates this via the is_internal keystone, so the agent's
            // reads/proposals are attributed to the Discord user's own identity.
            userId: actingUserId,
            agentId,
            agentType: "meta",
            workspaceId,
            agentUserId: callerAgentUserId ?? resolvedService.agentUserId,
            ...getPodCallback(),
            channelKind: "pm",
            // Client-aware: when this Discord channel is bound to a client entity
            // (via /link-client → contextObjectType="entity"), tell the IS which
            // entity this conversation is about so it loads that client's context.
            ...(contextObjectId ? { contextEntityId: contextObjectId } : {}),
            // Skill-aware: when the bot's `/skill <name>` command names a skill,
            // tell the IS to force-load it into this turn so the agent runs WITH
            // that skill as know-how (the Claude-Code-with-a-skill model).
            ...(body.skillName ? { forcedSkillName: body.skillName } : {}),
          });
        assistantContent = hubResponse?.content ?? "";
        reply = assistantContent;
      } catch (err) {
        logger.error(
          { err, channelId, discordChannelId: body.discordChannelId },
          "Discord agent turn: IS call failed"
        );
        reply =
          "The AI service is temporarily unavailable. Please try again in a moment.";
      }

      // ── 4. FIREWALL (resolved BEFORE persisting): the bot's reply must NEVER
      // land in — or be recorded under — a client-comms channel (those mirror to
      // the client's Telegram). If the @mention came from a client-comms channel,
      // redirect the Discord delivery to the linked TEAM channel; if there is no
      // team channel, tell the bridge to suppress it. We resolve this first so
      // the persist step below can SKIP recording the assistant turn under the
      // client-comms channel (otherwise that reply would leak into the
      // client-facing AI's thread context on a later turn).
      let deliverToExternalChannelId: string | undefined;
      let suppressReply = false;
      try {
        // Firewall resolution extracted to the shared helper (its ONE home).
        // Behavior is byte-identical: client-comms + team sibling → redirect to
        // the team channel; client-comms + no team → suppress; not client-comms →
        // reply in place.
        const { isClientComms, teamExternalId } =
          await resolveClientBinding(channelId);
        if (isClientComms) {
          if (teamExternalId) {
            deliverToExternalChannelId = teamExternalId;
          } else {
            suppressReply = true;
          }
        }
      } catch (err) {
        logger.warn(
          { err, channelId },
          "firewall channel-role resolve failed — replying in place"
        );
      }

      // ── 4b. Persist the assistant reply so channel history stays complete —
      // but NEVER under a client-comms channel. When the firewall redirected or
      // suppressed the reply, the genuine answer is delivered to the TEAM channel
      // on Discord by the bridge; we skip the pod-side record here so a later IS
      // turn reading the client-comms thread can't pick up an internal reply.
      const firewalled = !!deliverToExternalChannelId || suppressReply;
      if (assistantContent && !firewalled) {
        // Same shared hash-chain writer as the interactive + a2ai paths; the
        // reply chains off the already-recorded inbound message's hash.
        await persistAssistantReply({
          channelId,
          content: assistantContent,
          userId,
          previousHash: inboundHash,
          messageCategory: MessageCategory.CHAT,
        });
      }

      return c.json(
        {
          reply,
          // FIREWALL directives for the bridge (see 4b). When set, the bridge
          // must post the reply to `deliverToExternalChannelId` (the team
          // channel) instead of the source channel, or post nothing at all when
          // `suppressReply` is true.
          ...(deliverToExternalChannelId ? { deliverToExternalChannelId } : {}),
          ...(suppressReply ? { suppressReply: true } : {}),
          // Signal the bridge to prompt onboarding when the caller is unlinked.
          ...(needsConnect
            ? { needsConnect: true, discordUserId: body.discordUserId }
            : {}),
        },
        200
      );
    } catch (err) {
      logger.error(
        { err, discordChannelId: body.discordChannelId },
        "POST /discord/agent-turn failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
