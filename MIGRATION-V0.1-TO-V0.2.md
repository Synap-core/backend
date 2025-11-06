# 🔄 Migration Guide: V0.1 (Local) → V0.2 (Multi-User SaaS)

**Status**: 🚧 In Progress  
**Branch**: `main`  
**Target**: PostgreSQL + Better Auth + Multi-User

---

## 📋 Overview

This guide explains how to migrate from the single-user local MVP (v0.1) to the multi-user SaaS version (v0.2).

---

## ✅ What's Been Done

### 1. Database Schema Updates (Task 2.1 + 2.3) ✅

**Status**: Complete

**Changes**:
- ✅ All schemas now support both SQLite and PostgreSQL
- ✅ Added `userId` column to: `events`, `entities`, `relations`
- ✅ PostgreSQL schemas use native `uuid`, `timestamp`, `jsonb` types
- ✅ PostgreSQL uses `pgvector` for embeddings (efficient similarity search)
- ✅ SQLite schemas remain unchanged (for `open-source` branch)

**Files Modified**:
- `packages/database/src/schema/events.ts`
- `packages/database/src/schema/entities.ts`
- `packages/database/src/schema/content_blocks.ts`
- `packages/database/src/schema/relations.ts`

**Key Pattern**:
```typescript
const isPostgres = process.env.DB_DIALECT === 'postgres';

if (isPostgres) {
  // PostgreSQL schema with userId
  const { pgTable, uuid, timestamp } = require('drizzle-orm/pg-core');
  // ...
} else {
  // SQLite schema (single-user)
  const { sqliteTable, text, integer } = require('drizzle-orm/sqlite-core');
  // ...
}
```

### 2. PostgreSQL Migrations Created ✅

**Status**: Complete

**Files Created**:
- `packages/database/migrations-pg/0001_enable_pgvector.sql` - Enables vector extension
- `packages/database/migrations-pg/0002_enable_rls.sql` - Row-Level Security policies

**What RLS Does**:
- Automatically filters queries by `userId`
- Prevents cross-user data access at the database level
- No application-level filtering needed (database enforces it)

### 3. Environment Template Created ✅

**Status**: Complete

**File Created**:
- `env.production.example` - Template for production environment

---

## 🚧 Next Steps (In Progress)

### Task 2.2: Integrate Better Auth ⏳

**Status**: Not Started

**Estimated Time**: 3 hours

**Steps**:

#### 1. Install Dependencies

```bash
cd /Users/antoine/Documents/Code/synap-backend
pnpm add better-auth @better-auth/drizzle
pnpm add --save-dev @types/better-auth
```

#### 2. Configure Better Auth

Create `packages/auth/src/better-auth.ts`:

```typescript
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle';
import { db } from '@synap/database';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg'
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // Enable in production
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!
    }
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24 // 1 day
  }
});

export type Session = typeof auth.$Infer.Session;
```

#### 3. Add Auth Routes to API

Update `apps/api/src/index.ts`:

```typescript
import { auth } from '@synap/auth';

// Better Auth routes (/api/auth/*)
app.all('/api/auth/*', async (c) => {
  return auth.handler(c.req.raw);
});

// Protect tRPC routes
app.use('/trpc/*', async (c, next) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers
  });
  
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  // Set current user for RLS
  await db.execute(sql`SET app.current_user_id = ${session.user.id}`);
  
  c.set('user', session.user);
  c.set('userId', session.user.id);
  
  return next();
});
```

#### 4. Update tRPC Context

Update `packages/api/src/context.ts`:

```typescript
import { auth } from '@synap/auth';
import type { Session } from '@synap/auth';

export async function createContext({ req }: FetchCreateContextFnOptions) {
  const session = await auth.api.getSession({
    headers: req.headers
  });
  
  return {
    user: session?.user || null,
    userId: session?.user.id || null,
    authenticated: !!session,
    session: session || null
  } satisfies Record<string, unknown>;
}

export type Context = Awaited<ReturnType<typeof createContext>>;
```

#### 5. Setup OAuth Providers

**Google OAuth**:
1. Go to https://console.cloud.google.com
2. Create new project "Synap"
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add redirect URI: `http://localhost:3000/api/auth/callback/google`
6. Copy Client ID and Secret to `.env`

**GitHub OAuth**:
1. Go to https://github.com/settings/developers
2. New OAuth App
3. Callback URL: `http://localhost:3000/api/auth/callback/github`
4. Copy Client ID and Secret to `.env`

---

### Task 2.4: RLS Migrations ⏳

**Status**: SQL Files Created, Need to Run

**Steps**:

#### 1. Setup Neon PostgreSQL

```bash
# Create account: https://neon.tech
# Create project: "synap-backend-production"
# Get connection string
```

#### 2. Update Environment

```bash
cp env.production.example .env.production
nano .env.production
```

Add:
```bash
DB_DIALECT=postgres
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/synap?sslmode=require
```

#### 3. Run Migrations

```bash
# Source production environment
export $(cat .env.production | xargs)

# Run pgvector migration
psql $DATABASE_URL < packages/database/migrations-pg/0001_enable_pgvector.sql

# Generate and push schemas
pnpm --filter database db:generate
pnpm --filter database db:push

# Run RLS migration
psql $DATABASE_URL < packages/database/migrations-pg/0002_enable_rls.sql
```

#### 4. Verify RLS

```sql
-- Connect to Neon database
psql $DATABASE_URL

-- Check RLS is enabled
SELECT schemaname, tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public';

-- List policies
SELECT tablename, policyname 
FROM pg_policies 
WHERE schemaname = 'public';
```

---

### Task 2.5: Update Workflows for Multi-User ⏳

**Status**: Not Started

**Estimated Time**: 3 hours

