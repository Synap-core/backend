/**
 * Real-time Client - WebSocket connection for live updates
 * 
 * Connects to the Synap real-time notification system (Cloudflare Durable Objects)
 * to receive live updates about async operations.
 */

/**
 * NotificationMessage type definition
 * 
 * Matches the type from @synap/realtime but defined here to avoid dependency.
 */
export interface NotificationMessage {
  type: string;
  data: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  status?: 'success' | 'error' | 'pending';
}

export interface RealtimeConfig {
  /** WebSocket URL (e.g., 'wss://realtime.synap.app/rooms/user_123/subscribe') */
  url: string;
  
  /** User ID for the connection */
  userId: string;
  
  /** Callback when a message is received */
  onMessage?: (message: NotificationMessage) => void;
  
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
  
  /** Callback when connection is established */
  onConnect?: () => void;
  
  /** Callback when connection is closed */
  onDisconnect?: () => void;
  
  /** Maximum number of reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  
  /** Reconnection delay in milliseconds (default: 1000) */
  reconnectDelay?: number;
}

/**
 * Real-time WebSocket Client
 * 
 * Connects to the Synap real-time notification system to receive live updates.
 * 
 * @example
 * ```typescript
 * const realtime = new SynapRealtimeClient({
 *   url: 'wss://realtime.synap.app/rooms/user_123/subscribe',
 *   userId: 'user-123',
 *   onMessage: (message) => {
 *     console.log('Received:', message);
 *     if (message.type === 'note.creation.completed') {
 *       // Refresh notes list
 *     }
 *   },
 * });
 * 
 * realtime.connect();
 * ```
 */
export class SynapRealtimeClient {
  private ws: WebSocket | null = null;
  private config: RealtimeConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isIntentionallyDisconnected = false;

  constructor(config: RealtimeConfig) {
    this.config = config;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 5;
    this.reconnectDelay = config.reconnectDelay ?? 1000;
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    this.isIntentionallyDisconnected = false;
    const wsUrl = this.config.url;
    
    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.config.onConnect?.();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: NotificationMessage = JSON.parse(event.data);
          this.config.onMessage?.(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
          this.config.onError?.(
            new Error(`Failed to parse message: ${error instanceof Error ? error.message : String(error)}`)
          );
        }
      };

      this.ws.onerror = () => {
        this.config.onError?.(new Error('WebSocket error'));
      };

      this.ws.onclose = () => {
        this.config.onDisconnect?.();
      
        // Attempt to reconnect if not intentionally disconnected
        if (!this.isIntentionallyDisconnected) {
          this.attemptReconnect();
        }
      };
    } catch (error) {
      this.config.onError?.(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.isIntentionallyDisconnected = true;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.config.onError?.(
        new Error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`)
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}

