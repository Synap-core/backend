/**
 * Client utility for broadcasting notifications to Durable Objects
 * 
 * This utility is used by Inngest workers to send notifications
 * to connected WebSocket clients.
 */

export interface NotificationMessage {
  type: string;
  data: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  status?: 'success' | 'error' | 'pending';
}

export interface BroadcastOptions {
  roomId: string;
  message: NotificationMessage;
  realtimeUrl?: string;
}

/**
 * Broadcast a notification to a Durable Object room
 * 
 * @param options - Broadcast options
 * @returns Promise resolving to broadcast result
 */
export async function broadcastNotification(
  options: BroadcastOptions
): Promise<{ success: boolean; broadcastCount?: number; error?: string }> {
  const { roomId, message, realtimeUrl = process.env.REALTIME_URL || 'https://realtime.synap.app' } = options;

  try {
    const response = await fetch(`${realtimeUrl}/rooms/${roomId}/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Broadcast failed: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as { broadcastCount?: number };
    return {
      success: true,
      broadcastCount: result.broadcastCount,
    };
  } catch (error) {
    console.error('Failed to broadcast notification:', error);
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

