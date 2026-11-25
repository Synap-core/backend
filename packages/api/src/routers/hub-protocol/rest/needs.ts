/**
 * Hub Protocol REST — a space's NEEDS (founder decisions D2 and D3, 16 Nov
 * 2026; migration 0426).
 *
 *   GET /workspaces/:workspaceId/needs          the vocabulary, and the needs
 *                                               the space's processes declare,
 *                                               each filled or empty
 *   PUT /workspaces/:workspaceId/needs/:need    fill (or clear, null) one need
 *
 * Same service as tRPC `needs` (`services/needs/space-need-door.ts`): one
 * read, one governed write (`checkPermissionOrPropose`, `workspace/bind_need`).
 * An agent caller gets `{ status: "proposed", proposalId, reviewUrl }` (202).
 */
import { z as zOpenapi } from "@hono/zod-openapi";
import { ErrorSchema, uuidQueryParam } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { jsonGoverned } from "../proposal-response.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  requireUuidParam,
  verifyWorkspaceReadAccess,
  type HubHono,
} from "./_shared.js";

const NeedSchema = zOpenapi.object({
  slug: zOpenapi.string(),
  label: zOpenapi.string(),
  description: zOpenapi.string(),
  intents: zOpenapi.array(zOpenapi.string()),
  aliases: zOpenapi.array(zOpenapi.string()),
});

const NeedCoverageSchema = zOpenapi.object({
  need: zOpenapi.string(),
  label: zOpenapi.string().nullable(),
  known: zOpenapi.boolean(),
  state: zOpenapi.enum(["filled", "empty"]),
  implicit: zOpenapi.boolean(),
  provider: zOpenapi
    .object({
      capabilityId: zOpenapi.string(),
      name: zOpenapi.string().nullable(),
    })
    .nullable(),
  binding: zOpenapi
    .object({
      bindingId: zOpenapi.string(),
      setBy: zOpenapi.string(),
      updatedAt: zOpenapi.string(),
      origin: zOpenapi.enum(["person", "automatic"]),
    })
    .nullable(),
  candidates: zOpenapi.array(
    zOpenapi.object({
      capabilityId: zOpenapi.string(),
      name: zOpenapi.string(),
    })
  ),
});

const SpaceNeedsResponseSchema = zOpenapi.object({
  vocabulary: zOpenapi.array(NeedSchema),
  coverage: zOpenapi.object({
    workspaceId: zOpenapi.string(),
    needs: zOpenapi.array(NeedCoverageSchema),
    empty: zOpenapi.array(zOpenapi.string()),
  }),
});

const BindNeedBodySchema = zOpenapi.object({
  providerCapabilityId: uuidQueryParam.nullable(),
});

const BindNeedResponseSchema = zOpenapi.object({
  status: zOpenapi.enum(["applied", "proposed"]),
  result: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()).optional(),
  proposalId: zOpenapi.string().optional(),
  reviewUrl: zOpenapi.string().optional(),
});

export function registerNeedsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/workspaces/{workspaceId}/needs",
    tags: ["Workspaces"],
    summary:
      "A space's needs: the vocabulary, and each declared need filled or empty",
    description:
      "The needs a space's processes name (`need:` refs of its playbooks and " +
      "automations), each `filled` (with the provider the space bound) or " +
      "`empty` (with the installed capabilities that declare they fill it), " +
      "plus the need vocabulary. Space members only. Requires " +
      "hub-protocol.read scope.",
    request: { params: zOpenapi.object({ workspaceId: uuidQueryParam }) },
    responses: {
      200: {
        description: "The space's needs",
        schema: SpaceNeedsResponseSchema,
      },
      400: { description: "Invalid workspace id", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/workspaces/:workspaceId/needs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const workspaceId = requireUuidParam(c, "workspaceId");
    if (workspaceId instanceof Response) return workspaceId;
    if (!(await verifyWorkspaceReadAccess(userId, workspaceId))) {
      return c.json({ error: "Not a member of this space" }, 403);
    }
    try {
      const { readSpaceNeeds } =
        await import("../../../services/needs/space-need-door.js");
      const out = await readSpaceNeeds(workspaceId);
      return c.json({
        vocabulary: out.vocabulary,
        coverage: {
          ...out.coverage,
          needs: out.coverage.needs.map((n) => ({
            ...n,
            binding: n.binding
              ? { ...n.binding, updatedAt: n.binding.updatedAt.toISOString() }
              : null,
          })),
        },
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "GET /workspaces/:workspaceId/needs failed"
      );
      return c.json(
        { error: "The space's needs could not be read" },
        httpStatusForTrpcError(err)
      );
    }
  });

  registerOpenApi(app, {
    method: "put",
    path: "/workspaces/{workspaceId}/needs/{need}",
    tags: ["Workspaces"],
    summary: "Fill (or clear) one need of a space",
    description:
      "Binds the need to a provider capability (its container id), once for " +
      "the space and shared by its members; `providerCapabilityId: null` " +
      "clears it. The provider must be this space's or pod-wide, and declare " +
      "it fills the need or offer a tool for one of its intents. GOVERNED " +
      "(`workspace/bind_need`): an agent caller gets `{ status: 'proposed', " +
      "proposalId }` (202), applied on approval; a member who may write " +
      "applies at once (`{ status: 'applied' }`). Requires hub-protocol.write.",
    request: {
      params: zOpenapi.object({
        workspaceId: uuidQueryParam,
        need: zOpenapi.string(),
      }),
      body: BindNeedBodySchema,
    },
    responses: {
      200: { description: "Applied", schema: BindNeedResponseSchema },
      202: {
        description: "Proposed for review",
        schema: BindNeedResponseSchema,
      },
      400: {
        description: "Invalid input, or the provider cannot fill it",
        schema: ErrorSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such provider", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.put("/workspaces/:workspaceId/needs/:need", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const agentUserId = (c.get("agentUserId") as string | undefined) ?? null;
    const workspaceId = requireUuidParam(c, "workspaceId");
    if (workspaceId instanceof Response) return workspaceId;
    const need = c.req.param("need");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const { BindSpaceNeedInputSchema, bindSpaceNeedThroughGate } =
      await import("../../../services/needs/space-need-door.js");
    const parsed = BindSpaceNeedInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    const { SpaceNeedBindError } =
      await import("../../../services/needs/space-needs.js");
    const { canonicalNeedSlug } = await import("@synap-core/types/needs");
    const slug = canonicalNeedSlug(need);
    if (!slug) return c.json({ error: `"${need}" is not a need.` }, 400);
    try {
      // The ONE governed door (checkPermissionOrPropose, workspace/bind_need),
      // shared with tRPC needs.bind.
      const r = await bindSpaceNeedThroughGate({
        userId,
        agentUserId,
        workspaceId,
        need: slug,
        providerCapabilityId: parsed.data.providerCapabilityId,
      });
      if (r.status === "denied") return c.json({ error: r.reason }, 403);
      if (r.status === "proposed") return jsonGoverned(c, r);
      return c.json({ status: "applied" as const, result: r.result });
    } catch (err) {
      if (err instanceof SpaceNeedBindError) {
        return c.json(
          { error: err.message, reasonCode: err.code },
          err.code === "NO_SUCH_PROVIDER" ? 404 : 400
        );
      }
      logger.error(
        { err, userId, workspaceId, need },
        "PUT /workspaces/:workspaceId/needs/:need failed"
      );
      return c.json(
        { error: "The need could not be filled" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
