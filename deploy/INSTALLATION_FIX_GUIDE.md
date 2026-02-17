# Installation Fix Guide: Backend ↔ Intelligence Hub Integration

## Overview

This guide documents the fixes needed to properly install and configure the Synap backend and intelligence hub so they work together correctly.

## Architecture

```
Multiple Backends (one per user)  →  Single Intelligence Hub
   Backend A (user1)  ──┐
   Backend B (user2)  ──┼──→ Intelligence Hub (shared)
   Backend C (user3)  ──┘
```

Each backend gets a unique API key to authenticate with the shared intelligence hub.

---

## Critical Issues Fixed

### 1. ✅ API Key Seeding (CRITICAL)

**Problem:** API keys were in `.env` but never seeded into the database.
**Solution:** Created `/packages/database/scripts/init-hub-keys.ts` to seed keys after migrations.

### 2. ✅ Document Sessions Migration (HIGH)

**Problem:** `document_sessions` table missing required columns (`chat_thread_id`, `is_active`, etc.)
**Solution:** Created migration `/packages/database/migrations-drizzle/0031_add_document_sessions_columns.sql`

### 3. ✅ Embeddings Route Not Mounted (CRITICAL)

**Problem:** `/api/embeddings` returned 404 — backend couldn't generate vector embeddings
**Solution:** Created `/apps/intelligence-hub/src/routes/embeddings-router.ts` and mounted in `index.ts`

### 4. Missing Environment Variables (CRITICAL)

**Problem:** Intelligence hub missing:

- `OPENROUTER_API_KEY` (all AI calls fail)
- `DATA_POD_URL` (thread context loading fails)

Backend missing:

- `PUBLIC_URL` (intelligence hub gets wrong callback URL)
- `HUB_PROTOCOL_API_KEY` (not prompted during install)

**Solution:** See updated synap CLI files below.

---

## Installation Steps (New Process)

### Step 1: Install Intelligence Hub FIRST

```bash
cd /opt/intelligence-hub/deploy
./synap install

# It will prompt for:
# - Port (default: 3001)
# - Deployment mode (standalone/integrated)
# - Hub API Key (auto-generated if empty)
# - OpenRouter API Key (REQUIRED - NEW)
# - OpenAI API Key (optional)
# - Anthropic API Key (optional)
# - Google AI API Key (optional)
```

**Save the generated `HUB_PROTOCOL_API_KEY` - you'll need it for each backend!**

---

### Step 2: Install Backend(s)

```bash
cd /opt/synap-backend
./synap install

# It will prompt for:
# - Domain (e.g., backend.synap.live)
# - Email (for SSL)
# - OpenAI API Key (REQUIRED)
# - Anthropic API Key (optional)
# - Intelligence Hub URL (e.g., http://46.224.230.35:3001)
# - Intelligence Hub API Key (the key from Step 1)
```

The backend will automatically:

1. Run migrations
2. Seed the API key into the database
3. Start all services

---

## Docker Compose Changes Needed

### Backend: `deploy/docker-compose.yml`

Add a new service to run after migrations:

```yaml
# Database initialization (runs after migrations)
backend-init:
  image: ghcr.io/${GITHUB_REPOSITORY:-synap-core/backend}:${BACKEND_VERSION:-latest}
  build:
    context: ..
    dockerfile: deploy/Dockerfile.api
  environment:
    DATABASE_URL: postgresql://synap:${POSTGRES_PASSWORD}@postgres:5432/synap
    HUB_PROTOCOL_API_KEY: ${HUB_PROTOCOL_API_KEY}
    HUB_PROTOCOL_API_KEYS: ${HUB_PROTOCOL_API_KEYS:-}
  command: node node_modules/@synap/database/dist/scripts/init-hub-keys.js
  deploy:
    restart_policy:
      condition: on-failure
      max_attempts: 3
  depends_on:
    backend-migrate:
      condition: service_completed_successfully
  networks:
    - synap-net
```

