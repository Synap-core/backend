# Frontend Deep Dive Audit Report (REVISED)

**Date**: 2026-01-07  
**Scope**: Complete Frontend & Backend Analysis

## 🚨 Critical Findings

After deeper analysis, the situation is **more complex** than initially assessed. The application has a **three-layer disconnect**:

1. **Frontend UI** → Uses MOCK data
2. **Frontend Stores** → Manages client-side state (408 lines for chat, 298 lines for documents)
3. **Backend API** → Has working routers but frontend doesn't use them

---

## 🔴 CRITICAL: Workspace Layout Hard-Coded Values

### Location: [`layout.tsx`](file:///Users/antoine/Documents/Code/synap/synap-app/apps/web/app/workspace/layout.tsx)

```typescript
// Lines 14-17
const activeWorkspaceId = "workspace_demo"; // ❌ HARD-CODED
const userId = "user_1"; // ❌ HARD-CODED
const userName = "Demo User"; // ❌ HARD-CODED
```

**Impact**:

- **Real-time sync NEVER connects to actual user workspace**
- All users connect to the same demo workspace ID
- WebSocket events go to wrong workspace
- Collaborative features don't work for real users

**Fix Required**:

```typescript
// Should be:
const { activeWorkspaceId } = useWorkspaceStore();
const { user } = useAuth();  // Or from tRPC context

return (
  <SocketIOProvider
    url={url}
    workspaceId={activeWorkspaceId || ''}  // From store
    userId={user?.id || ''}                // From auth
    userName={user?.name || 'Anonymous'}   // From auth
  >
```

---

## 🔴 CRITICAL: Backend Router Mismatch

### The `chat` vs `infiniteChat` Confusion

**Problem**: Frontend hooks reference `trpc.chat.*` but backend has TWO routers:

#### 1. [`chat.ts`](file:///Users/antoine/Documents/Code/synap/synap-backend/packages/api/src/routers/chat.ts) - EMPTY ❌

```typescript
export const chatRouter = router({
  // All endpoints temporarily disabled - refactor needed
  // TODO: Refactor to use repositories directly from @synap/database
});
```

#### 2. [`infinite-chat.ts`](file:///Users/antoine/Documents/Code/synap/synap-backend/packages/api/src/routers/infinite-chat.ts) - FULLY FUNCTIONAL ✅

```typescript
export const infiniteChatRouter = router({
  createThread, // ✅ Works
  sendMessage, // ✅ Works - calls Intelligence Hub
  getMessages, // ✅ Works - infinite scroll
  listThreads, // ✅ Works
  getBranches, // ✅ Works
  mergeBranch, // ✅ Works
});
```

**Issue**: `infinite-chat.ts` is NOT REGISTERED in the app router!

