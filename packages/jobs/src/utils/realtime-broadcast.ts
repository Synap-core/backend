/**
 * Real-time notification broadcasting utility
 *
 * Used by pg-boss workers + the permission gate to broadcast notifications to
 * connected clients. Delivery goes through the Realtime server's Socket.IO
 * bridge (`POST ${REALTIME_URL}/bridge/emit`) — the SAME contract the working
 * `domain-event-bridge` + `chat-realtime-broadcast` use. The notification
 * `type` becomes the Socket.IO event name; the whole message rides as `data`
 * and is delivered to the target user's room (`user:${userId}`).
 */

function getRealtimeUrl(): string {
  return process.env.REALTIME_URL || "http://localhost:4001";
}

export interface NotificationMessage {
  type: string;
  data: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  status?: "success" | "error" | "pending";
}

export interface BroadcastOptions {
  userId: string;
  requestId?: string;
  message: NotificationMessage;
  realtimeUrl?: string;
}

/**
 * Broadcast notification to connected clients via the Realtime bridge.
 *
 * Targets the user's Socket.IO room (`user:${userId}`). Any `requestId` stays
 * inside the message payload for client-side correlation — the bridge has no
 * per-request room, so a single emit to the user room replaces the old
 * two-room (user + request) fan-out. Fire-and-forget: failures are returned,
 * never thrown, so a broadcast miss never blocks the caller.
 *
 * @param options - Broadcast options
 * @returns Promise resolving to broadcast results
 */
export async function broadcastNotification(
  options: BroadcastOptions
): Promise<{ success: boolean; broadcastCount?: number; error?: string }> {
  const { userId, message, realtimeUrl = getRealtimeUrl() } = options;

  try {
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
        userId,
        data: message,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Broadcast failed: ${response.status}`,
      };
    }

    const result = (await response.json()) as { emitCount?: number };
    return {
      success: true,
      broadcastCount: result.emitCount ?? 0,
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
 * Broadcast success notification
 *
 * Convenience function for broadcasting success notifications.
 */
export async function broadcastSuccess(
  userId: string,
  type: string,
  data: Record<string, unknown>,
  options?: { requestId?: string; realtimeUrl?: string }
): Promise<{ success: boolean; broadcastCount?: number; error?: string }> {
  return broadcastNotification({
    userId,
    requestId: options?.requestId,
    message: {
      type,
      data,
      requestId: options?.requestId,
      status: "success",
      timestamp: new Date().toISOString(),
    },
    realtimeUrl: options?.realtimeUrl,
  });
}

/**
 * Broadcast error notification
 *
 * Convenience function for broadcasting error notifications.
 */
export async function broadcastError(
  userId: string,
  type: string,
  error: string,
  options?: { requestId?: string; realtimeUrl?: string }
): Promise<{ success: boolean; broadcastCount?: number; error?: string }> {
  return broadcastNotification({
    userId,
    requestId: options?.requestId,
    message: {
      type,
      data: { error },
      requestId: options?.requestId,
      status: "error",
      timestamp: new Date().toISOString(),
    },
    realtimeUrl: options?.realtimeUrl,
  });
}
