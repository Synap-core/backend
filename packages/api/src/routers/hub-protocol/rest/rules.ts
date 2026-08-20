/**
 * Hub Protocol REST — rules (the Rule Loop's API-key-native door)
 *
 * WHY THIS FILE EXISTS. The rule doors on the skills tRPC router
 * (`skills.createRule` / `listRules` / `getRule`) are `protectedProcedure` —
 * session-cookie shaped. An API-key-authenticated CLI or agent caller trips the
 * identity remap on that path and gets a bare 403, which is exactly the caller
 * the Rule Loop exists for. These routes are the `scopedProcedure`-equivalent
 * siblings: same underlying logic, Bearer-scope gated, no remap.
 *
 * NO LOGIC IS DUPLICATED HERE:
 *   - classify  → calls `classifyRuleIntent` (services/knowledge), the ONE
 *                 classifier. Pure, synchronous, zero I/O, zero writes.
 *   - create    → calls `createRuleGoverned` (services/rules/create), the ONE
 *                 governed create door — the same function `skills.createRule`
 *                 calls, so an agent-authored write still PROPOSES.
 *   - list      → reuses `visibleSkillsWhere` (the canonical skill visibility
 *                 predicate) + `readRuleMetadata`. A rule IS a `skills` row
 *                 (`kind:"instruction"`, `category:"rule"`), so it can never be
 *                 more visible than a skill.
 *
 * Routes (STATIC BEFORE DYNAMIC — Hono is first-match):
 *   POST /rules/classify   — classify a natural-language rule. READ-ONLY.
 *   POST /rules            — create a rule (governed).
 *   GET  /rules            — list rules under the caller's visibility floor.
 *
 * There is deliberately NO `/rules/:id` route here. If one is ever added it
 * MUST be registered AFTER `/rules/classify`, or Hono captures "classify" as an
 * id — this repo has shipped that bug. `rules.route-order.test.ts` pins it.
 */

import { z } from "@hono/zod-openapi";
import { and, db, desc, eq, skills } from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  confineWorkspaceOrForbidden,
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  resolveActorId,
  type HubHono,
} from "./_shared.js";
import { classifyRuleIntent } from "../../../services/knowledge/classify-intent.js";
import { createRuleGoverned } from "../../../services/rules/create.js";
import {
  RULE_CATEGORY,
  readRuleMetadata,
} from "../../../services/rules/index.js";
import { visibleSkillsWhere } from "../../../services/skills/visibility.js";
import { listPendingRuleProposals } from "../../../services/proposals/pending-rules.js";

// ── Wire schemas ───────────────────────────────────────────────────────────

const ClassifyRuleBodySchema = z.object({
  text: z.string().min(1),
  /**
   * Optional grounding the classifier already accepts: what the pod actually
   * has. Both arms contribute SUPPORTING weight only — neither can raise a
   * shape on its own.
   */
  context: z
    .object({
      capabilities: z.array(z.string()).optional(),
      profiles: z.array(z.string()).optional(),
    })
    .optional(),
});

const ShapeMatchSchema = z.object({
  shape: z.string(),
  confidence: z.number(),
  cues: z.array(z.string()),
});

const ClassifyRuleResponseSchema = z.object({
  shapes: z.array(ShapeMatchSchema),
  primary: z.string(),
  oneShot: z.boolean(),
  needsClarification: z
    .object({ reason: z.string(), question: z.string() })
    .optional(),
});

const CreateRuleBodySchema = z.object({
  intent: z.string().min(1),
  scope: z.object({
    kind: z.enum(["pod", "workspace", "user"]),
    workspaceId: z.string().uuid().optional(),
  }),
  trust: z.enum(["propose", "auto"]).optional(),
  factSkillId: z.string().uuid().optional(),
  automationIds: z.array(z.string().uuid()).default([]),
  /** Acting AGENT identity when the key carries one (verified, never trusted raw). */
  agentUserId: z.string().uuid().optional(),
  /** Honored only for service keys — see `resolveActingContext`. */
  userId: z.string().uuid().optional(),
});

