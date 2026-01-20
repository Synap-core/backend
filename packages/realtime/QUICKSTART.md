# Quick Start Guide - Real-Time Notifications

## Prerequisites

1. **Cloudflare Account** with Workers plan
2. **Wrangler CLI**: `npm install -g wrangler`
3. **Authentication**: `wrangler login`

## Local Development

```bash
cd packages/realtime

# Install dependencies
pnpm install

# Start local development server
pnpm dev

# The worker will be available at http://localhost:8787
```

## Deployment

```bash
# Deploy to Cloudflare
pnpm deploy

# Set environment variable (if needed)
wrangler secret put REALTIME_URL
```

## Testing

### Manual WebSocket Test

```bash
# Install wscat (if not already installed)
npm install -g wscat

# Connect to WebSocket
wscat -c wss://realtime.synap.app/rooms/user_test-123/subscribe
```

### Broadcast Test (from another terminal)

```bash
curl -X POST https://realtime.synap.app/rooms/user_test-123/broadcast \
  -H "Content-Type: application/json" \
  -d '{
    "type": "test.notification",
    "data": { "message": "Hello from test!" },
    "status": "success"
  }'
```

You should see the message appear in the WebSocket client.

## Integration with Backend

### 1. Set Environment Variable

In your backend environment:

```bash
export REALTIME_URL=https://realtime.synap.app
```

### 2. Workers Automatically Broadcast

All handlers now automatically broadcast notifications. No additional configuration needed.

### 3. Frontend Integration

```typescript
import { useSynapRealtime } from '@synap/ui';

function MyComponent() {
  const { lastMessage, isConnected } = useSynapRealtime({
    userId: 'user-123',
  });

  useEffect(() => {
    if (lastMessage?.type === 'note.creation.completed') {
      console.log('Note created!', lastMessage.data);
    }
  }, [lastMessage]);

  return <div>{isConnected ? 'Connected' : 'Disconnected'}</div>;
}
```

## Troubleshooting

### WebSocket Connection Fails

1. Check Cloudflare Worker is deployed
2. Verify WebSocket URL is correct
3. Check browser console for errors
4. Verify CORS is configured (if needed)

### Notifications Not Received

1. Check worker logs for broadcast errors
2. Verify `REALTIME_URL` environment variable is set
3. Check Durable Object health: `GET /rooms/:roomId/health`
4. Verify WebSocket connection is active

## Next Steps

- Add authentication to WebSocket connections
- Implement message queuing for offline users
- Add presence system (track online users)
