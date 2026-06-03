/**
 * Hub Protocol REST — proposals
 */

import { TRPCError } from "@trpc/server";
import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateProposalRequestSchema,
  CreateProposalResponseSchema,
  ListProposalsQuerySchema,
  UpdateProposalRequestSchema,
  WireProposalSchema,
} from "./_codecs/proposal.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getCaller,
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  type HubHono,
} from "./_shared.js";
import { createEventBackedProposal } from "../../../utils/event-backed-proposal.js";

export function registerProposalsRoutes(app: HubHono): void {
  // ── OpenAPI metadata for /proposals* routes ──────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/proposals",
    tags: ["Proposals"],
    summary: "List proposals",
    description:
      "Returns proposals for the authenticated user / a workspace. Default status filter is `pending`.",
    request: {
      query: ListProposalsQuerySchema,
    },
    responses: {
      200: {
        description: "Array of proposals",
        schema: z.array(WireProposalSchema),
      },
      403: { description: "Missing scope", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/proposals/{id}",
    tags: ["Proposals"],
    summary: "Revise a pending proposal",
    description:
      "Replaces a pending proposal's payload (e.g. AI revising its proposal after user feedback). Does NOT re-run the event pipeline.",
    request: {
      params: z.object({ id: z.string() }),
      body: UpdateProposalRequestSchema,
    },
    responses: {
      200: { description: "Updated proposal", schema: WireProposalSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Proposal not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/proposals",
    tags: ["Proposals"],
    summary: "Create a proposal",
    description:
      "Creates a pending proposal on behalf of an agent. Returns the new proposal id with status `pending`.",
    request: {
      body: CreateProposalRequestSchema,
    },
    responses: {
      200: {
        description: "Created proposal",
        schema: CreateProposalResponseSchema,
      },
      400: { description: "Missing required fields", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /proposals?userId=...&workspaceId=...&status=...
   */
  app.get("/proposals", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const userId = c.req.query("userId") || (c.get("userId") as string);
    const workspaceId = c.req.query("workspaceId");
    const status =
      (c.req.query("status") as "pending" | "approved" | "rejected" | "all") ||
      "pending";
    try {
      const effectiveWsId =
        workspaceId ||
        (await getUserAccessibleWorkspaceIds(userId))[0] ||
        undefined;
      const caller = await getCaller(c, { workspaceId: effectiveWsId });
      const result = await caller.proposals.listProposals({
        userId,
        workspaceId: effectiveWsId,
        status,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "listProposals failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * PATCH /proposals/:id
   * AI revises a pending proposal (no event pipeline re-run)
   * Body: { data: {...}, summary?: string }
   */
  app.patch("/proposals/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const proposalId = c.req.param("id");
    const body = (await c.req.json()) as {
      data: Record<string, unknown>;
      summary?: string;
    };
    try {
      const caller = await getCaller(c);
      const result = await caller.proposals.updateProposal({
        proposalId,
        data: body.data,
        summary: body.summary,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, proposalId }, "updateProposal failed");
      const code =
        err instanceof TRPCError && err.code === "NOT_FOUND"
          ? 404
          : err instanceof TRPCError && err.code === "BAD_REQUEST"
            ? 400
            : 500;
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        code
      );
    }
  });

  /**
   * POST /proposals
   * Create a new proposal on behalf of an agent.
   */
  app.post("/proposals", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = (await c.req.json()) as {
      workspaceId?: string | null;
      agentUserId?: string;
      channelId?: string;
      targetType: string;
      targetId: string;
      proposalType: string;
      data: Record<string, unknown>;
      summary?: string;
      sourceMessageId?: string;
    };
    if (
      !body.targetType ||
      !body.targetId ||
      !body.proposalType ||
      !body.data
    ) {
      return c.json(
        {
          error: "targetType, targetId, proposalType, and data are required",
        },
        400
      );
    }
    try {
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const userId = resolvedAgentUserId ?? (c.get("userId") as string);
      const action = inferProposalAction(body.proposalType);
      const isRequestShaped =
        typeof body.data.requestId === "string" &&
        typeof body.data.targetType === "string" &&
        typeof body.data.changeType === "string";
      const { proposal } = await createEventBackedProposal({
        userId,
        workspaceId: body.workspaceId ?? null,
        targetType: body.targetType,
        targetId: body.targetId,
        proposalType: body.proposalType,
        action,
        source: "intelligence",
        summary: body.summary,
        agentUserId: resolvedAgentUserId ?? null,
        createdBy: resolvedAgentUserId ?? userId,
        threadId: body.channelId ?? null,
        sourceMessageId: body.sourceMessageId ?? null,
        data: isRequestShaped
          ? {
              ...body.data,
              source: body.data.source ?? "agent",
              sourceId: body.data.sourceId ?? userId,
            }
          : {
              ...body.data,
              source: "agent",
              sourceId: userId,
              changeType: action,
              ...(body.summary ? { summary: body.summary } : {}),
            },
      });
      return c.json({ id: proposal.id, status: "pending" });
    } catch (err) {
      logger.error({ err }, "createProposal failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}

function inferProposalAction(proposalType: string): string {
  const parts = proposalType.split(".");
  return parts[1] || parts[0] || "update";
}