**Files to Modify**:

#### 1. Workflows Class

`packages/@initiativ-core/src/workflows.ts`:

```typescript
export class Workflows {
  constructor(
    private core: InitiativCore,
    private userId: string  // NEW!
  ) {}
  
  async captureNote(input, options?) {
    // Pass userId to all operations
    const note = await this.core.storage.createNote({
      userId: this.userId,
      content: input.content
    });
    // ...
  }
}
```

#### 2. Storage Layer

`packages/@initiativ-storage/src/files.ts`:

```typescript
async writeNote(userId: string, noteId: string, content: string) {
  // User-scoped directory
  const userDir = path.join(this.dataPath, 'users', userId, 'notes');
  await fs.mkdir(userDir, { recursive: true });
  
  const filepath = path.join(userDir, `${noteId}.md`);
  await fs.writeFile(filepath, content, 'utf-8');
  
  return filepath;
}
```

#### 3. RAG Layer

`packages/@initiativ-rag/src/llamaindex-rag.ts`:

```typescript
async search(userId: string, query: string, options?) {
  // Filter by userId
  const vectorStore = await QdrantVectorStore.fromExistingCollection({
    filter: { userId: { $eq: userId } }
  });
  // ...
}
```

#### 4. Adapter

`packages/api/src/adapters/initiativ-adapter.ts`:

```typescript
export async function createNoteViaInitiativ(
  core: InitiativCore,
  userId: string,  // NEW!
  input,
  options?
) {
  const workflows = new Workflows(core, userId);
  return workflows.captureNote(input, options);
}
```

#### 5. Router

`packages/api/src/routers/notes.ts`:

```typescript
create: protectedProcedure
  .mutation(async ({ ctx, input }) => {
    const note = await createNoteViaInitiativ(
      core,
      ctx.userId!,  // Pass from context
      input
    );
    // ...
  })
```

---

### Task 2.6: Multi-User Testing ⏳

**Status**: Not Started

**Estimated Time**: 1 hour

Create `packages/core/tests/multi-user.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { auth } from '@synap/auth';
import { trpc } from './test-utils';

describe('Multi-User Isolation', () => {
  it('should isolate notes between users', async () => {
    // Create user 1
    const user1 = await auth.api.signup({
      email: 'user1@test.com',
      password: 'pass123'
    });
    
    // Create user 2
    const user2 = await auth.api.signup({
      email: 'user2@test.com',
      password: 'pass123'
    });
    
    // User 1 creates note
    const note1 = await trpc.notes.create.mutate(
      { content: 'User 1 secret note' },
      { headers: { Authorization: `Bearer ${user1.session.token}` } }
    );
    
    // User 2 searches
    const results = await trpc.notes.search.query(
      { query: 'secret', useRAG: false },
      { headers: { Authorization: `Bearer ${user2.session.token}` } }
    );
    
    // User 2 should NOT see User 1's note
    expect(results.length).toBe(0);
    
    // User 1 should see their own note
    const user1Results = await trpc.notes.search.query(
      { query: 'secret', useRAG: false },
      { headers: { Authorization: `Bearer ${user1.session.token}` } }
    );
    
    expect(user1Results.length).toBe(1);
    expect(user1Results[0].id).toBe(note1.id);
  });
});
```

---

## 📊 Progress Tracker

| Task | Status | Files | Time |
|------|--------|-------|------|
| 2.1: PostgreSQL Schema | ✅ Complete | 4 schema files | 2h |
| 2.2: Better Auth | ⏳ Ready | Auth package | 3h |
| 2.3: Add userId | ✅ Complete | Schema files | 1h |
| 2.4: RLS Migrations | ⏳ SQL Ready | 2 migration files | 2h |
| 2.5: Update Workflows | ⏳ Planned | 5+ files | 3h |
| 2.6: Multi-User Tests | ⏳ Planned | 1 test file | 1h |

**Total Progress**: 2/6 tasks complete (33%)

---

## 🚀 How to Continue

### Option 1: Run Locally with PostgreSQL

```bash
# 1. Setup Neon database
# 2. Update .env.production
# 3. Run migrations
# 4. Start servers with production env

export $(cat .env.production | xargs)
pnpm --filter api dev
pnpm --filter jobs dev
```

### Option 2: Keep Developing with SQLite

```bash
# Continue using SQLite for testing
# Switch to PostgreSQL later

export DB_DIALECT=sqlite
pnpm --filter api dev
```

---

## 🎯 Definition of Done (V0.2)

### Functional Requirements

- [ ] Users can sign up with email/password
- [ ] Users can sign in with Google OAuth
- [ ] Users can sign in with GitHub OAuth
- [ ] Each user sees only their own notes
- [ ] RLS prevents cross-user access at DB level
- [ ] All Initiativ workflows scoped to userId
- [ ] Multi-user tests pass

### Technical Requirements

- [ ] PostgreSQL (Neon) connected
- [ ] pgvector extension enabled
- [ ] RLS policies active
- [ ] Better Auth integrated
- [ ] Session management working
- [ ] userId in all table schemas
- [ ] User-scoped file storage

### Performance Requirements

- [ ] Note creation: <2s (with AI)
- [ ] RAG search: <500ms
- [ ] RLS overhead: <50ms

---

## 📚 Resources

- **Better Auth Docs**: https://better-auth.com
- **Neon Docs**: https://neon.tech/docs
- **pgvector Docs**: https://github.com/pgvector/pgvector
- **RLS Guide**: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- **Drizzle PostgreSQL**: https://orm.drizzle.team/docs/get-started-postgresql

---

**Next Step**: Install Better Auth dependencies and configure OAuth providers.

```bash
pnpm add better-auth @better-auth/drizzle
```



