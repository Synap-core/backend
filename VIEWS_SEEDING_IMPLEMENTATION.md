# Views Seeding Implementation - Complete

## ✅ What Was Created

### 1. Utility Function

**File**: `packages/database/src/utils/ensure-default-views.ts`

- Idempotent function to ensure default views exist
- Creates "All Tasks" (table) and "Task Board" (kanban)
- Uses profile slugs (flexible, no hardcoded IDs)
- **Exported** from `@synap/database` package

### 2. Executor

**File**: `packages/jobs/src/executors/default-views-executor.ts`

- Listens to `workspaces.create.completed` event
- Calls `ensureDefaultViews(workspaceId, userId)`
- Runs after whiteboard executor
- **Registered** in `packages/jobs/src/index.ts`

### 3. Default Views Created

#### "All Tasks" (Table View)

- Type: `table`
- Category: `structured`
- Scope: `task` profile
- Query: Sort by `createdAt` desc
- Config: Columns (title, status, priority, dueDate, assignee)

#### "Task Board" (Kanban View)

- Type: `kanban`
- Category: `structured`
- Scope: `task` profile
- Query: No filters/sorts
- Config: Group by `status`, 4 columns (todo, in-progress, done, cancelled)

---

## 🚀 How It Works

### Automatic Creation

When a workspace is created:

1. `workspaces.create.completed` event fires
2. `createDefaultWhiteboard` executor runs (creates whiteboard)
3. `createDefaultViews` executor runs (creates table + kanban views)
4. Both use profile slugs (no hardcoded IDs)

### Idempotent

- Checks if views already exist (by name)
- Safe to run multiple times
- Won't create duplicates

---

## 📋 Comparison: Profiles vs Views

| Aspect                | Profiles          | Views                             |
| --------------------- | ----------------- | --------------------------------- |
| **Scope**             | System (shared)   | Workspace (per workspace)         |
| **Seeding Method**    | Migration         | Executor                          |
| **Default Count**     | 6 system profiles | 1 whiteboard + 2 structured views |
| **User Customizable** | ✅ Yes            | ✅ Yes                            |
| **Deletable**         | ❌ No (system)    | ✅ Yes (user can delete)          |

**Key Difference**:

- **Profiles** = System-wide (migration-based, one-time)
- **Views** = Workspace-specific (executor-based, per workspace)

---

## 🎯 Summary

✅ **Profiles**: Migration seeds 6 system profiles (note, task, project, event, person, company)
✅ **Views**: Executor creates 3 default views (whiteboard, "All Tasks" table, "Task Board" kanban)

**Result**: New workspaces get:

- 6 system profiles (shared across all workspaces)
- 1 whiteboard (workspace-specific)
- 2 structured views (workspace-specific)

This gives users a complete starting point with both profiles and views ready to use!
