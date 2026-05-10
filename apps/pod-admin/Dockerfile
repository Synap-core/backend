FROM node:20-alpine AS base
RUN npm install -g pnpm@10.28.0
WORKDIR /app

# ============================================================================
# Builder
# ============================================================================
FROM base AS builder

RUN apk add --no-cache python3 make g++

# Workspace manifests — pod-admin depends on @synap-core/api-types via workspace.
# Copy all workspace package.jsons because pnpm's frozen-lockfile resolves
# against the full graph; the actual install is filtered to pod-admin's
# transitive closure via `--filter pod-admin...`.
# Also copy the root tsconfig.json — every package's tsconfig extends it, so
# missing it breaks api-types' `tsc` (TS5083 "Cannot read file").
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/admin-ui/package.json     ./apps/admin-ui/
COPY apps/api/package.json          ./apps/api/
COPY apps/pod-admin/package.json    ./apps/pod-admin/
COPY packages/ai-embeddings/package.json    ./packages/ai-embeddings/
COPY packages/ai/package.json               ./packages/ai/
COPY packages/api-types/package.json        ./packages/api-types/
COPY packages/api/package.json              ./packages/api/
COPY packages/auth/package.json             ./packages/auth/
COPY packages/core/package.json             ./packages/core/
COPY packages/database/package.json         ./packages/database/
COPY packages/events/package.json           ./packages/events/
COPY packages/feed-service/package.json     ./packages/feed-service/
COPY packages/hub-protocol/package.json     ./packages/hub-protocol/
COPY packages/intelligence-client/package.json ./packages/intelligence-client/
COPY packages/jobs/package.json             ./packages/jobs/
COPY packages/realtime/package.json         ./packages/realtime/
COPY packages/scripts/package.json          ./packages/scripts/
COPY packages/search/package.json           ./packages/search/
COPY packages/shared-utils/package.json     ./packages/shared-utils/
COPY packages/storage/package.json          ./packages/storage/
COPY packages/test-e2e/package.json         ./packages/test-e2e/
COPY packages/types/package.json            ./packages/types/

RUN --mount=type=cache,id=pnpm-pod-admin,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter pod-admin...

# Source — pod-admin + its workspace dep chain (types ← api-types).
COPY apps/pod-admin ./apps/pod-admin
COPY packages/api-types ./packages/api-types
COPY packages/types ./packages/types

# Build the workspace dep chain FIRST. pod-admin's TypeScript pass imports
# `AppRouter` from @synap-core/api-types, which itself depends on
# @synap-core/types. The repo `.dockerignore` excludes every `dist/`, so we
# have to materialise both packages' compiled output inside the container.
# `--filter @synap-core/api-types...` (note the trailing `...`) tells pnpm
# to build api-types plus all of its transitive workspace dependencies in
# topological order — types first, then api-types.
RUN pnpm --filter @synap-core/api-types... build

RUN cd apps/pod-admin && NEXT_TELEMETRY_DISABLED=1 pnpm build

# ============================================================================
# Runner — Next.js standalone output
# ============================================================================
FROM node:20-alpine AS runner

RUN apk add --no-cache dumb-init

RUN addgroup -g 10001 -S nodejs && \
    adduser -S nodejs -u 10001

WORKDIR /app
USER nodejs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone server (minimal node_modules + server.js)
COPY --from=builder --chown=nodejs:nodejs /app/apps/pod-admin/.next/standalone ./
# Static assets (the standalone server expects these in .next/static)
COPY --from=builder --chown=nodejs:nodejs /app/apps/pod-admin/.next/static ./apps/pod-admin/.next/static

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/pod-admin/server.js"]
