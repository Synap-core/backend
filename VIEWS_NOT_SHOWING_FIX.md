# Views Not Showing - Root Cause & Fix

## 🔍 Root Cause

The `useViewsList` hook was expecting an `api` prop to be provided, but `ViewsManagementPage` was not providing it. When no API was provided, the hook would:

1. Return empty array (line 41: `return []`)
2. Disable the query (line 43: `enabled: enabled && !!api?.listViews`)

**Result**: No views were ever fetched, even though views exist in the database.

---

## ✅ Fix Applied

Updated `useViewsList` hook to use tRPC directly when no API is provided:

### Before:

```typescript
const {
  data: views = [],
  isLoading,
  error,
  refetch,
} = useQuery({
  queryKey: ["views", "list", filters],
  queryFn: async () => {
    if (api?.listViews) {
      return api.listViews(filters);
    }
    // Fallback: return empty array if no API
    return [];
  },
  enabled: enabled && !!api?.listViews,
});
```

### After:

```typescript
// Use tRPC directly if no API provided
const viewsQuery = trpc.views.list.useQuery(
  {
    workspaceId: filters?.workspaceId,
    type:
      filters?.viewType && filters.viewType !== "all"
        ? (filters.viewType as any)
        : undefined,
  },
  {
    enabled: enabled && !!filters?.workspaceId,
  }
);

const views = viewsQuery.data || [];
const isLoading = viewsQuery.isLoading;
const error = viewsQuery.error;
const refetch = viewsQuery.refetch;
```

---

## 🔧 Additional Fixes

1. **Mutations**: Updated delete, update, and toggleFavorite to use tRPC when no API is provided
2. **Invalidation**: Properly invalidate tRPC cache after mutations
3. **Metadata Updates**: Use `views.save` endpoint for metadata updates (favorites)

---

## 📋 Backend Endpoint Used

**`trpc.views.list`**:

- Filters by `workspaceId` (optional)
- Filters by `type` (optional)
- Returns views where `userId = ctx.userId` (only views created by current user)

**Note**: The backend filters by `userId`, so only views created by the current user are returned. If views were created by a different user (e.g., via executor), they won't show up unless the backend logic is updated.

---

## 🚨 Potential Issue: User ID Mismatch

The backend `views.list` endpoint filters by `ctx.userId`:

```typescript
where: and(
  eq(views.userId, ctx.userId),
  input.workspaceId ? eq(views.workspaceId, input.workspaceId) : undefined,
  ...
)
```

**If views were created by executors** (like `createDefaultViews`), they use the `userId` from the event. This should match the current user, but if there's a mismatch, views won't show.

**To verify**: Check if views in database have the correct `user_id` matching the logged-in user.

---

## ✅ Next Steps

1. **Test**: Open views app and verify views are showing
2. **Check Database**: Verify views exist and have correct `user_id` and `workspace_id`
3. **Check Executor**: Verify `createDefaultViews` executor is using the correct `userId`

---

## 📝 Files Changed

- `synap-app/packages/apps/views-management/src/hooks/useViewsList.ts`
  - Added tRPC direct usage when no API provided
  - Updated mutations to use tRPC
  - Fixed query invalidation
