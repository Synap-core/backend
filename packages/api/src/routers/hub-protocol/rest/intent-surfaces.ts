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
 *   GET /attention/lens-page   → `signals.list({ lens: "page" })` (a lens page, whole)
 *   GET /attention/count       → `signals.count`
 *   GET /needs-you             → `signals.needsYou` (THE needs-you rule's rows
 *                                by fold + the folds counted, decision E)
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
  confineWorkspaceOrForbidden,
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
import { LENS_PAGE_READ_CAPS } from "@synap-core/types/lens";
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

/**
 * A lens page's scope: the SAME axes `signals.list` narrows by (a space,
 * optionally a project inside it; a project; a track; a session). No
 * `profileSlug`: the page lens refuses the intent lens.
 */
const lensPageQuery = z.object({
  workspaceId: uuidQueryParam.optional(),
  projectId: uuidQueryParam.optional(),
  trackId: uuidQueryParam.optional(),
  sessionId: uuidQueryParam.optional(),
  /** Happened from this instant (the viewer's local midnight); absent = the whole history. */
  since: z.string().datetime({ offset: true }).optional(),
});

const attentionQuery = z.object({
  ...lensQuery,
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** `GET /needs-you` — the whole floor by default, narrowed like `count`. */
const needsYouQuery = z.object({
  workspaceId: uuidQueryParam.optional(),
  projectId: uuidQueryParam.optional(),
  trackId: uuidQueryParam.optional(),
  sessionId: uuidQueryParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

type HubContext = HonoContext<{ Variables: HubVariables }>;

/**
 * The shared door: scope check, query parse, caller context, error map.
 * A workspace-bound key never reads the pod, so every door declares one:
 *  - `confineWorkspace`: the query's `workspaceId` goes through the one clamp
 *    (`getConfinedWorkspace`), so a bound key reads its own workspace when it
 *    names none and is refused (403) on another;
 *  - `refuseBoundKey`: the read has no workspace axis (it is every space), so
 *    a bound key is refused (403).
 */
function readDoor<Q extends z.ZodTypeAny>(
  name: string,
  schema: Q,
  run: (ctx: Context, query: z.infer<Q>) => Promise<unknown>,
  opts: { confineWorkspace: true } | { refuseBoundKey: true }
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
    let query = parsed.data as z.infer<Q>;
    const boundTo = c.get("keyWorkspaceId");
    if ("refuseBoundKey" in opts && boundTo) {
      return c.json(
        {
          error: `This key is confined to workspace ${boundTo}; ${name} reads every space`,
        },
        403
      );
    }
    if ("confineWorkspace" in opts) {
      const confined = confineWorkspaceOrForbidden(
        c,
        (query as { workspaceId?: string }).workspaceId
      );
      if (!confined.ok) return c.json({ error: confined.error }, 403);
      query = {
        ...(query as Record<string, unknown>),
        workspaceId: confined.workspaceId ?? undefined,
      } as z.infer<Q>;
    }
    const userId = c.get("userId") as string;
    try {
      const ctx = await createHubProtocolCallerContext(userId, scopes);
      return c.json((await run(ctx as Context, query)) as never);
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
      "Every space the caller sees with its intent (`settings.intent`, else inferred) and, per produced kind, the pipeline in one line, needs-you, being-worked and a headline thing (`lifecycle.home`). `projectId` lists only the project's spaces (the ones it uses + its home; 404 when the caller cannot see it) and narrows every count. A workspace-bound key is refused (403): Home is every space.",
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
    path: "/attention/lens-page",
    tags: ["Attention"],
    summary:
      "A lens page, whole: what needs you, what is happening, what was produced",
    description:
      "Every class of the lens page at a scope (`signals.list({ lens: 'page' })`): Needs you, Proposed, Happening, Produced, Happened, plus the status banner, read with the caps every lens host asks for (`LENS_PAGE_READ_CAPS`). The scope is the narrowing lens (`workspaceId`, optionally with `projectId`; `projectId`; `trackId`; `sessionId`); none = the pod. `since` bounds Happened (a session sends none). Read by a space package's frame through the browser's host bridge, which stamps the scope.",
    request: { query: lensPageQuery },
    responses: {
      200: { description: "Page", schema: z.object({}).passthrough() },
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

  registerOpenApi(app, {
    method: "get",
    path: "/needs-you",
    tags: ["Attention"],
    summary: "What really needs the person, and where everything else went",
    description:
      "`signals.needsYou` — THE needs-you rule (decision E): `rows.needs_you` is the headline; `rows.working` (an agent is on it), `rows.stopped` (no agent for 7 days; one row per ask, `needsYouRows` draws one per session), `rows.review_later`, `rows.from_system` (no real asker) and `rows.changes_to_review` (pending proposals nothing waits on) are its folds. `count` is `signals.count` over the same read, with `count.folds`. Read this instead of re-deriving needs-you from session reads.",
    request: { query: needsYouQuery },
    responses: {
      200: {
        description: "Rows by fold + the count",
        schema: z.object({}).passthrough(),
      },
      ...errors,
    },
  });

  app.get(
    "/needs-you",
    readDoor("needs-you", needsYouQuery, (ctx, q) =>
      signalsRouter.createCaller(ctx).needsYou({
        ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.trackId ? { trackId: q.trackId } : {}),
        ...(q.sessionId ? { sessionId: q.sessionId } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      })
    )
  );
  app.get(
    "/lifecycle/board",
    readDoor(
      "lifecycle.board",
      boardQuery,
      (ctx, q) =>
        lifecycleRouter.createCaller(ctx).board({
          ...lensOf(q),
          ...(q.windowDays ? { window: { days: q.windowDays } } : {}),
          ...(q.firstN !== undefined ? { firstN: q.firstN } : {}),
          ...(q.column ? { column: q.column } : {}),
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.limit ? { limit: q.limit } : {}),
          workedBy: q.workedBy === "true",
        }),
      { confineWorkspace: true }
    )
  );
  app.get(
    "/lifecycle/throughput",
    readDoor(
      "lifecycle.throughput",
      throughputQuery,
      (ctx, q) =>
        lifecycleRouter.createCaller(ctx).throughput({
          ...lensOf(q),
          ...(q.bucket || q.count
            ? { period: { bucket: q.bucket ?? "week", count: q.count ?? 12 } }
            : {}),
        }),
      { confineWorkspace: true }
    )
  );
  app.get(
    "/lifecycle/home",
    readDoor(
      "lifecycle.home",
      homeQuery,
      (ctx, q) =>
        lifecycleRouter
          .createCaller(ctx)
          .home(q.projectId ? { projectId: q.projectId } : {}),
      { refuseBoundKey: true }
    )
  );
  app.get(
    "/lifecycle/moving",
    readDoor(
      "lifecycle.moving",
      movingQuery,
      (ctx, q) =>
        lifecycleRouter.createCaller(ctx).moving({
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
          limit: q.limit ?? 30,
        }),
      { confineWorkspace: true }
    )
  );
  app.get(
    "/attention/needs-you",
    readDoor(
      "attention.needs-you",
      attentionQuery,
      (ctx, q) =>
        signalsRouter.createCaller(ctx).list({
          ...lensOf(q),
          lens: "needs-you",
          ...(q.limit ? { limit: q.limit } : {}),
        }),
      { confineWorkspace: true }
    )
  );
  app.get(
    "/attention/lens-page",
    readDoor(
      "attention.lens-page",
      lensPageQuery,
      (ctx, q) =>
        signalsRouter.createCaller(ctx).list({
          lens: "page",
          ...(q.workspaceId ? { workspaceId: q.workspaceId } : {}),
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(q.trackId ? { trackId: q.trackId } : {}),
          ...(q.sessionId ? { sessionId: q.sessionId } : {}),
          caps: { ...LENS_PAGE_READ_CAPS },
          ...(q.since ? { since: q.since } : {}),
        }),
      // A frame's or pod app's key is a bound key: its page is its space's,
      // never the pod's (the scope axes AND with the workspace).
      { confineWorkspace: true }
    )
  );
  app.get(
    "/attention/count",
    readDoor(
      "attention.count",
      attentionQuery,
      (ctx, q) => signalsRouter.createCaller(ctx).count(lensOf(q)),
      { confineWorkspace: true }
    )
  );
}
