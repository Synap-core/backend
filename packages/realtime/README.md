# @synap/realtime - Real-Time Notifications

Real-time notification system using Cloudflare Durable Objects and WebSocket.

## Overview

This package provides real-time feedback for asynchronous operations in the Synap backend. When Inngest workers complete their tasks, they broadcast notifications to connected WebSocket clients via Cloudflare Durable Objects.

## Architecture

- **Cloudflare Worker**: Routes requests to Durable Objects
- **Durable Object (NotificationRoom)**: Manages WebSocket connections for a room
- **Broadcast Utility**: Used by Inngest workers to send notifications
- **React Hook**: Frontend hook for connecting to WebSocket

## Setup

### Prerequisites

- Cloudflare account with Workers plan
- Wrangler CLI installed: `npm install -g wrangler`

### Installation

```bash
cd packages/realtime
pnpm install
```

### Development

```bash
# Start local development server
pnpm dev

# Deploy to Cloudflare
pnpm deploy
```

### Configuration

Set environment variables:

```bash
# Set realtime URL (if different from default)
wrangler secret put REALTIME_URL
```

## Usage

### Worker Side (Broadcasting)

```typescript
import { broadcastNotification } from "@synap/jobs/utils/realtime-broadcast";

// Broadcast success notification
await broadcastNotification({
  userId: "user-123",
  requestId: "request-456",
  message: {
    type: "note.creation.completed",
    data: { entityId: "entity-789" },
    requestId: "request-456",
    status: "success",
    timestamp: new Date().toISOString(),
  },
});
```

### Frontend Side (Receiving)

```typescript
import { useSynapRealtime } from '@synap/ui';

function MyComponent() {
  const { lastMessage, isConnected } = useSynapRealtime({
    userId: 'user-123',
    requestId: 'request-456', // Optional
  });

  useEffect(() => {
    if (lastMessage?.type === 'note.creation.completed') {
      console.log('Note created!', lastMessage.data);
    }
  }, [lastMessage]);

  return (
    <div>
      {isConnected ? 'Connected' : 'Disconnected'}
      {lastMessage && <div>Last message: {lastMessage.type}</div>}
    </div>
  );
}
```

## API

### Worker Routes

- `GET /rooms/:roomId/subscribe` - Upgrade to WebSocket
- `POST /rooms/:roomId/broadcast` - Broadcast notification
- `GET /rooms/:roomId/health` - Health check

### Room Types

- `user_{userId}` - User-based notifications
- `request_{requestId}` - Request-based notifications

## Testing

```bash
# Run tests
pnpm test

# Manual WebSocket test
wscat -c wss://realtime.synap.app/rooms/user_test-123/subscribe
```

## Documentation

See [ARCHITECTURE_REALTIME.md](../../ARCHITECTURE_REALTIME.md) for detailed architecture documentation.