Looking at [`packages/api/src/index.ts`](file:///Users/antoine/Documents/Code/synap/synap-backend/packages/api/src/index.ts):

- Line 74: `registerRouter('chat', chatRouter, ...)` ← Registers EMPTY router
- `infiniteChatRouter` is NEVER imported or registered!

**Impact**: The fully functional chat system with Intelligence Hub integration is **unavailable to the frontend**.

---

## 🔴 CRITICAL: Frontend Stores Are Disconnected

### Chat Store (408 lines) - Client-Side Only

[`chatStore.ts`](file:///Users/antoine/Documents/Code/synap/synap-app/packages/synap-stores/src/chatStore.ts) manages:

- Thread creation
- Message history
- AI proposals
- Streaming state

**Problem**: It's 100% local state with NO backend persistence.

```typescript
createThread: (workspaceId, title) => {
  const id = `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`; // ❌ Local ID
  // ... stores in Zustand, NOT in database
};
```

**Impact**:

- Threads are lost on refresh
- No cross-device sync
- No collaboration

### Document Store (298 lines) - Client-Side Only

[`documentStore.ts`](file:///Users/antoine/Documents/Code/synap/synap-app/packages/synap-stores/src/documentStore.ts) manages:

- Document state
- Version history (snapshots)
- AI proposals as "staged commits"
- Collaboration state

**Problem**: Same as chat store - pure client-side state.

---

## 🟢 GOOD NEWS: Backend Infrastructure EXISTS

### Documents Router - FULLY FUNCTIONAL ✅

[`documents.ts`](file:///Users/antoine/Documents/Code/synap/synap-backend/packages/api/src/routers/documents.ts) has:

- ✅ `upload` - Create document
- ✅ `get` - Fetch document
- ✅ `update` - Save changes (DIRECT UPDATE for performance)
- ✅ `delete` - Remove document
- ✅ `list` - List user's documents
- ✅ `saveVersion` - Manual snapshot (Cmd+S)
- ✅ `listVersions` - Version history
- ✅ `restoreVersion` - Restore old version
- ✅ `startSession` - Collaborative editing session

**Registered**: Line 81 of `index.ts` ✅

### Infinite Chat Router - FULLY FUNCTIONAL ✅ (BUT NOT REGISTERED)

[`infinite-chat.ts`](file:///Users/antoine/Documents/Code/synap/synap-backend/packages/api/src/routers/infinite-chat.ts) has:

- ✅ `createThread` - Start new conversation
- ✅ `sendMessage` - Send to Intelligence Hub, get AI response
- ✅ `getMessages` - Infinite scroll pagination
- ✅ `listThreads` - Get user's threads
- ✅ `getBranches` - Get conversation branches
- ✅ `mergeBranch` - Merge branch into main thread

**Registered**: ❌ NOT REGISTERED - This router is orphaned!

---

## 📊 Complete Architecture Map

```
┌─────────────────────────────────────────────────────────┐
│ FRONTEND UI (workspace/page.tsx)                        │
│ Uses: MOCK_CHATS, MOCK_ARTIFACTS                        │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ├─ Should use ─┐
                    │               │
┌───────────────────▼───────────────▼───────────────────┐
│ FRONTEND STORES (Zustand)                             │
│ - chatStore.ts (408 lines) - Local state only         │
│ - documentStore.ts (298 lines) - Local state only     │
└───────────────────┬───────────────────────────────────┘
                    │
                    ├─ Should persist via ─┐
                    │                       │
┌───────────────────▼───────────────────────▼───────────┐
│ FRONTEND HOOKS (@synap/hooks)                         │
│ - useChatMessages → trpc.chat.getMessages ❌ BROKEN   │
│ - useWorkspaceData → trpc.entities.list ✅ WORKS      │
└───────────────────┬───────────────────────────────────┘
                    │
                    ├─ Calls ─┐
                    │         │
┌───────────────────▼─────────▼─────────────────────────┐
│ BACKEND API ROUTERS (tRPC)                            │
│ - chat.ts → EMPTY ❌                                   │
│ - infinite-chat.ts → NOT REGISTERED ❌ (but works!)   │
│ - documents.ts → REGISTERED ✅ WORKS                   │
│ - entities.ts → REGISTERED ✅ WORKS                    │
└───────────────────────────────────────────────────────┘
```

---

## 🎯 Revised Priority Action Plan

### Phase 0: Register Infinite Chat Router (IMMEDIATE - 30 minutes)

**File**: `packages/api/src/index.ts`

```typescript
// ADD IMPORT
import { infiniteChatRouter } from "./routers/infinite-chat.js";

// REPLACE LINE 74
registerRouter("chat", infiniteChatRouter, {
  version: "2.0.0",
  source: "core",
  description: "Infinite chat with Intelligence Hub and branching",
});
```

**Impact**: Makes the working chat system available to frontend immediately.

---

### Phase 1: Fix Workspace Layout (HIGH PRIORITY - 1 hour)

**File**: `apps/web/app/workspace/layout.tsx`

1. Import authentication and workspace state
2. Replace hard-coded values with dynamic data
3. Handle loading states

```typescript
'use client';

import { SocketIOProvider } from '@synap/client';
import { useWorkspaceStore } from '@synap/stores';
import { useAuth } from '@/lib/auth/AuthProvider';

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { activeWorkspaceId } = useWorkspaceStore();
  const { user } = useAuth();  // Or get from tRPC context
  const url = process.env.NEXT_PUBLIC_REALTIME_URL || 'http://localhost:4001';

  // Don't render until we have workspace and user
  if (!activeWorkspaceId || !user) {
    return <div>Loading workspace...</div>;
  }

  return (
    <SocketIOProvider
      url={url}
      workspaceId={activeWorkspaceId}
      userId={user.id}
      userName={user.name || 'Anonymous'}
    >
      {children}
    </SocketIOProvider>
  );
}
```

---

### Phase 2: Connect Chat UI to Backend (MEDIUM PRIORITY - 3 hours)

**Goal**: Replace `MOCK_CHATS` with real data from `trpc.chat.*`

#### Step 1: Update Hook to Use Correct Router

**File**: `packages/synap-hooks/src/useChatMessages.ts`

```typescript
// BEFORE (Line 49)
return trpc.chat.getMessages.useInfiniteQuery(...)

// AFTER (CORRECT - matches backend!)
return trpc.chat.getMessages.useInfiniteQuery(...)
// This will work now that we registered infiniteChatRouter as 'chat'
```

#### Step 2: Create Thread Management Hook

**NEW FILE**: `packages/synap-hooks/src/useChatThreads.ts`

```typescript
import { trpc } from "@synap/client";

export function useChatThreads(workspaceId: string) {
  const threadsQuery = trpc.chat.listThreads.useQuery({
    projectId: workspaceId,
  });

  const createThreadMutation = trpc.chat.createThread.useMutation();
  const sendMessageMutation = trpc.chat.sendMessage.useMutation();

  return {
    threads: threadsQuery.data?.threads || [],
    isLoading: threadsQuery.isLoading,
    createThread: createThreadMutation.mutateAsync,
    sendMessage: sendMessageMutation.mutateAsync,
  };
}
```

#### Step 3: Replace MOCK_CHATS in Workspace Page

**File**: `apps/web/app/workspace/page.tsx`

```typescript
// REMOVE
import { MOCK_CHATS } from "./mock-data";
const [currentChatId, setCurrentChatId] = useState(MOCK_CHATS[0].id);

// ADD
import { useChatThreads } from "@synap/hooks";
const { threads: chats, isLoading: isLoadingChats } = useChatThreads(
  activeWorkspaceId || ""
);
const [currentChatId, setCurrentChatId] = useState<string | null>(null);

// Initialize to first thread once loaded
useEffect(() => {
  if (!currentChatId && chats.length > 0) {
    setCurrentChatId(chats[0].id);
  }
}, [chats, currentChatId]);
```

---

### Phase 3: Connect Document UI to Backend (MEDIUM PRIORITY - 3 hours)

**Goal**: Replace `MOCK_ARTIFACTS` with `trpc.documents.*`

#### Step 1: Create Documents Hook

**NEW FILE**: `packages/synap-hooks/src/useDocuments.ts`

```typescript
import { trpc } from "@synap/client";

export function useDocuments(workspaceId: string) {
  const documentsQuery = trpc.documents.list.useQuery({
    projectId: workspaceId,
  });

  const uploadMutation = trpc.documents.upload.useMutation();
  const updateMutation = trpc.documents.update.useMutation();

  return {
    documents: documentsQuery.data?.documents || [],
    isLoading: documentsQuery.isLoading,
    upload: uploadMutation.mutateAsync,
    update: updateMutation.mutateAsync,
  };
}
```

#### Step 2: Replace MOCK_ARTIFACTS

**File**: `apps/web/app/workspace/page.tsx`

```typescript
// REMOVE
import { MOCK_ARTIFACTS } from "./mock-data";

// ADD
import { useDocuments } from "@synap/hooks";
const { documents: artifacts } = useDocuments(activeWorkspaceId || "");
```

---

### Phase 4: Decide on Store Usage (STRATEGIC DECISION NEEDED)

**Question**: What role should the Zustand stores play?

**Option A**: Remove Stores, Use tRPC Cache Only

- ✅ Simpler architecture
- ✅ TanStack Query handles caching
- ❌ Lose optimistic updates
- ❌ Lose offline support

**Option B**: Keep Stores, Sync with Backend

- ✅ Optimistic updates (instant UI)
- ✅ Offline-first capability
- ❌ More complex state management
- ❌ Risk of sync conflicts

**Recommendation**: **Option B** - The stores are well-architected. We should:

1. Keep stores for UI state and optimistic updates
2. Add backend sync layer
3. Use stores as "write-ahead log" that syncs to backend

---

## 📝 Summary of Required Changes

### Immediate (This Session)

1. ✅ Register `infiniteChatRouter` as `chat` router (30 min)
2. ✅ Fix workspace layout hard-coded values (1 hour)

### Next Sprint (2-3 days)

3. ✅ Wire `useChatMessages` to backend `chat.getMessages`
4. ✅ Create `useChatThreads` hook
5. ✅ Replace `MOCK_CHATS` in workspace UI
6. ✅ Create `useDocuments` hook (different from `useDocumentCollaboration`)
7. ✅ Replace `MOCK_ARTIFACTS` in workspace UI

### Future Sprint (Strategic)

8. 🔄 Decide on store syncing strategy
9. 🔄 Implement bidirectional sync (stores ↔ backend)
10. 🔄 Add optimistic updates
11. 🔄 Test offline scenarios

---

## 🚧 Estimated Timeline

- **Phase 0**: 30 minutes (register router)
- **Phase 1**: 1 hour (fix layout)
- **Phase 2**: 3 hours (connect chat UI)
- **Phase 3**: 3 hours (connect documents UI)
- **Phase 4**: TBD (strategic decision + implementation)

**Total for Phases 0-3**: ~7.5 hours (1 day)

---

## 🎯 Next Step

**Decision Required**: Should I proceed with Phase 0 (registering the router) immediately?
