# Testing Guide

**Last Updated:** 2025-12-04  
**Coverage Goal:** 70%+ overall, 80%+ for critical paths  

---

## Overview

This guide covers testing strategies, patterns, and best practices for the Synap backend. We use **Vitest** for all testing with real PostgreSQL databases for integration tests.

---

## Quick Start

### Running Tests

```bash
# Run all tests
pnpm test

# Run specific package tests
pnpm --filter @synap/database test
pnpm --filter @synap/domain test

# Run with coverage
pnpm --filter @synap/database test:coverage

# Watch mode
pnpm --filter @synap/database test:watch
```

---

## Test Infrastructure

### Vitest Configuration

Each package has a `vitest.config.ts` that auto-loads environment variables:

```typescript
// packages/database/vitest.config.ts
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    test: {
      globals: true,
      environment: 'node',
      setupFiles: ['./src/__tests__/setup.ts'],
      env: {
        DATABASE_URL: env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/synap',
        NODE_ENV: 'test',
      },
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
      },
    },
  };
});
```

### Environment Files

**`.env.test`** (auto-loaded):
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/synap
OPENAI_API_KEY=test-key
NODE_ENV=test
```

---

## Test Data Management

### Convention: test-* Prefix

**All test data must use `test-` prefix for user IDs:**

```typescript
// ✅ Correct
const userId = generateTestUserId();  // Returns "test-abc123"

// ❌ Wrong
const userId = 'user-123';  // Will pollute real data
```

### Cleanup Pattern

```typescript
// setup.ts or test file
beforeAll(async () => {
  // Clean all test data before running
  await sql`DELETE FROM events_timescale WHERE user_id LIKE 'test-%'`;
  await sql`DELETE FROM entities WHERE user_id LIKE 'test-%'`;
  await sql`DELETE FROM entity_vectors WHERE user_id LIKE 'test-%'`;
});

afterAll(async () => {
  // Clean up after tests
  await sql`DELETE FROM events_timescale WHERE user_id LIKE 'test-%'`;
  await sql.end();  // Close connection
});
```

---

## Test Utilities

### Helper Functions

**`packages/database/src/__tests__/test-utils.ts`:**

```typescript
import crypto from 'crypto';
import { sql } from '../index.js';

