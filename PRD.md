# 📋 Synap Backend - Product Requirements Document

**Version**: 1.0.0  
**Date**: 2025-01-17  
**Status**: Draft

---

## 🎯 Vision

Synap Backend is a flexible, event-sourced knowledge management platform that supports multiple deployment models:

1. **Local-First**: Single-user, offline-capable, SQLite-based
2. **Multi-User SaaS**: Cloud-based, PostgreSQL, Better Auth
3. **Hybrid Dual-Access**: Users can access both local content AND company/community content simultaneously

---

## 🚀 Core Use Cases

### Use Case 1: Personal Knowledge Management (Local)
**User**: Individual developer, researcher, writer  
**Scenario**: User wants a private, local-first knowledge base
- ✅ SQLite database (local file)
- ✅ MinIO storage (local filesystem)
- ✅ Simple token authentication
- ✅ No network required
- ✅ Full data ownership

### Use Case 2: Team/Company Knowledge Base (SaaS)
**User**: Team members, company employees  
**Scenario**: Company deploys Synap for team knowledge sharing
- ✅ PostgreSQL database (shared)
- ✅ Cloudflare R2 storage (shared)
- ✅ Better Auth with OAuth
- ✅ User isolation (each user sees only their data)
- ✅ Company-wide search (optional)

### Use Case 3: Hybrid Dual-Access (NEW) ⭐
**User**: Employee who wants both personal and company content  
**Scenario**: User works for Company X but also maintains personal notes
- ✅ **Local Context**: Personal SQLite database + MinIO
- ✅ **Company Context**: Access to company PostgreSQL + R2
- ✅ **Unified Interface**: Single API, context switching
- ✅ **Data Isolation**: Personal data never touches company servers
- ✅ **Cross-Context Search**: Search both personal and company content

### Use Case 4: Community/Open Knowledge Base
**User**: Community members, open-source contributors  
**Scenario**: Public knowledge base with user contributions
- ✅ PostgreSQL database (shared)
- ✅ Public + private content
- ✅ User authentication
- ✅ Content sharing permissions

---

## 🏗️ Dual-Access Architecture

### Current State

```
┌─────────────────────────────────────────┐
│         Single Mode Selection            │
│                                         │
│  DB_DIALECT=sqlite  →  Local Mode      │
│  DB_DIALECT=postgres → Multi-User Mode │
└─────────────────────────────────────────┘
```

**Problem**: User must choose ONE mode. Cannot access both simultaneously.

### Target State

```
┌─────────────────────────────────────────────────────────────┐
│              Dual-Access Architecture                       │
│                                                             │
│  ┌──────────────────┐         ┌──────────────────┐        │
│  │  Local Context    │         │ Company Context  │        │
│  │                  │         │                  │        │
│  │  • SQLite DB     │         │  • PostgreSQL    │        │
│  │  • MinIO Storage │         │  • R2 Storage    │        │
│  │  • No userId    │         │  • userId-based  │        │
│  │  • Private       │         │  • Shared        │        │
│  └────────┬─────────┘         └────────┬─────────┘        │
│           │                            │                  │
│           └────────────┬────────────────┘                  │
│                        │                                   │
│           ┌────────────▼────────────┐                     │
│           │   Unified API Layer     │                     │
│           │                         │                     │
│           │  • Context switching    │                     │
│           │  • Unified search       │                     │
│           │  • Cross-context ops    │                     │
│           └─────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

#### 1. Context Switching
```typescript
// User can switch contexts per-request
POST /trpc/notes.create
Headers: {
  "Authorization": "Bearer <token>",
  "X-Context": "local" | "company" | "both"  // NEW
}
```

#### 2. Unified Search
```typescript
// Search across both contexts
POST /trpc/notes.search
{
  "query": "meeting notes",
  "contexts": ["local", "company"],  // Search both
  "useRAG": true
}
```

#### 3. Data Isolation
- **Local data**: Never leaves user's device/server
- **Company data**: Stored in company's infrastructure
- **No mixing**: Clear separation, explicit context

#### 4. Storage Path Strategy
```typescript
// Local context
storage.buildPath("local", "note", "id", "md")
// → "local/notes/id.md"

