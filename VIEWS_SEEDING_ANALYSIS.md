# Views Seeding Analysis & Recommendation

## 🔍 Current State

### ✅ What Exists

1. **Default Whiteboard**: `ensureDefaultWhiteboard()`
   - ✅ Created automatically when workspace is created
   - ✅ Executor: `default-whiteboard-executor.ts`
   - ✅ Triggered by: `workspaces.create.completed` event
   - ✅ Pattern: Utility function + Executor

### ❌ What's Missing

1. **No default structured views** (table, kanban, list, grid, etc.)
2. **No default bento grid** (composite view)
3. **No view templates** (starter configurations)

---

## 📋 Available View Types (12 total)

### Structured Views (9 types):

1. `table` - Spreadsheet view
2. `kanban` - Board view (columns)
3. `list` - Simple list
4. `grid` - Grid layout
5. `gallery` - Gallery/card view
6. `calendar` - Calendar view
7. `gantt` - Gantt chart
8. `timeline` - Timeline view
9. `graph` - Network graph

### Canvas Views (2 types):

1. `whiteboard` - ✅ Has default creation
2. `mindmap` - ❌ No default

### Composite Views (1 type):

1. `bento` - Grid of embedded views ❌ No default

---

## 💡 Recommendation: Minimal Default Views

### Why Create Default Views?

- **User Onboarding**: Gives users a starting point
- **Examples**: Shows different view types in action
- **Demonstrates System**: Shows profile-based filtering
- **Reduces Friction**: Users can start using immediately

### What to Create?

**Option 1: Minimal (RECOMMENDED)**

- **"All Tasks"** (table view) - Shows all tasks
- **"Task Board"** (kanban view) - Kanban board for tasks

**Option 2: Comprehensive**

- Views for each major profile (task, project, event, person, company)
- Bento grid dashboard
- Too many → clutter

**Option 3: None**

- Clean slate
- Users create what they need
- But feels empty

---

## 🎯 Proposed Default Views

### 1. "All Tasks" (Table View)

```typescript
{
  type: 'table',
  category: 'structured',
  name: 'All Tasks',
  description: 'View all tasks in a table',
  scopeProfileIds: [taskProfileId], // From system profiles
  query: {
    filters: [],
    sorts: [{ field: 'createdAt', direction: 'desc' }],
    search: '',
  },
  config: {
    visibleColumns: ['title', 'status', 'priority', 'dueDate', 'assignee'],
    columnOrder: ['title', 'status', 'priority', 'dueDate', 'assignee'],
  },
}
```

### 2. "Task Board" (Kanban View)

```typescript
{
  type: 'kanban',
  category: 'structured',
  name: 'Task Board',
  description: 'Kanban board for tasks',
  scopeProfileIds: [taskProfileId],
  query: {
    filters: [],
    sorts: [],
    search: '',
  },
  config: {
    groupByColumnId: 'status',
    kanbanColumns: [
      { id: 'todo', value: 'todo', label: 'To Do', order: 0 },
      { id: 'in-progress', value: 'in-progress', label: 'In Progress', order: 1 },
      { id: 'done', value: 'done', label: 'Done', order: 2 },
    ],
  },
}
```

### Optional: Bento Grid Dashboard

```typescript
{
  type: 'bento',
  category: 'composite',
  name: 'Dashboard',
  description: 'Overview dashboard',
  embeddedViewIds: [allTasksViewId, taskBoardViewId],
  config: {
    layout: 'grid',
    gridColumns: 2,
    gridRows: 2,
  },
}
```

---

## 🛠️ Implementation Approach

### Pattern: Same as Whiteboard

1. **Utility Function**: `ensureDefaultViews()` (in `@synap/database`)
2. **Executor**: `default-views-executor.ts` (in `@synap/jobs`)
3. **Trigger**: `workspaces.create.completed` event (after whiteboard)

### Why This Pattern?

- ✅ Consistent with existing whiteboard pattern
- ✅ Uses profile slugs (flexible, no hardcoded IDs)
- ✅ Idempotent (safe to run multiple times)
- ✅ Can be called manually if needed

---

## 📝 Implementation Plan

### Step 1: Create Utility Function

**File**: `packages/database/src/utils/ensure-default-views.ts`

- Similar to `ensureDefaultWhiteboard`
- Creates "All Tasks" (table) and "Task Board" (kanban)
- Uses profile slugs (not IDs) for flexibility
- Idempotent (checks if views already exist)

### Step 2: Create Executor

**File**: `packages/jobs/src/executors/default-views-executor.ts`

- Listens to `workspaces.create.completed`
- Calls `ensureDefaultViews(workspaceId, userId)`
- Runs after whiteboard executor

### Step 3: Register Executor

**File**: `packages/jobs/src/index.ts`

- Add executor to exports

---

## 🤔 Open Questions

1. **Which views to create?**
   - **Recommendation**: Just "All Tasks" + "Task Board" (minimal, useful)

2. **Should bento grid be included?**
   - **Recommendation**: No (too complex for starters, can add later)

3. **Should views be workspace-specific?**
   - **Recommendation**: Yes (like whiteboard, shared in workspace)

4. **Should views be deletable?**
   - **Recommendation**: Yes (user can delete if not needed)

5. **Should we create views for all profiles?**
   - **Recommendation**: No (too many, start with tasks only)

---

## ✅ Final Recommendation

**Create 2 default views**:

1. "All Tasks" (table view)
2. "Task Board" (kanban view)

**Implementation**:

- Utility function: `ensureDefaultViews()`
- Executor: `default-views-executor.ts`
- Pattern: Same as whiteboard (executor-based, not migration)

**Why not migration?**

- Views are workspace-specific (not system-wide like profiles)
- Need profile IDs (can query by slug)
- Executor pattern is more flexible

**Next Steps**:

1. Create utility function
2. Create executor
3. Register executor
4. Test with new workspace
