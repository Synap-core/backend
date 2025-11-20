# @synap/client

**Type-safe Client SDK for Synap Core OS**

A hybrid 3-layer SDK that provides both high-level convenience methods and low-level RPC access.

---

## 🏗️ Architecture

The SDK is built on 3 layers:

1. **Core RPC** (Auto-generated): Direct tRPC access via `client.rpc.*`
2. **Business Facade**: High-level methods via `client.notes.*`, `client.chat.*`, etc.
3. **Authentication**: Agnostic token management via `getToken()`

---

## 📦 Installation

```bash
npm install @synap/client
# or
pnpm add @synap/client
# or
yarn add @synap/client
```

---

## 🚀 Quick Start

### Basic Usage

```typescript
import SynapClient from '@synap/client';

const synap = new SynapClient({
  url: 'http://localhost:3000',
  getToken: async () => {
    // Get your auth token (Better Auth, custom auth, etc.)
    return await getSessionToken();
  },
});

// High-level API (recommended)
await synap.notes.create({
  content: '# My Note\n\nContent here',
  title: 'My Note',
});

// Low-level API (for power users)
await synap.rpc.notes.create.mutate({
  content: '# My Note',
});
```

### With Static Token

```typescript
const synap = new SynapClient({
  url: 'http://localhost:3000',
  token: 'your-static-token',
});
```

---

## 📚 API Reference

### High-Level API (Business Facade)

#### Notes

```typescript
// Create a note
await synap.notes.create({
  content: '# My Note',
  title: 'My Note',
  tags: ['important'],
});

// List notes
const notes = await synap.notes.list({
  limit: 20,
  offset: 0,
});

// Get a note
const note = await synap.notes.get('note-id');
```

#### Chat

```typescript
// Send a message
const result = await synap.chat.sendMessage({
  content: 'Create a note about AI',
  threadId: 'thread-123',
});

// Get thread
const thread = await synap.chat.getThread('thread-123');

// List threads
const threads = await synap.chat.listThreads();
```

#### Tasks

```typescript
// Complete a task
await synap.tasks.complete('task-id');
```

#### Capture

```typescript
// Capture a thought
await synap.capture.thought('I need to remember to buy milk');
```

#### System

```typescript
// Health check
const health = await synap.system.health();

// System info
const info = await synap.system.info();
```

### Low-Level API (RPC)

For full control, use the RPC client directly:

```typescript
// Direct tRPC access
await synap.rpc.notes.create.mutate({ content: '...' });
await synap.rpc.notes.list.query({ limit: 20 });
await synap.rpc.chat.sendMessage.mutate({ content: '...' });
```

---

## 🔌 Real-Time (WebSocket)

```typescript
import { SynapRealtimeClient } from '@synap/client/realtime';

const realtime = new SynapRealtimeClient({
  url: synap.getRealtimeUrl('user-123'),
  userId: 'user-123',
  onMessage: (message) => {
    console.log('Received:', message);
    if (message.type === 'note.creation.completed') {
      // Refresh notes list
    }
  },
});

realtime.connect();
```

---

## ⚛️ React Integration

```typescript
import { trpc, createSynapReactClient } from '@synap/client/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();
const trpcClient = createSynapReactClient({
  url: 'http://localhost:3000',
  getToken: async () => await getSessionToken(),
});

function App() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <MyComponent />
    </trpc.Provider>
  );
}

function MyComponent() {
  const { data: notes } = trpc.notes.list.useQuery();
  const createNote = trpc.notes.create.useMutation();

  return (
    <div>
      {notes?.map(note => (
        <div key={note.id}>{note.title}</div>
      ))}
    </div>
  );
}
```

---

## 🔐 Authentication

The SDK supports multiple authentication methods:

### Better Auth (PostgreSQL mode)

```typescript
const synap = new SynapClient({
  url: 'http://localhost:3000',
  getToken: async () => {
    const session = await getSession();
    return session?.token || null;
  },
});
```

### Static Token (SQLite mode)

```typescript
const synap = new SynapClient({
  url: 'http://localhost:3000',
  token: process.env.SYNAP_SECRET_TOKEN,
});
```

### Custom Auth

```typescript
const synap = new SynapClient({
  url: 'http://localhost:3000',
  getToken: async () => {
    // Your custom auth logic
    return await myAuthService.getToken();
  },
});
```

---

## 📖 Documentation

- **[Full Documentation](../../docs/development/SDK_NPM.md)** - Complete guide
- **[Backend SDK Reference](../../docs/development/SDK_REFERENCE.md)** - Backend APIs
- **[Extensibility Guide](../../docs/development/EXTENSIBILITY.md)** - Extending the system

---

## 📝 License

MIT

