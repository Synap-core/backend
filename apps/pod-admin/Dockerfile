FROM node:20-alpine AS base
RUN npm install -g pnpm@10.28.0
WORKDIR /app

# ============================================================================
# Builder — install full workspace + build pod-admin and its workspace deps
#
# Why the whole workspace: pod-admin imports `@synap-core/api-types` which
# transitively pulls in `@synap-core/types`, which devDepends on `@synap/database`
# and `@synap-core/core` — both of which need their own tsconfig + source to
# compile. Trying to copy a hand-curated subset breaks under topological build
# (turbo / pnpm). The backend Dockerfile takes the same shape — copy everything,
# install once, let turbo handle the order.
# ============================================================================
FROM base AS builder

RUN apk add --no-cache python3 make g++

# ── Layer 1: dependency manifests (cached unless lockfile or package.json changes) ──
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
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

# Install ALL workspace deps — turbo build below needs every package's
# devDeps (tsc, tsup, etc.) resolvable from the host's lockfile.
RUN --mount=type=cache,id=pnpm-synap,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Layer 2: source + build (re-runs on every source change) ──
COPY . .

# Build pod-admin via turbo so its workspace deps (api-types, types, etc.) get
# built first in topological order. concurrency=1 keeps memory bounded.
RUN NODE_OPTIONS=--max-old-space-size=4096 NEXT_TELEMETRY_DISABLED=1 \
    pnpm turbo build --filter=pod-admin --concurrency=1

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
