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
 *      channel chat path uses (resolveIntelligenceServiceByAgentId +
 *      client.sendMessageStream). Stream frames are accumulated in-process so
 *      a bridge timeout can still return tool steps + partial text (Phase 1
 *      agent-turn observability). The orchestrator (and its proposal-gating
 *      for external actions) lives in the IS — this is the thin dispatch
 *      wrapper, NOT a re-implementation of the agent.
 *   4. Persists the assistant reply (with metadata.aiSteps) and returns it
 *      synchronously as { reply, steps?, partial?, timedOut?, error? }.
 *
 * Reply strategy = SYNCHRONOUS JSON envelope (not SSE to Discord). Streaming
 * is only Pod→IS; the bridge still receives one final body. Outbound is still
 * available via DiscordConnector (for proposal-approved external actions) —
 * see connectors/DiscordConnector.ts.
 *
 * External actions stay proposal-gated: the IS reaches back into the pod via
 * Hub Protocol, where checkPermissionOrPropose() governs every mutation exactly
 * as it does for browser chat.
 */

import { randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { getConfinedWorkspace } from "../confine-workspace.js";
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
import type { AIStep } from "@synap-core/types";
import { recordInboundMessage } from "../../../services/connectors/inbound-recorder.js";
import {
  createOrGetChatTurn,
  decideChatTurnClaimAction,
  finishChatTurn,
  isUsefulAssistantContent,
  reopenChatTurn,
  stableUuidFromSeed,
  type DurableChatTurn,
} from "../../../services/chat-turns/chat-turn-store.js";

import { resolveIntelligenceServiceByAgentId } from "../../../utils/intelligence-routing.js";
import { resolveExistingExternalUser } from "../../../services/external-user-mapping.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { runMailFeed } from "../../../services/mail-feed/run-mail-feed.js";
import { runEventSync } from "../../../services/event-sync/run-event-sync.js";
import { accumulateAgentTurnStream } from "./discord-agent-turn-stream.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

/**
 * Pod-side deadline for Discord agent-turn stream accumulation.
 * Must sit slightly under the bridge's HTTP abort (typically 120s, matching
 * CHAT_FETCH_TIMEOUT_MS) so we can return a partial JSON body with steps
 * instead of the bridge seeing an empty body. Override via AGENT_TURN_DEADLINE_MS.
 */
const AGENT_TURN_DEADLINE_MS = Number(
  process.env.AGENT_TURN_DEADLINE_MS ?? 110_000
);

const IS_UNAVAILABLE_REPLY =
  "The AI service is temporarily unavailable. Please try again in a moment.";

const PARTIAL_TIMEOUT_REPLY =
  "The agent timed out before finishing. Partial progress is included when available.";

/** AI step shape returned on the agent-turn response (mirrors channel aiSteps). */
const AgentTurnStepSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    content: z.string(),
    timestamp: z.string(),
    toolName: z.string().optional(),
    toolInput: z.unknown().optional(),
    toolOutput: z.unknown().optional(),
    duration: z.number().optional(),
    error: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(["pending", "running", "complete", "error"]).optional(),
  })
  .passthrough();

// Re-export for tests / callers that import from the route module.
export { accumulateAgentTurnStream } from "./discord-agent-turn-stream.js";
export type { AgentTurnStreamResult } from "./discord-agent-turn-stream.js";

// Inbound attachment descriptor (Discord photo carry-through, Wave 1). The
// bridge forwards each embed/attachment as { type, url, name? }. Stored under
// `messages.metadata.attachments` (schema {type,url}) and surfaced — bounded —
// on the `external_message.received` event. Capped at 4 to bound payload size.
const AttachmentInputSchema = z.object({
  type: z.string(),
  // https only — Discord CDN attachment URLs are always https, and this blocks a
  // stored `javascript:`/`data:`/`file:` URL from becoming an XSS/SSRF vector in
  // any downstream consumer (matches the shell.openExternal https-only rule).
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "attachment url must be https"),
  name: z.string().optional(),
});

