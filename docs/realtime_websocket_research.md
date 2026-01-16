# Real-Time WebSocket Solutions - Research & Recommendations

## Executive Summary

For a pod-per-user architecture with PostgreSQL + postgres.js, the recommended approach is:

🎯 **Recommendation: `ws` library + PostgreSQL LISTEN/NOTIFY + Redis Pub/Sub (optional for multi-pod)**

**Rationale:**

- ✅ Maximum performance (50,000+ connections/pod, <20ms latency)
- ✅ Minimal overhead (5KB bundle, perfect for per-user pods)
- ✅ Full control over implementation
- ✅ Perfect match for postgres.js (both lightweight, TypeScript-native)
- ✅ LISTEN/NOTIFY works brilliantly for low-medium notification rates
- ✅ Simple architecture for single-pod-per-user

---

## Part 1: WebSocket Library Comparison

### Option 1: `ws` ⭐ **RECOMMENDED**

**Performance (2024):**

- 50,000+ concurrent connections per server
- ~19ms average RTT (Round Trip Time)
- 44,000+ messages/second throughput
- 5KB bundle size
- Lowest CPU usage and latency

**Pros:**

- ✅ **Raw performance** - Fastest option available
- ✅ **Minimal overhead** - Pure WebSocket, no custom protocol
- ✅ **Full control** - Build exactly what you need
- ✅ **Perfect for pods** - Lightweight, efficient resource usage
- ✅ **Battle-tested** - Used by Socket.IO internally
- ✅ **TypeScript-first** - Excellent types, clean API

**Cons:**

- ❌ Manual implementation of features (reconnection, rooms, broadcasting)
- ❌ No auto-fallback to long-polling
- ❌ More boilerplate code initially

**Best For:**

- ✅ Pod-per-user architecture (your case!)
- ✅ Microservices communication
- ✅ Low-latency trading platforms
- ✅ IoT device communication
- ✅ Maximum performance requirements

**Example Code:**

```typescript
import { WebSocketServer } from "ws";
import { sql } from "@synap/database";

const wss = new WebSocketServer({ port: 8080 });

// Listen to PostgreSQL notifications
await sql.listen("events", (payload) => {
  const event = JSON.parse(payload);

  // Broadcast to all connected clients
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(event));
    }
  });
});

wss.on("connection", (ws, req) => {
  console.log("Client connected");

  ws.on("message", (data) => {
    console.log("Received:", data);
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});
```

---

### Option 2: Socket.IO

**Performance (2024):**

- ~27,000 messages/second throughput (~40% slower than ws)
- ~31ms average RTT
- 10.4KB bundle size
- 20-30% overhead from custom protocol

**Pros:**

- ✅ Auto-reconnection built-in
- ✅ Rooms and namespaces
- ✅ Auto-fallback to HTTP long-polling
- ✅ Broadcasting helpers
- ✅ Better DX (Developer Experience)
- ✅ Scales horizontally with Redis adapter

**Cons:**

- ❌ More overhead than `ws`
- ❌ Custom protocol (not pure WebSocket)
- ❌ Larger bundle size
- ❌ Overkill for pod-per-user architecture

**Best For:**

- Multi-room chat applications
- Browser clients needing fallback support
- Applications where DX > raw performance
- Teams preferring batteries-included solutions

---

### Option 3: Soketi

**Performance (2024):**

- Built on `uWebSockets.js` (very fast)
- Negligible memory footprint per connection
- Pusher Protocol v7 compatible
- Redis scaling built-in
- Prometheus metrics included

**Pros:**

- ✅ Production-ready server out of the box
- ✅ Built-in monitoring (Prometheus)
- ✅ Redis support for scaling
- ✅ Self-hosted Pusher alternative
- ✅ Great for Laravel ecosystem

**Cons:**

- ❌ Requires separate server process
- ❌ Pusher protocol overhead
- ❌ Less flexible than `ws`
- ❌ Not ideal for pod-per-user architecture

**Best For:**

- Laravel applications
- Teams migrating from Pusher
- Need managed WebSocket server
- Want built-in monitoring

---

## Part 2: Real-Time Communication Patterns

