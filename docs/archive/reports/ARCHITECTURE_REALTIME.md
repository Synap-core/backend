# Synap Realtime Architecture

## Overview

Synap uses a **WebSocket-based realtime notification system** built on **Cloudflare Workers + Durable Objects** to provide instant feedback to users when background jobs complete.

### Architecture Diagram

```
┌─────────────────┐
│   Frontend UI   │
│  (React Hook)   │
└────────┬────────┘
         │ WebSocket
         ↓
┌─────────────────────────────────────────┐
│  Cloudflare Worker                      │
│  /packages/realtime/src/index.ts        │
└────────┬────────────────────────────────┘
         │ Routes to Room
         ↓
┌─────────────────────────────────────────┐
│  Durable Object: NotificationRoom       │
│  /packages/realtime/src/                │
│  notification-room.ts                   │
│                                         │
│  Manages WebSocket connections          │
│  Broadcasts messages to clients         │
└─────────────────────────────────────────┘
         ↑
         │ HTTP POST /broadcast
         │
┌─────────────────────────────────────────┐
│  Inngest Handler                        │
│  /packages/jobs/src/handlers/           │
│  {handler-name}.ts                      │
│                                         │
│  - Processes event                      │
│  - Calls broadcastNotification()        │
└─────────────────────────────────────────┘
```

### Why Cloudflare Durable Objects?

- **Stateful WebSocket connections**: Durable Objects provide a single consistent state across all WebSocket connections
- **Global edge deployment**: Low latency worldwide
- **Automatic scaling**: Handles connection spikes without configuration
- **Built-in persistence**: Room state survives worker restarts

## Room Structure

Synap uses two types of WebSocket rooms:

### 1. User Rooms
**Room ID Format**: `user_{userId}`

All notifications for a specific user are broadcast to this room. The frontend subscribes to this room on login.

```typescript
// Example: User "abc123" connects to room "user_abc123"
const userId = "abc123";
const roomId = `user_${userId}`;
const wsUrl = `wss://realtime.synap.app/rooms/${roomId}/subscribe`;
```

### 2. Request Rooms
**Room ID Format**: `request_{requestId}`

Used for request-scoped notifications. Allows the frontend to subscribe to notifications for a specific async operation.

```typescript
// Example: Request "req-xyz" connects to room "request_req-xyz"
const requestId = "req-xyz";
const roomId = `request_${requestId}`;
const wsUrl = `wss://realtime.synap.app/rooms/${roomId}/subscribe`;
```

**Use Case**: When the user initiates an action that returns a `requestId`, they can subscribe to that specific request room to get real-time updates.

## Backend: Broadcasting from Handlers

### Pattern Overview

All Inngest event handlers follow this pattern:

```typescript
import { broadcastNotification, broadcastError } from '../utils/realtime-broadcast.js';

export class MyEventHandler implements IEventHandler {
  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    const userId = event.userId;
    const requestId = event.requestId;

    try {
      // Step 1: Do work
      const result = await step.run('process-something', async () => {
        // ... processing logic
      });

      // Step 2: Broadcast success notification
      await step.run('broadcast-notification', async () => {
        await broadcastNotification({
          userId,
          requestId,
          message: {
            type: 'my.event.completed',
            data: { ...result },
            status: 'success',
            timestamp: new Date().toISOString(),
          },
        });
      });

      return { success: true };
    } catch (error) {
      // Broadcast error notification
      await broadcastError(
        userId,
        'my.event.failed',
        error instanceof Error ? error.message : String(error),
        { requestId }
      );

      return { success: false, error: String(error) };
    }
  }
}
```

### Broadcast Utility API

#### `broadcastNotification(options: BroadcastOptions)`

Sends a success notification to user and request rooms.

```typescript
interface BroadcastOptions {
  userId: string;
  requestId?: string;
  message: NotificationMessage;
  realtimeUrl?: string; // Optional, defaults to env var
}

