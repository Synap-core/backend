FROM node:20-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# ============================================================================
# Prepare: Prune monorepo to only what 'api' needs
# ============================================================================
FROM base AS prepare
COPY . .
RUN npx --yes turbo@^2 prune api --docker

# ============================================================================
# Builder: Install dependencies and build
# ============================================================================
FROM base AS builder

# Copy package.json files (for Docker layer caching)
COPY --from=prepare /app/out/json/ .

# Install dependencies (allow lockfile updates for pruned workspace)
RUN pnpm install --no-frozen-lockfile

# Copy source code
COPY --from=prepare /app/out/full/ .

# Copy root tsconfig (needed by packages that extend from it)
COPY tsconfig.json ./

# Build the project
RUN pnpm turbo build --filter=api

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

# Copy built artifacts and production node_modules
COPY --from=builder --chown=nodejs:nodejs /app .

# Copy configuration files needed at runtime
COPY --chown=nodejs:nodejs kratos ./kratos
COPY --chown=nodejs:nodejs hydra ./hydra
COPY --chown=nodejs:nodejs packages/database/migrations-custom ./packages/database/migrations-custom
COPY --chown=nodejs:nodejs packages/database/migrations-drizzle ./packages/database/migrations-drizzle
COPY --chown=nodejs:nodejs packages/database/drizzle.config.ts ./packages/database/drizzle.config.ts

# Expose port
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/index.js"]