### WebSocket vs SSE vs Long Polling

| Feature             | WebSocket        | Server-Sent Events (SSE)       | Long Polling     |
| ------------------- | ---------------- | ------------------------------ | ---------------- |
| **Latency**         | <20ms            | <50ms                          | 200-500ms        |
| **Connection Type** | Bidirectional    | Unidirectional (server→client) | Request/Response |
| **Protocol**        | Custom (ws://)   | HTTP                           | HTTP             |
| **Browser Support** | Excellent (2024) | Good (no IE11)                 | Universal        |
| **Data Type**       | Text + Binary    | Text only (UTF-8)              | Text/Binary      |
| **Auto Reconnect**  | Manual           | Built-in                       | N/A              |
| **Throughput**      | 44K+ msg/s       | ~10K msg/s                     | ~100 req/s       |
| **Resource Usage**  | Low              | Very Low                       | High             |
| **Scaling**         | Complex          | Simple                         | Very Simple      |

**Verdict for Your Use Case:**

- ✅ **WebSocket** - Best for bidirectional real-time (chat, collaboration, live updates)
- ⚠️ **SSE** - Good alternative if only server→client needed (notifications, feeds)
- ❌ **Long Polling** - Legacy fallback only

---

## Part 3: PostgreSQL LISTEN/NOTIFY Integration

### Architecture Pattern

```
PostgreSQL Triggers
       ↓
   pg_notify('channel', json_payload)
       ↓
postgres.js LISTEN subscription
       ↓
  WebSocket Server (ws)
       ↓
  Broadcast to clients
```

### Implementation Example

**Step 1: PostgreSQL Trigger**

```sql
-- Create notification trigger
CREATE OR REPLACE FUNCTION notify_event_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Send minimal payload
  PERFORM pg_notify(
    'events',
    json_build_object(
      'event_id', NEW.id,
      'event_type', NEW.event_type,
      'user_id', NEW.user_id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach to events table
CREATE TRIGGER event_insert_trigger
  AFTER INSERT ON events_timescale
  FOR EACH ROW
  EXECUTE FUNCTION notify_event_change();
```

**Step 2: Node.js Listener with postgres.js**

```typescript
import { WebSocketServer } from "ws";
import { sql } from "@synap/database";

// Create WebSocket server
const wss = new WebSocketServer({ port: 8080 });

// Listen to PostgreSQL notifications
await sql.listen("events", async (payload) => {
  try {
    // Parse notification
    const notification = JSON.parse(payload);

    // Fetch full event data if needed
    const [event] = await sql`
      SELECT * FROM events_timescale 
      WHERE id = ${notification.event_id}
    `;

    // Broadcast to relevant clients
    broadcastToUser(notification.user_id, {
      type: "event_created",
      data: event,
    });
  } catch (err) {
    console.error("Notification error:", err);
  }
});

function broadcastToUser(userId: string, message: any) {
  wss.clients.forEach((client) => {
    if (client.userId === userId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Handle WebSocket connections
wss.on("connection", (ws, req) => {
  // Extract user ID from auth token
  const token = req.headers.authorization?.replace("Bearer ", "");
  ws.userId = verifyToken(token);

  ws.on("close", () => {
    console.log(`User ${ws.userId} disconnected`);
  });
});
```

---

### Best Practices for Production

#### 1. Keep NOTIFY Payloads Small

```typescript
// ❌ BAD - Large payload
PERFORM pg_notify('events', row_to_json(NEW)::text);

// ✅ GOOD - Minimal payload, fetch full data separately
PERFORM pg_notify('events', json_build_object('id', NEW.id)::text);
```

**Why:** NOTIFY has 8KB payload limit, and large payloads slow transaction commits.

#### 2. Use Outbox Pattern for Reliability

```sql
-- Outbox table for guaranteed delivery
CREATE TABLE event_outbox (
  id UUID PRIMARY KEY,
  event_id UUID REFERENCES events_timescale(id),
  channel TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger stores in outbox
CREATE OR REPLACE FUNCTION queue_event_notification()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO event_outbox (id, event_id, channel, payload)
  VALUES (gen_random_uuid(), NEW.id, 'events', jsonb_build_object('id', NEW.id));

  PERFORM pg_notify('events', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Why:** LISTEN/NOTIFY is ephemeral - if no listener is connected, messages are lost. Outbox ensures delivery.

#### 3. Manage NOTIFY Performance Limits

**Throughput Limits:**

- ✅ Low-Medium: < 500 notifications/second - Perfect for LISTEN/NOT IFY
- ⚠️ Medium-High: 500-2000/s - Consider outbox + polling
- ❌ High: > 2000/s - Use Redis Pub/Sub or Kafka instead

**Global Lock Issue:**

- NOTIFY acquires global lock during commit
- Can serialize all commits under heavy write load
- For high-volume writes, use LISTEN/NOTIFY as signal, queue as transport

#### 4. Handle Reconnections

```typescript
async function setupListener() {
  try {
    await sql.listen("events", handleNotification);
    console.log("Listening to events channel");
  } catch (err) {
    console.error("Listen failed, retrying in 5s...", err);
    setTimeout(setupListener, 5000);
  }
}

// Initial setup
await setupListener();
```

---

## Part 4: Pod-Per-User Architecture Considerations

### Your Specific Architecture

```
User Request → Ingress → Pod (User 123) → PostgreSQL
                          ↓
                      WebSocket Server (ws)
                          ↓
                      LISTEN 'events'
```

**Key Benefits:**

1. ✅ **Isolation** - Each user's traffic in separate pod
2. ✅ **Simple State** - No cross-pod communication needed
3. ✅ **No Sticky Sessions** - User always routes to their pod
4. ✅ **Resource Control** - Per-user resource limits
5. ✅ **Security** - Natural multi-tenancy

### Scaling Patterns

#### Single-Pod-Per-User (Current)

```typescript
// No multi-pod complexity needed!
await sql.listen("events", (payload) => {
  // Just broadcast to clients in THIS pod
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
});
```

**Pros:**

- ✅ Simplest possible architecture
- ✅ No Redis/message broker needed
- ✅ Perfect for pod-per-user model

#### Multi-Pod-Per-User (Future Scaling)

If you ever need multiple pods per user:

```typescript
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);
const pubsub = redis.duplicate();

