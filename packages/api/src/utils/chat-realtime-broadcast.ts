/**
 * Chat real-time broadcast via Realtime server bridge
 *
 * The API server does not have Socket.IO in context. We POST to the Realtime
 * server's /bridge/emit endpoint so chat events (stream, message, thread:created, etc.)
 * are delivered to connected clients on the /presence namespace.
 *
 * Reliability: up to MAX_RETRIES attempts with exponential backoff.
 * A 5-second total deadline prevents slow retries from accumulating.
 * Failures are warned but never throw — the API response must not be blocked.
 */

function getRealtimeUrl(): string {
  return process.env.REALTIME_URL || "http://localhost:4001";
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 50;
/** Total time budget across all retry attempts (ms) */
const TOTAL_DEADLINE_MS = 5_000;

export interface ChatBroadcastOptions {
  event: string;
  data: Record<string, unknown>;
  workspaceId?: string | null;
  userId?: string | null;
  /** Target a specific channel room (e.g. for stream events). Reduces noise for other clients. */
  channelId?: string | null;
  /** Target a view room (e.g. for view-scoped realtime updates). */
  viewId?: string | null;
}

async function attemptEmit(
  url: string,
  body: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.BRIDGE_SECRET
          ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
          : {}),
      },
      body,
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Emit a chat event to connected clients via the Realtime bridge.
 * Fire-and-forget: we do not await so the API response is not blocked.
 * Retries up to MAX_RETRIES times with exponential backoff within TOTAL_DEADLINE_MS.
 * At least one of workspaceId, userId, or channelId must be set.
 */
export function emitChatEvent(options: ChatBroadcastOptions): void {
  const { event, data, workspaceId, userId, channelId, viewId } = options;
  if (!workspaceId && !userId && !channelId && !viewId) return;

  const url = `${getRealtimeUrl()}/bridge/emit`;
  const body = JSON.stringify({
    event,
    data,
    ...(workspaceId && { workspaceId }),
    ...(userId && { userId }),
    ...(channelId && { channelId }),
    ...(viewId && { viewId }),
  });

  // Run retries in background — never blocks caller
  (async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), TOTAL_DEADLINE_MS);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((r) =>
          setTimeout(r, BASE_BACKOFF_MS * Math.pow(2, attempt - 1))
        );
      }
      if (controller.signal.aborted) break;

      const ok = await attemptEmit(url, body, controller.signal);
      if (ok) {
        clearTimeout(deadline);
        return;
      }
    }

    clearTimeout(deadline);
    console.warn(
      `[Chat] Failed to broadcast '${event}' after ${MAX_RETRIES} attempts`
    );
  })();
}
