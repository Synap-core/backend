/**
 * Live structure progress tail — GET /api/capture/runs/:captureRunId/progress
 *
 * A READ-ONLY view of a running `capture.structure` call. It is not a second
 * structuring door: it cannot start, change or cancel a run (Stop stays the
 * client's own abort of the mutation). The client opens it BEFORE calling the
 * mutation with the same `captureRunId`.
 *
 * Auth: the same session `authMiddleware` as `/api/chat`. The run is keyed by
 * the AUTHENTICATED user id — another user's run id reads as an empty run.
 *
 * Wire format (SSE, `text/event-stream`):
 *   id: <seq>\n
 *   data: <StructureProgressEvent JSON>\n\n      (see @synap-core/types/capture)
 *   : keepalive\n\n                              (comment, every 15s)
 * `?after=<seq>` (exclusive) replays buffered frames after that seq. The
 * stream closes after the `done` frame, or when the run's buffer expires.
 * Closing the stream only detaches this reader; the mutation keeps running.
 */
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "@synap/auth";
import type { StructureProgressEvent } from "@synap-core/types/capture";
import {
  STRUCTURE_PROGRESS_IDLE_TTL_MS,
  subscribeStructureProgress,
} from "../utils/structure-progress-bus.js";

const KEEPALIVE_MS = 15_000;

interface ProgressVariables {
  userId: string;
  user: unknown;
  authenticated: boolean;
}

export const captureProgressStreamApp = new Hono<{
  Variables: ProgressVariables;
}>();

captureProgressStreamApp.use("*", authMiddleware);

export function encodeStructureProgressFrame(
  event: StructureProgressEvent
): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

captureProgressStreamApp.get("/runs/:captureRunId/progress", (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const captureRunId = z.string().uuid().safeParse(c.req.param("captureRunId"));
  if (!captureRunId.success) {
    return c.json({ error: "captureRunId must be a uuid" }, 400);
  }
  const afterRaw = c.req.query("after") ?? c.req.header("last-event-id");
  const after = afterRaw === undefined ? 0 : Number(afterRaw);
  if (!Number.isSafeInteger(after) || after < 0) {
    return c.json({ error: "after must be a non-negative integer" }, 400);
  }

  const encoder = new TextEncoder();
  let detach = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let idleClose: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};

      const close = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        if (idleClose) clearTimeout(idleClose);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the reader.
        }
      };
      detach = close;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      // A run no mutation ever follows must not hold the connection forever.
      const armIdleClose = () => {
        if (idleClose) clearTimeout(idleClose);
        idleClose = setTimeout(close, STRUCTURE_PROGRESS_IDLE_TTL_MS);
      };

      let lastSeq = after;
      const deliver = (event: StructureProgressEvent) => {
        // Replay and live delivery can overlap on the boundary seq.
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        send(encodeStructureProgressFrame(event));
        armIdleClose();
        if (event.kind === "done") close();
      };

      const subscription = subscribeStructureProgress(
        userId,
        captureRunId.data,
        after,
        deliver
      );
      unsubscribe = subscription.unsubscribe;
      for (const event of subscription.replay) deliver(event);
      if (closed) return;
      if (subscription.done) {
        close();
        return;
      }
      keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      armIdleClose();
    },
    cancel() {
      // Detach only — the structure mutation is not owned by this reader.
      detach();
    },
  });

  return c.newResponse(stream, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
});
