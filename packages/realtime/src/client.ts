/**
 * Client utility for broadcasting notifications via the Realtime bridge.
 *
 * Sends notifications to connected Socket.IO clients through the Realtime
 * server's `POST ${REALTIME_URL}/bridge/emit` endpoint — the SAME contract the
 * backend's `domain-event-bridge` + `chat-realtime-broadcast` use. The legacy
 * `${prefix}_${id}` roomId is translated to the bridge's typed target field
 * (`user:` → userId, `workspace:` → workspaceId, `view:` → viewId,
 * `channel:` → channelId). The notification `type` becomes the Socket.IO event
 * name and the whole message rides as `data`.
 */

export interface NotificationMessage {
  type: string;
  data: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  status?: "success" | "error" | "pending";
}

export interface BroadcastOptions {
  roomId: string;
  message: NotificationMessage;
  realtimeUrl?: string;
}

function getRealtimeUrl(): string {
  return process.env.REALTIME_URL || "http://localhost:4001";
}

/**
 * Translate a legacy `${prefix}_${id}` roomId into the bridge's typed target.
 * The bridge routes on workspaceId / viewId / userId / channelId — it has no
 * per-request room, so a `request_*` (or any unrecognized) prefix yields an
 * empty target and the bridge then 400s.
 */
function roomIdToBridgeTarget(roomId: string): {
  userId?: string;
  workspaceId?: string;
  viewId?: string;
  channelId?: string;
} {
  const idx = roomId.indexOf("_");
  if (idx === -1) return {};
  const prefix = roomId.slice(0, idx);
  const id = roomId.slice(idx + 1);
  switch (prefix) {
    case "user":
      return { userId: id };
    case "workspace":
      return { workspaceId: id };
    case "view":
      return { viewId: id };
    case "channel":
      return { channelId: id };
    default:
      return {};
  }
}

/**
 * Broadcast a notification to a room via the Realtime bridge.
 *
 * @param options - Broadcast options
 * @returns Promise resolving to broadcast result
 */
export async function broadcastNotification(
  options: BroadcastOptions
): Promise<{ success: boolean; broadcastCount?: number; error?: string }> {
  const { roomId, message, realtimeUrl = getRealtimeUrl() } = options;

  try {
    const target = roomIdToBridgeTarget(roomId);
    const response = await fetch(`${realtimeUrl}/bridge/emit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.BRIDGE_SECRET
          ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
          : {}),
      },
      body: JSON.stringify({
        event: message.type,
        data: message,
        ...target,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Broadcast failed: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as { emitCount?: number };
    return {
      success: true,
      broadcastCount: result.emitCount,
    };
  } catch (error) {
    console.error("Failed to broadcast notification:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Broadcast notification by userId
 *
 * Convenience function for broadcasting to a user's notification room.
 */
export async function broadcastToUser(
  userId: string,
  message: NotificationMessage,
  realtimeUrl?: string
): Promise<{ success: boolean; broadcastCount?: number; error?: string }> {
  return broadcastNotification({
    roomId: `user_${userId}`,
    message,
    realtimeUrl,
  });
}

/**
 * Broadcast notification by requestId
 *
 * Convenience function for broadcasting to a request's notification room.
 */
export async function broadcastToRequest(
  requestId: string,
  message: NotificationMessage,
  realtimeUrl?: string
): Promise<{ success: boolean; broadcastCount?: number; error?: string }> {
  return broadcastNotification({
    roomId: `request_${requestId}`,
    message,
    realtimeUrl,
  });
}
