# Realtime Integration Guide

Developer guide for integrating real-time collaboration in the Synap frontend.

Covers: **Documents** (TipTap/ProseMirror) and **Whiteboards** (Tldraw).

---

## Architecture Overview

```
Frontend App
  |
  |-- /presence namespace -----> Presence tracking (who's online, cursors, typing)
  |-- /yjs namespace ----------> CRDT document sync (content collaboration)
  |-- tRPC (HTTP) -------------> Session lifecycle, manual saves, version history
  |
  v
Caddy (HTTPS termination at backend.synap.live)
  |
  |-- /socket.io/* --> realtime:4001  (WebSocket + polling)
  |-- /trpc/*      --> backend:4000   (HTTP)
  |
  v
Realtime Service (port 4001)        Backend API (port 4000)
  - Yjs CRDT sync                     - tRPC endpoints
  - Presence broadcast                - Session management
  - Debounced persistence             - Version snapshots
  - MinIO storage (whiteboards)       - MinIO storage (documents)
```

**Key principle**: Content flows through Yjs WebSocket for real-time edits. tRPC is only for metadata, session lifecycle, and explicit saves.

---

## 1. Dependencies

```bash
npm install yjs y-socket.io socket.io-client
# For TipTap documents:
npm install @tiptap/extension-collaboration @tiptap/extension-collaboration-cursor
# For Tldraw whiteboards:
npm install tldraw @tldraw/yjs
```

---

## 2. Connection URLs

| Environment | WebSocket URL | tRPC URL |
|-------------|---------------|----------|
| Local dev | `ws://localhost:4001` | `http://localhost:4000` |
| Production | `wss://backend.synap.live` | `https://backend.synap.live` |

In production, Caddy routes `/socket.io/*` to the realtime service automatically. The frontend connects to the same domain for both WebSocket and HTTP.

---

## 3. Presence (Online Users, Cursors, Typing)

Presence is a lightweight Socket.IO namespace for tracking who's viewing what. It's **separate from Yjs** and doesn't carry document content.

### Connect

```typescript
import { io } from "socket.io-client";

const REALTIME_URL = "wss://backend.synap.live"; // or ws://localhost:4001

const presenceSocket = io(`${REALTIME_URL}/presence`, {
  auth: {
    userId: "user-uuid",
    userName: "John Doe",
    viewId: "document-or-view-uuid",   // specific view
    viewType: "document",              // "document" | "whiteboard" | "ai-chat"
    workspaceId: "workspace-uuid",     // for workspace-level events
  },
  transports: ["websocket", "polling"],
  withCredentials: true,
});
```

### Required auth fields

| Field | Required | Description |
|-------|----------|-------------|
| `userId` | Yes | User's UUID. Connection rejected without it. |
| `userName` | No | Display name. Defaults to "Anonymous". |
| `viewId` | One of viewId/workspaceId | ID of the document/view being viewed. |
| `viewType` | No | Type hint: `"document"`, `"whiteboard"`, `"ai-chat"`, etc. |
| `workspaceId` | One of viewId/workspaceId | For workspace-level presence. |

### Listen for events

```typescript
// Initial presence state on connect
presenceSocket.on("presence:init", ({ users, yourColor }) => {
  // users: Array<{ userId, userName, color, cursor?, isTyping? }>
  // yourColor: string (assigned color for this user)
  setActiveUsers(users);
  setMyColor(yourColor);
});

// User joined/left updates
presenceSocket.on("presence:update", (users) => {
  setActiveUsers(users);
});
```

### Emit events

```typescript
// Cursor position (for non-Yjs views only — Yjs documents/whiteboards
// use Awareness for cursors, not this event)
// Event name is "cursor:move" (NOT "cursor:update")
presenceSocket.emit("cursor:move", { x: 100, y: 200 });

// Typing indicator — simple boolean, NOT "typing:start"/"typing:stop"
presenceSocket.emit("typing", true);   // user is typing
presenceSocket.emit("typing", false);  // user stopped typing

// Heartbeat (keeps session alive)
presenceSocket.emit("heartbeat");

// Request fresh presence data
presenceSocket.emit("presence:request");
```

> **Important**: For Yjs-connected views (documents with TipTap, whiteboards with Tldraw),
> cursor positions are synced through **Yjs Awareness**, not Socket.IO `cursor:move`.
> The `cursor:move` event is only for non-Yjs views (e.g. kanban, timeline).

### Join additional rooms dynamically

