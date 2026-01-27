# syntax=docker/dockerfile:1.4

# Build arguments
ARG NODE_VERSION=20
ARG PNPM_VERSION=10.28.0

# ============================================================================
# Base stage with pnpm
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS base
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ============================================================================
# Dependencies stage - install all dependencies
# ============================================================================
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .npmrc ./
COPY turbo.json ./
COPY packages/*/package.json ./packages/
COPY apps/*/package.json ./apps/

# Use BuildKit cache mount for pnpm store (install all deps including dev for build)
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile

# ============================================================================
# Build stage - compile TypeScript
# ============================================================================
FROM deps AS build
COPY . .

# Verify node_modules are accessible and rebuild if needed
# pnpm workspaces create symlinks that may not survive COPY
RUN ls -la /app/node_modules/@types/node || (echo "node_modules missing, reinstalling..." && pnpm install --frozen-lockfile)

RUN pnpm exec turbo run build --filter=api

# ============================================================================
# Production dependencies - install only prod deps
# ============================================================================
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .npmrc ./
COPY turbo.json ./
COPY packages/*/package.json ./packages/
COPY apps/*/package.json ./apps/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --prod

# ============================================================================
# Runtime stage - final production image
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS runtime

# Install runtime dependencies
RUN apk add --no-cache \
  postgresql-client \
  dumb-init \
  && rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 10001 -S nodejs && \
  adduser -S nodejs -u 10001

WORKDIR /app

# Copy production dependencies
COPY --from=prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=prod-deps --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=prod-deps --chown=nodejs:nodejs /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Copy built files
COPY --from=build --chown=nodejs:nodejs /app/packages ./packages
COPY --from=build --chown=nodejs:nodejs /app/apps ./apps

# Copy configuration files (needed for Ory and migrations)
COPY --chown=nodejs:nodejs kratos ./kratos
COPY --chown=nodejs:nodejs hydra ./hydra
COPY --chown=nodejs:nodejs packages/database/migrations-custom ./packages/database/migrations-custom
COPY --chown=nodejs:nodejs packages/database/migrations-drizzle ./packages/database/migrations-drizzle
COPY --chown=nodejs:nodejs packages/database/drizzle.config.ts ./packages/database/drizzle.config.ts

# Switch to non-root user
USER nodejs

# Expose API port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Use dumb-init to handle signals properly
CMD ["dumb-init", "node", "apps/api/dist/index.js"]