// Generate test user ID with prefix
export function generateTestUserId(prefix = 'test'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// Clean all test data
export async function cleanTestData() {
  await sql`DELETE FROM events_timescale WHERE user_id LIKE 'test-%'`;
  await sql`DELETE FROM entities WHERE user_id LIKE 'test-%'`;
  await sql`DELETE FROM entity_vectors WHERE user_id LIKE 'test-%'`;
  await sql`DELETE FROM conversation_messages WHERE user_id LIKE 'test-%'`;
}

// Wait for async operations
export async function waitFor(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Create test event
export function createTestEvent(userId: string, type: string, data: any): SynapEvent {
  return {
    id: crypto.randomUUID(),
    version: 'v1',
    type,
    userId,
    data,
    source: 'api',
    timestamp: new Date(),
  };
}
```

---

## Repository Testing

### Example: EventRepository Tests

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@synap/database';
import { eventRepository } from '@synap/database';
import { generateTestUserId, createTestEvent } from './test-utils.js';

describe('EventRepository', () => {
  beforeAll(async () => {
    await sql`DELETE FROM events_timescale WHERE user_id LIKE 'test-%'`;
  });

  afterAll(async () => {
    await sql`DELETE FROM events_timescale WHERE user_id LIKE 'test-%'`;
    await sql.end();
  });

  it('should append event successfully', async () => {
    const userId = generateTestUserId();
    const event = createTestEvent(userId, 'note.created', { content: 'Test' });

    await eventRepository.append(event);

    const [stored] = await sql`
      SELECT * FROM events_timescale WHERE user_id = ${userId}
    `;

    expect(stored).toBeDefined();
    expect(stored.type).toBe('note.created');
  });

  it('should enforce user isolation', async () => {
    const user1 = generateTestUserId();
    const user2 = generateTestUserId();

    await eventRepository.append(createTestEvent(user1, 'note.created', {}));
    await eventRepository.append(createTestEvent(user2, 'note.created', {}));

    const user1Events = await sql`
      SELECT * FROM events_timescale WHERE user_id = ${user1}
    `;

    expect(user1Events.length).toBe(1);
    expect(user1Events[0].user_id).toBe(user1);
  });
});
```

---

## Service Testing (with Mocks)

### Example: VectorService with Mocked Embeddings

```typescript
import { describe, it, expect, vi } from 'vitest';
import { VectorService } from '../services/vectors.js';

// Mock AI embeddings to avoid real API calls
vi.mock('@synap/ai-embeddings', () => ({
  generateEmbedding: vi.fn(async (text: string) => {
    // Return deterministic mock based on text
    const hash = text.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return Array.from({ length: 1536 }, (_, i) => 
      Math.sin(hash + i) * 0.5 + 0.5
    );
  }),
}));

describe('VectorService', () => {
  const vectorService = new VectorService(db);

  it('should store embedding', async () => {
    const userId = generateTestUserId();
    const entityId = crypto.randomUUID();

    await vectorService.upsertEntityEmbedding({
      entityId,
      userId,
      entityType: 'note',
      title: 'Test',
      content: 'Test content',
    });

    const [stored] = await sql`
      SELECT * FROM entity_vectors WHERE entity_id = ${entityId}
    `;

    expect(stored).toBeDefined();
  });
});
```

---

## Testing Patterns

### 1. User Isolation

**Always test that users can't access each other's data:**

```typescript
it('should enforce user isolation', async () => {
  const user1 = generateTestUserId();
  const user2 = generateTestUserId();

  // Create data for both users
  await createEntityForUser(user1);
  await createEntityForUser(user2);

  // Query should only return user1's data
  const results = await service.getEntities({ userId: user1 });
  
  expect(results.every(r => r.userId === user1)).toBe(true);
});
```

### 2. Data Serialization

**Test that complex data types are handled correctly:**

```typescript
it('should serialize Date objects', async () => {
  const date = new Date('2024-01-15T10:30:00Z');
  const event = createTestEvent(userId, 'test', { date });

  await eventRepository.append(event);

  const [stored] = await sql`SELECT data FROM events WHERE id = ${event.id}`;
  expect(new Date(stored.data.date)).toEqual(date);
});
```

### 3. Edge Cases

**Always test boundaries and edge cases:**

```typescript
it('should handle empty results', async () => {
  const userId = generateTestUserId();
  const results = await service.search({ userId, query: '' });
  expect(results).toEqual([]);
});

it('should handle large data', async () => {
  const largeContent = 'A'.repeat(100_000);  // 100KB
  const event = createTestEvent(userId, 'test', { content: largeContent });
  await expect(eventRepository.append(event)).resolves.not.toThrow();
});

it('should handle special characters', async () => {
  const specialContent = "It's a test with \"quotes\" \n newlines & symbols: @#$%";
  const event = createTestEvent(userId, 'test', { content: specialContent });
  await expect(eventRepository.append(event)).resolves.not.toThrow();
});
```

### 4. Concurrent Operations

**Test concurrent writes:**

```typescript
it('should handle concurrent writes', async () => {
  const userId = generateTestUserId();
  const events = Array.from({ length: 10 }, (_, i) =>
    createTestEvent(userId, 'test', { index: i })
  );

  // Run all appends concurrently
  await Promise.all(events.map(e => eventRepository.append(e)));

  const stored = await sql`
    SELECT * FROM events WHERE user_id = ${userId}
  `;

  expect(stored.length).toBe(10);
});
```

---

## Coverage Goals

### Critical Paths (80%+ coverage)
- EventRepository
- VectorRepository  
- EntityRepository
- Core domain services

### Standard Paths (70%+ coverage)
- API routes
- Business logic
- Utilities

### Lower Priority (50%+ coverage)
- UI components
- Admin tools
- Dev utilities

---

## Best Practices

### 1. Import Test Globals Explicitly

```typescript
// ✅ Always import, even with globals: true
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
```

### 2. Use Descriptive Test Names

```typescript
// ✅ Clear what's being tested
it('should enforce user isolation in search results', async () => { /* ... */ });

// ❌ Vague
it('should work', async () => { /* ... */ });
```

### 3. One Assertion Per Test (When Possible)

```typescript
// ✅ Focused test
it('should return correct count', async () => {
  const results = await service.count({ userId });
  expect(results).toBe(5);
});

// ❌ Multiple unrelated assertions
it('should do everything', async () => {
  expect(a).toBe(1);
  expect(b).toBe(2);
  expect(c).toBe(3);
});
```

### 4. Clean Up Properly

```typescript
// ✅ Clean before and after
beforeAll(async () => await cleanTestData());
afterAll(async () => {
  await cleanTestData();
  await sql.end();  // Close connections
});
```

---

## Common Pitfalls

### ❌ Not Using test- Prefix
```typescript
const userId = 'user-123';  // ❌ Pollutes database
```

### ❌ Forgetting to Close Connections
```typescript
afterAll(async () => {
  // ❌ Missing sql.end()
  await cleanTestData();
});
```

### ❌ Testing with Real API Keys
```typescript
// ❌ Uses real OpenAI API
const embedding = await generateEmbedding(text);

// ✅ Mock it
vi.mock('@synap/ai-embeddings', () => ({ /* mock */ }));
```

### ❌ Not Cleaning Between Tests
```typescript
// ❌ Tests depend on each other
it('test 1', async () => { await create(); });
it('test 2', async () => { /* expects test 1 data */ });

// ✅ Independent tests
beforeEach(async () => await cleanTestData());
```

---

## Running Tests in CI/CD

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: synap
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
    
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3
        with:
          node-version: 20
          cache: 'pnpm'
      
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/synap
```

---

## Debugging Tests

### Enable Debug Logging

```bash
LOG_LEVEL=debug pnpm test
```

### Run Single Test

```typescript
it.only('should debug this specific test', async () => {
  // Only this test runs
});
```

### Use Console Logging

```typescript
console.log('Debug value:', result);  // Shows in test output
```

### Check Database State

```typescript
const state = await sql`SELECT * FROM table WHERE condition`;
console.log('Database state:', state);
```

---

## Resources

- **Vitest Docs:** https://vitest.dev
- **Test Examples:** `packages/database/src/__tests__/`
- **Test Utilities:** `packages/database/src/__tests__/test-utils.ts`
- **Error Report:** `error_resolution_report.md` - Common test issues

---

## Summary

**Key Takeaways:**
1. Always use `test-` prefix for test data
2. Clean up before and after tests
3. Test user isolation
4. Mock external APIs  
5. Test edge cases (empty, large, special chars)
6. Keep tests independent
7. Aim for 70%+ coverage

**Next Steps:**
1. Review existing tests as examples
2. Write tests for new features
3. Run coverage reports regularly
4. Fix failing tests immediately