```typescript
// Subscribe to extra rooms after initial connection
presenceSocket.emit("join-room", `workspace:${workspaceId}`);
presenceSocket.emit("leave-room", `workspace:${workspaceId}`);
```

### Disconnect

```typescript
presenceSocket.disconnect();
```

---

## 4. Document Collaboration (TipTap + Yjs)

Documents use Yjs for CRDT-based real-time sync. Content is persisted server-side to MinIO (debounced every 10s) and versioned on session close.

### Room naming

```
Room name: "{documentId}"
Example:   "aab9b236-c960-46dc-a0fd-2b7a09fa67ee"
```

### Connect with SocketIOProvider

```typescript
import * as Y from "yjs";
import { SocketIOProvider } from "y-socket.io";

const REALTIME_URL = "wss://backend.synap.live"; // or ws://localhost:4001

// 1. Create Yjs document
const ydoc = new Y.Doc();

// 2. Connect to Yjs server
const provider = new SocketIOProvider(
  REALTIME_URL,
  documentId,         // Room name = document UUID
  ydoc,
  {
    autoConnect: true,
    resyncInterval: 5000,  // Re-sync every 5s for consistency
    disableBc: false,      // Enable broadcast channel for same-tab sync
  }
);

// 3. Monitor connection status
provider.on("sync", (synced: boolean) => {
  console.log("Synced:", synced);
});

provider.socket.on("connect", () => {
  console.log("Connected to Yjs server");
});

provider.socket.on("disconnect", (reason) => {
  console.log("Disconnected:", reason);
});
```

### Integrate with TipTap

```typescript
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";

const editor = new Editor({
  extensions: [
    StarterKit.configure({
      // Disable default history — Yjs handles undo/redo
      history: false,
    }),
    Collaboration.configure({
      document: ydoc,
      // TipTap uses "default" as the fragment name by default
      // The server stores whatever Yjs updates come in
    }),
    CollaborationCursor.configure({
      provider: provider,
      user: {
        name: "John Doe",
        color: "#f59e0b",  // Use the color from presence:init
      },
    }),
  ],
});
```

### Clean up on unmount

```typescript
// React example
useEffect(() => {
  return () => {
    provider.destroy();  // Disconnects socket, clears Yjs state
    ydoc.destroy();
    editor?.destroy();
  };
}, []);
```

### Server-side persistence (automatic)

The server handles all persistence — no frontend action needed for saving content:

| Trigger | What happens | Timing |
|---------|-------------|--------|
| Yjs update | Debounced write to `document_versions` table | Every 10 seconds |
| Last user disconnects | Version snapshot created in `document_versions` | On room close |
| Auto-save cron | Snapshot for active sessions | Every 30 minutes |

---

## 5. Whiteboard Collaboration (Tldraw + Yjs)

Whiteboards use Yjs for CRDT sync. Content is persisted server-side to **MinIO** (not the database) as the canonical JSON store.

### Room naming

```
Room name: "whiteboard-{documentId}"
Example:   "whiteboard-aab9b236-c960-46dc-a0fd-2b7a09fa67ee"
```

The `documentId` comes from `view.documentId` (not `view.id`). Get it from `views.get` tRPC response.

### Option A: Tldraw + Yjs (recommended)

```typescript
import * as Y from "yjs";
import { SocketIOProvider } from "y-socket.io";

const REALTIME_URL = "wss://backend.synap.live";

// 1. Create Yjs document
const ydoc = new Y.Doc();

// 2. Connect to Yjs server
const provider = new SocketIOProvider(
  REALTIME_URL,
  `whiteboard-${documentId}`,   // Must match server's parseRoomName()
  ydoc,
  {
    autoConnect: true,
    resyncInterval: 5000,
  }
);

// 3. Get the Yjs Map for Tldraw store
// IMPORTANT: The server reads/writes using this exact map name
const yStore = ydoc.getMap(`tl_map_${documentId}`);
```

#### Integrate with Tldraw

```typescript
import { Tldraw, useYjsStore } from "@tldraw/yjs";
// Or use custom Tldraw Yjs binding:

function WhiteboardEditor({ documentId }: { documentId: string }) {
  const store = useTldrawYjsStore(ydoc, documentId);

  return (
    <Tldraw store={store} />
  );
}
```

#### Custom Tldraw ↔ Yjs binding (if @tldraw/yjs is unavailable)

