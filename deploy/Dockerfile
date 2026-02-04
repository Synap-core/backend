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
# Install all dependencies with retry mechanism
RUN pnpm install --frozen-lockfile || (sleep 5 && pnpm install --frozen-lockfile) || (sleep 10 && pnpm install --frozen-lockfile)

# Build the project using Turborepo
RUN pnpm turbo build --filter=api --filter=@synap/realtime

# Build migration script independently
RUN cd packages/database && pnpm build:migrate

# Deploy to self-contained directory with hard-linked dependencies
# This creates a portable, production-ready package
RUN rm -rf /app/deploy && pnpm deploy --filter=api --filter=@synap/realtime --prod --legacy /app/deploy

# Prepare custom migrations directory (optional - only if migrations-custom exists)
# Create directory unconditionally, then copy files if they exist
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

# Install tsx globally for running TypeScript files (needed for realtime server)
RUN npm install -g tsx

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

# Copy custom migrations (optional - prepared in builder stage)
# The migration script (scripts/migrate.ts) gracefully handles:
#   - Missing directory: logs "No custom migrations directory found, skipping..." and continues
#   - Empty directory: logs "No custom migrations found, skipping..." and continues
#   - Existing migrations: applies them in alphabetical order
# Directory is prepared in builder stage (always exists, may be empty)
COPY --from=builder --chown=nodejs:nodejs /app/migrations-custom-temp/ ./migrations-custom/

# Copy realtime package source files (needed to run with tsx)
COPY --from=builder --chown=nodejs:nodejs /app/packages/realtime/src ./node_modules/@synap/realtime/src
COPY --from=builder --chown=nodejs:nodejs /app/packages/realtime/package.json ./node_modules/@synap/realtime/package.json

# Expose ports
EXPOSE 3000 4001

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
# pnpm deploy puts the package files directly in the deploy directory
CMD ["node", "dist/index.js"]
