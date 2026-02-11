/**
 * Chat real-time broadcast via Realtime server bridge
 *
 * The API server does not have Socket.IO in context. We POST to the Realtime
 * server's /bridge/emit endpoint so chat events (stream, message, thread:created, etc.)
 * are delivered to connected clients on the /presence namespace.
 */

function getRealtimeUrl(): string {
  return process.env.REALTIME_URL || "http://localhost:4001";
}

export interface ChatBroadcastOptions {
  event: string;
  data: Record<string, unknown>;
  workspaceId?: string | null;
  userId?: string | null;
}

/**
 * Emit a chat event to connected clients via the Realtime bridge.
 * Fire-and-forget: we do not await so the API response is not blocked.
 * At least one of workspaceId or userId should be set so the bridge can target a room.
 */
export function emitChatEvent(options: ChatBroadcastOptions): void {
  const { event, data, workspaceId, userId } = options;
  if (!workspaceId && !userId) {
    return;
  }
  const url = `${getRealtimeUrl()}/bridge/emit`;
  const body = JSON.stringify({
    event,
    data,
    ...(workspaceId && { workspaceId }),
    ...(userId && { userId }),
  });
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).catch((err) => {
    console.warn("[Chat] Failed to broadcast to realtime:", event, err);
  });
}
