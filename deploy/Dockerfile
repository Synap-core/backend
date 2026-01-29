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

# Build migration script independently
RUN cd packages/database && pnpm build:migrate

# Deploy to self-contained directory with hard-linked dependencies
# This creates a portable, production-ready package
RUN rm -rf /app/deploy && pnpm deploy --filter=api --prod --legacy /app/deploy

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

# Copy migrations to locations where the migration script expects them (relative to dist/scripts/migrate.js)
COPY --chown=nodejs:nodejs packages/database/migrations-drizzle ./node_modules/@synap/database/migrations-drizzle
COPY --chown=nodejs:nodejs packages/database/migrations-custom ./node_modules/@synap/database/migrations-custom
COPY --from=builder --chown=nodejs:nodejs /app/packages/database/dist/scripts ./node_modules/@synap/database/dist/scripts

# Also copy to a standard location for direct execution if needed
COPY --chown=nodejs:nodejs packages/database/migrations-drizzle ./migrations-drizzle
COPY --chown=nodejs:nodejs packages/database/migrations-custom ./migrations-custom
COPY --chown=nodejs:nodejs packages/database/drizzle.config.ts ./drizzle.config.ts

# Expose port
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
# pnpm deploy puts the package files directly in the deploy directory
CMD ["node", "dist/index.js"]