const IngestRequestSchema = z
  .object({
    // Optional (Wave 3, pod-wide): when omitted the inbound is recorded against a
    // pod-level (null-workspace) channel home — the "user floor" — instead of
    // being pinned to one workspace. Provided → workspace-scoped, unchanged.
    workspaceId: z.string().uuid().optional(),
    discordChannelId: z.string().min(1),
    discordUserId: z.string().min(1),
    discordUsername: z.string().min(1).optional(),
    // Relaxed from min(1): an attachment-only message (photo, no caption) is a
    // valid inbound. The `.refine` below still rejects a wholly empty message.
    text: z.string().max(50_000).optional().default(""),
    messageId: z.string().min(1),
    attachments: z.array(AttachmentInputSchema).max(4).optional(),
  })
  .refine(
    (d) =>
      Boolean(
        (d.text && d.text.trim()) || (d.attachments && d.attachments.length)
      ),
    { message: "text or attachments required" }
  )
  .openapi("DiscordIngestRequest");

const IngestResponseSchema = z
  .object({ recorded: z.boolean() })
  .openapi("DiscordIngestResponse");

const AgentTurnRequestSchema = z
  .object({
    // Optional (Wave 3, pod-wide turn): when omitted the turn runs POD-WIDE — the
    // agent reads across the caller's accessible workspaces + globals (the "user
    // floor") and places each write in the workspace that fits the signal. When
    // provided the turn is pinned to that one workspace exactly as before (the
    // current pinned Discord bridge always passes it).
    workspaceId: z.string().uuid().optional(),
    discordChannelId: z.string().min(1),
    discordUserId: z.string().min(1),
    discordUsername: z.string().min(1),
    // Relaxed from min(1): an attachment-only message (photo, no caption) is a
    // valid inbound. The `.refine` below still rejects a wholly empty message.
    text: z.string().max(50_000).optional().default(""),
    messageId: z.string().min(1),
    attachments: z.array(AttachmentInputSchema).max(4).optional(),
    // Optional: a skill the bot's `/skill <name>` command wants force-loaded into
    // this turn. Passed through to the IS as forcedSkillName; the agent runs WITH
    // that skill's know-how loaded — the "Claude-Code-with-a-skill" model.
    skillName: z.string().min(1).max(200).optional(),
    // IS llmSemaphore priority. Digests / background bridge work MUST pass
    // "background" so interactive @mentions skip ahead in the queue. Default
    // (omit) = interactive — same as pre-priority behavior.
    priority: z.enum(["interactive", "background"]).optional(),
  })
  .refine(
    (d) =>
      Boolean(
        (d.text && d.text.trim()) || (d.attachments && d.attachments.length)
      ),
    { message: "text or attachments required" }
  )
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
    // Phase 1 agent-turn observability (ADDITIVE — non-breaking):
    // tool/thinking steps collected from the IS SSE stream (same shape as
    // channel chat metadata.aiSteps). Present on success (may be empty) and on
    // partial timeout so the bridge can show "tools so far".
    steps: z.array(AgentTurnStepSchema).optional(),
    // true when the pod aborted the IS stream (deadline / client disconnect)
    // after collecting some content or steps — reply may be partial text.
    partial: z.boolean().optional(),
    // true when the abort was due to the pod deadline (vs hard IS failure).
    timedOut: z.boolean().optional(),
    // Soft error string when partial progress was returned, or diagnostic
    // detail alongside the friendly apology on hard failure.
    error: z.string().optional(),
    // Durable chat_turns row id for this agent turn (UnifiedRun flowType "chat").
    // Present when the inbound was freshly recorded and a turn ledger row was
    // reserved (or on duplicate when a prior turn exists for the same request).
    turnId: z.string().uuid().optional(),
  })
  .openapi("DiscordAgentTurnResponse");

// On-demand trigger responses — mirror the runner result shapes so the bridge's
// `/mail-feed run` / `/events sync` commands can report what actually happened
// (posted/created counts) instead of a blind "queued".
const MailFeedRunResponseSchema = z
  .object({
    skipped: z.boolean().optional(),
    reason: z.string().optional(),
    processed: z.number().optional(),
    posted: z.number().optional(),
    skippedMuted: z.number().optional(),
    deniedDropped: z.number().optional(),
  })
  .openapi("DiscordMailFeedRunResponse");

