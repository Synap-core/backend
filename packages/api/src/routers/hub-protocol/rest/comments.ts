/**
 * Hub Protocol REST — comments on an object, for an APP (plan 48854969 §10.1).
 *
 *   POST /comments                       open a thread (anchor) or reply (parentId)
 *   GET  /comments?objectType=&objectId=&state=   an object's threads in one state
 *   POST /comments/:messageId/resolved   resolve or re-open a thread (a person only)
 *
 * A thin shell over the ONE comments service (`services/comments/comments.ts`),
 * the same calls the tRPC `comments.*` router and the MCP comment path make:
 * no logic of its own. The Design app reaches the pod only through `/api/hub/*`
 * with the person's app token (`app_person`), so its board annotations (pins,
 * `anchor.locator`) come through here.
 *
 * Floors are the service's: writing a comment needs READ access to the object
 * and, for a scoped key, the grant's update right on it (`entity.<kind>.update`
 * or `document.update` in its space); resolving needs the thread's author or
 * an editor of the object, the same grant right, and a person: an agent's key
 * is refused (agents propose, humans resolve). An invalid anchor is a 400
 * naming every bad field.
 */
import { z } from "@hono/zod-openapi";

import {
  COMMENT_CONTENT_MAX,
  listObjectComments,
  postComment,
  setCommentResolved,
} from "../../../services/comments/comments.js";
import { OBJECT_ROOM_CONTEXT_TYPES } from "../../../utils/channel-visibility.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const PostCommentRequestSchema = z
  .object({
    /** A new thread: what it is about (`ObjectCommentAnchor`, checked by the service). */
    anchor: z.record(z.string(), z.unknown()).optional(),
    /** A reply: any message of the thread. */
    parentId: z.string().uuid().optional(),
    content: z.string().trim().min(1).max(COMMENT_CONTENT_MAX),
    /** One user intent: a retry returns the first comment. */
    clientRequestId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .openapi("PostCommentRequest");

const PostCommentReplySchema = z
  .object({
    messageId: z.string(),
    rootId: z.string(),
    channelId: z.string(),
    object: z.object({ type: z.string(), id: z.string() }),
    ackState: z.enum(["applied", "duplicate-ignored"]),
  })
  .openapi("PostCommentReply");

const ListCommentsQuerySchema = z.object({
  objectType: z.enum(OBJECT_ROOM_CONTEXT_TYPES),
  objectId: z.string().uuid(),
  state: z.enum(["open", "resolved"]).default("open"),
});

const CommentsListingSchema = z
  .object({
    channelId: z.string().nullable(),
    counts: z.object({ open: z.number().int(), resolved: z.number().int() }),
    threads: z.array(z.record(z.string(), z.unknown())),
  })
  .openapi("ObjectCommentsListing");

const SetResolvedRequestSchema = z
  .object({ resolved: z.boolean() })
  .strict()
  .openapi("SetCommentResolvedRequest");

const SetResolvedReplySchema = z
  .object({
    rootId: z.string(),
    resolvedAt: z.string().nullable(),
    changed: z.boolean(),
  })
  .openapi("SetCommentResolvedReply");

/** A refusal of the comments service, as HTTP (its message, its code). */
function failure(err: unknown, route: string) {
  const status = httpStatusForTrpcError(err);
  if (status === 500) logger.error({ err }, route);
  return {
    status,
    body: {
      error: err instanceof Error ? err.message : "Unknown error",
      ...(err && typeof err === "object" && "code" in err
        ? { code: String((err as { code: unknown }).code) }
        : {}),
    },
  };
}

const invalid = (
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>
) => ({
  error: "Invalid request",
  issues: issues.map((i) => ({
    path: i.path.map(String).join("."),
    message: i.message,
  })),
});

export function registerCommentsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/comments",
    tags: ["Comments"],
    summary: "Comment on an object, or reply in a comment thread",
    description:
      "A comment is a message in the object's one conversation. `anchor` " +
      "opens a thread: `{kind:'entity', entityId, field?, locator?}` or " +
      "`{kind:'document', documentId, quote?, blockRef?, offset?, revision?}`; " +
      "`locator` pins it on a design (`{surface:'design', frameId, blockId?}`) " +
      "or a story (`{surface:'story', storyId}`) with `viewport` " +
      "(desktop / tablet / phone), `point` `{x, y}` (fractions 0 to 1), " +
      "`contentVersion` and an optional `screenshot` (a pod file id). " +
      "`parentId` replies in a thread instead (exactly one of the two). " +
      "Needs read access to the object and, for a scoped key, the update " +
      "right on it (`entity.<kind>.update` or `document.update` in its " +
      "space). 400 names every bad anchor field.",
    request: { body: PostCommentRequestSchema },
    responses: {
      200: { description: "Posted (or the first post of a retry)", schema: PostCommentReplySchema },
      400: { description: "Invalid anchor or body", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such object or thread", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });
  app.post("/comments", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write"))
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = PostCommentRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const agentUserId = c.get("agentUserId") as string | undefined;
    try {
      const posted = await postComment({
        userId: acting.userId,
        ...(agentUserId ? { agentUserId } : {}),
        ...(parsed.data.anchor !== undefined
          ? { anchor: parsed.data.anchor as never }
          : {}),
        ...(parsed.data.parentId ? { parentId: parsed.data.parentId } : {}),
        content: parsed.data.content,
        idempotencyKey: parsed.data.clientRequestId,
      });
      return c.json(posted, 200);
    } catch (err) {
      const f = failure(err, "POST /comments");
      return c.json(f.body, f.status);
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/comments",
    tags: ["Comments"],
    summary: "An object's comment threads in one state",
    description:
      "The threads on one object (`objectType` entity or document, " +
      "`objectId`) that are `open` (default) or `resolved`, each with its " +
      "anchor (a pin's `locator` included), its replies, `resolvedAt` / " +
      "`resolvedBy` and whether the caller may resolve it (`canResolve`), " +
      "plus both counts. `channelId` is null when nobody has commented yet. " +
      "Read through the caller's read floor on the object: one it cannot " +
      "read is a 404.",
    request: { query: ListCommentsQuerySchema },
    responses: {
      200: { description: "The threads", schema: CommentsListingSchema },
      400: { description: "Bad query", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such object", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });
  app.get("/comments", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read"))
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    const query = ListCommentsQuerySchema.safeParse({
      objectType: c.req.query("objectType"),
      objectId: c.req.query("objectId"),
      state: c.req.query("state") || undefined,
    });
    if (!query.success) return c.json(invalid(query.error.issues), 400);
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    try {
      return c.json(
        await listObjectComments({
          userId: acting.userId,
          object: { type: query.data.objectType, id: query.data.objectId },
          state: query.data.state,
        }),
        200
      );
    } catch (err) {
      const f = failure(err, "GET /comments");
      return c.json(f.body, f.status);
    }
  });

  registerOpenApi(app, {
    method: "post",
    path: "/comments/{messageId}/resolved",
    tags: ["Comments"],
    summary: "Resolve or re-open a comment thread",
    description:
      "Sets the thread's resolved state (any message of the thread names " +
      "it). The thread's author or an editor of the object, a person: an " +
      "agent's key is refused (it replies in the thread; the person " +
      "resolves). A scoped key needs the update right on the object. " +
      "Idempotent: `changed` is false when the thread already had that state.",
    request: {
      params: z.object({ messageId: z.string().uuid() }),
      body: SetResolvedRequestSchema,
    },
    responses: {
      200: { description: "The thread's state", schema: SetResolvedReplySchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such thread", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });
  app.post("/comments/:messageId/resolved", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write"))
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    const messageId = z.string().uuid().safeParse(c.req.param("messageId"));
    if (!messageId.success)
      return c.json({ error: "messageId is not a comment id (a uuid)" }, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = SetResolvedRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const agentUserId = c.get("agentUserId") as string | undefined;
    try {
      return c.json(
        await setCommentResolved({
          userId: acting.userId,
          ...(agentUserId ? { agentUserId } : {}),
          messageId: messageId.data,
          resolved: parsed.data.resolved,
        }),
        200
      );
    } catch (err) {
      const f = failure(err, "POST /comments/:messageId/resolved");
      return c.json(f.body, f.status);
    }
  });
}