interface NotificationMessage {
  type: string;
  data: Record<string, any>;
  status: 'success' | 'error' | 'pending';
  timestamp: string;
  requestId?: string;
  error?: string;
}
```

**Example**:
```typescript
await broadcastNotification({
  userId: 'user-123',
  requestId: 'req-abc',
  message: {
    type: 'note.creation.completed',
    data: {
      entityId: 'note-456',
      title: 'My Note',
      fileUrl: 'https://storage.synap.app/files/...',
    },
    status: 'success',
    timestamp: new Date().toISOString(),
  },
});
```

#### `broadcastError(userId, eventType, errorMessage, metadata?)`

Convenience method for broadcasting errors.

```typescript
await broadcastError(
  'user-123',
  'note.creation.failed',
  'File upload failed: insufficient storage',
  { requestId: 'req-abc' }
);
```

### Real Handler Examples

#### Example 1: Note Creation Handler

```typescript
// /packages/jobs/src/handlers/note-creation-handler.ts
export class NoteCreationHandler implements IEventHandler {
  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    const userId = event.userId;
    const requestId = event.requestId;

    try {
      // Step 1: Upload file to storage
      const fileMetadata = await step.run('upload-to-storage', async () => {
        return await storageService.uploadFile(buffer, filePath, contentType);
      });

      // Step 2: Create entity projection
      const entity = await step.run('create-entity-projection', async () => {
        return await entityService.createNote({
          userId,
          title,
          content,
          tags,
          fileMetadata,
        });
      });

      // Step 3: Broadcast success
      await step.run('broadcast-notification', async () => {
        const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
        await broadcastNotification({
          userId,
          requestId,
          message: {
            type: 'note.creation.completed',
            data: {
              entityId: entity.id,
              fileUrl: fileMetadata.url,
              filePath: fileMetadata.path,
              title: entity.title,
            },
            status: 'success',
            timestamp: new Date().toISOString(),
          },
        });
      });

      return { success: true };
    } catch (error) {
      const { broadcastError } = await import('../utils/realtime-broadcast.js');
      await broadcastError(
        userId,
        'note.creation.failed',
        error instanceof Error ? error.message : String(error),
        { requestId }
      );
      return { success: false, error: String(error) };
    }
  }
}
```

#### Example 2: Conversation Message Handler

```typescript
// /packages/jobs/src/handlers/conversation-message-handler.ts
export class ConversationMessageHandler implements IEventHandler {
  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    const userId = event.userId;
    const { threadId, content } = event.data as { threadId: string; content: string };

    try {
      // Step 1: Append user message
      const userMessage = await step.run('append-user-message', async () => {
        return await conversationService.appendMessage({
          threadId,
          role: 'user',
          content,
          userId,
        });
      });

      // Step 2: Run AI agent
      const agentState = await step.run('run-synap-agent', async () => {
        return await runSynapAgent({ userId, threadId, message: content });
      });

      // Step 3: Append assistant response
      const assistantMessage = await step.run('append-assistant-message', async () => {
        return await conversationService.appendMessage({
          threadId,
          role: 'assistant',
          content: agentState.response,
          metadata: { agentState },
          userId,
        });
      });

      // Step 4: Broadcast notification
      await step.run('broadcast-notification', async () => {
        const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
        await broadcastNotification({
          userId,
          requestId: event.requestId,
          message: {
            type: 'conversation.response.generated',
            data: {
              threadId,
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              response: agentState.response,
            },
            status: 'success',
            timestamp: new Date().toISOString(),
          },
        });
      });

      return { success: true };
    } catch (error) {
      const { broadcastError } = await import('../utils/realtime-broadcast.js');
      await broadcastError(
        userId,
        'conversation.message.failed',
        error instanceof Error ? error.message : String(error),
        { requestId: event.requestId }
      );
      return { success: false, error: String(error) };
    }
  }
}
```

### All Handlers Using Broadcast

✅ **Verified**: All 5 production handlers implement the broadcast pattern:

1. `/packages/jobs/src/handlers/note-creation-handler.ts`
2. `/packages/jobs/src/handlers/task-creation-handler.ts`
3. `/packages/jobs/src/handlers/project-creation-handler.ts`
4. `/packages/jobs/src/handlers/task-completion-handler.ts`
5. `/packages/jobs/src/handlers/conversation-message-handler.ts`

## Frontend: Subscribing to Notifications

### React Hook: `useSynapRealtime`

The frontend uses a production-ready React hook that handles:
- WebSocket connection management
- Auto-reconnect with exponential backoff
- Keepalive ping every 30 seconds
- Connection state tracking
- Message filtering by type

```typescript
import { useSynapRealtime } from '@synap/ui';

