/**
 * `GET /api/events/stream` — the RAW event fanout (admin dashboard).
 *
 * Every event on the pod, every user's, full payload, with no workspace or
 * session floor (`eventStreamManager.registerClient`). It was mounted with no
 * auth at all until 2026-09-27, so anyone who could reach the pod could tail
 * the whole event log. It is now pod-admin only — the same gate as
 * `system.listAuditLogs`, the other deliberately pod-wide event read. A
 * per-user live tail is `GET /api/hub/events/stream`, which is owner-pinned.
 *
 * Guard: `admin-event-stream.test.ts` drives this chain.
 */

import type { Hono } from "hono";
import { TRPCError } from "@trpc/server";
import { authMiddleware } from "@synap/auth";
import {
  assertPodAdmin,
  eventStreamManager,
  refuseGuestSession,
} from "@synap/api";
import { createLogger } from "@synap-core/core";
import { isAllowedOrigin } from "./cors-origin.js";

const log = createLogger({ module: "api-server" });

export function mountAdminEventStream(app: Hono): void {
  app.get(
    "/api/events/stream",
    authMiddleware,
    refuseGuestSession,
    async (c) => {
      const userId = c.get("userId" as never) as string | undefined;
      if (!userId) return c.json({ error: "Unauthorized" }, 401);
      try {
        await assertPodAdmin(userId);
      } catch (err) {
        if (err instanceof TRPCError && err.code === "FORBIDDEN") {
          return c.json({ error: "Pod admin access required" }, 403);
        }
        throw err;
      }

      const clientId = crypto.randomUUID();

      const stream = new ReadableStream({
        start(controller) {
          // Register the client
          eventStreamManager.registerClient(clientId, controller);

          // Send initial connection message
          const encoder = new TextEncoder();
          const initialMessage = `data: ${JSON.stringify({ type: "connected", clientId })}\n\n`;
          controller.enqueue(encoder.encode(initialMessage));

          log.info({ clientId }, "SSE client stream started");
        },
        cancel() {
          // Cleanup when client disconnects
          eventStreamManager.unregisterClient(clientId);
          log.info({ clientId }, "SSE client stream cancelled");
        },
      });

      // Echo the caller's origin only when it's a trusted first party (same
      // policy as the global CORS middleware) — never `*`-with-credentials.
      const sseOrigin = c.req.header("origin");
      const sseHeaders: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      };
      if (sseOrigin && isAllowedOrigin(sseOrigin)) {
        sseHeaders["Access-Control-Allow-Origin"] = sseOrigin;
        sseHeaders["Access-Control-Allow-Credentials"] = "true";
        sseHeaders["Vary"] = "Origin";
      }

      return c.newResponse(stream, 200, sseHeaders);
    }
  );
}
