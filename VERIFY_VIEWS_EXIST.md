# Verify Views Exist - Complete Guide

## 🔍 Quick SQL Queries

### 1. Check All Views in Your Workspace

```sql
-- Replace <workspace-id> with your actual workspace ID
SELECT
  id,
  name,
  type,
  category,
  workspace_id,
  user_id,
  created_at
FROM views
WHERE workspace_id = '<workspace-id>'
ORDER BY created_at DESC;
```

### 2. Check for Default Views by Name

```sql
SELECT
  id,
  name,
  type,
  user_id,
  workspace_id,
  created_at
FROM views
WHERE name IN ('All Tasks', 'Task Board', 'Main Whiteboard')
  AND workspace_id = '<workspace-id>';
```

### 3. Check User ID Mismatch

```sql
-- Get your current user ID from the frontend (check browser console or auth)
-- Then check if views have matching user_id:
SELECT
  id,
  name,
  user_id,
  workspace_id
FROM views
WHERE workspace_id = '<workspace-id>'
  AND user_id = '<your-user-id>';
```

### 4. Check if Task Profile Exists

```sql
-- This is required for views to be created
SELECT id, slug, display_name, scope
FROM profiles
WHERE slug = 'task' AND scope = 'system';
```

---

## 🐛 Debug Checklist

### Step 1: Check if Views Exist

Run SQL query #1 above. If no views found:

- ✅ Views don't exist → Executor may not have run
- ✅ Views exist but wrong workspace → Check workspace ID

### Step 2: Check User ID

The backend `views.list` endpoint filters by `userId`:

```typescript
where: and(
  eq(views.userId, ctx.userId),  // Only shows views created by current user
  ...
)
```

**If views exist but have different `user_id`:**

- Views were created by a different user
- Executor used wrong `userId` from event
- **Fix**: Update views to have correct `user_id` OR update backend to show all workspace views

### Step 3: Check Executor Logs

Look for logs from `default-views-executor`:

```bash
# In backend logs, look for:
[defaultViewsExecutor] Processing workspace.create.completed
[defaultViewsExecutor] ensureDefaultViews result: created
```

**If executor didn't run:**

- Check if `workspaces.create.completed` event was emitted
- Check if executor is registered in `packages/jobs/src/index.ts`

### Step 4: Check Task Profile

If task profile doesn't exist, executor will skip:

```
Task profile not found - system profiles may not be seeded yet
```

**Fix**: Run migration to seed system profiles:

```bash
cd synap-backend/packages/database
pnpm db:migrate
```

---

## 🛠️ Manual Fix Options

### Option 1: Run Executor Manually

```typescript
// In backend console or via script
import { ensureDefaultViews } from "@synap/database";

const result = await ensureDefaultViews(workspaceId, userId);
console.log(result);
```

### Option 2: Create Views via SQL

```sql
-- First, get task profile ID
SELECT id FROM profiles WHERE slug = 'task' AND scope = 'system';

-- Then create views (replace UUIDs and IDs)
INSERT INTO views (
  id, type, category, name, description, workspace_id, user_id,
  scope_profile_ids, scope_mode, query, config, created_at, updated_at
) VALUES (
  gen_random_uuid(),
  'table',
  'structured',
  'All Tasks',
  'View all tasks in a table',
  '<workspace-id>',
  '<user-id>',
  ARRAY['<task-profile-id>']::uuid[],
  'explicit',
  '{"filters": [], "sorts": [{"field": "createdAt", "direction": "desc"}], "search": "", "limit": 100, "offset": 0}'::jsonb,
  '{"visibleColumns": ["title", "status", "priority", "dueDate", "assignee"], "columnOrder": ["title", "status", "priority", "dueDate", "assignee"]}'::jsonb,
  NOW(),
  NOW()
);
```

### Option 3: Update Backend to Show All Workspace Views

If views exist but have wrong `user_id`, you can update the backend to show all workspace views (not just user's views):

**File**: `packages/api/src/routers/views.ts` (line 248-262)

Change from:

```typescript
where: and(
  eq(views.userId, ctx.userId),  // Only user's views
  ...
)
```

To:

```typescript
where: and(
  // Show all views in workspace (user has access via workspace membership)
  input.workspaceId ? eq(views.workspaceId, input.workspaceId) : undefined,
  ...
)
```

**Note**: This requires permission check to ensure user has access to workspace.

---

## 📋 Quick Verification Script

I've created a script to check views: `synap-backend/scripts/check-views.ts`

```bash
cd synap-backend
pnpm tsx scripts/check-views.ts <workspace-id>
```

This will:

- ✅ Check if workspace exists
- ✅ List all views in workspace
- ✅ Group by user ID
- ✅ Check for default views
- ✅ Verify task profile exists

---

## 🚨 Most Likely Issues

1. **Views don't exist** → Executor didn't run or failed silently
2. **Views have wrong `user_id`** → Backend filters them out
3. **Task profile missing** → Executor skipped creation
4. **Workspace ID mismatch** → Views in different workspace

---

## ✅ Next Steps

1. Run SQL query #1 to check if views exist
2. If views exist, check `user_id` matches your logged-in user
3. If views don't exist, check executor logs
4. If task profile missing, run migration
5. Use verification script for automated check
