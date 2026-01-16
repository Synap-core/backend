# Synap Backend - Developer Integration Guide

**Version**: 2.0  
**Last Updated**: 2026-01-15

> **Quick Start**: Copy-paste the patterns below when adding new features. Follow the established architecture to maintain consistency.

---

## 📋 Table of Contents

1. [Adding a New Table](#adding-a-new-table)
2. [User → Workspace → Project Hierarchy](#user-workspace-project-hierarchy)
3. [Event-Driven Architecture](#event-driven-architecture)
4. [Preferences System](#preferences-system)
5. [Storage Integration](#storage-integration)

---

## Adding a New Table

**Pattern**: Event-Driven CQRS with Repositories

### Step 1: Database Schema

**File**: `packages/database/src/schema/your-table.ts`

```typescript
import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const yourTable = pgTable("your_table", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),

  // Your fields here
  name: text("name").notNull(),
  metadata: jsonb("metadata").default({}).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type YourTable = typeof yourTable.$inferSelect;
export type NewYourTable = typeof yourTable.$inferInsert;

export const insertYourTableSchema = createInsertSchema(yourTable);
export const selectYourTableSchema = createSelectSchema(yourTable);
```

**Then**:

1. Add to `packages/database/src/schema/index.ts`
2. Run `pnpm --filter @synap/database db:generate`
3. Run `pnpm --filter @synap/database db:push`

---

### Step 2: Repository

**File**: `packages/database/src/repositories/your-table-repository.ts`

```typescript
import { eq, and } from "drizzle-orm";
import { yourTable } from "../schema/index.js";
import { BaseRepository } from "./base-repository.js";

export interface CreateYourTableInput {
  name: string;
  metadata?: Record<string, unknown>;
  userId: string;
}

export class YourTableRepository extends BaseRepository {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, {
      subjectType: "yourTable",
      pluralName: "yourTables",
    });
  }

  async create(data: CreateYourTableInput, userId: string) {
    const [record] = await this.db
      .insert(yourTable)
      .values({ ...data })
      .returning();

    await this.emitCompleted("create", record, userId);
    return record;
  }

  async update(id: string, data: any, userId: string) {
    const [record] = await this.db
      .update(yourTable)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(yourTable.id, id), eq(yourTable.userId, userId)))
      .returning();

    if (!record) throw new Error("Not found");
    await this.emitCompleted("update", record, userId);
    return record;
  }

  async delete(id: string, userId: string) {
    await this.db
      .delete(yourTable)
      .where(and(eq(yourTable.id, id), eq(yourTable.userId, userId)));

    await this.emitCompleted("delete", { id }, userId);
  }
}
```

**Export**: Add to `packages/database/src/repositories/index.ts`

---

### Step 3: Executor

**File**: `packages/jobs/src/executors/your-table-executor.ts`

```typescript
import { inngest } from "../client.js";
import { getDb, EventRepository, YourTableRepository } from "@synap/database";

export const yourTableHandler = async ({ event, step }) => {
  const action = event.name.split(".")[1];
  const { userId } = event.user;
  const data = event.data;

  const db = await getDb();
  const eventRepo = new EventRepository(db);
  const repo = new YourTableRepository(db, eventRepo);

  if (action === "create") {
    await step.run("create", () => repo.create(data, userId));
  } else if (action === "update") {
    await step.run("update", () => repo.update(data.id, data, userId));
  } else if (action === "delete") {
    await step.run("delete", () => repo.delete(data.id, userId));
  }

  return { success: true };
};

export const yourTableExecutor = inngest.createFunction(
  {
    id: "your-table-executor",
    name: "YourTable Operations",
    concurrency: { limit: 20 },
  },
  { event: "yourTable.*.validated" },
  yourTableHandler
);
```

**Register**:

1. Export from `packages/jobs/src/executors/index.ts`
2. Add to functions array in `packages/jobs/src/index.ts`

---

### Step 4: API Router

**File**: `packages/api/src/routers/your-table.ts`

```typescript
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { emitRequestEvent } from "../utils/emit-event.js";
import { randomUUID } from "crypto";

export const yourTableRouter = router({
  create: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const id = randomUUID();

      await emitRequestEvent({
        type: "yourTable.create.requested",
        subjectId: id,
        subjectType: "yourTable",
        data: { id, ...input, userId: ctx.userId },
        userId: ctx.userId,
      });

      return { id, status: "requested" };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    return db.query.yourTable.findMany({
      where: eq(yourTable.userId, ctx.userId),
    });
  }),
});
```

**Register**: Add to `packages/api/src/index.ts`

---

### Event Flow

```
Frontend → Router → GlobalValidator → Executor → Repository → DB
           ↓           ↓                ↓           ↓
       .requested  .validated      .completed   Event Store
```

---

## User → Workspace → Project Hierarchy

### Structure

```
User
├── User Preferences (uiPreferences JSONB)
└── Workspaces (owner/member)
    ├── Workspace Settings (settings JSONB)
    ├── Workspace Members (roles)
    └── Projects
        ├── Project Members (roles)
        └── Entities/Documents
```

### Roles

**Workspace & Project Roles**:

- `owner`: Full control
- `admin`: Manage members, settings
- `editor`: Create/edit content
- `viewer`: Read-only

### User Preferences

```typescript
import { getUserPreference, setUserPreference } from "@synap/database";

// Get
const pref = await getUserPreference(userId, "entity.deleteDocument");

// Set
await setUserPreference(userId, "entity.deleteDocument", false);
```

**Available Keys**:

- `entity.deleteDocument` - Cascade delete (default: true)
- `editor.autosave` - Auto-save enabled (default: true)
- `editor.autosaveInterval` - Seconds (default: 30)
- `theme.mode` - 'light' | 'dark' | 'system'

### Workspace Preferences

```typescript
import {
  getWorkspacePreference,
  setWorkspacePreference,
} from "@synap/database";

const aiEnabled = await getWorkspacePreference(
  workspaceId,
  "features.aiEnabled"
);
```

**Available Keys**:

- `features.aiEnabled` - AI toggle (default: true)
- `features.collaborativeEditing` - Collab (default: true)
- `retention.documentDays` - Retention (default: 90)

---

## Event-Driven Architecture

### Event Naming

```
<resource>.<action>.<status>

Examples:
- yourTable.create.requested  ← Router
- yourTable.create.validated  ← GlobalValidator
- yourTable.create.completed  ← Repository
```

### Emitting Events

**Router**:

```typescript
await emitRequestEvent({
  type: "yourTable.create.requested",
  subjectId: id,
  subjectType: "yourTable",
  data: {
    /* data */
  },
  userId: ctx.userId,
});
```

**Repository** (automatic via BaseRepository):

```typescript
await this.emitCompleted("create", record, userId);
```

---

## Preferences System

### When to Use

- **User Preferences**: Personal settings (UI, editor)
- **Workspace Preferences**: Team features (AI, retention)

### Integration Pattern

```typescript
// In executor
const { getUserPreference } = await import("@synap/database");
const userPref = await getUserPreference(userId, "entity.deleteDocument");

// Allow override
const finalValue = data.deleteDocument ?? userPref;
```

### Default Values

**Application-level** (in code, not DB):

- Easy to update (no migration)
- Sparse storage (only changes saved)
- Always returns a value

---

## Storage Integration

### Upload Pattern

```typescript
const uploadResult = await step.run("upload", async () => {
  const { storage } = await import("@synap/storage");

  const key = storage.buildPath(userId, "documents", id, "md");
  const metadata = await storage.upload(key, content, {
    contentType: "text/markdown",
  });

  return { url: metadata.url, key: metadata.path, size: metadata.size };
});
```

### Delete Pattern

**⚠️ CRITICAL**: Delete storage BEFORE database!

```typescript
// 1. Delete from storage
await step.run("delete-storage", async () => {
  const { storage } = await import("@synap/storage");
  await storage.delete(record.storageKey);
});

// 2. Delete from DB
await step.run("delete-record", () => repo.delete(id, userId));
```

---

## Best Practices

### ✅ DO

- Use event-driven pattern (Router → GlobalValidator → Executor → Repository)
- Check permissions in GlobalValidator
- Keep repositories pure (DB only)
- Use preferences for configurable behavior
- Clean up storage on deletion
- Use Drizzle types and Zod schemas

### ❌ DON'T

- Direct DB operations in routers
- Business logic in repositories
- Hardcode behaviors users might change
- Leave orphaned storage files
- Skip event emission
- Use `any` types

---

## Quick Checklist

Adding a new table:

- [ ] Schema created (`schema/your-table.ts`)
- [ ] Repository created (`repositories/your-repo.ts`)
- [ ] Executor created (`executors/your-executor.ts`)
- [ ] Router created (`routers/your-router.ts`)
- [ ] All exports added to index files
- [ ] Migration generated and applied
- [ ] Builds passing (database, jobs, api)
- [ ] Manual testing complete

---

## File Locations

```
packages/
├── database/
│   ├── src/schema/your-table.ts
│   ├── src/repositories/your-repo.ts
│   └── src/utils/preferences.ts
├── jobs/
│   └── src/executors/your-executor.ts
└── api/
    └── src/routers/your-router.ts
```

---

**Questions?** Check existing implementations: entities, documents, tags, workspaces.

**Last Updated**: 2026-01-15
