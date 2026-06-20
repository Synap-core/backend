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

import { createHash, randomUUID } from "crypto";
import { z } from "@hono/zod-openapi";
import {
  db,
  agents,
  channels,
  messages,
  eq,
  and,
  isNotNull,
  drizzleSql,
  ChannelType,
  ChannelScope,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database";
import type { HubResponse } from "@synap-core/types";
import { emitSideEffects } from "@synap/events";

import { resolveIntelligenceServiceByAgentId } from "../../../utils/intelligence-routing.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const AgentTurnRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    discordChannelId: z.string().min(1),
    discordUserId: z.string().min(1),
    discordUsername: z.string().min(1),
    text: z.string().min(1).max(50_000),
    messageId: z.string().min(1),
  })
  .openapi("DiscordAgentTurnRequest");

const AgentTurnResponseSchema = z
  .object({ reply: z.string() })
  .openapi("DiscordAgentTurnResponse");

export function registerDiscordRoutes(app: HubHono): void {
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
    const { userId, workspaceId } = acting;

    try {
      // ── 1. Resolve-or-create the Discord-bound EXTERNAL channel ─────────────
      // Dedup key: (channelType=EXTERNAL, externalSource='discord', externalId).
      // Mirrors the Unipile webhook upsert so the inbox/automation pipeline and
      // the outbound relay treat Discord channels identically.
      const preview = body.text.slice(0, 120);
      let channelId: string;

      const existing = await db.query.channels.findFirst({
        where: and(
          eq(channels.channelType, ChannelType.EXTERNAL),
          eq(channels.externalSource, "discord"),
          eq(channels.externalId, body.discordChannelId)
        ),
        columns: { id: true },
      });

      if (existing) {
        channelId = existing.id;
        await db
          .update(channels)
          .set({
            metadata: drizzleSql`${channels.metadata} || ${JSON.stringify({
              lastMessageAt: new Date().toISOString(),
              lastMessagePreview: preview,
              participantName: body.discordUsername,
              unread: true,
            })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(channels.id, channelId));
      } else {
        // Upsert against the partial unique index on (externalSource, externalId).
        // Under a concurrent first-message race the loser's insert no-ops, so we
        // re-SELECT the surviving row instead of throwing a 500 to the bot.
        const [inserted] = await db
          .insert(channels)
          .values({
            userId,
            workspaceId,
            channelType: ChannelType.EXTERNAL,
            scope: ChannelScope.WORKSPACE,
            title: `Discord · ${body.discordUsername}`,
            externalSource: "discord",
            externalChannelId: body.discordChannelId,
            externalId: body.discordChannelId,
            metadata: {
              participantName: body.discordUsername,
              participantExternalId: body.discordUserId,
              lastMessageAt: new Date().toISOString(),
              lastMessagePreview: preview,
              unread: true,
            },
          })
          .onConflictDoNothing({
            target: [channels.externalSource, channels.externalId],
            // The unique index is PARTIAL (`WHERE external_id IS NOT NULL`), so
            // the conflict arbiter must repeat that predicate or Postgres rejects
            // it with "no unique constraint matching the ON CONFLICT spec".
            where: isNotNull(channels.externalId),
          })
          .returning({ id: channels.id });

        if (inserted) {
          channelId = inserted.id;
          logger.info(
            { channelId, discordChannelId: body.discordChannelId },
            "Auto-created EXTERNAL channel for inbound Discord message"
          );
        } else {
          // Lost the race — the surviving row was inserted concurrently.
          const survivor = await db.query.channels.findFirst({
            where: and(
              eq(channels.channelType, ChannelType.EXTERNAL),
              eq(channels.externalSource, "discord"),
              eq(channels.externalId, body.discordChannelId)
            ),
            columns: { id: true },
          });
          if (!survivor) {
            throw new Error(
              "Failed to resolve-or-create Discord channel after conflict"
            );
          }
          channelId = survivor.id;
        }
      }

      // ── 2. Idempotency guard: has this exact inbound already been processed? ──
      // Discord delivery is at-least-once (gateway retries), so a duplicate POST
      // must NOT re-run the IS turn or post a second reply. The inbound hash is
      // deterministic over (channel, messageId); if a row already exists we replay
      // the prior assistant reply instead of doing the work again.
      const inboundHash = createHash("sha256")
        .update(`discord:${body.discordChannelId}:${body.messageId}`)
        .digest("hex");

      const alreadyProcessed = await db.query.messages.findFirst({
        where: eq(messages.hash, inboundHash),
        columns: { id: true },
      });
      if (alreadyProcessed) {
        // Duplicate delivery. Return the prior assistant reply (chained off the
        // same inbound hash) if it exists; otherwise the first turn is still in
        // flight — return an empty reply so the bot posts nothing twice.
        const priorReply = await db.query.messages.findFirst({
          where: and(
            eq(messages.previousHash, inboundHash),
            eq(messages.role, MessageRole.ASSISTANT)
          ),
          columns: { content: true },
        });
        return c.json({ reply: priorReply?.content ?? "" }, 200);
      }

      // Record the inbound message (role=user, authorType=external).
      await db
        .insert(messages)
        .values({
          channelId,
          userId,
          role: MessageRole.USER,
          authorType: MessageAuthorType.EXTERNAL,
          messageCategory: MessageCategory.CHAT,
          externalSource: "discord",
          content: body.text,
          hash: inboundHash,
        })
        .onConflictDoNothing();

      // Fire the same automation event inbound external messages emit.
      emitSideEffects({
        subjectType: "external_message",
        action: "received",
        subjectId: channelId,
        userId,
        workspaceId,
        data: {
          channelId,
          provider: "discord",
          threadId: body.discordChannelId,
          participantName: body.discordUsername,
          messagePreview: preview,
        },
      }).catch((err) => {
        logger.warn({ err, channelId }, "emitSideEffects failed (non-fatal)");
      });

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
            userId,
            agentId,
            agentType: "meta",
            workspaceId,
            agentUserId: resolvedService.agentUserId,
            dataPodUrl:
              process.env.PUBLIC_URL || `https://${process.env.DOMAIN}`,
            dataPodApiKey: resolvedService.serviceApiKey,
            channelKind: "pm",
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

      // ── 4. Persist the assistant reply so channel history stays complete ─────
      // Only persist a genuine IS turn — never the friendly fallback.
      if (assistantContent) {
        const assistantId = randomUUID();
        const assistantHash = createHash("sha256")
          .update(`${assistantId}${assistantContent}${inboundHash}`)
          .digest("hex");
        await db.insert(messages).values({
          id: assistantId,
          channelId,
          userId,
          role: MessageRole.ASSISTANT,
          authorType: MessageAuthorType.AI_AGENT,
          messageCategory: MessageCategory.CHAT,
          content: assistantContent,
          previousHash: inboundHash,
          hash: assistantHash,
        });
      }

      return c.json({ reply }, 200);
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
