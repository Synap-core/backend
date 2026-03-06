FROM node:20-alpine AS base
RUN npm install -g pnpm@10.28.0
WORKDIR /app

# ============================================================================
# Builder: Install dependencies and build both services
# ============================================================================
FROM base AS builder

# Build tools for native addons
RUN apk add --no-cache python3 make g++

COPY . .

RUN pnpm install --no-frozen-lockfile

# Build API + realtime in one turbo pass
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm turbo build \
      --filter=api \
      --filter=@synap/realtime \
      --concurrency=1

# Build provision-agent script (standalone tsup bundle)
RUN cd /app/packages/api && npx tsup --config tsup.provision.config.ts

# Build admin-ui SPA
RUN cd apps/admin-ui && npx vite build

# Deploy each service to its own self-contained directory
RUN pnpm deploy --filter=api --prod --legacy /app/deploy/api
RUN pnpm deploy --filter=@synap/realtime --prod --legacy /app/deploy/realtime

# Prepare custom migrations
RUN mkdir -p /app/migrations-custom-temp && \
  if [ -d "/app/packages/database/migrations-custom" ] && \
     [ -n "$(ls -A /app/packages/database/migrations-custom/*.sql 2>/dev/null)" ]; then \
    cp /app/packages/database/migrations-custom/*.sql /app/migrations-custom-temp/; \
  fi

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

# Drizzle + custom migrations (used by backend-migrate service)
COPY --from=builder --chown=nodejs:nodejs /app/packages/database/migrations-drizzle/*.sql ./api/migrations-drizzle/
COPY --from=builder --chown=nodejs:nodejs /app/migrations-custom-temp/ ./api/migrations-custom/

# Provision-agent script
COPY --from=builder --chown=nodejs:nodejs /app/packages/api/dist/scripts ./api/dist/scripts/

# Admin UI static build
COPY --from=builder --chown=nodejs:nodejs /app/apps/admin-ui/dist ./api/admin-ui/

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
