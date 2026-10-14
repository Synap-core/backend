/**
 * Hub REST — the READS of an intent surface (surfaces W1.8), for the
 * generative bridge (a ViewFrame cell proxies `/api/hub/*`), the CLI and the
 * IS. Thin doors over the tRPC procedures the surface itself reads — never a
 * second predicate:
 *
 *   GET /lifecycle/board       → `lifecycle.board`      (the pipeline)
 *   GET /lifecycle/throughput  → `lifecycle.throughput` (the goal line)
 *   GET /lifecycle/home        → `lifecycle.home`       (what each space makes)
 *   GET /lifecycle/moving      → `lifecycle.moving`     (things being worked)
 *   GET /attention/needs-you   → `signals.list({ lens: "needs-you" })`
 *   GET /attention/count       → `signals.count`
 *
 * The kind-level reads take the intent lens (`profileSlug`) plus the board's
 * lens (`workspaceId` · `projectId` · `trackId`); the homes reads take only
 * the narrowing lens they declare. Sessions ON a kind's things ride
 * the existing `GET /focus-sessions?subjectProfileSlug=` (same predicate as
 * `focusSessions.list({ subject })`).
 *
 * Read scope `hub-protocol.read`; the acting identity is the authenticated
 * owner (`createHubProtocolCallerContext`), so every floor is the tRPC door's.
 */

import { z } from "@hono/zod-openapi";
import { ErrorSchema, uuidQueryParam } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  type HubHono,
  type HubVariables,
  httpStatusForTrpcError,
} from "./_shared.js";
import type { Context as HonoContext } from "hono";
import { createHubProtocolCallerContext } from "../utils.js";
import { lifecycleRouter } from "../../lifecycle.js";
import { signalsRouter } from "../../signals.js";
import type { Context } from "../../../types/context.js";

const lensQuery = {
  profileSlug: z.string().min(1),
  workspaceId: uuidQueryParam.optional(),
  projectId: uuidQueryParam.optional(),
  trackId: uuidQueryParam.optional(),
};

const boardQuery = z.object({
  ...lensQuery,
  windowDays: z.coerce.number().int().min(1).max(366).optional(),
  firstN: z.coerce.number().int().min(0).max(50).optional(),
  column: z.string().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** `true` projects `workedBy` on every item. */
  workedBy: z.enum(["true", "false"]).optional(),
});

const throughputQuery = z.object({
  ...lensQuery,
  bucket: z.enum(["day", "week", "month"]).optional(),
  count: z.coerce.number().int().min(1).max(366).optional(),
});

const homeQuery = z.object({
  projectId: uuidQueryParam.optional(),
});

