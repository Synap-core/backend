FROM node:20-alpine AS base
RUN npm install -g pnpm@10.28.0
WORKDIR /app

# ============================================================================
# Builder: Install dependencies and build both services
# ============================================================================
FROM base AS builder

# Build tools for native addons
RUN apk add --no-cache python3 make g++

# ── Layer 1: dependency manifests (cached unless lockfile or package.json changes) ──
# Copy workspace config and all package.json files BEFORE source code.
# This layer is only invalidated when dependencies change, not on every commit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json      ./apps/api/
COPY packages/ai-embeddings/package.json ./packages/ai-embeddings/
COPY packages/ai/package.json            ./packages/ai/
COPY packages/api-types/package.json     ./packages/api-types/
COPY packages/api/package.json           ./packages/api/
COPY packages/auth/package.json          ./packages/auth/
COPY packages/core/package.json          ./packages/core/
COPY packages/database/package.json      ./packages/database/
COPY packages/events/package.json        ./packages/events/
COPY packages/feed-service/package.json  ./packages/feed-service/
COPY packages/hub-protocol/package.json  ./packages/hub-protocol/
COPY packages/intelligence-client/package.json ./packages/intelligence-client/
COPY packages/jobs/package.json          ./packages/jobs/
COPY packages/realtime/package.json      ./packages/realtime/
COPY packages/scripts/package.json       ./packages/scripts/
COPY packages/search/package.json        ./packages/search/
COPY packages/shared-utils/package.json  ./packages/shared-utils/
COPY packages/storage/package.json       ./packages/storage/
COPY packages/test-e2e/package.json      ./packages/test-e2e/
COPY packages/types/package.json         ./packages/types/

# Install all dependencies — pnpm store is cached across builds
RUN --mount=type=cache,id=pnpm-backend,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Layer 2: source + build (re-runs on every source change) ──
COPY . .

# Build API + realtime in one turbo pass (no persistent cache — prevents stale build artifacts)
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm turbo build \
      --filter=api \
      --filter=@synap/realtime \
      --concurrency=1

# Build provision-agent script (standalone tsup bundle)
RUN cd /app/packages/api && npx tsup --config tsup.provision.config.ts

# Deploy each service to its own self-contained directory
RUN pnpm deploy --filter=api --prod --legacy /app/deploy/api
RUN pnpm deploy --filter=@synap/realtime --prod --legacy /app/deploy/realtime


# ============================================================================
# Runner: Single image, both entry points included
# ============================================================================
FROM node:20-alpine AS runner

RUN apk add --no-cache postgresql-client dumb-init

RUN addgroup -g 10001 -S nodejs && \
    adduser -S nodejs -u 10001

WORKDIR /app
USER nodejs

# API service files
COPY --from=builder --chown=nodejs:nodejs /app/deploy/api ./api/

# Realtime service files
COPY --from=builder --chown=nodejs:nodejs /app/deploy/realtime ./realtime/

# Config files (API needs these at runtime)
COPY --chown=nodejs:nodejs kratos ./api/kratos
COPY --chown=nodejs:nodejs hydra ./api/hydra

# Migrations (used by backend-migrate service)
COPY --from=builder --chown=nodejs:nodejs /app/packages/database/migrations/*.sql ./api/migrations/

# Provision-agent script
COPY --from=builder --chown=nodejs:nodejs /app/packages/api/dist/scripts ./api/dist/scripts/

# Shameful hoist for API node_modules (pnpm deploy --legacy doesn't create top-level symlinks)
USER root
RUN pnpm_dir=/app/api/node_modules/.pnpm; \
    ls "$pnpm_dir" | while read entry; do \
      if echo "$entry" | grep -q "^@"; then \
        scope_part=$(echo "$entry" | sed 's/+[^@]*@.*//'); \
        name_part=$(echo "$entry" | sed 's/^[^+]*+//' | sed 's/@.*//'); \
        pkg_path="$scope_part/$name_part"; \
      else \
        pkg_path=$(echo "$entry" | sed 's/@.*//'); \
      fi; \
      target="/app/api/node_modules/$pkg_path"; \
      src="$pnpm_dir/$entry/node_modules/$pkg_path"; \
      if [ ! -e "$target" ] && [ -d "$src" ]; then \
        mkdir -p "$(dirname "$target")" && ln -snf "$src" "$target"; \
      fi; \
    done
USER nodejs

# Default entry point: API (docker-compose overrides CMD for realtime)
WORKDIR /app/api
EXPOSE 4000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