// Subscribe to Redis channel
await pubsub.subscribe(`user:${userId}:events`);

pubsub.on("message", (channel, message) => {
  // Broadcast to local WebSocket clients
  broadcastToClients(message);
});

// When PostgreSQL NOTIFY received
await sql.listen("events", async (payload) => {
  const event = JSON.parse(payload);

  // Publish to Redis (reaches all pods for this user)
  await redis.publish(`user:${event.user_id}:events`, JSON.stringify(event));
});
```

### Kubernetes Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-pod
spec:
  replicas: 1 # One pod per user
  selector:
    matchLabels:
      app: synap-user-pod
      user-id: "{{USER_ID}}" # Dynamic per user
  template:
    spec:
      containers:
        - name: app
          image: synap-backend:latest
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: url
            - name: WS_PORT
              value: "8080"
          resources:
            limits:
              memory: "512Mi"
              cpu: "500m"
            requests:
              memory: "256Mi"
              cpu: "250m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
```

---

## Part 5: Final Recommendations

### Architecture Decision

**For Your Pod-Per-User Model:**

```
┌─────────────────────────────────────────────┐
│ User Pod (Isolated per user)               │
├─────────────────────────────────────────────┤
│                                             │
│  ┌──────────┐      ┌──────────────┐        │
│  │   API    │─────▶│  WebSocket   │        │
│  │  Server  │      │  Server (ws) │        │
│  └──────────┘      └──────┬───────┘        │
│       │                   │                 │
│       ▼                   │                 │
│  ┌──────────────────┐    │                 │
│  │  postgres.js     │◀───┘                 │
│  │  LISTEN 'events' │                      │
│  └────────┬─────────┘                      │
└───────────┼──────────────────────────────────┘
            │
            ▼
   ┌─────────────────┐
   │   PostgreSQL    │
   │  + TimescaleDB  │
   │   NOTIFY via    │
   │    Triggers     │
   └─────────────────┘
```

