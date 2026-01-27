FROM node:20-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# ============================================================================
# Builder: Install dependencies and build
# ============================================================================
FROM base AS builder

# Copy all files for build
COPY . .

# Install all dependencies (including dev deps for building)
RUN pnpm install --frozen-lockfile

# Build the project using Turborepo
RUN pnpm turbo build --filter=api

# Deploy to self-contained directory with hard-linked dependencies
# This creates a portable, production-ready package
RUN pnpm deploy --filter=api --prod --legacy /app/deploy

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
COPY --chown=nodejs:nodejs packages/database/migrations-custom ./packages/database/migrations-custom
COPY --chown=nodejs:nodejs packages/database/migrations-drizzle ./packages/database/migrations-drizzle
COPY --chown=nodejs:nodejs packages/database/drizzle.config.ts ./packages/database/drizzle.config.ts

# Expose port
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/index.js"]