```typescript
import { createTLStore, defaultShapeUtils } from "tldraw";

function useTldrawYjsStore(ydoc: Y.Doc, documentId: string) {
  const [store] = useState(() => createTLStore({ shapeUtils: defaultShapeUtils }));
  const yMap = ydoc.getMap(`tl_map_${documentId}`);

  useEffect(() => {
    // Sync Yjs → Tldraw
    const observer = () => {
      const records: Record<string, any> = {};
      yMap.forEach((val, key) => {
        if (val && typeof val === "object") {
          records[key] = val;
        }
      });
      store.loadSnapshot({ store: records });
    };
    yMap.observe(observer);

    // Sync Tldraw → Yjs
    const unsub = store.listen((entry) => {
      ydoc.transact(() => {
        for (const record of Object.values(entry.changes.added)) {
          yMap.set(record.id, record);
        }
        for (const [_, to] of Object.values(entry.changes.updated)) {
          yMap.set(to.id, to);
        }
        for (const record of Object.values(entry.changes.removed)) {
          yMap.delete(record.id);
        }
      });
    }, { source: "user", scope: "document" });

    // Load initial state from Yjs
    if (yMap.size > 0) observer();

    return () => {
      yMap.unobserve(observer);
      unsub();
    };
  }, [store, yMap]);

  return store;
}
```

### Option B: REST-only (no Yjs, simpler)

If real-time collaboration isn't needed, use tRPC directly:

```typescript
// Load whiteboard content
const { data } = trpc.views.get.useQuery({ id: viewId });
const initialContent = data?.content; // Tldraw store JSON from MinIO

// Save on user action or debounced auto-save
const saveMutation = trpc.views.save.useMutation();

function handleSave(store: TLStore) {
  const snapshot = store.getSnapshot();
  saveMutation.mutate({
    id: viewId,
    content: {
      category: "canvas",
      store: snapshot.store,
    },
  });
}
```

### Server-side persistence (automatic for Yjs path)

| Trigger | What happens | Storage |
|---------|-------------|---------|
| Yjs update | Debounced write to MinIO | Every 10 seconds |
| Last user disconnects | Final flush to MinIO | On room close |
| `views.save` tRPC | Write to MinIO + `document_versions` row | On explicit save |

Whiteboards do NOT create versioned snapshots automatically (no `document_versions` rows on disconnect). The MinIO file is always the latest state. Use `whiteboards.saveVersion` tRPC for explicit version history.

---

## 6. Session Lifecycle (tRPC)

Sessions track who's editing what. They're used by the auto-save cron and chat integration.

### Start a session (before connecting Yjs)

```typescript
// Path: trpc.documents.startSession (NOT trpc.documents.sessions.startSession)
const { sessionId, chatThreadId } = await trpc.documents.startSession.mutate({
  documentId,
});
// Store sessionId for cleanup
// chatThreadId links to a dedicated AI chat for this editing session
```

### End a session (on unmount / page leave)

```typescript
// Path: trpc.documents.endSession (NOT trpc.documents.sessions.endSession)
await trpc.documents.endSession.mutate({ sessionId });
```

> **Note for whiteboards**: Whiteboards do NOT need `startSession`/`endSession`.
> The Yjs server tracks whiteboard room connections directly and auto-saves on disconnect.
> Sessions are document-specific because they link to a `chatThreadId` for AI features.

**Tip**: Also end sessions on `beforeunload`:

```typescript
window.addEventListener("beforeunload", () => {
  // Use sendBeacon for reliability during page close
  navigator.sendBeacon(
    `${API_URL}/api/trpc/documents.endSession`,
    JSON.stringify({ sessionId })
  );
});
```

Note: Even if the frontend doesn't call `endSession`, the Yjs server marks sessions inactive when the room closes (all connections disconnected).

---

## 7. Manual Save & Version History

### Documents

```typescript
// Explicit save (Cmd+S) — creates immutable version snapshot
await trpc.documents.saveVersion.mutate({
  documentId,
  message: "Manual save",  // optional
});

// List versions
const versions = await trpc.documents.listVersions.query({
  documentId,
  limit: 20,
});

// Restore to a previous version
await trpc.documents.restoreVersion.mutate({
  documentId,
  versionId: "version-uuid",
});
```

### Whiteboards

```typescript
// Explicit save — snapshots current MinIO state to document_versions
await trpc.whiteboards.saveVersion.mutate({
  viewId,            // Note: viewId, not documentId
  message: "Before major change",
});

// List versions
const versions = await trpc.whiteboards.listVersions.query({
  viewId,
  limit: 20,
});

// Restore
await trpc.whiteboards.restoreVersion.mutate({
  viewId,
  versionId: "version-uuid",
});
```