function MyComponent() {
  const { lastMessage, isConnected, sendMessage } = useSynapRealtime({
    userId: 'user-123',
    requestId: 'req-abc', // Optional: subscribe to specific request
    onMessage: (message) => {
      console.log('Received:', message);

      if (message.type === 'note.creation.completed') {
        // Handle note creation success
        showNotification({
          title: 'Note created!',
          message: message.data.title,
        });
      }
    },
    onConnect: () => {
      console.log('Connected to realtime');
    },
    onDisconnect: () => {
      console.log('Disconnected from realtime');
    },
  });

  return (
    <div>
      <Badge color={isConnected ? 'green' : 'red'}>
        {isConnected ? 'Connected' : 'Disconnected'}
      </Badge>

      {lastMessage && (
        <pre>{JSON.stringify(lastMessage, null, 2)}</pre>
      )}
    </div>
  );
}
```

### Hook Features

#### Auto-Reconnect with Exponential Backoff

```typescript
// From /packages/ui/src/hooks/useSynapRealtime.ts
ws.onclose = () => {
  setIsConnected(false);

  if (reconnectAttempts.current < maxReconnectAttempts) {
    const delay = reconnectDelay * Math.pow(2, reconnectAttempts.current - 1);

    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);

    setTimeout(() => {
      reconnectAttempts.current++;
      connect();
    }, delay);
  }
};
```

**Default Settings**:
- Initial delay: 1000ms (1 second)
- Max attempts: 10
- Backoff: Exponential (1s → 2s → 4s → 8s → 16s → 32s → 64s → ...)

#### Keepalive Ping

```typescript
// Ping every 30 seconds to keep connection alive
useEffect(() => {
  if (!isConnected) return;

  const pingInterval = setInterval(() => {
    sendMessage('ping');
  }, 30000);

  return () => clearInterval(pingInterval);
}, [isConnected, sendMessage]);
```

#### Message Filtering

```typescript
const { lastMessage } = useSynapRealtime({
  userId: 'user-123',
  messageFilter: (message) => {
    // Only listen to note-related events
    return message.type.startsWith('note.');
  },
});
```

### Real Frontend Example

#### Example 1: Note Upload with Progress

```typescript
function NoteUploader() {
  const [uploadRequestId, setUploadRequestId] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'completed' | 'failed'>('idle');

  const { lastMessage } = useSynapRealtime({
    userId: user.id,
    requestId: uploadRequestId,
    onMessage: (message) => {
      if (message.type === 'note.creation.completed') {
        setUploadStatus('completed');
        showNotification({
          title: 'Note created!',
          message: `Your note "${message.data.title}" is ready`,
          color: 'green',
        });
      } else if (message.type === 'note.creation.failed') {
        setUploadStatus('failed');
        showNotification({
          title: 'Upload failed',
          message: message.error || 'Unknown error',
          color: 'red',
        });
      }
    },
  });

  const handleUpload = async (file: File) => {
    const requestId = crypto.randomUUID();
    setUploadRequestId(requestId);
    setUploadStatus('uploading');

    // Publish event to backend
    await trpc.capture.uploadNote.mutate({
      file,
      title: file.name,
      requestId, // Include requestId for tracking
    });

    // UI updates will happen via WebSocket message
  };

  return (
    <div>
      <FileInput onChange={handleUpload} disabled={uploadStatus === 'uploading'} />

      {uploadStatus === 'uploading' && (
        <Alert color="blue">
          <Loader size="sm" /> Uploading note...
        </Alert>
      )}

      {uploadStatus === 'completed' && lastMessage && (
        <Alert color="green">
          Note created! View at {lastMessage.data.fileUrl}
        </Alert>
      )}
    </div>
  );
}
```

#### Example 2: Chat with Streaming Response

```typescript
function ChatInterface({ threadId }: { threadId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);

  const { isConnected } = useSynapRealtime({
    userId: user.id,
    onMessage: (message) => {
      if (message.type === 'conversation.response.generated') {
        const { userMessageId, assistantMessageId, response } = message.data;

        // Add assistant message to UI
        setMessages(prev => [
          ...prev,
          {
            id: assistantMessageId,
            role: 'assistant',
            content: response,
            timestamp: message.timestamp,
          },
        ]);

        setIsWaitingForResponse(false);
      }
    },
  });

  const handleSendMessage = async (content: string) => {
    const requestId = crypto.randomUUID();

    // Optimistic UI update
    setMessages(prev => [
      ...prev,
      { id: 'temp', role: 'user', content, timestamp: new Date().toISOString() },
    ]);
    setIsWaitingForResponse(true);

    // Send to backend
    await trpc.chat.sendMessage.mutate({
      threadId,
      content,
      requestId,
    });

    // Response will arrive via WebSocket
  };

  return (
    <div>
      <Badge color={isConnected ? 'green' : 'red'}>
        {isConnected ? 'Connected' : 'Disconnected'}
      </Badge>

      <MessageList messages={messages} />

      {isWaitingForResponse && (
        <div>
          <Loader size="sm" /> Synap is thinking...
        </div>
      )}

      <ChatInput onSend={handleSendMessage} disabled={!isConnected} />
    </div>
  );
}
```

## Cloudflare Infrastructure

### Worker Entry Point

```typescript
// /packages/realtime/src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Extract room ID from path: /rooms/{roomId}/subscribe or /rooms/{roomId}/broadcast
    const match = path.match(/^\/rooms\/([^\/]+)\/(subscribe|broadcast)$/);
    if (!match) {
      return new Response('Not found', { status: 404 });
    }

    const [, roomId, action] = match;

    // Get Durable Object instance for this room
    const id = env.NOTIFICATION_ROOM.idFromName(roomId);
    const room = env.NOTIFICATION_ROOM.get(id);

    // Forward request to Durable Object
    return room.fetch(request);
  },
};
```

### Durable Object: NotificationRoom

```typescript
// /packages/realtime/src/notification-room.ts
export class NotificationRoom {
  private connections: Set<WebSocket> = new Set();
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for clients
    if (request.method === 'GET' && url.pathname.endsWith('/subscribe')) {
      return this.handleWebSocketUpgrade(request);
    }

