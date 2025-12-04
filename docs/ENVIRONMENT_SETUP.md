# Environment Setup Guide

## Quick Start

### 1. Local Development Setup

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your values
# At minimum, you need:
# - DATABASE_URL (already set to localhost default)
# - OPENAI_API_KEY (get from https://platform.openai.com/api-keys)

# For testing
cp .env.test .env.test.local  # Optional: override test defaults
```

### 2. Start Development Services

```bash
# Start Docker services (PostgreSQL, Redis, MinIO, Ory)
docker compose up -d

# Run migrations
pnpm db:migrate

# Start development server
pnpm dev
```

## Environment Files

| File | Purpose | Git Tracked | Auto-Loaded |
|------|---------|-------------|-------------|
| `.env.example` | Template with all variables | ✅ Yes | ❌ No |
| `.env` | Your local development config | ❌ No (.gitignored) | ✅ Yes (runtime) |
| `.env.test` | Test environment defaults | ✅ Yes | ✅ Yes (vitest) |
| `.env.test.local` | Your test overrides | ❌ No (.gitignored) | ✅ Yes (vitest) |

## Required Environment Variables

### Minimal Setup (Local Dev)

```bash
# .env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/synap
OPENAI_API_KEY=sk-your-key-here
```

### Full Setup (All Features)

See `.env.example` for complete list with documentation.

## Testing

Tests automatically load `.env.test` via vitest configuration.

### Test Isolation Strategy

**Convention-Based:** All test data uses `test-*` user IDs

```typescript
// Test code
const userId = `test-${crypto.randomUUID().slice(0, 8)}`;
```

**Cleanup:** Glob pattern deletes all `test-*` data

```sql
DELETE FROM events_timescale WHERE user_id LIKE 'test-%';
```

### Running Tests

```bash
# All tests (uses .env.test automatically)
pnpm test

# Specific package
pnpm --filter @synap/database test

# With coverage
pnpm test:coverage
```

### Test Environment Variables

Loaded in this order (later overrides earlier):
1. `.env.test` (shared defaults)
2. `.env.test.local` (your overrides)
3. `vitest.config.ts` env section (hardcoded fallbacks)

## Docker Integration

Environment variables are shared between:
- Local Node.js processes (via `.env`)
- Docker containers (via `docker compose.yml` `env_file`)

### Update docker compose.yml

```yaml
services:
  api:
    env_file:
      - .env  # Load from .env file
    environment:
      # Override specific vars if needed
      NODE_ENV: development
```

## CI/CD Environment

For GitHub Actions / CI pipelines:

```yaml
# .github/workflows/test.yml
env:
  DATABASE_URL: postgresql://postgres:postgres@localhost:5432/test_db
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  NODE_ENV: test
```

## Troubleshooting

### "DATABASE_URL is required" Error

**Problem:** Tests fail with config validation error

**Solution:**
1. Ensure `.env.test` exists
2. Check `vitest.config.ts` has `env` section
3. Verify DATABASE_URL is set in `.env`

### "Invalid API Key" in Tests

**For Unit Tests:** Use mock embeddings
```typescript
// vitest.config.ts
env: {
  USE_MOCK_EMBEDDINGS: 'true',
}
```

**For Integration Tests:** Use real API key in `.env.test.local`
```bash
# .env.test.local
OPENAI_API_KEY=sk-your-real-test-key
```

### Environment Not Loading

**Check Load Order:**
```bash
# Debug: Print loaded env
node -e "require('dotenv').config(); console.log(process.env.DATABASE_URL)"
```

## Best Practices

### ✅ DO

- Keep `.env.example` up-to-date with all variables
- Use sensible defaults in `.env.example`
- Document each variable with comments
- Use `.env.test` for safe test defaults
- Commit `.env.example` and `.env.test`

### ❌ DON'T

- Commit `.env` or `.env.local` (contains secrets)
- Put hardcoded secrets in code
- Use production credentials in tests
- Skip documentation in `.env.example`

## Security

### Secrets Management

**Local Development:**
- Store in `.env` (gitignored)
- Never commit to git

**Production:**
- Use environment variables from hosting platform
- Or use secret management (AWS Secrets Manager, etc.)

### API Keys

**Development:**
- Use separate API keys for dev/test/prod
- Set rate limits on dev keys
- Rotate regularly

**Testing:**
- Mock external APIs when possible
- Use test/sandbox API keys
- Never use production keys in tests
