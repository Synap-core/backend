# E2E Tests - Synap Backend

End-to-end tests for validating critical flows in the Synap ecosystem.

## Overview

These tests validate:
1. **Complete Conversation Flow** - User sends message → AI responds → Action executed
2. **Event-Driven Flow** - Event published → Worker processes → Entity created
3. **Hub Protocol Flow** - Token generation → Data request → Insight submission
4. **Security Isolation** - User A cannot access User B's data

## Prerequisites

### Environment Setup

1. **Database**: PostgreSQL (via Docker Compose) or SQLite
2. **Services**: 
   - API server (started automatically by tests)
   - PostgreSQL (if using PostgreSQL mode)
   - MinIO (for storage)
   - Ory Kratos + Hydra (if using PostgreSQL mode)

### Environment Variables

Create a `.env.test` file or set these variables:

```bash
# Database
DATABASE_URL=postgresql://postgres:synap_dev_password@localhost:5432/synap_test
# OR for SQLite:
DB_DIALECT=sqlite
SQLITE_DB_PATH=:memory:

# Auth (for PostgreSQL)
KRATOS_PUBLIC_URL=http://localhost:4433
KRATOS_ADMIN_URL=http://localhost:4434
HYDRA_PUBLIC_URL=http://localhost:4444
HYDRA_ADMIN_URL=http://localhost:4445

# Auth (for SQLite)
SYNAP_SECRET_TOKEN=test-token-here

# AI (optional, for conversation tests)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...

# Inngest (optional)
INNGEST_EVENT_KEY=test-key
```

## Running Tests

### Run All E2E Tests

```bash
pnpm test:e2e
```

### Run in Watch Mode

```bash
pnpm test:e2e:watch
```

### Run Specific Test File

```bash
pnpm test:e2e tests/e2e/core-flows.test.ts
```

## Test Structure

```
tests/e2e/
├── setup.ts              # Test environment setup
├── vitest.config.ts      # Vitest configuration
├── core-flows.test.ts    # Core flow tests
└── README.md            # This file
```

## Test Environment

The test setup (`setup.ts`) automatically:
1. Initializes test database (PostgreSQL or SQLite)
2. Applies migrations
3. Starts API server on a random port
4. Creates test users (User A and User B)
5. Logs in users and gets session cookies
6. Creates API keys for Hub Protocol testing

## Performance Benchmarks

Tests include performance assertions:
- **Conversation Flow**: < 10 seconds
- **Event-Driven Flow**: < 10 seconds
- **Hub Protocol Flow**: < 5 seconds
- **Security Isolation**: < 15 seconds

## Troubleshooting

### Tests Timeout

- Check that all services are running (PostgreSQL, MinIO, Ory)
- Verify environment variables are set correctly
- Check API server logs for errors

### Database Connection Errors

- Ensure PostgreSQL is running: `docker compose ps`
- Check DATABASE_URL is correct
- Verify migrations have been applied

### Authentication Errors

- For PostgreSQL: Ensure Ory Kratos is running
- For SQLite: Ensure SYNAP_SECRET_TOKEN is set
- Check session cookies are being set correctly

### API Server Not Starting

- Check port conflicts (tests use random ports)
- Verify all dependencies are installed
- Check for build errors: `pnpm build`

## Adding New Tests

1. Create a new test file in `tests/e2e/`
2. Import `setupTestEnvironment` from `./setup.ts`
3. Use `testEnv` to access API URL and test users
4. Follow existing test patterns

Example:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestEnvironment } from './setup.js';

describe('My New Test', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
  });

  it('should test something', async () => {
    const { apiUrl, users } = testEnv;
    // Your test here
  });
});
```

## CI/CD Integration

These tests are designed to run in CI/CD pipelines:

```yaml
# Example GitHub Actions
- name: Run E2E Tests
  run: |
    docker compose up -d
    pnpm test:e2e
  env:
    DATABASE_URL: postgresql://postgres:password@localhost:5432/synap_test
```

## Notes

- Tests use a separate test database to avoid affecting development data
- API server starts on a random port to avoid conflicts
- Test users are created fresh for each test run
- Cleanup happens automatically after tests complete

