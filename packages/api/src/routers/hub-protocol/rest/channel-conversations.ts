/**
 * Hub Protocol REST — a space's conversations, and the person's own send
 * (CRM Messages contract b4f8c2cd, A and D; build map ca310f27 slice 1).
 *
 *   GET  /channels/conversations?workspaceId&needsYou&cursor&limit
 *        every person the caller is reaching out to in one space, in one
 *        read (`listSpaceConversations`, services/channels/
 *        space-conversations.ts). On the fence as `NARROWED("channel")`:
 *        the route narrows itself (people, channels and drafts each through
 *        the caller's floor and the key's grant), and a key limited to spaces
 *        must hold `channel.read` in the space it asks about.
 *
 *   POST /channels/{channelId}/send {text, subject?, draftId?, workspaceId?,
 *        expectedRevision?}
 *        the PERSON sends on their own channel: what is in the message box
 *        goes out, and their click is the approval. With `draftId` the
 *        draft's words are replaced (the recipient stays pinned) and it is
 *        approved; without one the message is filed (`sendExternalMessage`,
 *        the one governed send door), then approved. Through the same
 *        approval as everywhere (`proposals.approve`): the key needs the
 *        approve right, an agent never sends here. Someone not reachable yet
 *        (not a LinkedIn connection) keeps the text as a HELD draft:
 *        `{status: 'held'}`, never an error that loses it.
 *
 *   POST /channels/linkedin-reach/{personId}
 *        measure one person's LinkedIn reach now (finding 491ba787): one
 *        profile read with the owner's LinkedIn account, the reach fact and
 *        the member id recorded on the person (`readLinkedinReach`,
 *        services/channels/linkedin-reach-read.ts). Machine-written system
 *        facts and a provider read, like the daily sweep: no proposal. On
 *        the fence as a POST read, `NARROWED("channel")`: the person is read
 *        through the caller's floor and the key's grant (404 otherwise). A
 *        failed read writes nothing and answers its error.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { db, getRequestGrant } from "@synap/database";
import { permits } from "@synap/governance-policy/grants";
import { isFencedGrant } from "../../../access/grant-door-fence.js";
import { sendExternalMessage } from "../../../connectors/external-dispatch.js";
import {
  loadSendChannel,
  messagingSendGrantVerdict,
} from "../../../connectors/channel-send.js";
import { canUserSeeChannel } from "../../../utils/channel-visibility.js";
import { mergeProposalRevision } from "../../../services/proposals/proposals-service.js";
import {
  findOpenDraftOnChannel,
  readSendOutcome,
} from "../../../services/channels/person-send.js";
import { listSpaceConversations } from "../../../services/channels/space-conversations.js";
import { readLinkedinReach } from "../../../services/channels/linkedin-reach-read.js";
import { proposalsRouter as mainProposalsRouter } from "../../proposals.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  ChannelSendRequestSchema,
  ChannelSendResponseSchema,
  LinkedinReachResponseSchema,
  SpaceConversationsQuerySchema,
  SpaceConversationsResponseSchema,
} from "./_codecs/channel.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  readJsonBody,
  rejectAgentReviewer,
  uuidPathParam,
  verifyWorkspaceReadAccess,
  type HubHono,
} from "./_shared.js";

export function registerChannelConversationsRoutes(app: HubHono): void {
  // ── GET /channels/conversations ──────────────────────────────────────────
  const conversationsRoute = createRoute({
    method: "get",
    path: "/channels/conversations",
    tags: ["Channels"],
    summary: "List a space's conversations",
    description:
      "Every person the caller is reaching out to in one space, in one read, " +
      "newest activity first: a person with an external channel or an " +
      "open send who is a lead of the space, themselves (a role in it) or " +
      "through the company they work at (`works_at` a company with a role " +
      "in it). Each row: the person (name, company), the lead it is listed " +
      "for (`lead`: kind, id, stage), their channel ids, the last message, the draft waiting " +
      "(`draft`, `held` = not sendable yet, or `failed` with its reason), " +
      "unread inbound messages and their LinkedIn reach. `needsYou=true` " +
      "keeps the people a draft, a failed send or an unread message waits " +
      "on. Paged by `cursor` (`nextCursor`).",
    request: { query: SpaceConversationsQuerySchema },
    responses: {
      200: {
        description: "The space's conversations",
        content: {
          "application/json": { schema: SpaceConversationsResponseSchema },
        },
      },
      400: {
        description: "Invalid cursor",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(conversationsRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const { workspaceId, needsYou, cursor, limit } = c.req.valid("query");
    // The space: the person reads it, and a key limited to spaces holds
    // `channel.read` there (the fence admitted it on `channel.read` anywhere).
    if (!(await verifyWorkspaceReadAccess(userId, workspaceId))) {
      return c.json({ error: "Space not found or access denied" }, 403);
    }
    const grant = getRequestGrant();
    if (
      isFencedGrant(grant) &&
      !grant!.scopes.some((s) =>
        permits(s, {
          subject: "channel",
          action: "read",
          qualifier: null,
          workspaceId,
          entityId: null,
          projectIds: null,
        })
      )
    ) {
      return c.json(
        {
          error:
            "This key may not read conversations in this space. Give it 'channel.read' there.",
          code: "GRANT_DENIED",
        },
        403
      );
    }
    try {
      const result = await listSpaceConversations({
        userId,
        workspaceId,
        needsYou: needsYou === "true",
        cursor: cursor ?? null,
        limit,
      });
      if (result.status === "bad_cursor") {
        return c.json({ error: "Invalid cursor" }, 400);
      }
      return c.json(
        {
          conversations: result.conversations,
          nextCursor: result.nextCursor,
        },
        200
      );
    } catch (err) {
      logger.error({ err, workspaceId }, "GET /channels/conversations");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err) as never
      );
    }
  });

  // ── POST /channels/linkedin-reach/:personId ──────────────────────────────
  // Static segment first: registered before any `/channels/:id/…` POST.
  registerOpenApi(app, {
    method: "post",
    path: "/channels/linkedin-reach/:personId",
    tags: ["Channels"],
    summary: "Measure a person's LinkedIn reach now",
    description:
      "Reads the person's LinkedIn profile once with the owner's connected " +
      "LinkedIn account (from its daily lookup budget) and records what it " +
      "says on the person: `linkedinConnection` (a 1st-degree connection is " +
      "`connected`, which makes their held messages sendable; a profile that " +
      "only says 'not connected' keeps a stored fact) and `linkedinProviderId` " +
      "when none is stored. Answers the reach stored after the read. A read " +
      "that fails writes nothing.",
    request: { params: z.object({ personId: uuidPathParam }) },
    responses: {
      200: {
        description: "The reach recorded",
        schema: LinkedinReachResponseSchema,
      },
      400: { description: "Invalid personId", schema: ErrorSchema },
      403: {
        description: "Forbidden, or the person is not the caller's own",
        schema: ErrorSchema,
      },
      404: {
        description: "No person the caller reads, or no such LinkedIn member",
        schema: ErrorSchema,
      },
      409: {
        description:
          "Nothing to read with: no connected LinkedIn account (or two), or no LinkedIn id or profile URL on the person",
        schema: ErrorSchema,
      },
      429: {
        description: "Today's LinkedIn profile lookups are spent",
        schema: ErrorSchema,
      },
      502: { description: "The LinkedIn read failed", schema: ErrorSchema },
      503: {
        description: "No messaging service reads LinkedIn profiles",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/channels/linkedin-reach/:personId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const personId = c.req.param("personId");
    if (!z.string().uuid().safeParse(personId).success) {
      return c.json({ error: "Invalid personId" }, 400);
    }
    try {
      const r = await readLinkedinReach({ userId, personId });
      switch (r.status) {
        case "measured":
          return c.json(
            {
              reach: r.reach,
              invitedAt: r.invitedAt,
              providerId: r.providerId,
            },
            200
          );
        case "not_found":
          return c.json({ error: "Person not found" }, 404);
        case "not_owner":
          return c.json(
            {
              error:
                "Only the person's owner can measure their LinkedIn reach, with their own LinkedIn account.",
              code: "NOT_OWNER",
            },
            403
          );
        case "unconfigured":
          return c.json(
            {
              error:
                "No messaging service on this pod reads LinkedIn profiles.",
              code: "UNCONFIGURED",
            },
            503
          );
        case "no_account":
          return c.json(
            {
              error:
                r.accounts === 0
                  ? "Connect a LinkedIn account first."
                  : "Several LinkedIn accounts are connected: the pod does not guess which one reads.",
              code: "NO_ACCOUNT",
            },
            409
          );
        case "no_identifier":
          return c.json(
            {
              error:
                "No LinkedIn id or profile URL on this person: add their LinkedIn profile URL first.",
              code: "NO_IDENTIFIER",
            },
            409
          );
        case "no_budget":
          return c.json(
            {
              error:
                "Today's LinkedIn profile lookups are spent. Try again tomorrow.",
              code: "NO_BUDGET",
            },
            429
          );
        case "not_on_linkedin":
          return c.json(
            { error: "LinkedIn has no such member.", code: "NOT_ON_LINKEDIN" },
            404
          );
        case "failed":
          return c.json(
            {
              error: `The LinkedIn read failed; nothing was recorded. ${r.error}`,
              code: "PROVIDER_FAILED",
            },
            502
          );
      }
    } catch (err) {
      logger.error({ err, personId }, "POST /channels/linkedin-reach/:id");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err) as never
      );
    }
  });

  // ── POST /channels/:channelId/send ───────────────────────────────────────
  const ChannelSendBodySchema = ChannelSendRequestSchema.extend({
    workspaceId: z
      .string()
      .uuid()
      .optional()
      .describe("The space the app acts in (where the message is filed)."),
  });
  registerOpenApi(app, {
    method: "post",
    path: "/channels/:channelId/send",
    tags: ["Channels"],
    summary: "Send a message as the person on their own channel",
    description:
      "The person sends what is in the message box; their click is the " +
      "approval. With `draftId`, that draft's words are replaced by `text` " +
      "(the recipient stays) and it is approved; without one the message is " +
      "filed, then approved. `sent` = it went out. `held` = the person is " +
      "not reachable yet (not a LinkedIn connection): the text is kept as a " +
      "held draft, `reason` names the next step. `failed` = it did not go " +
      "out (`reason`), the text is kept on the failed send. Needs the approve " +
      "right; an agent never sends here.",
    request: {
      params: z.object({ channelId: uuidPathParam }),
      body: ChannelSendBodySchema,
    },
    responses: {
      200: {
        description: "What happened to the message",
        schema: ChannelSendResponseSchema,
      },
      400: { description: "Invalid body", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: {
        description: "No conversation or draft the caller can read",
        schema: ErrorSchema,
      },
      409: {
        description: "The draft changed since it was read",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/channels/:channelId/send", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    // The person's click is the approval: an agent never sends here (it
    // files a draft through the intent actions instead).
    const blocked = rejectAgentReviewer(c, "approve");
    if (blocked) return blocked;
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const channelId = c.req.param("channelId");
    if (!z.string().uuid().safeParse(channelId).success) {
      return c.json({ error: "Invalid channelId" }, 400);
    }
    const jsonRead = await readJsonBody(c);
    if (!jsonRead.ok) return jsonRead.res;
    const parsed = ChannelSendBodySchema.safeParse(jsonRead.body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", issues: parsed.error.issues },
        400
      );
    }
    const { text, subject, draftId, expectedRevision, workspaceId } =
      parsed.data;

    try {
      // The conversation: one the caller reads, external, live, and theirs.
      const channel = await loadSendChannel(channelId);
      if (
        !channel ||
        channel.channelType !== "external" ||
        channel.status !== "active" ||
        !(await canUserSeeChannel(db, channelId, userId))
      ) {
        return c.json({ error: "Conversation not found" }, 404);
      }
      if (channel.userId !== userId) {
        return c.json(
          {
            error: "Only the person whose conversation this is can send in it.",
          },
          403
        );
      }
      // The key's grant on a send in this conversation (the send door's own
      // check): a key that may not send is refused before anything changes.
      const verdict = await messagingSendGrantVerdict({
        channel,
        userId,
        agentUserId: null,
        actingWorkspaceId: workspaceId ?? null,
      });
      if (verdict) {
        return c.json({ error: verdict.denial, code: "GRANT_DENIED" }, 403);
      }

      let proposalId: string;
      let revision = expectedRevision;
      if (draftId) {
        // The draft: a send on THIS channel the caller reads, still open.
        const draft = await findOpenDraftOnChannel({
          userId,
          draftId,
          channelId,
        });
        if (!draft) return c.json({ error: "Draft not found" }, 404);
        const data = (draft.data ?? {}) as Record<string, unknown>;
        const reworded =
          data.body !== text ||
          (subject !== undefined && data.subject !== subject);
        if (reworded) {
          // The words only: who it goes to stays pinned (PROTECTED_FIELDS_BY_TYPE).
          await mergeProposalRevision({
            proposalId: draft.id,
            patch: {
              kind: "inner",
              fields: {
                body: text,
                ...(subject !== undefined ? { subject } : {}),
              },
            },
            actorId: userId,
            ...(expectedRevision !== undefined ? { expectedRevision } : {}),
          });
          const seen = Array.isArray(draft.revisionHistory)
            ? draft.revisionHistory.length
            : 0;
          revision = (expectedRevision ?? seen) + 1;
        }
        proposalId = draft.id;
      } else {
        // File it through the one governed send door: always a proposal here
        // (the approval below is the person's click).
        const filed = await sendExternalMessage({
          channelId,
          threadId: null,
          accountId: "",
          body: text,
          userId,
          agentUserId: null,
          workspaceId: workspaceId ?? null,
          mustPropose: true,
          subject: subject ?? null,
        });
        if (!filed.proposed || !filed.proposalId) {
          return c.json(
            {
              error: filed.error ?? "Nothing was filed.",
              ...(filed.errorClass ? { code: filed.errorClass } : {}),
            },
            filed.errorClass === "target_missing" ? 404 : 403
          );
        }
        if (filed.held) {
          return c.json(
            {
              status: "held" as const,
              proposalId: filed.proposalId,
              reason: filed.held.reason,
            },
            200
          );
        }
        proposalId = filed.proposalId;
      }

      // The person's click is the approval: the one approve door.
      const ctx = await createHubProtocolCallerContext(
        userId,
        c.get("scopes") as string[]
      );
      const caller = mainProposalsRouter.createCaller(
        ctx as Parameters<typeof mainProposalsRouter.createCaller>[0]
      );
      try {
        await caller.approve({
          proposalId,
          ...(revision !== undefined ? { expectedRevision: revision } : {}),
        });
      } catch (err) {
        const outcome = await readSendOutcome(proposalId);
        if (outcome.status === "held" || outcome.status === "failed") {
          return c.json(
            {
              status: outcome.status,
              proposalId,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
            },
            200
          );
        }
        // Refused before anything ran (no approve right, a stale revision):
        // the draft stays as it is, named so the caller can come back to it.
        return c.json(
          {
            error: err instanceof Error ? err.message : "Unknown error",
            proposalId,
          },
          httpStatusForTrpcError(err) as never
        );
      }
      const outcome = await readSendOutcome(proposalId);
      return c.json(
        {
          status: (outcome.status ?? "sent") as "sent" | "held" | "failed",
          proposalId,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        },
        200
      );
    } catch (err) {
      logger.error({ err, channelId }, "POST /channels/:id/send");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err) as never
      );
    }
  });
}