### Implementation Checklist

**Phase 1: Basic Real-Time (2-3 hours)**

- [ ] Install `ws` library: `pnpm add ws @types/ws`
- [ ] Create WebSocket server file (`packages/realtime/src/server.ts`)
- [ ] Add PostgreSQL trigger for NOTIFY
- [ ] Implement postgres.js LISTEN subscription
- [ ] Add basic broadcast to connected clients
- [ ] Test with single client

**Phase 2: Production Features (4-6 hours)**

- [ ] Add authentication to WebSocket connections
- [ ] Implement per-user message filtering
- [ ] Add automatic reconnection (client-side)
- [ ] Create outbox table for guaranteed delivery
- [ ] Add connection monitoring/metrics
- [ ] Implement graceful shutdown

**Phase 3: Optimization (2-3 hours)**

- [ ] Add connection pooling for postgres.js listener
- [ ] Implement message batching
- [ ] Add rate limiting per connection
- [ ] Set up Prometheus metrics
- [ ] Load testing (k6 or Artillery)

### Code Example: Complete Setup

```typescript
// packages/realtime/src/server.ts
import { WebSocketServer } from "ws";
import { sql } from "@synap/database";
import { verifyToken } from "@synap/auth";

const PORT = parseInt(process.env.WS_PORT || "8080");
const wss = new WebSocketServer({ port: PORT });

// Connection management
const connections = new Map<string, Set<WebSocket>>();

// Setup PostgreSQL listener
await sql.listen("events", async (payload) => {
  try {
    const { event_id, user_id } = JSON.parse(payload);

    // Fetch full event
    const [event] = await sql`
      SELECT * FROM events_timescale WHERE id = ${event_id}
    `;

    // Broadcast to user's connections
    broadcastToUser(user_id, {
      type: "event",
      data: event,
    });
  } catch (err) {
    console.error("Notification error:", err);
  }
});

// WebSocket connection handler
wss.on("connection", async (ws, req) => {
  try {
    // Authenticate
    const token = req.headers.authorization?.replace("Bearer ", "");
    const userId = await verifyToken(token);

    // Track connection
    if (!connections.has(userId)) {
      connections.set(userId, new Set());
    }
    connections.get(userId)!.add(ws);

    ws.on("message", (data) => {
      // Handle client messages
      console.log(`Message from ${userId}:`, data);
    });

    ws.on("close", () => {
      connections.get(userId)?.delete(ws);
      console.log(`User ${userId} disconnected`);
    });

    // Send welcome message
    ws.send(
      JSON.stringify({
        type: "connected",
        userId,
      })
    );
  } catch (err) {
    ws.close(1008, "Unauthorized");
  }
});

function broadcastToUser(userId: string, message: any) {
  const userConnections = connections.get(userId);
  if (!userConnections) return;

  const payload = JSON.stringify(message);
  userConnections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

console.log(`WebSocket server running on port ${PORT}`);
```

---

## Summary Table

| Aspect                   | Recommendation      | Rationale                                           |
| ------------------------ | ------------------- | --------------------------------------------------- |
| **WebSocket Library**    | `ws`                | Max performance, minimal overhead, perfect for pods |
| **Database Integration** | LISTEN/NOTIFY       | Native PostgreSQL, low-medium volume perfect        |
| **Payload Strategy**     | Minimal + Fetch     | Avoid 8KB limit, faster commits                     |
| **Reliability**          | Outbox Pattern      | Guaranteed delivery even if listener offline        |
| **Scaling Pattern**      | Single-pod-per-user | Simplest, no Redis needed initially                 |
| **Communication**        | WebSocket > SSE     | Bidirectional needed for real-time                  |
| **Fallback**             | Optional Redis      | Only if multi-pod-per-user needed later             |

---

## Next Steps

Would you like me to:

1. **Implement the basic real-time setup** (Phase 1: 2-3 hours)
2. **Create detailed production implementation plan** with security, monitoring, etc.
3. **Research alternative approaches** (e.g., Supabase Realtime, Rails ActionCable patterns)
4. **Something else?**
