# Multi-stage Dockerfile for Synap Backend
# Builds the backend API server with all dependencies

FROM node:20-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json ./

# Copy all package.json files
COPY packages/*/package.json ./packages/
COPY apps/*/package.json ./apps/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build stage
FROM base AS build

# Copy source code
COPY . .

# Reinstall dependencies with source code (needed for workspace dependencies)
RUN pnpm install --frozen-lockfile

# Build all packages (excluding admin-ui which is frontend-only)
RUN pnpm build --filter='!admin-ui'

# Production stage
FROM node:20-alpine AS production

# Install pnpm
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json ./

# Copy package.json files
COPY packages/*/package.json ./packages/
COPY apps/*/package.json ./apps/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files from build stage
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps

# Copy necessary config files
COPY env.example .env.example

# Copy configuration directories (needed for Ory)
COPY kratos ./kratos
COPY hydra ./hydra

# Copy scripts (needed for migrations)
COPY scripts ./scripts

# Copy database migrations and config
COPY packages/database/migrations-custom ./packages/database/migrations-custom
COPY packages/database/migrations-drizzle ./packages/database/migrations-drizzle
COPY packages/database/drizzle.config.ts ./packages/database/drizzle.config.ts

# Expose port
EXPOSE 3000

# Install PostgreSQL client for health checks and migrations
RUN apk add --no-cache postgresql-client

# Create startup script that runs migrations then starts server
RUN echo '#!/bin/sh\n\
set -e\n\
echo "🚀 Synap Backend Starting..."\n\
echo ""\n\
# Wait for PostgreSQL to be ready\n\
if [ -n "$DATABASE_URL" ]; then\n\
  echo "⏳ Waiting for database..."\n\
  DB_HOST=$(echo $DATABASE_URL | sed -n "s/.*@\\([^:]*\\):.*/\\1/p")\n\
  DB_PORT=$(echo $DATABASE_URL | sed -n "s/.*@[^:]*:\\([0-9]*\\)\\/.*/\\1/p" || echo "5432")\n\
  DB_USER=$(echo $DATABASE_URL | sed -n "s/.*:\\/\\/\\([^:]*\\):.*/\\1/p")\n\
  until pg_isready -h "${DB_HOST:-postgres}" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" 2>/dev/null; do\n\
    echo "  Database not ready, waiting..."\n\
    sleep 2\n\
  done\n\
  echo "✅ Database is ready"\n\
  echo ""\n\
  # Run migrations\n\
  echo "📦 Running database migrations..."\n\
  cd packages/database && pnpm db:migrate || echo "⚠️  Migration failed, continuing anyway..."\n\
  echo ""\n\
fi\n\
echo "🚀 Starting API server..."\n\
exec pnpm --filter api start\n\
' > /app/start.sh && chmod +x /app/start.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the API server (with migrations)
CMD ["/app/start.sh"]