// Company context  
storage.buildPath(userId, "note", "id", "md")
// → "users/{userId}/notes/id.md"
```

---

## 📊 Data Model Changes

### Current Schema (PostgreSQL)
```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,  -- Required for multi-user
  type TEXT NOT NULL,
  ...
);
```

### Dual-Access Schema (PostgreSQL)
```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY,
  user_id TEXT,           -- NULL for local context
  context TEXT NOT NULL,  -- 'local' | 'company' | 'community'
  company_id TEXT,        -- NULL for local, set for company
  type TEXT NOT NULL,
  ...
);

-- Indexes
CREATE INDEX idx_entities_user_context ON entities(user_id, context);
CREATE INDEX idx_entities_company ON entities(company_id, context);
```

### Local Schema (SQLite) - No Changes
```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  -- No user_id (single-user)
  type TEXT NOT NULL,
  ...
);
```

---

## 🔐 Authentication & Authorization

### Local Context
- **Auth**: Simple token (SYNAP_SECRET_TOKEN)
- **User**: Implicit (no userId)
- **Storage**: Local filesystem (MinIO)

### Company Context
- **Auth**: Better Auth (OAuth + Email/Password)
- **User**: Explicit (userId from session)
- **Storage**: Company R2 bucket
- **Isolation**: Application-level filtering by userId

### Hybrid Access
- **Auth**: Both tokens required
  - Local: SYNAP_SECRET_TOKEN
  - Company: Better Auth session
- **Context Header**: `X-Context: local | company | both`
- **Default**: If both available, use `both` for unified operations

---

## 🎨 API Design

### Context-Aware Endpoints

```typescript
// Create note in local context
POST /trpc/notes.create
Headers: { "X-Context": "local" }
Body: { content: "Personal note" }

// Create note in company context
POST /trpc/notes.create
Headers: { "X-Context": "company" }
Body: { content: "Company note" }

// Unified search (both contexts)
POST /trpc/notes.search
Headers: { "X-Context": "both" }
Body: { query: "meeting", contexts: ["local", "company"] }
```

### Response Format
```typescript
{
  "results": [
    {
      "id": "uuid",
      "content": "...",
      "context": "local",      // NEW: Which context?
      "source": "local-db",    // NEW: Data source
      ...
    },
    {
      "id": "uuid",
      "content": "...",
      "context": "company",
      "source": "company-db",
      ...
    }
  ],
  "meta": {
    "localCount": 5,
    "companyCount": 12,
    "total": 17
  }
}
```

---

## 🔄 Migration Path

### Phase 1: Foundation (Current)
- ✅ SQLite mode (local)
- ✅ PostgreSQL mode (multi-user)
- ✅ Context switching via DB_DIALECT

### Phase 2: Dual-Access Core (Next)
- ⏳ Add `context` column to PostgreSQL schema
- ⏳ Add `X-Context` header support
- ⏳ Update API to handle context switching
- ⏳ Update storage paths for context isolation

### Phase 3: Unified Operations
- ⏳ Cross-context search
- ⏳ Unified API responses
- ⏳ Context-aware permissions

### Phase 4: Advanced Features
- ⏳ Content sharing between contexts
- ⏳ Sync local → company (optional)
- ⏳ Company → local export

---

## 🧪 Testing Strategy

### Unit Tests
- Context switching logic
- Storage path generation per context
- Query filtering per context

### Integration Tests
- Create note in local context
- Create note in company context
- Search across both contexts
- Verify data isolation

### E2E Tests
- User with both contexts configured
- Unified search workflow
- Context switching workflow

---

## 📈 Success Metrics

### Technical
- ✅ Dual-context requests: <200ms latency
- ✅ Cross-context search: <500ms latency
- ✅ Zero data leakage between contexts
- ✅ 100% test coverage for context switching

### User Experience
- ✅ Seamless context switching
- ✅ Unified search results
- ✅ Clear context indicators in UI
- ✅ No performance degradation

---

## 🚨 Risks & Mitigations

### Risk 1: Data Leakage
**Mitigation**: 
- Strict context validation
- Separate database connections
- Comprehensive isolation tests

### Risk 2: Performance Impact
**Mitigation**:
- Lazy loading of contexts
- Caching per context
- Async context switching

### Risk 3: Complexity
**Mitigation**:
- Clear API design
- Comprehensive documentation
- Developer tooling

---

## 📚 Related Documents

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical architecture
- [ROADMAP.md](./ROADMAP.md) - Implementation roadmap
- [SETUP.md](./SETUP.md) - Setup instructions

---

**Next Steps**: See [ROADMAP.md](./ROADMAP.md) for implementation plan.

