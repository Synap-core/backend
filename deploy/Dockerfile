# ============================================================================
# LEGACY DOCKERFILE - Combined API + Realtime (for backward compatibility)
# ============================================================================
# NOTE: This file is kept for backward compatibility and fallback scenarios.
# For new deployments, use separate Dockerfiles:
#   - Dockerfile.api (API service)
#   - Dockerfile.realtime (Realtime service)
# ============================================================================

FROM node:20-alpine AS base
RUN npm install -g pnpm@10.28.0
WORKDIR /app

# ============================================================================
# Builder: Install dependencies and build
# ============================================================================
FROM base AS builder

# Copy all files for build
COPY . .

# Install all dependencies (including dev deps for building)
RUN pnpm install --frozen-lockfile || (sleep 5 && pnpm install --frozen-lockfile) || (sleep 10 && pnpm install --frozen-lockfile)

# Build the project using Turborepo
RUN pnpm turbo build --filter=api --filter=@synap/realtime

# Build admin-ui SPA
RUN cd apps/admin-ui && npx vite build

# Build migration script independently
RUN cd packages/database && pnpm build:migrate

# Best Practice: Copy built packages and use pnpm install --prod
# This is the standard approach - let pnpm resolve all dependencies
RUN rm -rf /app/deploy && mkdir -p /app/deploy

# Copy built packages to workspace structure
RUN mkdir -p /app/deploy/packages/api /app/deploy/packages/realtime && \
    cp -r /app/packages/api/dist /app/deploy/packages/api/dist && \
    cp /app/packages/api/package.json /app/deploy/packages/api/package.json && \
    cp -r /app/packages/realtime/dist /app/deploy/packages/realtime/dist && \
    cp /app/packages/realtime/package.json /app/deploy/packages/realtime/package.json

# Copy workspace packages they depend on
RUN mkdir -p /app/deploy/packages && \
    cp -r /app/packages/database /app/deploy/packages/ && \
    cp -r /app/packages/storage /app/deploy/packages/ && \
    cp -r /app/packages/core /app/deploy/packages/ && \
    cp -r /app/packages/auth /app/deploy/packages/ && \
    cp -r /app/packages/events /app/deploy/packages/ && \
    cp -r /app/packages/jobs /app/deploy/packages/ && \
    cp -r /app/packages/search /app/deploy/packages/ 2>/dev/null || true

# Copy workspace config and lockfile
RUN cp /app/pnpm-workspace.yaml /app/deploy/pnpm-workspace.yaml && \
    cp /app/pnpm-lock.yaml /app/deploy/pnpm-lock.yaml && \
    echo '{"name":"synap-backend-deploy","private":true,"dependencies":{"@synap/api":"workspace:*","@synap/realtime":"workspace:*"}}' > /app/deploy/package.json

# Let pnpm install production dependencies (resolves everything automatically)
RUN cd /app/deploy && pnpm install --prod --frozen-lockfile --legacy

# Move API dist to root (where CMD expects it)
RUN cp -r /app/deploy/packages/api/dist/* /app/deploy/dist/ 2>/dev/null || \
    cp -r /app/deploy/node_modules/@synap/api/dist/* /app/deploy/dist/ 2>/dev/null || true

# Prepare custom migrations directory (optional - only if migrations-custom exists)
RUN mkdir -p /app/migrations-custom-temp && \
    if [ -d "/app/packages/database/migrations-custom" ] && [ -n "$(ls -A /app/packages/database/migrations-custom/*.sql 2>/dev/null)" ]; then \
      cp /app/packages/database/migrations-custom/*.sql /app/migrations-custom-temp/; \
    fi

# ============================================================================
# Runner: Minimal production image
# ============================================================================
FROM node:20-alpine AS runner

# Install runtime dependencies
RUN apk add --no-cache postgresql-client dumb-init

# Create non-root user
RUN addgroup -g 10001 -S nodejs && \
  adduser -S nodejs -u 10001

WORKDIR /app
USER nodejs

# Copy self-contained deployment (includes hard-linked node_modules)
COPY --from=builder --chown=nodejs:nodejs /app/deploy .

# Copy configuration files needed at runtime
COPY --chown=nodejs:nodejs kratos ./kratos
COPY --chown=nodejs:nodejs hydra ./hydra

# Copy migration script (compiled from builder)
COPY --from=builder --chown=nodejs:nodejs /app/packages/database/dist/scripts ./node_modules/@synap/database/dist/scripts

# Copy migrations to primary location (checked first by migration script)
# Exclude .bak files (backup files should not be migrated)
COPY --chown=nodejs:nodejs packages/database/migrations-drizzle/*.sql ./migrations-drizzle/

# Copy admin-ui static build
COPY --from=builder --chown=nodejs:nodejs /app/apps/admin-ui/dist ./admin-ui/

# Copy custom migrations (optional - prepared in builder stage)
# The migration script (scripts/migrate.ts) gracefully handles:
#   - Missing directory: logs "No custom migrations directory found, skipping..." and continues
#   - Empty directory: logs "No custom migrations found, skipping..." and continues
#   - Existing migrations: applies them in alphabetical order
# Directory is prepared in builder stage (always exists, may be empty)
COPY --from=builder --chown=nodejs:nodejs /app/migrations-custom-temp/ ./migrations-custom/

# Expose ports
EXPOSE 3000 4001

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
# pnpm deploy puts the package files directly in the deploy directory
CMD ["node", "dist/index.js"]