### Intelligence Hub: `deploy/.env` Template

Update the install script to prompt for and include:

```bash
NODE_ENV=production
INTELLIGENCE_HUB_PORT=3001
HUB_PROTOCOL_API_KEY=<generated>

# AI Providers (at least ONE required)
OPENROUTER_API_KEY=<user-provided>  # NEW - REQUIRED
OPENAI_API_KEY=<user-provided>      # Optional
ANTHROPIC_API_KEY=<user-provided>   # Optional
GOOGLE_AI_API_KEY=<user-provided>   # Optional

# Backend Connection (optional - used by chat-stream route)
DATA_POD_URL=<optional>
```

---

## Synap CLI Updates Needed

### Intelligence Hub CLI: `deploy/synap`

Add to the install function (around line 190):

```bash
# OpenRouter Key (REQUIRED for AI)
if [ -z "$OPENROUTER_KEY" ]; then
    read -p "OpenRouter API Key (REQUIRED): " OPENROUTER_KEY
    while [ -z "$OPENROUTER_KEY" ]; do
        echo -e "${RED}OpenRouter API key is required for AI features${NC}"
        read -p "OpenRouter API Key: " OPENROUTER_KEY
    done
fi
```

Update the `.env` generation (line 216):

```bash
cat > .env <<EOF
# Synap Intelligence Configuration
# Generated: $(date)
COMPOSE_PROJECT_NAME=synap-intelligence
NODE_ENV=production
INTELLIGENCE_HUB_PORT=${PORT}
HUB_PROTOCOL_API_KEY=${HUB_KEY}
DOMAIN=${DOMAIN}
LETSENCRYPT_EMAIL=${EMAIL}
OPENROUTER_API_KEY=${OPENROUTER_KEY}
OPENAI_API_KEY=${OPENAI_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
GOOGLE_AI_API_KEY=${GOOGLE_KEY}
DATA_POD_URL=${DATA_POD_URL:-}
EOF
```

### Backend CLI: `/synap`

Update the prompts (around line 450-500) to include:

```bash
# Intelligence Hub Connection (REQUIRED)
if [ -z "$INTELLIGENCE_URL" ]; then
    read -p "Intelligence Hub URL (e.g., http://46.224.230.35:3001): " INTELLIGENCE_URL
    while [ -z "$INTELLIGENCE_URL" ]; do
        echo -e "${RED}Intelligence Hub URL is required${NC}"
        read -p "Intelligence Hub URL: " INTELLIGENCE_URL
    done
fi

if [ -z "$INTELLIGENCE_KEY" ]; then
    read -p "Intelligence Hub API Key (from hub install): " INTELLIGENCE_KEY
    while [ -z "$INTELLIGENCE_KEY" ]; do
        echo -e "${RED}Intelligence Hub API Key is required${NC}"
        read -p "Intelligence Hub API Key: " INTELLIGENCE_KEY
    done
fi

# OpenAI Key (REQUIRED)
if [ -z "$OPENAI_API_KEY" ]; then
    read -p "OpenAI API Key (REQUIRED for embeddings): " OPENAI_API_KEY
    while [ -z "$OPENAI_API_KEY" ]; do
        echo -e "${RED}OpenAI API key is required for embeddings and vector search${NC}"
        read -p "OpenAI API Key: " OPENAI_API_KEY
    done
fi
```

Update `.env` generation (around line 100-115):

```bash
# Intelligence Service
INTELLIGENCE_HUB_URL=${intelligence_url}
INTELLIGENCE_HUB_API_KEY=${intelligence_key}

# PUBLIC_URL (for callbacks from intelligence hub)
PUBLIC_URL=https://${domain}

# AI Provider API Keys
OPENAI_API_KEY=${openai_key}
ANTHROPIC_API_KEY=${anthropic_key}
GOOGLE_AI_API_KEY=${google_key}
```

