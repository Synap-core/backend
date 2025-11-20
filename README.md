# Synap Backend - PostgreSQL Edition

**Personal Knowledge Management System with AI-Powered Intelligence Hub**

Synap is an event-driven backend for managing personal knowledge with AI assistance. This is the PostgreSQL-only version with TimescaleDB and pgvector extensions.

---

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 20+ & pnpm
- Docker (for PostgreSQL)

### 2. Start Database

```bash
# Start PostgreSQL + MinIO + Redis
docker compose up -d

# Verify services are healthy
docker compose ps
```

**Connection URLs:**
- PostgreSQL: `postgresql://postgres:synap_dev_password@localhost:5432/synap`
- MinIO: `http://localhost:9000` (console: `http://localhost:9001`)
- Redis: `redis://localhost:6379`

### 3. Install Dependencies

```bash
pnpm install
```

### 4. Setup Environment

```bash
# Copy example env file
cp .env.example .env

# Edit .env with your settings
# DATABASE_URL is already configured for docker-compose
```

### 5. Run Migrations

```bash
cd packages/database
pnpm db:migrate
```

This applies both:
- **Drizzle migrations** (auto-generated from TypeScript schema)
- **Custom migrations** (extensions, functions, hypertables)

### 6. Start Development

```bash
# Terminal 1: API server
pnpm dev

# Terminal 2: Inngest dev server (background jobs)
cd packages/jobs
pnpm dev
```

**API available at:** `http://localhost:3000`

---

## 📦 Architecture

### Core Technologies

- **Database:** PostgreSQL 16 with TimescaleDB + pgvector
- **ORM:** Drizzle ORM (type-safe, performant)
- **API:** tRPC (type-safe APIs) + Hono (web server)
- **Jobs:** Inngest (event-driven background jobs)
- **Storage:** MinIO / R2 (S3-compatible)
- **AI:** LangGraph + Vercel AI SDK
- **Auth:** Better Auth (multi-user)

### Key Features

1. **Event Sourcing** - TimescaleDB for immutable event history
2. **Vector Search** - pgvector for semantic search
3. **Hybrid Storage** - PostgreSQL for metadata, R2/MinIO for content
4. **Row-Level Security** - PostgreSQL RLS for multi-user isolation
5. **Type-Safe APIs** - tRPC with Zod validation
6. **AI Integration** - Hub Protocol for AI agents

---

## 🗂️ Project Structure

```
synap-backend/
├── packages/
│   ├── api/          # tRPC routers + API logic
│   ├── database/     # Drizzle schema + migrations
│   ├── jobs/         # Inngest background jobs
│   ├── ai/           # LangGraph agents
│   ├── types/        # Shared TypeScript types
│   ├── core/         # Utilities (logger, errors, etc.)
│   ├── auth/         # Better Auth configuration
│   └── storage/      # R2/MinIO client
├── apps/
│   ├── api-server/   # Hono API server
│   └── admin-ui/     # Admin dashboard (optional)
├── docker-compose.yml # PostgreSQL + MinIO + Redis
└── scripts/          # Utility scripts
```

---

## 🔧 Development

### Database Commands

```bash
cd packages/database

# Generate migration from schema changes
pnpm db:generate

# Apply all migrations
pnpm db:migrate

# Push schema directly (dev only, no migration files)
pnpm db:push

# Open Drizzle Studio (visual DB editor)
pnpm db:studio
```

### Adding a New Table

1. **Edit schema** (`packages/database/src/schema/my-table.ts`):
   ```typescript
   import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
   
   export const myTable = pgTable('my_table', {
     id: uuid('id').primaryKey().defaultRandom(),
     name: text('name').notNull(),
     createdAt: timestamp('created_at').notNull().defaultNow(),
   });
   ```

2. **Export in index** (`packages/database/src/schema/index.ts`):
   ```typescript
   export * from './my-table.js';
   ```

3. **Generate migration**:
   ```bash
   pnpm db:generate
   ```

4. **Apply migration**:
   ```bash
   pnpm db:migrate
   ```

### Adding Custom SQL (Extensions, Functions)

For PostgreSQL-specific features (extensions, PL/pgSQL functions, hypertables):

