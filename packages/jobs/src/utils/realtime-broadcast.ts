/**
 * Real-time notification broadcasting utility
 *
 * This utility is used by Inngest handlers to broadcast notifications
 * to connected WebSocket clients via Cloudflare Durable Objects.
 */

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
 * Broadcast notification to connected clients
 *
 * Sends a notification to both the user's room and the request's room (if requestId provided).
 * This allows clients to subscribe either by userId or by requestId.
 *
 * @param options - Broadcast options
 * @returns Promise resolving to broadcast results
 */
export async function broadcastNotification(
  options: BroadcastOptions
): Promise<{ success: boolean; broadcastCount?: number; error?: string }> {
  const {
    userId,
    requestId,
    message,
    realtimeUrl = process.env.REALTIME_URL || "https://realtime.synap.app",
  } = options;

  try {
    // Broadcast to user room
    const userRoomId = `user_${userId}`;
    const userResponse = await fetch(
      `${realtimeUrl}/rooms/${userRoomId}/broadcast`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      }
    );

    let userBroadcastCount = 0;
    if (userResponse.ok) {
      const userResult = (await userResponse.json()) as {
        broadcastCount?: number;
      };
      userBroadcastCount = userResult.broadcastCount || 0;
    }

    // Also broadcast to request room if requestId provided
    let requestBroadcastCount = 0;
    if (requestId) {
      const requestRoomId = `request_${requestId}`;
      const requestResponse = await fetch(
        `${realtimeUrl}/rooms/${requestRoomId}/broadcast`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(message),
        }
      );

      if (requestResponse.ok) {
        const requestResult = (await requestResponse.json()) as {
          broadcastCount?: number;
        };
        requestBroadcastCount = requestResult.broadcastCount || 0;
      }
    }

    const totalBroadcastCount = userBroadcastCount + requestBroadcastCount;

    return {
      success: true,
      broadcastCount: totalBroadcastCount,
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