---

## Multi-Backend Support

To support multiple backends with one intelligence hub, use the `HUB_PROTOCOL_API_KEYS` format:

### Backend A `.env`:

```bash
HUB_PROTOCOL_API_KEY=synap_hub_live_abc123
```

### Backend B `.env`:

```bash
HUB_PROTOCOL_API_KEY=synap_hub_live_def456
```

### Backend C `.env`:

```bash
HUB_PROTOCOL_API_KEY=synap_hub_live_ghi789
```

Each backend runs the `backend-init` service which seeds its own key into the database.

---

## Testing the Fix

### 1. Test API Key in Database

```bash
docker exec synap-backend-postgres-1 psql -U synap -d synap -c \
  "SELECT id, key_name, hub_id, scope, is_active FROM api_keys WHERE key_name LIKE '%Hub%';"
```

Expected: At least one row with `hub-protocol.read` and `hub-protocol.write` scopes.

### 2. Test Intelligence Hub Endpoint

```bash
curl -X POST http://<hub-host>:3001/api/embeddings \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <HUB_PROTOCOL_API_KEY>" \
  -d '{"text":"test"}'
```

Expected: JSON with `embedding` array (1536 dimensions).

### 3. Test Backend Hub Protocol

```bash
curl -s "https://backend.synap.live/api/hub/health"
```

Expected: `{"status":"ok","service":"hub-protocol"}`

```bash
curl -s "https://backend.synap.live/api/hub/search?userId=<uuid>&query=test" \
  -H "Authorization: Bearer <HUB_PROTOCOL_API_KEY>"
```

Expected: Search results (not "Invalid or expired API key").

### 4. Test End-to-End AI Call

```bash
curl -X POST http://<hub-host>:3001/api/expertise/request \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <HUB_PROTOCOL_API_KEY>" \
  -d '{
    "query":"hello",
    "userId":"<real-uuid>",
    "dataPodUrl":"https://backend.synap.live",
    "dataPodApiKey":"<HUB_PROTOCOL_API_KEY>"
  }'
```

Expected: JSON with AI response content (not "OpenRouter API key is missing").

---

## Migration Path (Existing Installations)

If you already have backend and intelligence hub running:

### 1. Update Intelligence Hub

```bash
cd /opt/intelligence-hub/deploy

# Add OPENROUTER_API_KEY to .env
echo "OPENROUTER_API_KEY=sk-or-v1-..." >> .env

# Rebuild and restart
./synap update
```

### 2. Update Backend

```bash
cd /opt/synap-backend

# Add PUBLIC_URL to .env
echo "PUBLIC_URL=https://backend.synap.live" >> deploy/.env

# Copy the new init script
# (from /opt/synap-backend/packages/database/scripts/init-hub-keys.ts)

# Build the database package
cd packages/database
pnpm build

# Run the init script manually
cd /opt/synap-backend/deploy
export $(cat .env | xargs)
node ../packages/database/dist/scripts/init-hub-keys.js

# Restart services
./synap restart
```

### 3. Run Document Sessions Migration

```bash
cd /opt/synap-backend
# Copy migration file to migrations-drizzle/
# Run migrations
docker exec synap-backend-backend-1 node node_modules/@synap/database/dist/scripts/migrate.js
```

---

## Summary Checklist

- [x] Created `init-hub-keys.ts` script
- [x] Created document_sessions migration
- [x] Created embeddings router
- [x] Mounted embeddings route in index.ts
- [ ] Update backend docker-compose.yml (add backend-init service)
- [ ] Update backend synap CLI (prompt for all required env vars)
- [ ] Update intelligence-hub synap CLI (prompt for OPENROUTER_API_KEY)
- [ ] Test on a fresh installation
- [ ] Update READMEs with new installation flow

---

**Next Steps:** Apply the docker-compose and CLI updates, then test the full installation flow on a clean server.
