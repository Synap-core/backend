/**
 * React Hook for Real-Time Notifications
 * 
 * This hook connects to the Cloudflare Durable Object WebSocket endpoint
 * and provides real-time notifications for a user or request.
 * 
 * @example
 * ```tsx
 * const { lastMessage, isConnected } = useSynapRealtime({
 *   userId: 'user-123',
 *   requestId: 'request-456', // Optional
 * });
 * 
 * useEffect(() => {
 *   if (lastMessage?.type === 'note.creation.completed') {
 *     console.log('Note created!', lastMessage.data);
 *   }
 * }, [lastMessage]);
 * ```
 */

import { useEffect, useState, useRef, useCallback } from 'react';

export interface RealtimeOptions {
  userId: string;
  requestId?: string;
  realtimeUrl?: string;
  autoConnect?: boolean;
  onMessage?: (message: NotificationMessage) => void;
  onError?: (error: Event) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export interface NotificationMessage {
  type: string;
  data: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  status?: 'success' | 'error' | 'pending';
}

export interface UseSynapRealtimeReturn {
  lastMessage: NotificationMessage | null;
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  sendMessage: (message: string) => void;
  error: Event | null;
}

/**
 * React hook for real-time notifications via WebSocket
 * 
 * Connects to the Cloudflare Durable Object WebSocket endpoint and provides
 * real-time notifications. Supports both user-based and request-based subscriptions.
 */
export function useSynapRealtime(options: RealtimeOptions): UseSynapRealtimeReturn {
  const {
    userId,
    requestId,
    realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL || 'wss://realtime.synap.app',
    autoConnect = true,
    onMessage,
    onError,
    onConnect,
    onDisconnect,
  } = options;

  const [lastMessage, setLastMessage] = useState<NotificationMessage | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Event | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;
  const reconnectDelay = 1000; // Start with 1 second

  /**
   * Get WebSocket URL based on subscription type
   */
  const getWebSocketUrl = useCallback(() => {
    // Prefer requestId if provided, otherwise use userId
    const roomId = requestId ? `request_${requestId}` : `user_${userId}`;
    // Convert HTTP/HTTPS URL to WebSocket URL
    let wsUrl = realtimeUrl;
    if (wsUrl.startsWith('http://')) {
      wsUrl = wsUrl.replace('http://', 'ws://');
    } else if (wsUrl.startsWith('https://')) {
      wsUrl = wsUrl.replace('https://', 'wss://');
    } else if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      // Default to wss if no protocol specified
      wsUrl = `wss://${wsUrl}`;
    }
    return `${wsUrl}/rooms/${roomId}/subscribe`;
  }, [userId, requestId, realtimeUrl]);

  /**
   * Connect to WebSocket
   */
  const connect = useCallback(() => {
    // Don't connect if already connected (WebSocket.OPEN = 1)
    if (wsRef.current?.readyState === 1) {
      return;
    }

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
    }

    try {
      const wsUrl = getWebSocketUrl();
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setIsConnected(true);
        setError(null);
        reconnectAttempts.current = 0;
        onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          const message: NotificationMessage = JSON.parse(event.data);
          setLastMessage(message);
          onMessage?.(message);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      ws.onerror = (event) => {
        setError(event);
        onError?.(event);
      };

      ws.onclose = () => {
        setIsConnected(false);
        onDisconnect?.();

        // Attempt to reconnect if not manually disconnected
        if (reconnectAttempts.current < maxReconnectAttempts) {
          reconnectAttempts.current++;
          const delay = reconnectDelay * Math.pow(2, reconnectAttempts.current - 1); // Exponential backoff
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      };

      wsRef.current = ws;
    } catch (err) {
      console.error('Failed to create WebSocket connection:', err);
      setError(err as Event);
    }
  }, [getWebSocketUrl, onMessage, onError, onConnect, onDisconnect]);

  /**
   * Disconnect from WebSocket
   */
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttempts.current = maxReconnectAttempts; // Prevent reconnection

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  /**
   * Send message to WebSocket (for keepalive)
   */
  const sendMessage = useCallback((message: string) => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(message);
    }
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    // Cleanup on unmount
    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  // Keepalive ping
  useEffect(() => {
    if (!isConnected) return;

    const pingInterval = setInterval(() => {
      sendMessage('ping');
    }, 30000); // Ping every 30 seconds

    return () => {
      clearInterval(pingInterval);
    };
  }, [isConnected, sendMessage]);

  return {
    lastMessage,
    isConnected,
    connect,
    disconnect,
    sendMessage,
    error,
  };
}

