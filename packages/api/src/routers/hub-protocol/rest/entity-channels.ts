/**
 * Hub Protocol REST — a person's channels (channels wave, design d00cd2ac §6).
 *
 *   GET /entities/{id}/channels   the conversations the pod holds with one
 *                                 record: provider, account, chat id (null
 *                                 until the first send), last message, unread
 *                                 and pending proposed messages.
 *
 * Read through `listPersonChannels` (services/channels/person-channels.ts):
 * the record, its channels, their messages and the proposals are each read
 * under the caller's floor AND the key's grant. A record the caller cannot
 * read is a 404. On the scoped-key fence as `NARROWED("channel")`: an app
 * asks for `channel.read`, and the read narrows itself to what the grant
 * reaches (a channel follows its person, access/grant-read.ts).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { EntityChannelsResponseSchema } from "./_codecs/channel.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  uuidPathParam,
  type HubHono,
} from "./_shared.js";
import { listPersonChannels } from "../../../services/channels/person-channels.js";

export function registerEntityChannelsRoutes(app: HubHono): void {
  const route = createRoute({
    method: "get",
    path: "/entities/{id}/channels",
    tags: ["Entities", "Channels"],
    summary: "List the channels with a person",
    description:
      "The conversations the pod holds with one record (LinkedIn, email, " +
      "Discord, …), newest first: the tool, the account it goes through, the " +
      "tool's chat id (null until the first send opens the chat), the last " +
      "message, unread inbound messages and pending proposed messages. A " +
      "proposed message is a pending `messaging.external.send` proposal " +
      "(GET /channels/{id}/proposed-messages). 404 when the caller cannot " +
      "read the record.",
    request: { params: z.object({ id: uuidPathParam }) },
    responses: {
      200: {
        description: "The record's channels",
        content: {
          "application/json": { schema: EntityChannelsResponseSchema },
        },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No record the caller can read",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(route, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    const { id: entityId } = c.req.valid("param");
    try {
      const result = await listPersonChannels({ userId, entityId });
      if (result.status === "not_found") {
        return c.json({ error: "Record not found or access denied" }, 404);
      }
      return c.json({ channels: result.channels }, 200);
    } catch (err) {
      logger.error({ err, entityId }, "GET /entities/:id/channels failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err) as never
      );
    }
  });
}