    // HTTP POST for broadcasting from backend
    if (request.method === 'POST' && url.pathname.endsWith('/broadcast')) {
      return this.handleBroadcast(request);
    }

    return new Response('Method not allowed', { status: 405 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept WebSocket connection
    server.accept();
    this.connections.add(server);

    // Handle disconnection
    server.addEventListener('close', () => {
      this.connections.delete(server);
    });

    // Handle ping messages
    server.addEventListener('message', (event) => {
      if (event.data === 'ping') {
        server.send('pong');
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const message: NotificationMessage = await request.json();

    let broadcastCount = 0;
    const deadConnections: WebSocket[] = [];

    for (const connection of this.connections) {
      try {
        if (connection.readyState === 1) { // OPEN
          connection.send(JSON.stringify(message));
          broadcastCount++;
        } else {
          deadConnections.push(connection);
        }
      } catch (error) {
        deadConnections.push(connection);
      }
    }

    // Clean up dead connections
    for (const conn of deadConnections) {
      this.connections.delete(conn);
    }

    return new Response(
      JSON.stringify({ success: true, broadcastCount }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}
```

## Best Practices

### 1. Always Include `requestId`

When initiating async operations from the frontend, generate and include a `requestId`:

```typescript
const requestId = crypto.randomUUID();

// Pass to backend
await trpc.myMutation.mutate({ ...data, requestId });

// Subscribe to notifications for this request
const { lastMessage } = useSynapRealtime({
  userId: user.id,
  requestId, // Frontend will receive notifications for this specific request
});
```

### 2. Use Inngest Steps for Broadcasting

Always wrap broadcast calls in Inngest steps for reliability and retries:

```typescript
// ✅ Good: Wrapped in step
await step.run('broadcast-notification', async () => {
  await broadcastNotification({...});
});

// ❌ Bad: Direct call (won't retry on failure)
await broadcastNotification({...});
```

### 3. Broadcast Both Success and Error

```typescript
try {
  // ... processing
  await step.run('broadcast-notification', async () => {
    await broadcastNotification({...});
  });
} catch (error) {
  // Always broadcast errors so frontend knows what happened
  await broadcastError(userId, 'operation.failed', String(error), { requestId });
  throw error;
}
```

### 4. Include Meaningful Data in Notifications

Provide enough context for the frontend to update UI without additional API calls:

```typescript
// ✅ Good: Includes all needed data
await broadcastNotification({
  userId,
  requestId,
  message: {
    type: 'note.creation.completed',
    data: {
      entityId: entity.id,
      title: entity.title,
      fileUrl: fileMetadata.url,
      filePath: fileMetadata.path,
      tags: entity.tags,
      createdAt: entity.createdAt,
    },
    status: 'success',
    timestamp: new Date().toISOString(),
  },
});

// ❌ Bad: Not enough data (frontend needs to fetch separately)
await broadcastNotification({
  userId,
  message: {
    type: 'note.creation.completed',
    data: { entityId: entity.id }, // Missing title, url, etc.
    status: 'success',
  },
});
```

### 5. Handle Connection States in UI

Always show connection status and handle disconnections gracefully:

```typescript
const { isConnected, lastMessage } = useSynapRealtime({...});

return (
  <div>
    {!isConnected && (
      <Alert color="yellow">
        <IconWifi size={16} /> Reconnecting to realtime...
      </Alert>
    )}

    {/* Your UI */}
  </div>
);
```

## Troubleshooting

### Frontend: No Messages Received

**Check**:
1. Is `userId` correct in the hook?
2. Is WebSocket connection established? Check `isConnected` state
3. Is backend actually broadcasting? Check Inngest logs
4. Is `requestId` matching? Verify frontend and backend use same ID

**Debug**:
```typescript
const { lastMessage, isConnected } = useSynapRealtime({
  userId: user.id,
  requestId: myRequestId,
  onMessage: (msg) => {
    console.log('📨 Received message:', msg);
  },
  onConnect: () => {
    console.log('✅ WebSocket connected');
  },
  onDisconnect: () => {
    console.warn('❌ WebSocket disconnected');
  },
});

console.log('Connection status:', isConnected);
console.log('Last message:', lastMessage);
```

### Backend: Broadcast Not Reaching Clients

**Check**:
1. Is `REALTIME_URL` environment variable set correctly?
2. Is the Durable Object deployed?
3. Are there any errors in broadcast utility logs?

**Debug**:
```typescript
await step.run('broadcast-notification', async () => {
  console.log('Broadcasting to userId:', userId);
  console.log('requestId:', requestId);

  const result = await broadcastNotification({
    userId,
    requestId,
    message: {...},
  });

  console.log('Broadcast result:', result);
});
```

### Connection Keeps Dropping

**Possible Causes**:
1. Cloudflare Worker timeout (max 15 minutes for WebSocket)
2. Network issues
3. Missing keepalive ping

**Solution**: The hook already implements keepalive ping every 30 seconds. If still dropping, check:
- Cloudflare Worker logs for errors
- Network proxy/firewall settings
- Browser console for WebSocket errors

### Too Many Reconnection Attempts

**Cause**: Frontend keeps trying to reconnect but fails

**Solution**:
```typescript
const { isConnected, error } = useSynapRealtime({
  userId: user.id,
  maxReconnectAttempts: 5, // Limit attempts
  onError: (error) => {
    // Show user-friendly error
    showNotification({
      title: 'Connection Error',
      message: 'Unable to connect to realtime. Please refresh the page.',
      color: 'red',
    });
  },
});
```

## Performance Considerations

### Scalability

- **Durable Objects**: Each room is a separate Durable Object instance
- **Max connections per room**: ~10,000 (Cloudflare limit)
- **Max rooms**: Unlimited (Durable Objects scale automatically)

### Cost Optimization

1. **Use Request Rooms sparingly**: Only subscribe to request-specific notifications when needed
2. **Unsubscribe when component unmounts**: The hook handles this automatically
3. **Batch notifications**: If sending multiple updates, consider batching into a single message

### Monitoring

Key metrics to monitor:
- Active WebSocket connections per room
- Message broadcast latency
- Reconnection rate
- Failed broadcast attempts

## Production Checklist

- [x] All handlers implement broadcast pattern
- [x] React hook with auto-reconnect implemented
- [x] Keepalive ping configured
- [x] Error broadcasting implemented
- [x] Connection state shown in UI
- [ ] E2E tests for realtime flow (TODO: Phase 5)
- [ ] Monitoring dashboard for WebSocket connections (TODO)
- [ ] Alerting for high reconnection rates (TODO)
- [ ] Load testing of WebSocket rooms (TODO)

## Next Steps

1. **Write E2E Tests**: Test the full flow from event → handler → broadcast → frontend
2. **Add Monitoring**: Track WebSocket connection metrics in Prometheus
3. **Load Testing**: Verify performance under high connection count
4. **Documentation**: Add API docs for all notification message types