---

## 8. Socket.IO Bridge Events (Server → Client)

The backend pushes notifications to connected clients via Socket.IO bridge. Listen on the **presence** namespace:

```typescript
// Version saved notification
presenceSocket.on("document.snapshot.saved", (data) => {
  // { documentId, versionId, version, message }
  showToast(`Version ${data.version} saved`);
});

// Document restored notification
presenceSocket.on("document.restored", (data) => {
  // { documentId, restoredFromVersion, currentVersion }
  // Reload the document content
});

// Chat events (AI responses, entity extraction, etc.)
presenceSocket.on("chat_response", (data) => { /* ... */ });
presenceSocket.on("ai_step", (data) => { /* ... */ });
presenceSocket.on("entity_created", (data) => { /* ... */ });
presenceSocket.on("branch_decision", (data) => { /* ... */ });
```

---

## 9. Complete Integration Example

### Document Editor Page

```typescript
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { SocketIOProvider } from "y-socket.io";
import { io, Socket } from "socket.io-client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { trpc } from "../lib/trpc";

const REALTIME_URL = import.meta.env.VITE_REALTIME_URL || "wss://backend.synap.live";

export function DocumentEditor({ documentId, userId, userName }: Props) {
  const editorRef = useRef<Editor | null>(null);
  const providerRef = useRef<SocketIOProvider | null>(null);
  const presenceRef = useRef<Socket | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const [activeUsers, setActiveUsers] = useState([]);
  const [myColor, setMyColor] = useState("#f59e0b");
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    // --- 1. Start editing session ---
    trpc.documents.startSession.mutate({ documentId }).then(({ sessionId }) => {
      sessionIdRef.current = sessionId;
    });

    // --- 2. Connect presence ---
    const presence = io(`${REALTIME_URL}/presence`, {
      auth: { userId, userName, viewId: documentId, viewType: "document" },
      transports: ["websocket", "polling"],
      withCredentials: true,
    });
    presenceRef.current = presence;

    presence.on("presence:init", ({ users, yourColor }) => {
      setActiveUsers(users);
      setMyColor(yourColor);
    });
    presence.on("presence:update", setActiveUsers);

    // --- 3. Connect Yjs ---
    const ydoc = new Y.Doc();
    const provider = new SocketIOProvider(REALTIME_URL, documentId, ydoc, {
      autoConnect: true,
      resyncInterval: 5000,
    });
    providerRef.current = provider;

    provider.on("sync", (state: boolean) => setSynced(state));

    // --- 4. Create TipTap editor ---
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc }),
        CollaborationCursor.configure({
          provider,
          user: { name: userName, color: myColor },
        }),
      ],
    });
    editorRef.current = editor;

    // --- Cleanup ---
    return () => {
      editor.destroy();
      provider.destroy();
      ydoc.destroy();
      presence.disconnect();
      if (sessionIdRef.current) {
        trpc.documents.endSession.mutate({ sessionId: sessionIdRef.current });
      }
    };
  }, [documentId]);

  // --- Cmd+S handler ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        trpc.documents.saveVersion.mutate({ documentId });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [documentId]);

  return (
    <div>
      <div className="status-bar">
        {synced ? "Synced" : "Syncing..."}
        {activeUsers.map((u) => (
          <span key={u.userId} style={{ color: u.color }}>{u.userName}</span>
        ))}
      </div>
      <div ref={(el) => el && editorRef.current?.view && el.appendChild(editorRef.current.view.dom)} />
    </div>
  );
}
```

### Whiteboard Editor Page