const movingQuery = z.object({
  projectId: uuidQueryParam.optional(),
  workspaceId: uuidQueryParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const attentionQuery = z.object({
  ...lensQuery,
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

type HubContext = HonoContext<{ Variables: HubVariables }>;

/** The shared door: scope check, query parse, caller context, error map. */
function readDoor<Q extends z.ZodTypeAny>(
  name: string,
  schema: Q,
  run: (ctx: Context, query: z.infer<Q>) => Promise<unknown>
) {
  return async (c: HubContext) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const parsed = schema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          error: parsed.error.issues
            .map((i) => `${i.path.join(".") || "query"}: ${i.message}`)
            .join("; "),
        },
        400
      );
    }
    const userId = c.get("userId") as string;
    try {
      const ctx = await createHubProtocolCallerContext(userId, scopes);
      return c.json((await run(ctx as Context, parsed.data)) as never);
    } catch (err) {
      logger.error({ err, userId }, `${name} failed`);
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  };
}

const lensOf = (q: {
  profileSlug: string;
  workspaceId?: string;
  projectId?: string;
  trackId?: string;
}) => ({
  profileSlug: q.profileSlug,
  ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
  ...(q.projectId ? { projectId: q.projectId } : {}),
  ...(q.trackId ? { trackId: q.trackId } : {}),
});

const errors = {
  400: { description: "Bad request", schema: ErrorSchema },
  403: { description: "Forbidden", schema: ErrorSchema },
  404: { description: "Unknown kind / track", schema: ErrorSchema },
  412: { description: "The kind declares no lifecycle", schema: ErrorSchema },
  500: { description: "Internal error", schema: ErrorSchema },
};

export function registerIntentSurfacesRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/lifecycle/board",
    tags: ["Lifecycle"],
    summary: "The pipeline of a kind or role",
    description:
      "Things of `profileSlug` grouped by their declared lifecycle status, in option order (`lifecycle.board`). `workedBy=true` adds who is on each card.",
    request: { query: boardQuery },
    responses: {
      200: { description: "Board", schema: z.object({}).passthrough() },
      ...errors,
    },
  });
  registerOpenApi(app, {
    method: "get",
    path: "/lifecycle/throughput",
    tags: ["Lifecycle"],
    summary: "Things into done / lost per bucket",
    description:
      "The goal line of a kind or role (`lifecycle.throughput`): every bucket, zeros included, oldest first.",
    request: { query: throughputQuery },
    responses: {
      200: { description: "Throughput", schema: z.object({}).passthrough() },
      ...errors,
    },
  });
  registerOpenApi(app, {
    method: "get",
    path: "/lifecycle/home",
    tags: ["Lifecycle"],
    summary: "What each space produces, and how its things stand",
    description:
      "Every space the caller sees with its intent (`settings.intent`, else inferred) and, per produced kind, the pipeline in one line, needs-you, being-worked and a headline thing (`lifecycle.home`). `projectId` lists only the project's spaces (the ones it uses + its home; 404 when the caller cannot see it) and narrows every count.",
    request: { query: homeQuery },
    responses: {
      200: { description: "Home", schema: z.object({}).passthrough() },
      ...errors,
    },
  });
  registerOpenApi(app, {
    method: "get",
    path: "/lifecycle/moving",
    tags: ["Lifecycle"],
    summary: "The things being worked, with their work",
    description:
      "Things with open work on them (a session, an in-flight worker, a scheduled prep), most urgent first, plus `unattached`: open work sessions on no thing (`lifecycle.moving`).",
    request: { query: movingQuery },
    responses: {
      200: { description: "Moving now", schema: z.object({}).passthrough() },
      ...errors,
    },
  });
  registerOpenApi(app, {
    method: "get",
    path: "/attention/needs-you",
    tags: ["Attention"],
    summary: "What needs you ON a kind's things",
    description:
      "The needs-you rows narrowed to the things of `profileSlug` (`signals.list({ lens: 'needs-you', profileSlug })`).",
    request: { query: attentionQuery },
    responses: {
      200: { description: "Signals", schema: z.object({}).passthrough() },
      ...errors,
    },
  });
  registerOpenApi(app, {
    method: "get",
    path: "/attention/count",
    tags: ["Attention"],
    summary: "The needs-you number ON a kind's things",
    description:
      "`signals.count({ profileSlug })` — the number with its parts (decisions, notifications, blocked, review).",
    request: { query: attentionQuery },
    responses: {
      200: { description: "Count", schema: z.object({}).passthrough() },
      ...errors,
    },
  });

  app.get(
    "/lifecycle/board",
    readDoor("lifecycle.board", boardQuery, (ctx, q) =>
      lifecycleRouter.createCaller(ctx).board({
        ...lensOf(q),
        ...(q.windowDays ? { window: { days: q.windowDays } } : {}),
        ...(q.firstN !== undefined ? { firstN: q.firstN } : {}),
        ...(q.column ? { column: q.column } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        workedBy: q.workedBy === "true",
      })
    )
  );
  app.get(
    "/lifecycle/throughput",
    readDoor("lifecycle.throughput", throughputQuery, (ctx, q) =>
      lifecycleRouter.createCaller(ctx).throughput({
        ...lensOf(q),
        ...(q.bucket || q.count
          ? { period: { bucket: q.bucket ?? "week", count: q.count ?? 12 } }
          : {}),
      })
    )
  );
  app.get(
    "/lifecycle/home",
    readDoor("lifecycle.home", homeQuery, (ctx, q) =>
      lifecycleRouter
        .createCaller(ctx)
        .home(q.projectId ? { projectId: q.projectId } : {})
    )
  );
  app.get(
    "/lifecycle/moving",
    readDoor("lifecycle.moving", movingQuery, (ctx, q) =>
      lifecycleRouter.createCaller(ctx).moving({
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
        limit: q.limit ?? 30,
      })
    )
  );
  app.get(
    "/attention/needs-you",
    readDoor("attention.needs-you", attentionQuery, (ctx, q) =>
      signalsRouter.createCaller(ctx).list({
        ...lensOf(q),
        lens: "needs-you",
        ...(q.limit ? { limit: q.limit } : {}),
      })
    )
  );
  app.get(
    "/attention/count",
    readDoor("attention.count", attentionQuery, (ctx, q) =>
      signalsRouter.createCaller(ctx).count(lensOf(q))
    )
  );
}