const EventSyncRunResponseSchema = z
  .object({
    skipped: z.boolean().optional(),
    reason: z.string().optional(),
    processed: z.number().optional(),
    created: z.number().optional(),
    skippedExisting: z.number().optional(),
  })
  .openapi("DiscordEventSyncRunResponse");

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

    // Item 3 Part 3: confine a bound service key to its workspace before resolving.
    const confinedWorkspaceId =
      getConfinedWorkspace(c, body.workspaceId) ?? undefined;
    const acting = await resolveActingContext(c, {
      workspaceId: confinedWorkspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;
    // When workspaceId was provided it is membership-checked and returned here
    // unchanged; when omitted (Wave 3, pod-wide) it resolves to null and the
    // inbound is recorded against a pod-level channel home.
    const workspaceId = acting.workspaceId;

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
        attachments: body.attachments,
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
      "Resolves-or-creates the Discord-bound channel, records the inbound message, runs ONE Intelligence Service orchestrator turn via streaming accumulation (external actions stay proposal-gated), and returns the agent's reply text synchronously. On pod deadline, returns partial:true with steps collected so far.",
    request: { body: AgentTurnRequestSchema },
    responses: {
      200: {
        description:
          "Agent reply (may be partial with steps when timed out mid-stream)",
        schema: AgentTurnResponseSchema,
      },
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
    // Item 3 Part 3: confine a bound service key to its workspace before resolving.
    const confinedWorkspaceId =
      getConfinedWorkspace(c, body.workspaceId) ?? undefined;
    const acting = await resolveActingContext(c, {
      workspaceId: confinedWorkspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;
    // CONTRACT (Wave 3): workspaceId is `string | null`. Provided → membership-
    // checked and returned unchanged (turn PINNED to that workspace, byte-for-byte
    // the prior behavior). Omitted → null, a POD-WIDE turn: the channel home is
    // pod-level, the IS scopes reads to the user floor, and the agent places each
    // write in the workspace that fits.
    const workspaceId = acting.workspaceId;

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

    // Hoisted so the outer catch can mark a reserved turn failed if anything
    // throws after createOrGetChatTurn (avoids stuck "running" forever).
    let durableTurn: DurableChatTurn | undefined;
    let turnFinished = false;

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
          attachments: body.attachments,
        });

      // Stable request key for chat_turns (UUID column; Discord snowflakes are
      // not UUIDs — derive deterministically from the same idempotency seed).
      const turnRequestId = stableUuidFromSeed(
        `${body.discordChannelId}:${body.messageId}`
      );

      // ── 2b. Durable chat turn claim (works for first delivery AND retries).
      // Gateway retries re-POST the same messageId → recorded:false, but we must
      // still apply D5 claim policy: completed/skip with useful assistant, running
      // → in_progress, failed + no useful assistant → CAS reopen + re-run IS.
      // Best-effort: a ledger failure must not block a first-time agent turn.
      try {
        const inboundMsg = await db.query.messages.findFirst({
          where: eq(messages.hash, inboundHash),
          columns: { id: true },
        });
        const claimed = await createOrGetChatTurn({
          channelId,
          userId: actingUserId,
          requestId: turnRequestId,
          userMessageId: inboundMsg?.id ?? randomUUID(),
          assistantMessageId: randomUUID(),
        });
        durableTurn = claimed.turn;

        // Useful assistant = inbound-chained reply OR the turn's allocated row.
        const priorReply = await db.query.messages.findFirst({
          where: and(
            eq(messages.previousHash, inboundHash),
            eq(messages.role, MessageRole.ASSISTANT)
          ),
          columns: { content: true, id: true },
        });
        let usefulAssistantContent = isUsefulAssistantContent(
          priorReply?.content
        )
          ? (priorReply!.content as string)
          : "";
        if (!usefulAssistantContent) {
          const allocated = await db.query.messages.findFirst({
            where: eq(messages.id, durableTurn.assistantMessageId),
            columns: { content: true },
          });
          if (isUsefulAssistantContent(allocated?.content)) {
            usefulAssistantContent = allocated!.content as string;
          }
        }
        const hasUsefulAssistant = usefulAssistantContent.length > 0;

        const action = decideChatTurnClaimAction({
          // On duplicate inbound, the turn already exists — never treat as "created".
          created: recorded ? claimed.created : false,
          status: durableTurn.status,
          hasUsefulAssistant,
        });

        if (action === "in_progress") {
          return c.json(
            {
              reply: "",
              partial: true,
              error: "turn_in_progress",
              turnId: durableTurn.id,
            },
            200
          );
        }

        if (
          action === "skip_completed" ||
          action === "skip_with_assistant" ||
          action === "skip_cancelled"
        ) {
          // Replays of partial/failed turns must stay marked partial so the
          // bridge does not present a half-answer as a clean success.
          const isCleanComplete = action === "skip_completed";
          return c.json(
            {
              reply: usefulAssistantContent,
              turnId: durableTurn.id,
              ...(isCleanComplete
                ? {}
                : {
                    partial: true,
                    error: durableTurn.error ?? durableTurn.status,
                  }),
            },
            200
          );
        }

        // failed + no useful assistant → CAS-reopen and fall through to IS.
        if (action === "reopen_and_run") {
          const claimedReopen = await reopenChatTurn(durableTurn.id);
          if (!claimedReopen) {
            return c.json(
              {
                reply: "",
                partial: true,
                error: "turn_in_progress",
                turnId: durableTurn.id,
              },
              200
            );
          }
          durableTurn = { ...durableTurn, status: "running", error: null };
        }
        // action === "run" (first claim) falls through to IS below.
      } catch (err) {
        if (!recorded) {
          // Retry path with no ledger: do not double-run IS without a claim.
          logger.warn(
            { err, channelId, discordChannelId: body.discordChannelId },
            "Discord agent turn: retry claim failed — not re-running IS"
          );
          return c.json(
            {
              reply: "",
              partial: true,
              error: "turn_claim_failed",
            },
            200
          );
        }
        logger.warn(
          { err, channelId, discordChannelId: body.discordChannelId },
          "Discord agent turn: chat turn reserve failed — continuing without ledger"
        );
      }

      // ── 3. Run ONE orchestrator turn via the Intelligence Service ───────────
      // Reuse the channel chat path's IS dispatch: resolve the orchestrator, then
      // sendMessageStream (same frames channels.sendMessage consumes). Accumulate
      // content + aiSteps so a bridge/pod timeout can still return partial steps
      // instead of an empty body. The agent + its proposal-gating run inside the IS.
      const [orchestrator] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
        .limit(1);
      if (!orchestrator) {
        // Mirror the channel-chat path: a missing orchestrator is a real
        // misconfiguration, not something to paper over with a fabricated id.
        if (durableTurn) {
          await finishChatTurn({
            turnId: durableTurn.id,
            status: "failed",
            error: "Orchestrator agent not synced — run agent sync",
          }).catch(() => undefined);
          turnFinished = true;
        }
        return c.json(
          {
            error: "Orchestrator agent not synced — run agent sync",
            ...(durableTurn ? { turnId: durableTurn.id } : {}),
          },
          503
        );
      }
      const agentId = orchestrator.id;

      const resolvedService = await resolveIntelligenceServiceByAgentId(
        agentId,
        // Service routing is a workspace HINT only; a pod-wide (null) turn has no
        // specific lens, so pass undefined → env/default resolution, unchanged.
        { userId, workspaceId: workspaceId ?? undefined, capability: "chat" }
      );

      // `reply` is what we return to the bot; `assistantContent` is the genuine
      // IS turn output that we persist to channel history. They diverge only when
      // the IS errors with zero progress: we return a friendly apology but persist
      // NOTHING, so a transient outage doesn't write a permanent "unavailable"
      // turn (and a later retry can produce the real reply). Partial timeout
      // keeps real content/steps and may persist them.
      let reply = "";
      let assistantContent = "";
      let aiSteps: AIStep[] = [];
      let partial = false;
      let timedOut = false;
      let turnError: string | undefined;

      // Deadline slightly under the bridge HTTP abort so we finish the JSON
      // response with steps instead of the client seeing a truncated body.
      // Also honor the inbound request abort (proxy disconnect).
      const turnDeadline = new AbortController();
      const deadlineTimer = setTimeout(() => {
        turnDeadline.abort();
      }, AGENT_TURN_DEADLINE_MS);
      const requestSignal =
        typeof c.req.raw?.signal !== "undefined" ? c.req.raw.signal : undefined;
      const streamSignal = requestSignal
        ? AbortSignal.any([turnDeadline.signal, requestSignal])
        : turnDeadline.signal;

      try {
        const stream = resolvedService.client.sendMessageStream({
          query: body.text,
          threadId: channelId,
          // Run the turn AS the linked caller (or the operator when unlinked).
          // The IS delegates this via the is_internal keystone, so the agent's
          // reads/proposals are attributed to the Discord user's own identity.
          userId: actingUserId,
          agentId,
          agentType: "meta",
          // CONTRACT: workspaceId is `string | null`. A null/absent workspaceId
          // means a POD-WIDE turn — the IS scopes its Hub reads to the user floor
          // (omits workspaceId → backend returns the caller's accessible
          // workspaces + globals) and the agent places each write in the
          // workspace that fits per-signal. A non-null workspaceId pins the turn
          // to that one workspace for reads and write-placement, unchanged.
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
          // Digests must not steal interactive LLM slots (IS FairSemaphore).
          ...(body.priority ? { priority: body.priority } : {}),
          signal: streamSignal,
        });

        const streamResult = await accumulateAgentTurnStream(
          stream,
          streamSignal
        );
        aiSteps = streamResult.aiSteps;
        timedOut = streamResult.timedOut;
        const hasProgress =
          Boolean(streamResult.fullContent) || aiSteps.length > 0;

        if (streamResult.streamError && !hasProgress) {
          // Hard failure with nothing useful collected — friendly apology, no
          // permanent "unavailable" row (same contract as pre-stream path).
          logger.error(
            {
              err: streamResult.streamError,
              channelId,
              discordChannelId: body.discordChannelId,
            },
            "Discord agent turn: IS stream failed with zero progress"
          );
          reply = IS_UNAVAILABLE_REPLY;
          turnError = streamResult.streamError;
        } else if (timedOut && hasProgress) {
          // Deadline hit after tools/text — return partial so the bridge can
          // show steps instead of empty body.
          assistantContent = streamResult.fullContent;
          reply = streamResult.fullContent || PARTIAL_TIMEOUT_REPLY;
          partial = true;
          turnError =
            streamResult.streamError ?? "Agent turn deadline exceeded";
          logger.warn(
            {
              channelId,
              discordChannelId: body.discordChannelId,
              stepCount: aiSteps.length,
              contentLen: streamResult.fullContent.length,
            },
            "Discord agent turn: deadline exceeded with partial progress"
          );
        } else if (timedOut && !hasProgress) {
          logger.error(
            { channelId, discordChannelId: body.discordChannelId },
            "Discord agent turn: deadline exceeded with zero progress"
          );
          reply = IS_UNAVAILABLE_REPLY;
          timedOut = true;
          turnError = "Agent turn deadline exceeded";
        } else if (streamResult.streamError && hasProgress) {
          // Stream error after some frames — still return what we have.
          assistantContent = streamResult.fullContent;
          reply = streamResult.fullContent || PARTIAL_TIMEOUT_REPLY;
          partial = true;
          turnError = streamResult.streamError;
          logger.warn(
            {
              err: streamResult.streamError,
              channelId,
              discordChannelId: body.discordChannelId,
              stepCount: aiSteps.length,
            },
            "Discord agent turn: IS stream error after partial progress"
          );
        } else {
          // Full success.
          assistantContent = streamResult.fullContent;
          reply = assistantContent;
        }
      } catch (err) {
        // Transport/setup failure before or outside the accumulator (circuit
        // open, 401, network). Zero progress → apology.
        logger.error(
          { err, channelId, discordChannelId: body.discordChannelId },
          "Discord agent turn: IS call failed"
        );
        reply = IS_UNAVAILABLE_REPLY;
        turnError = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(deadlineTimer);
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
      // Partial replies with real content are persisted (with aiSteps) so a
      // bridge retry/dedup can replay something useful.
      const firewalled = !!deliverToExternalChannelId || suppressReply;
      if (assistantContent && !firewalled) {
        // Same shared hash-chain writer as the interactive + a2ai paths; the
        // reply chains off the already-recorded inbound message's hash.
        // Provenance metadata mirrors channels.sendMessage (aiSteps + service).
        // Preallocate assistant id from the chat turn so the ledger links to
        // the durable reply row (same as channels.sendMessage).
        try {
          await persistAssistantReply({
            ...(durableTurn
              ? { assistantId: durableTurn.assistantMessageId }
              : {}),
            channelId,
            content: assistantContent,
            userId,
            previousHash: inboundHash,
            messageCategory: MessageCategory.CHAT,
            metadata: {
              aiSteps,
              intelligenceServiceId: resolvedService.serviceId,
              agentId,
              agentType: "meta",
              ...(partial ? { partial: true } : {}),
              ...(timedOut ? { timedOut: true } : {}),
            },
          });
        } catch (err) {
          logger.error(
            { err, channelId, discordChannelId: body.discordChannelId },
            "Discord agent turn: failed to persist assistant reply"
          );
          if (durableTurn) {
            await finishChatTurn({
              turnId: durableTurn.id,
              status: "failed",
              error:
                err instanceof Error
                  ? err.message
                  : "Could not persist the AI response",
            }).catch(() => undefined);
            turnFinished = true;
          }
        }
      }

      // Close the durable chat turn lifecycle (completed | failed). Mirrors
      // channels.sendMessage: timeout / stream error → failed; clean success →
      // completed. Partial content with timeout is still a failed turn so
      // diagnose surfaces it; successful full replies do not.
      if (durableTurn && !turnFinished) {
        const failed = Boolean(turnError) || timedOut || !assistantContent;
        await finishChatTurn({
          turnId: durableTurn.id,
          status: failed ? "failed" : "completed",
          ...(failed
            ? {
                error:
                  turnError ??
                  (timedOut
                    ? "Agent turn deadline exceeded"
                    : "No assistant content"),
              }
            : {}),
        }).catch((err) => {
          logger.warn(
            { err, turnId: durableTurn!.id },
            "Discord agent turn: finishChatTurn failed"
          );
        });
      }

      return c.json(
        {
          reply,
          // Always include steps on success/partial so the bridge can surface
          // tools-so-far (empty array is fine — additive field).
          steps: aiSteps,
          ...(partial ? { partial: true } : {}),
          ...(timedOut ? { timedOut: true } : {}),
          ...(turnError && (partial || !assistantContent)
            ? { error: turnError }
            : {}),
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
          ...(durableTurn ? { turnId: durableTurn.id } : {}),
        },
        200
      );
    } catch (err) {
      logger.error(
        { err, discordChannelId: body.discordChannelId },
        "POST /discord/agent-turn failed"
      );
      if (durableTurn && !turnFinished) {
        await finishChatTurn({
          turnId: durableTurn.id,
          status: "failed",
          error: err instanceof Error ? err.message : "Unknown error",
        }).catch(() => undefined);
      }
      return c.json(
        {
          error: err instanceof Error ? err.message : "Unknown error",
          ...(durableTurn ? { turnId: durableTurn.id } : {}),
        },
        500
      );
    }
  });

  // ── POST /discord/mail-feed/run ────────────────────────────────────────────
  // On-demand trigger for the mail feed — the SAME api-side runner the
  // `mail-feed-cron` fires, invoked in-process so the caller gets the
  // posted/processed counts synchronously (a tight test loop instead of waiting
  // for the 2h cron). No body: the runner resolves the pod's Discord tool +
  // its owner itself and no-ops when mailFeed is disabled. Idempotent (watermark).
  registerOpenApi(app, {
    method: "post",
    path: "/discord/mail-feed/run",
    tags: ["Discord"],
    summary: "Run the Gmail mail feed now (on-demand)",
    description:
      "Invokes the mail-feed runner in-process (gmail_search → triage → post into the Discord-bound channel) and returns the run summary. No-ops when the Discord tool's mailFeed is disabled. Idempotent via the watermark.",
    responses: {
      200: { description: "Run summary", schema: MailFeedRunResponseSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/discord/mail-feed/run", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    try {
      const result = await runMailFeed();
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err }, "POST /discord/mail-feed/run failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /discord/event-sync/run ───────────────────────────────────────────
  // On-demand trigger for the event sync — the SAME api-side runner the
  // `event-sync-cron` fires. Returns the created/processed counts synchronously.
  // No body: the runner resolves the Discord tool + owner and no-ops when
  // eventSync is disabled. Idempotent (dedup map in the tool metadata).
  registerOpenApi(app, {
    method: "post",
    path: "/discord/event-sync/run",
    tags: ["Discord"],
    summary: "Run the Google Calendar event sync now (on-demand)",
    description:
      "Invokes the event-sync runner in-process (event entities + stellar deadlines + calendar_list → native Discord scheduled events) and returns the run summary. No-ops when the Discord tool's eventSync is disabled. Idempotent via the dedup map.",
    responses: {
      200: { description: "Run summary", schema: EventSyncRunResponseSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/discord/event-sync/run", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    try {
      const result = await runEventSync();
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err }, "POST /discord/event-sync/run failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
