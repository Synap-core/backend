/**
 * POST /api/hub/chat/stream — an app's chat turn, bounded by the app's grant.
 *
 * The same stream as `/api/external/chat/stream` (the shared handler,
 * `services/chat-turns/stream-chat-request.ts`), for a space-scoped app holding
 * a connect grant. It needs `chat.stream` in the workspace the turn runs in
 * (`chatStreamPermitted`, the grant's own `permits`). The IS turn is signed with
 * the grant as an `app_grant` claim, so every hub call the turn makes is bounded
 * by that same grant (`hub-protocol/_middleware/auth.ts`). A person's own
 * session has no grant and keeps the person's full access, as before.
 */
import { z } from "@hono/zod-openapi";
import { getRequestGrant, type KeyGrant } from "@synap/database";
import { permits, type GrantScope } from "@synap/governance-policy/grants";
import {
  handleChatStream,
  streamBodySchema,
} from "../../../services/chat-turns/stream-chat-request.js";
import { appGrantClaimOf } from "../../../services/app-grant-claim.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, type HubHono } from "./_shared.js";

/**
 * Does the grant reach `chat.stream` in this workspace? A person's own session
 * (no grant) is not narrowed here. Exported for the grant tests.
 */
export function chatStreamPermitted(
  grant: KeyGrant | null | undefined,
  workspaceId: string
): boolean {
  if (!grant) return true;
  return grant.scopes.some((scope: GrantScope) =>
    permits(scope, { subject: "chat", action: "stream", workspaceId })
  );
}

export function registerChatRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/chat/stream",
    tags: ["Chat"],
    summary: "Stream one AI chat turn for an app (SSE)",
    description:
      "Streams one chat turn in a workspace the app's grant reaches with `chat.stream`. " +
      "Same SSE frames as /api/external/chat/stream; every hub call the turn makes is bounded by the app's grant. " +
      "Requires hub-protocol.write scope.",
    request: {
      body: streamBodySchema,
    },
    responses: {
      200: {
        description: "text/event-stream of the turn",
        schema: z.string(),
      },
      401: {
        description: "Unauthenticated",
        schema: z.object({ error: z.string() }),
      },
      403: {
        description: "Outside the grant",
        schema: z.object({ error: z.string() }),
      },
    },
  });

  app.post("/chat/stream", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const grant = getRequestGrant();
    return handleChatStream(c, {
      userId,
      authorizeTarget: ({ workspaceId }) =>
        chatStreamPermitted(grant, workspaceId),
      // The turn's IS token carries the grant (no grant = the person, as before).
      appGrant: grant ? appGrantClaimOf(grant) : null,
    });
  });
}
