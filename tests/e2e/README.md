# E2E Testing Guide

## Overview

This directory contains end-to-end tests for the Synap backend, designed to test critical flows **without requiring a frontend**.

## Test Suites

### 1. Validation Flows (`validation-flows.test.ts`)
Tests the global validator and proposal system:
- ✅ User-initiated entity creation (auto-approve)
- ✅ AI-initiated creation requiring approval
- ✅ AI auto-approve when enabled
- ✅ Permission denial for non-editors
- ✅ Mixed user/AI scenarios

### 2. Hub Protocol (`hub-protocol-e2e.test.ts`)
Tests external intelligence service integration:
- ✅ Token generation with scopes
- ✅ Data querying with access control
- ✅ Entity creation via Hub Protocol
- ✅ Proposal flow triggering
- ✅ Complete intelligence service workflow

### 3. Core Flows (`core-flows.test.ts`)
Tests basic system functionality:
- ✅ Complete conversation flow
- ✅ Event-driven processing
- ✅ Security isolation between users

## Running Tests

### Prerequisites
```bash
# Start required services
docker compose up -d postgres minio

# Run database migrations
pnpm --filter database db:migrate

# Start API server in another terminal
pnpm --filter api dev
```

### Run All E2E Tests
```bash
pnpm test:e2e
```

### Run Specific Test Suite
```bash
pnpm test:e2e validation-flows
pnpm test:e2e hub-protocol
```

### Watch Mode
```bash
pnpm test:e2e:watch
```

### With Coverage
```bash
pnpm test:e2e -- --coverage
```

## Test Architecture

### Test Harness (`test-harness.ts`)
Provides utilities for testing:
- **createTestClient**: tRPC client factory with authentication
- **EventStreamListener**: SSE event monitoring for real-time assertions
- **InngestEventSpy**: Inngest event tracking
- **DatabaseTestHelpers**: Direct DB queries for assertions
- **testDataFactory**: Factory functions for test data
- **retryUntil**: Helper for eventually consistent operations

### Setup (`setup.ts`)
Handles test environment initialization:
- Database setup (test database or in-memory)
- Test user creation
- API server verification
- Global setup/teardown hooks

## Writing New Tests

### Example Test Structure
```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { setupTestEnvironment } from "./setup.js";
import {
  createTestClient,
  testDataFactory,
  DatabaseTestHelpers,
  wait,
} from "./test-harness.js";

describe("My Feature", () => {
  let testEnv, client, dbHelpers;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    client = createTestClient(testEnv.apiUrl, testEnv.users.userA);
    dbHelpers = new DatabaseTestHelpers(db);
  });

  it("should do something", async () => {
    const result = await client.client.myFeature.myMethod.mutate({
      ...testDataFactory.entity("note"),
    });

    await wait(2000); // Wait for workers

    const exists = await dbHelpers.hasEntity(result.id);
    expect(exists).toBe(true);
  }, 20000);
});
```

### Best Practices

1. **Wait for Workers**: Inngest processing is async, use `wait()` or `retryUntil()`
2. **Clean Up**: Use `dbHelpers.cleanup()` in `afterAll`
3. **Timeout**: Set appropriate timeouts for E2E tests (20-45s)
4. **Isolation**: Each test creates own workspace
5. **Assertions**: Verify both API response AND database state

## Environment Variables

```bash
# Test database (optional, defaults to main DB)
TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/synap_test

# API server URL (optional, defaults to localhost:3000)
TEST_API_URL=http://localhost:3000

# Test mode
NODE_ENV=test
```

## Troubleshooting

### Tests Timing Out
- Ensure API server is running
- Check Inngest is processing events
- Increase test timeout if needed

### Database Errors
- Verify migrations are applied
- Check DATABASE_URL is correct
- Ensure test database exists

### Permission Errors
- Verify test users are created
- Check workspace membership
- Confirm API keys are valid

## CI/CD Integration

These tests are designed to run in CI/CD:

```yaml
# .github/workflows/ci.yml
- name: E2E Tests
  run: |
    docker compose up -d
    pnpm db:migrate
    pnpm test:e2e
  env:
    DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
```

## Performance Targets

- **User entity creation**: < 5s (request → validated → DB)
- **AI proposal creation**: < 5s (request → proposal in DB)
- **Hub Protocol flow**: < 10s (token → query → create)
- **Bulk operations** (5 entities): < 15s

## Next Steps

- [ ] Add metrics collection during tests
- [ ] Implement chaos testing (random failures)
- [ ] Add load testing scenarios
- [ ] Set up test result reporting dashboard