const CreateRuleResponseSchema = z.union([
  z.object({ status: z.literal("created"), ruleId: z.string() }),
  z.object({ status: z.literal("proposed"), proposalId: z.string() }),
  z.object({ status: z.literal("denied"), reason: z.string() }),
]);

const ListRulesQuerySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
  /**
   * Also return rules that exist only as a PENDING proposal (no `skills` row
   * yet). Default FALSE — a caller reading this list to decide what is IN
   * EFFECT must keep getting only materialized rules. Accepts "1"/"true".
   */
  includeProposed: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .transform((v) => v === true || v === "true" || v === "1")
    .optional(),
});

const WireRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  approved: z.boolean().nullable(),
  workspaceId: z.string().nullable(),
  createdAt: z.string(),
  rule: z.record(z.string(), z.unknown()),
  /**
   * `"active"` = a real `skills` row. `"proposed"` = awaiting review, returned
   * only under `includeProposed`, and carrying the `proposalId` to review it.
   * Present on EVERY row so no consumer can mistake one for the other.
   */
  status: z.enum(["active", "proposed"]),
  proposalId: z.string().optional(),
});

// ── Register ───────────────────────────────────────────────────────────────

export function registerRulesRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/rules/classify",
    tags: ["Rules"],
    summary: "Classify a natural-language rule",
    description:
      "Routes a STATEMENT to the shapes it implies (fact · behaviour · structure · schedule · notification · extraction · unknown), each with a confidence and the literal cues that fired. Also reports `oneShot` (the text reads as a one-off request, not a standing rule) and `needsClarification` when the routing is undecidable. READ-ONLY: no writes, no side effects, no I/O.",
    request: { body: ClassifyRuleBodySchema },
    responses: {
      200: { description: "Intent route", schema: ClassifyRuleResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/rules",
    tags: ["Rules"],
    summary: "Create a rule (governed)",
    description:
      'Governed create. A `{status:"proposed", proposalId}` body is a SUCCESS (HTTP 200) — the write is queued for the owner\'s review, exactly as an agent-authored write should be. `{status:"denied"}` is a 403.',
    request: { body: CreateRuleBodySchema },
    responses: {
      200: {
        description: "Created or proposed",
        schema: CreateRuleResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden / denied", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/rules",
    tags: ["Rules"],
    summary: "List rules",
    description:
      'Rules visible to the caller, newest first. Floored by the canonical `visibleSkillsWhere` predicate. Every row carries `status`: `"active"` for a materialized rule. With `includeProposed=true` the list ALSO contains rules that exist only as a pending proposal — `status:"proposed"` + the `proposalId` to review them (`synap open proposal <id>`) — floored by `proposals.list`\'s own `userVisibleWhere` predicate plus the rule scope tiers. Default OFF, so a caller reading "what is in effect" is unaffected.',
    request: { query: ListRulesQuerySchema },
    responses: {
      200: {
        description: "Rules",
        schema: z.object({ rules: z.array(WireRuleSchema) }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /rules/classify
   *
   * MUST stay declared before any `/rules/:id`-shaped route (there is none
   * today). Read scope: this is a pure function over the request body — it
   * reads no rows and writes none.
   */
  app.post("/rules/classify", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Missing scope: hub-protocol.read required" },
        403
      );
    }
    const raw = await c.req.json().catch(() => null);
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = ClassifyRuleBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }

    const route = classifyRuleIntent(
      parsed.data.text,
      parsed.data.context ?? {}
    );
    return c.json(route);
  });

  /**
   * POST /rules
   *
   * Governance is NOT re-implemented here: the acting identity is resolved from
   * the VERIFIED auth context (never a raw body `userId`), the `agentUserId` is
   * proven to be a real agent the caller may act as, and both are handed to
   * `createRuleGoverned` — the same door `skills.createRule` calls. A
   * `"proposed"` verdict is returned with HTTP 200 because it IS a success.
   */
  app.post("/rules", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const raw = await c.req.json().catch(() => null);
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = CreateRuleBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }
    const body = parsed.data;

    // Service-key workspace confinement: pin/clamp BEFORE the workspace reaches
    // resolveActingContext or createRuleGoverned.
    const confined = confineWorkspaceOrForbidden(
      c,
      body.scope.workspaceId ?? null
    );
    if (!confined.ok) return c.json({ error: confined.error }, 403);
    const clampedWorkspaceId = confined.workspaceId ?? undefined;

    // SECURITY — acting identity comes from the verified auth context, never
    // `body.userId` directly (governed-agent-write → ungoverned-operator-write
    // IDOR). Mirrors POST /automations/create.
    const acting = await resolveActingContext(c, {
      ...(body.userId ? { userId: body.userId } : {}),
      ...(clampedWorkspaceId ? { workspaceId: clampedWorkspaceId } : {}),
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    // ATTRIBUTION: the agent identity the key carries wins unless the caller
    // explicitly names one — and either way it is verified by resolveActorId
    // (real agent user + an active act-as grant to the acting caller) before it
    // can influence the gate.
    const ctxAgentUserId = c.get("agentUserId") as string | undefined;
    const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
    const actorResolution = await resolveActorId(
      resolvedAgentUserId,
      acting.userId
    );
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);

    try {
      const result = await createRuleGoverned({
        userId: acting.userId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        workspaceId: acting.workspaceId,
        intent: body.intent,
        scope: {
          kind: body.scope.kind,
          ...(clampedWorkspaceId ? { workspaceId: clampedWorkspaceId } : {}),
        },
        ...(body.trust ? { trust: body.trust } : {}),
        ...(body.factSkillId ? { factSkillId: body.factSkillId } : {}),
        automationIds: body.automationIds,
        auditSource: "hub.rules.create",
      });

      // A "denied" verdict is the ONLY non-2xx outcome. "proposed" is a
      // success: the write is queued for review, not rejected.
      if (result.status === "denied") return c.json(result, 403);
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "rules.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * GET /rules?workspaceId=&limit=&offset=
   *
   * Same predicate + same metadata reader as `skills.listRules`; the identity
   * is the auth middleware's resolved floor, never a query param.
   */
  app.get("/rules", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Missing scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);

    const parsed = ListRulesQuerySchema.safeParse({
      ...(c.req.query("workspaceId")
        ? { workspaceId: c.req.query("workspaceId") }
        : {}),
      ...(c.req.query("limit") ? { limit: c.req.query("limit") } : {}),
      ...(c.req.query("offset") ? { offset: c.req.query("offset") } : {}),
      ...(c.req.query("includeProposed")
        ? { includeProposed: c.req.query("includeProposed") }
        : {}),
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        400
      );
    }

    try {
      const rows = await db.query.skills.findMany({
        where: and(
          eq(skills.category, RULE_CATEGORY),
          visibleSkillsWhere(userId, parsed.data.workspaceId)
        ),
        orderBy: [desc(skills.createdAt)],
        limit: parsed.data.limit ?? 50,
        offset: parsed.data.offset ?? 0,
      });
      const materialized = rows.flatMap((row: typeof skills.$inferSelect) => {
        const rule = readRuleMetadata(row.metadata);
        return rule
          ? [
              {
                id: row.id,
                name: row.name,
                approved: row.approved,
                workspaceId: row.workspaceId,
                createdAt: row.createdAt,
                rule,
                status: "active" as const,
              },
            ]
          : [];
      });
      if (!parsed.data.includeProposed) return c.json({ rules: materialized });

      // Rules that exist only as a pending proposal — floored by the same
      // predicate `proposals.list` uses, then by `visibleSkillsWhere`'s scope
      // tiers mirrored onto the payload. Proposed FIRST: they await a decision.
      const proposed = await listPendingRuleProposals({
        userId,
        ...(parsed.data.workspaceId
          ? { workspaceId: parsed.data.workspaceId }
          : {}),
        limit: parsed.data.limit ?? 50,
      });
      return c.json({ rules: [...proposed, ...materialized] });
    } catch (err) {
      logger.error({ err }, "rules.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