1. **Create file** in `packages/database/migrations-custom/`:
   ```sql
   -- migrations-custom/0011_my_custom_feature.sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   
   CREATE OR REPLACE FUNCTION my_function()
   RETURNS TABLE(...) AS $$
   BEGIN
     -- Logic here
   END;
   $$ LANGUAGE plpgsql;
   ```

2. **Apply migration**:
   ```bash
   pnpm db:migrate
   ```

---

## 🧪 Testing

```bash
# Run all tests
pnpm test

# Run tests for specific package
pnpm --filter @synap/api test

# Run tests in watch mode
pnpm test:watch
```

---

## 📚 Key Concepts

### Event Sourcing

All state changes are captured as immutable events in TimescaleDB:

```typescript
import { getEventRepository } from '@synap/database';

const eventRepo = getEventRepository();

// Append event
await eventRepo.append({
  type: 'task.created',
  data: { title: 'My Task' },
  userId: 'user-123',
});

// Query events
const events = await eventRepo.getByUserId('user-123');
```

### Vector Search

Store and search embeddings with pgvector:

```typescript
import { db, entityVectors } from '@synap/database';
import { cosineDistance } from 'drizzle-orm';

// Search similar vectors
const results = await db
  .select()
  .from(entityVectors)
  .where(cosineDistance(entityVectors.embedding, queryVector).lt(0.5))
  .limit(10);
```

### Row-Level Security (RLS)

Automatic user isolation for multi-tenant:

```typescript
import { setCurrentUser, clearCurrentUser } from '@synap/database';

// Set user context (applies RLS policies)
await setCurrentUser('user-123');

// All queries now filtered by user
const tasks = await db.select().from(tasks); // Only user-123's tasks

// Clear context
await clearCurrentUser();
```

### Hub Protocol

AI agents communicate with the data pod:

```typescript
// 1. Hub generates access token
const { token } = await client.hub.generateAccessToken.mutate({
  apiKey: hubApiKey,
  requestId: uuid(),
  scope: ['preferences', 'notes', 'tasks'],
});

// 2. Hub requests data
const { data } = await client.hub.requestData.query({
  token,
  scope: ['notes'],
});

// 3. Hub submits insights
await client.hub.submitInsight.mutate({
  token,
  requestId,
  insight: {
    type: 'action_plan',
    actions: [{ eventType: 'task.create', data: {...} }],
  },
});
```

---

## 🔐 Security

- **RLS**: PostgreSQL Row-Level Security for user isolation
- **API Keys**: Bcrypt-hashed, scoped permissions, rate-limited
- **JWT**: Short-lived tokens (5 min max) for Hub communication
- **Audit Logs**: All Hub accesses logged in Event Store
- **HTTPS**: Enforced in production

---

## 📖 Documentation

- **Architecture:** `docs/architecture/`
- **API Keys:** `docs/api/API_KEYS.md`
- **Hub Protocol:** `docs/architecture/PRDs/HUB_PROTOCOL_V1.md`
- **Event Sourcing:** `docs/architecture/EVENT_DRIVEN.md`
- **Deployment:** `docs/deployment/`

---

## 🐳 Production Deployment

### Option 1: Docker Compose

```bash
# Set production passwords
export POSTGRES_PASSWORD=your_secure_password
export MINIO_ROOT_PASSWORD=your_minio_password

# Start services
docker compose up -d

# Apply migrations
cd packages/database
export DATABASE_URL=postgresql://postgres:your_secure_password@localhost:5432/synap
pnpm db:migrate
```

### Option 2: Managed Services

- **Database:** Neon, Supabase, or Railway (PostgreSQL with TimescaleDB)
- **Storage:** Cloudflare R2 or AWS S3
- **Cache:** Upstash Redis

```bash
# Set environment variables
export DATABASE_URL=postgresql://...
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...

# Deploy
pnpm build
pnpm start
```

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

---

## 📄 License

MIT License - See LICENSE file for details

---

## 🆘 Support

- **Issues:** [GitHub Issues](https://github.com/your-repo/issues)
- **Discord:** [Synap Community](https://discord.gg/synap)
- **Docs:** `docs/` directory

---

**Built with ❤️ using PostgreSQL, TypeScript, and AI**
