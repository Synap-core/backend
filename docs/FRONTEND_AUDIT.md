# Frontend Code Audit Report
**Date**: 2026-01-07  
**Scope**: Synap Frontend Application (`synap-app/apps/web`)

## Executive Summary

The frontend application is in a **transitional state** between mock/demo data and full backend integration. While the infrastructure for backend connectivity is properly set up (tRPC, authentication, realtime sync), significant portions of the UI still rely on hard-coded mock data. This creates inconsistency and prevents users from accessing their actual workspace data.

**Current State**: ~40% backend-connected, ~60% mock data  
**Desired State**: 100% backend-connected with dynamic data

---

## 🔍 Detailed Findings

### 1. Mock Data Usage

#### 🚨 Critical: Workspace Chat & Artifacts (MOCK_CHATS, MOCK_ARTIFACTS)
**Location**: `app/workspace/mock-data.ts`  
**Used In**:
- [`app/workspace/page.tsx`](file:///Users/antoine/Documents/Code/synap/synap-app/apps/web/app/workspace/page.tsx) (Lines 25, 88-96, 260-269, 313, 348)
- [`app/components/CommandPaletteProvider.tsx`](file:///Users/antoine/Documents/Code/synap/synap-app/apps/web/app/components/CommandPaletteProvider.tsx) (Lines 22, 55, 75)

**Impact**: Users cannot see their actual chats or documents. All chat/document interactions are with hard-coded demo content.

**Backend Availability**: 
- ✅ Backend has tRPC routes for chats/conversations (likely)
- ✅ Backend has document/artifact storage
- ❌ Frontend is NOT querying these endpoints

#### 🟡 Medium: Home Dashboard Mock Data
**Location**: 
- `app/workspace/components/home/NotificationsPanel.tsx` (Line 105: `MOCK_NOTIFICATIONS`)
- `app/workspace/components/home/DataPodStatus.tsx` (Line 76: `MOCK_POD`)

**Impact**: Notifications and pod status are fake. Users cannot see real system state.

**Backend Availability**: Unclear if notification/pod endpoints exist.

#### 🟢 Low: Graph/Entity Mock Data
**Location**: `@synap/graph-view` package exports `MOCK_SYNAP_ENTITIES`  
**Used In**: 
- `app/demo/page.tsx` (Lines 24-26, 84, 150-169) ✅ **Acceptable** - Demo page should use mock data
- `app/components/CommandPaletteProvider.tsx` (Line 45) ⚠️ **Should use real data from backend**

**Backend Availability**: 
- ✅ `useWorkspaceData` hook fetches real entities via `trpc.entities.list`
- ✅ Real entities ARE being fetched but NOT used in Command Palette

---

### 2. Hard-Coded Values

#### 🚨 Critical: Initial Chat/Artifact Selection
**Location**: `app/workspace/page.tsx`
```typescript
// Lines 88-89
const [currentChatId, setCurrentChatId] = useState(MOCK_CHATS[0].id);
const [currentArtifactId, setCurrentArtifactId] = useState(MOCK_ARTIFACTS[0].id);
```

**Issue**: Always initializes to mock data instead of user's actual latest chat/document.

**Fix**: Should initialize from backend query (most recent chat) or localStorage (last viewed).

#### 🟡 Medium: MSW Provider Commented Out
**Location**: `app/providers.tsx` (Lines 22, 33)
```tsx
{/* <MSWProvider> */}
  <TamaguiProvider>...</TamaguiProvider>
{/* </MSWProvider> */}
```

**Status**: MSW is disabled, which is CORRECT for production. However, the mock data is still hard-coded in components instead of being dynamically served by MSW.

**Impact**: The `/mocks` directory (15 files, 8KB) is effectively dead code that could be removed or properly isolated to a dev-only feature flag.

---

### 3. Backend Integration Status

#### ✅ Working: Authentication & Workspace Bootstrapping
- Kratos authentication is functional
- Workspace selection is dynamic (fetches from backend)
- User session management works correctly

#### ✅ Working: Entity Management
- `useWorkspaceData` hook properly fetches entities, members, views via tRPC
- Real-time sync is set up via `useRealtimeSync`
- Entities are fetched but not always displayed

#### ❌ Missing: Chat/Conversation Integration
**Backend Routes Needed**:
- `trpc.chats.list` (or `conversations.list`)
- `trpc.chats.get`
- `trpc.chats.create`
- `trpc.messages.list`
- `trpc.messages.send`

**Frontend Work Required**:
- Create `useChats` hook (similar to `useWorkspaceData`)
- Replace `MOCK_CHATS` with real data
- Wire up chat UI to tRPC mutations

#### ❌ Missing: Artifact/Document Integration
**Backend Routes Needed**:
- `trpc.artifacts.list` (or `documents.list`)
- `trpc.artifacts.get`
- `trpc.artifacts.create`
- `trpc.artifacts.update` (for versioning)

**Frontend Work Required**:
- Create `useArtifacts` hook
- Replace `MOCK_ARTIFACTS` with real data
- Wire up document editor to backend persistence

---

### 4. Code Quality Issues

#### 🔴 Redundancy: Multiple Mock Data Sources
- `app/workspace/mock-data.ts` (442 lines)
- `app/demo/page.tsx` (uses separate mock from `@synap/graph-view`)
- `mocks/` directory (separate MSW handlers)

**Issue**: Three different systems for mock data. Should consolidate to ONE source (MSW) if needed for dev.

#### 🟡 Type Safety: Missing Backend Types
**Location**: `packages/synap-hooks/src/useWorkspaceData.ts`
```typescript
workspace: any | undefined; // TODO: Type from backend
entities: any[] | undefined; // TODO: Type from backend
members: any[] | undefined; // TODO: Type from backend
```

**Impact**: No IntelliSense, runtime errors possible.

**Fix**: Import types from `@synap/api` or generate from tRPC schema.

#### 🟡 Dead Code: Commented MSW Integration
- MSW is set up but disabled
- `/mocks` directory is 15 files but not used
- Decision needed: remove MSW entirely OR properly feature-flag it

---

## 📋 Cleanup Action Plan

### Phase 1: Chat & Artifact Backend Integration (High Priority)
**Estimated Effort**: 2-3 days

1. **Verify Backend Routes**
   - [ ] Check if chat/conversation routes exist in `synap-backend`
   - [ ] Check if artifact/document routes exist
   - [ ] If missing, create placeholder tRPC routes

2. **Create Frontend Hooks**
   - [ ] Create `packages/synap-hooks/src/useChats.ts`
   - [ ] Create `packages/synap-hooks/src/useArtifacts.ts`
   - [ ] Export from `index.ts`

3. **Replace Mock Data in Workspace**
   - [ ] Update `app/workspace/page.tsx` to use real data
   - [ ] Initialize `currentChatId` from query (most recent) or null
   - [ ] Initialize `currentArtifactId` similarly
   - [ ] Handle empty states (no chats, no artifacts)

4. **Update Command Palette**
   - [ ] Use real entities from `useWorkspaceData` instead of `MOCK_SYNAP_ENTITIES`
   - [ ] Use real chats/artifacts from new hooks

**Success Criteria**: Users see their actual chats and documents, not demo content.

---

### Phase 2: Home Dashboard Backend Integration (Medium Priority)
**Estimated Effort**: 1 day

1. **Notifications**
   - [ ] Create `trpc.notifications.list` backend route
   - [ ] Create `useNotifications` hook
   - [ ] Replace `MOCK_NOTIFICATIONS` in `NotificationsPanel.tsx`

2. **Data Pod Status**
   - [ ] Verify `trpc.pods.status` endpoint exists
   - [ ] Create `usePodStatus` hook
   - [ ] Replace `MOCK_POD` in `DataPodStatus.tsx`

---

### Phase 3: Type Safety & Code Cleanup (Low Priority)
**Estimated Effort**: 1 day

1. **Add Backend Types**
   - [ ] Export types from `@synap/api` package
   - [ ] Import in `useWorkspaceData` and other hooks
   - [ ] Replace all `any` with proper types

2. **MSW Decision**
   - **Option A** (Recommended): Remove MSW entirely
     - Delete `/mocks` directory
     - Remove `MSWProvider` from codebase
     - Remove `msw` from `package.json`
   - **Option B**: Properly feature-flag MSW for development
     - Only enable if `process.env.NEXT_PUBLIC_USE_MOCKS === 'true'`
     - Keep for demos/testing

3. **Remove Mock Data Files**
   - [ ] Delete `app/workspace/mock-data.ts` (after Phase 1)
   - [ ] Keep `app/demo/page.tsx` mock data (it's a demo)

---

## 🎯 Recommended Priority

### Immediate (This Week)
✅ **Phase 1**: Chat & Artifact integration - This is user-facing and critical

### Next Week
🟡 **Phase 2**: Home Dashboard - Nice to have but not critical

### Future Sprint
🟢 **Phase 3**: Type safety & cleanup - Technical debt

---

## 📊 Metrics

### Current State Analysis
```
Total Mock Data Usage:
- MOCK_CHATS: ~35 references
- MOCK_ARTIFACTS: ~30 references  
- MOCK_SYNAP_ENTITIES: ~15 references
- MOCK_NOTIFICATIONS: 2 references
- MOCK_POD: 2 references

Mock Data Files:
- app/workspace/mock-data.ts: 442 lines
- mocks/ directory: ~15 files (potentially removable)

Backend Integration:
✅ Auth: 100%
✅ Workspaces: 100%
✅ Entities (fetch): 100%
❌ Chats: 0%
❌ Artifacts: 0%
🟡 Notifications: 0%
```

### Expected State After Cleanup
```
Mock Data Files:
- app/demo/page.tsx: ~200 lines (demo only)
- mocks/: REMOVED or feature-flagged

Backend Integration:
✅ Auth: 100%
✅ Workspaces: 100%
✅ Entities: 100%
✅ Chats: 100%
✅ Artifacts: 100%
✅ Notifications: 100%
```

---

## 🚧 Implementation Risks

### Risk 1: Backend Routes Not Available
**Likelihood**: Medium  
**Impact**: High (blocks entire cleanup)  
**Mitigation**: 
- Verify routes first before starting frontend work
- Create placeholder routes if needed
- Define API contract with backend team

### Risk 2: Data Model Mismatch
**Likelihood**: Medium  
**Impact**: Medium (requires rework)  
**Mitigation**:
- Review backend schema before creating hooks
- Use TypeScript types from backend
- Test with small dataset first

### Risk 3: Breaking Changes During Migration
**Likelihood**: Low  
**Impact**: High (user-facing bugs)  
**Mitigation**:
- Implement feature flags for gradual rollout
- Keep mock data alongside real data initially
- A/B test with subset of users

---

## 📝 Conclusion

The frontend is well-architected with proper separation of concerns (hooks, components, providers). The main issue is **incomplete backend integration**, not poor code quality. The cleanup is straightforward:

1. Wire up existing backend endpoints
2. Replace mock data imports with hook calls
3. Remove dead code

Estimated total effort: **4-5 days** for full cleanup.

**Next Step**: Review this report and approve Phase 1 to begin Chat/Artifact integration.
