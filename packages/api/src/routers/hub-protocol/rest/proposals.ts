/**
 * Hub Protocol REST — proposals
 */

import { TRPCError } from "@trpc/server";
import { z } from "@hono/zod-openapi";
import { getConfinedWorkspace } from "../confine-workspace.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateProposalRequestSchema,
  CreateProposalResponseSchema,
  ListProposalsQuerySchema,
  PROPOSAL_STATUS_FILTERS,
  PROPOSAL_VIEWS,
  ProposalBasicSchema,
  type ProposalStatusFilter,
  toProposalBasic,
  UpdateProposalRequestSchema,
  WireProposalSchema,
} from "./_codecs/proposal.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getCaller,
  hasScope,
  isUuid,
  logger,
  rejectAgentReviewer,
  resolveProposalId,
  type HubHono,
} from "./_shared.js";
import { createEventBackedProposal } from "../../../utils/event-backed-proposal.js";
import { proposalsRouter as mainProposalsRouter } from "../../proposals.js";
import { createHubProtocolCallerContext } from "../utils.js";

export function registerProposalsRoutes(app: HubHono): void {
  // ── OpenAPI metadata for /proposals* routes ──────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/proposals",
    tags: ["Proposals"],
    summary: "List proposals",
    description:
      "Returns proposals for the authenticated user / a workspace. Default status filter is `pending`; " +
      "`auto_approved` lists the audit receipts of agent writes that executed immediately under governance. " +
      "`view=basic` returns the summary representation (identity + provenance, no `data`); the default " +
      "`view=full` returns the detailed representation unchanged.",
    request: {
      query: ListProposalsQuerySchema,
    },
    responses: {
      200: {
        // The handler returns the tRPC `listProposals` result verbatim, which
        // is `{ proposals: [...] }` — NOT a bare array. The previous
        // `z.array(WireProposalSchema)` declaration never matched the wire.
        description:
          "Proposals — full rows by default, basic rows when `view=basic`",
        schema: z.object({
          proposals: z.union([
            z.array(WireProposalSchema),
            z.array(ProposalBasicSchema),
          ]),
        }),
      },
      400: {
        description:
          "Malformed sessionId/workspaceId, or unknown status / view",
        schema: ErrorSchema,
      },
      403: { description: "Missing scope", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/proposals/{id}",
    tags: ["Proposals"],
    summary: "Get a single proposal by id",
    description:
      "Fetches one proposal's full current state — including `data` (e.g. a " +
      "capability.run proposal's `runResult` once approved). Callers previously " +
      "had no single-lookup door and had to page through GET /proposals to find " +
      "one by id.",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: { description: "The proposal", schema: WireProposalSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Proposal not found", schema: ErrorSchema },
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
    path: "/proposals/{id}/revert",
    tags: ["Proposals"],
    summary: "Revert an approved proposal",
    description:
      "Undoes the effect of an approved/auto-approved proposal: deletes the entities/relations/documents the approval created. Update and delete proposals cannot be reverted (no before-snapshot) and return 501.",
    request: {
      params: z.object({ id: z.string() }),
      body: z.object({ reason: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Revert applied",
        schema: z.object({
          success: z.boolean(),
          reverted: z.object({
            entityIds: z.array(z.string()).optional(),
            relationIds: z.array(z.string()).optional(),
            documentIds: z.array(z.string()).optional(),
          }),
        }),
      },
      400: {
        description: "Not revertible (wrong status)",
        schema: ErrorSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Proposal not found", schema: ErrorSchema },
      501: { description: "Revert not supported", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/proposals/{id}/approve",
    tags: ["Proposals"],
    summary: "Approve a pending proposal",
    description:
      "Approves a pending proposal, executing its effect immediately. Delegates to the canonical `proposals.approve` tRPC mutation, then re-fetches the proposal so the response carries its post-execution state (e.g. a capability.run's `data.runResult` — success + returned data, or the exact denial reason on failure) in the SAME round trip instead of requiring a separate GET.",
    request: {
      params: z.object({ id: z.string() }),
      body: z.object({ reason: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Proposal approved",
        schema: z.object({
          success: z.boolean(),
          proposalId: z.string(),
          proposal: WireProposalSchema.optional(),
        }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Proposal not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/proposals/{id}/reject",
    tags: ["Proposals"],
    summary: "Reject a pending proposal",
    description:
      "Rejects a pending proposal. Delegates to the canonical `proposals.reject` tRPC mutation.",
    request: {
      params: z.object({ id: z.string() }),
      body: z.object({ reason: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Proposal rejected",
        schema: z.object({ success: z.boolean(), proposalId: z.string() }),
      },
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
    const sessionId = c.req.query("sessionId");
    // Shape-check the uuid FILTERS before forwarding. Both reach `uuid` columns;
    // a malformed value makes Postgres throw invalid-uuid-syntax, which the
    // catch below maps to 500 — so a client typo reported as a server fault.
    // (Same trap `resolveProposalId` exists to close for proposal ids.) A
    // well-formed id that matches nothing is NOT an error: it correctly returns
    // an empty queue.
    for (const [name, value] of [
      ["sessionId", sessionId],
      ["workspaceId", workspaceId],
    ] as const) {
      if (value && !isUuid(value)) {
        return c.json(
          { error: `Invalid ${name}: "${value}" is not a uuid` },
          400
        );
      }
    }
    // Mirrors the tRPC `listProposals` enum EXACTLY — including `auto_approved`
    // (the audit receipt every auto-approved agent write leaves) and the other
    // terminal states the `proposals.status` column can hold. Validated here
    // rather than blind-cast: an unknown value used to slip past the cast, get
    // rejected by the zod enum downstream, and surface through the catch below
    // as a 500 for what is a client typo.
    const rawStatus = c.req.query("status") || "pending";
    const status = rawStatus as ProposalStatusFilter;
    if (!(PROPOSAL_STATUS_FILTERS as readonly string[]).includes(rawStatus)) {
      return c.json(
        {
          error: `Invalid status: "${rawStatus}". Expected one of ${PROPOSAL_STATUS_FILTERS.join(", ")}`,
        },
        400
      );
    }
    // AIP-157 `view`: absent ⇒ `full` ⇒ byte-for-byte today's response. Only an
    // explicit `view=basic` opts into the summary representation, so no existing
    // caller (or generated client) changes behaviour.
    const rawView = c.req.query("view") ?? "full";
    if (!(PROPOSAL_VIEWS as readonly string[]).includes(rawView)) {
      return c.json(
        {
          error: `Invalid view: "${rawView}". Expected one of ${PROPOSAL_VIEWS.join(", ")}`,
        },
        400
      );
    }
    try {
      // No workspaceId = the USER-WIDE queue (the user floor), NOT an arbitrary
      // first workspace. listProposals always applies userVisibleWhere; a
      // workspaceId only NARROWS. The old `|| wsIds[0]` fallback silently scoped
      // the queue to one workspace, hiding proposals everywhere else (e.g. a
      // session proposal filed in a non-default workspace went invisible).
      const caller = await getCaller(c, {
        workspaceId: workspaceId ?? undefined,
      });
      const result = await caller.proposals.listProposals({
        userId,
        ...(workspaceId ? { workspaceId } : {}),
        status,
        ...(sessionId ? { sessionId } : {}),
      });
      if (rawView === "basic") {
        return c.json({
          proposals: (
            result.proposals as unknown as Record<string, unknown>[]
          ).map(toProposalBasic),
        });
      }
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
   * GET /proposals/:id
   * Fetch one proposal by id — the single-lookup door that was missing
   * (callers had to page through GET /proposals and filter client-side).
   */
  app.get("/proposals/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const proposalId = c.req.param("id");
    try {
      const userId = c.get("userId") as string;
      const scopes = c.get("scopes") as string[];
      const resolvedId = await resolveProposalId(userId, proposalId);
      const ctx = await createHubProtocolCallerContext(userId, scopes);
      const caller = mainProposalsRouter.createCaller(
        ctx as Parameters<typeof mainProposalsRouter.createCaller>[0]
      );
      const result = await caller.get({ proposalId: resolvedId });
      return c.json(result);
    } catch (err) {
      logger.error({ err, proposalId }, "getProposal failed");
      const code =
        err instanceof TRPCError && err.code === "NOT_FOUND"
          ? 404
          : err instanceof TRPCError && err.code === "FORBIDDEN"
            ? 403
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
      const resolvedId = await resolveProposalId(
        c.get("userId") as string,
        proposalId
      );
      const caller = await getCaller(c);
      const result = await caller.proposals.updateProposal({
        proposalId: resolvedId,
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
            : // The shared revise core throws CONFLICT for a no-longer-pending
              // proposal (concurrent approve/reject) — surface it as 409, not a
              // blanket 500, so the caller can tell a race from a server fault.
              err instanceof TRPCError && err.code === "CONFLICT"
              ? 409
              : 500;
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        code
      );
    }
  });

  /**
   * POST /proposals/:id/revert
   * Undo an approved/auto-approved proposal's effect. Delegates to the canonical
   * `proposals.revert` tRPC mutation (governed deletes via the entity / relation
   * / document routers) so behavior is identical to the in-app revert.
   */
  app.post("/proposals/:id/revert", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    // SECURITY — revert is a human review action (it executes ungated writes:
    // deletes what a create made, or restores what a delete removed). Block agent
    // credentials — same self-review class the /approve guard closes.
    const blocked = rejectAgentReviewer(c, "revert");
    if (blocked) return blocked;
    const proposalId = c.req.param("id");
    let reason: string | undefined;
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        reason?: string;
      };
      reason = typeof body.reason === "string" ? body.reason : undefined;
    } catch {
      reason = undefined;
    }
    try {
      const userId = c.get("userId") as string;
      const scopes = c.get("scopes") as string[];
      const resolvedId = await resolveProposalId(userId, proposalId);
      const ctx = await createHubProtocolCallerContext(userId, scopes);
      const caller = mainProposalsRouter.createCaller(
        ctx as Parameters<typeof mainProposalsRouter.createCaller>[0]
      );
      const result = await caller.revert({ proposalId: resolvedId, reason });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, proposalId }, "revertProposal failed");
      const code =
        err instanceof TRPCError && err.code === "NOT_FOUND"
          ? 404
          : err instanceof TRPCError && err.code === "BAD_REQUEST"
            ? 400
            : err instanceof TRPCError && err.code === "FORBIDDEN"
              ? 403
              : err instanceof TRPCError && err.code === "NOT_IMPLEMENTED"
                ? 501
                : 500;
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        code
      );
    }
  });

  /**
   * POST /proposals/:id/approve
   * Approve a pending proposal. Delegates to the canonical `proposals.approve`
   * tRPC mutation so behavior is identical to the in-app approve flow.
   */
  app.post("/proposals/:id/approve", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    // SECURITY — an AGENT credential must never APPROVE a proposal (the human
    // review step). See rejectAgentReviewer for the full rationale.
    const blocked = rejectAgentReviewer(c, "approve");
    if (blocked) return blocked;
    const proposalId = c.req.param("id");
    try {
      const userId = c.get("userId") as string;
      const scopes = c.get("scopes") as string[];
      // Accept the git-style short id the CLI shows — resolve it to the full uuid.
      const resolvedId = await resolveProposalId(userId, proposalId);
      const ctx = await createHubProtocolCallerContext(userId, scopes);
      const caller = mainProposalsRouter.createCaller(
        ctx as Parameters<typeof mainProposalsRouter.createCaller>[0]
      );
      await caller.approve({ proposalId: resolvedId });
      // Re-fetch so the caller sees the post-execution state in ONE round trip —
      // e.g. a capability.run's data.runResult (success + returned data, or the
      // exact denial reason like "Capability is not approved") — instead of the
      // bare {success:true} the executor itself returns (execution outcome is
      // persisted onto the proposal row, not returned from the mutation call).
      const proposal = await caller
        .get({ proposalId: resolvedId })
        .catch(() => null);
      return c.json({ success: true, proposalId: resolvedId, proposal }, 200);
    } catch (err) {
      logger.error({ err, proposalId }, "approveProposal failed");
      const code =
        err instanceof TRPCError && err.code === "NOT_FOUND"
          ? 404
          : err instanceof TRPCError && err.code === "FORBIDDEN"
            ? 403
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
   * POST /proposals/:id/reject
   * Reject a pending proposal. Delegates to the canonical `proposals.reject`
   * tRPC mutation so behavior is identical to the in-app reject flow.
   *
   * NOTE: unlike /approve and /revert, reject is INTENTIONALLY not guarded
   * against agent credentials — rejection only prevents a pending change from
   * landing, so it carries no self-approval / undo risk. (An agent auto-rejecting
   * its own proposals is a no-op, not a governance bypass.)
   */
  app.post("/proposals/:id/reject", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const proposalId = c.req.param("id");
    let reason: string | undefined;
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        reason?: string;
      };
      reason = typeof body.reason === "string" ? body.reason : undefined;
    } catch {
      reason = undefined;
    }
    try {
      const userId = c.get("userId") as string;
      const scopes = c.get("scopes") as string[];
      const resolvedId = await resolveProposalId(userId, proposalId);
      const ctx = await createHubProtocolCallerContext(userId, scopes);
      const caller = mainProposalsRouter.createCaller(
        ctx as Parameters<typeof mainProposalsRouter.createCaller>[0]
      );
      await caller.reject({ proposalId: resolvedId, reason });
      return c.json({ success: true, proposalId: resolvedId }, 200);
    } catch (err) {
      logger.error({ err, proposalId }, "rejectProposal failed");
      const code =
        err instanceof TRPCError && err.code === "NOT_FOUND"
          ? 404
          : err instanceof TRPCError && err.code === "FORBIDDEN"
            ? 403
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
      sessionId?: string;
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
    // Item 3 Part 3: confine a bound service key to its workspace before the write.
    const workspaceId = getConfinedWorkspace(c, body.workspaceId) ?? null;
    try {
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const userId = resolvedAgentUserId ?? (c.get("userId") as string);
      const action = inferProposalAction(body.proposalType);
      // sessionId resolution: explicit body field > X-Session-Id header > null
      const sessionId = body.sessionId ?? c.get("sessionId") ?? null;
      const isRequestShaped =
        typeof body.data.requestId === "string" &&
        typeof body.data.targetType === "string" &&
        typeof body.data.changeType === "string";
      const { proposal } = await createEventBackedProposal({
        userId,
        workspaceId,
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
        sessionId,
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