```typescript
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { SocketIOProvider } from "y-socket.io";
import { Tldraw, createTLStore, defaultShapeUtils } from "tldraw";
import { trpc } from "../lib/trpc";

const REALTIME_URL = import.meta.env.VITE_REALTIME_URL || "wss://backend.synap.live";

export function WhiteboardEditor({ viewId, documentId, userId }: Props) {
  const providerRef = useRef<SocketIOProvider | null>(null);
  const [store, setStore] = useState<TLStore | null>(null);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const roomName = `whiteboard-${documentId}`;
    const yMap = ydoc.getMap(`tl_map_${documentId}`);

    // --- 1. Connect Yjs ---
    const provider = new SocketIOProvider(REALTIME_URL, roomName, ydoc, {
      autoConnect: true,
      resyncInterval: 5000,
    });
    providerRef.current = provider;
    provider.on("sync", (state: boolean) => setSynced(state));

    // --- 2. Create Tldraw store ---
    const tlStore = createTLStore({ shapeUtils: defaultShapeUtils });

    // --- 3. Yjs → Tldraw sync ---
    const loadFromYjs = () => {
      const records: Record<string, any> = {};
      yMap.forEach((val, key) => {
        if (val && typeof val === "object") records[key] = val;
      });
      if (Object.keys(records).length > 0) {
        tlStore.loadSnapshot({ store: records });
      }
    };
    yMap.observeDeep(loadFromYjs);

    // --- 4. Tldraw → Yjs sync ---
    const unsub = tlStore.listen((entry) => {
      ydoc.transact(() => {
        for (const record of Object.values(entry.changes.added)) {
          yMap.set(record.id, record);
        }
        for (const [_, to] of Object.values(entry.changes.updated)) {
          yMap.set(to.id, to);
        }
        for (const record of Object.values(entry.changes.removed)) {
          yMap.delete(record.id);
        }
      });
    }, { source: "user", scope: "document" });

    // --- 5. Initial load ---
    // Wait for Yjs sync, then load
    provider.on("sync", (state: boolean) => {
      if (state) loadFromYjs();
    });

    setStore(tlStore);

    // --- Cleanup ---
    return () => {
      unsub();
      yMap.unobserveDeep(loadFromYjs);
      provider.destroy();
      ydoc.destroy();
    };
  }, [documentId]);

  if (!store) return <div>Loading...</div>;

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <Tldraw store={store} />
    </div>
  );
}
```

---

## 10. How to get documentId and viewId

```typescript
// For whiteboards: fetch the view, which contains documentId
const { data } = trpc.views.get.useQuery({ id: viewId });
const documentId = data?.view.documentId;    // UUID for Yjs room
const yjsRoomId = data?.view.yjsRoomId;     // "whiteboard-{documentId}" (or compute it)
const initialContent = data?.content;         // JSON from MinIO (fallback if Yjs not yet synced)

// For documents: the documentId IS the room name
const documentId = routeParams.documentId;   // From URL
```

---

## 11. Troubleshooting

### Yjs doesn't sync / stays empty

1. **Check room name**: Must be exactly `{documentId}` for documents or `whiteboard-{documentId}` for whiteboards. UUID format, no prefix/suffix mismatch.
2. **Check WebSocket connection**: Open DevTools Network → WS tab. Look for connection to `/yjs|{roomName}`.
3. **Check server logs**: `docker compose logs realtime --tail 50` — look for `[Yjs] Loaded...` or `[Yjs] Failed...` messages.

### Whiteboard loads empty after refresh

1. Verify MinIO has content: `docker compose exec -T minio mc cat local/synap-storage/{storageKey}`
2. Check `views.get` returns content: The endpoint now loads from MinIO for whiteboards.
3. If using Yjs: Wait for `provider.synced === true` before rendering Tldraw.

### Version numbers are high but no version history

Old behavior (now fixed). `currentVersion` used to increment on every metadata update. Now it only changes on explicit saves and session close.

### Connection refused / CORS errors

- Local dev: Ensure realtime service is running on port 4001
- Production: Caddy handles `/socket.io/*` → `realtime:4001` automatically
- Check browser console for CORS errors; the server allows all origins

---

## Quick Reference

| What | Room Name | Map/Fragment | Storage |
|------|-----------|-------------|---------|
| Document (TipTap) | `{documentId}` | Default Yjs fragment | `document_versions` table |
| Whiteboard (Tldraw) | `whiteboard-{documentId}` | `tl_map_{documentId}` | MinIO (`storageKey`) |

| Action | Endpoint | Type |
|--------|----------|------|
| Start editing | `documents.startSession` | tRPC mutation |
| Stop editing | `documents.endSession` | tRPC mutation |
| Manual save (doc) | `documents.saveVersion` | tRPC mutation |
| Manual save (whiteboard) | `whiteboards.saveVersion` | tRPC mutation |
| Load whiteboard | `views.get` | tRPC query |
| Save whiteboard (REST) | `views.save` | tRPC mutation |
| List versions | `documents.listVersions` / `whiteboards.listVersions` | tRPC query |
| Restore version | `documents.restoreVersion` / `whiteboards.restoreVersion` | tRPC mutation |
