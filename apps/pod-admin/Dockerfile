# Debian (glibc), NOT alpine (musl): Next.js' SWC native binary segfaults
# (SIGSEGV in the build worker) under musl libc. glibc is Next.js' most-tested
# native target. The backend image stays on alpine because it ships no Next app.
FROM node:20-slim AS base
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
# ── Manifests: every workspace package.json, DERIVED from the tree ──
# This list used to be hand-written and fell behind: markdown-core (and seven
# other packages) were missing, so pnpm never installed their deps and tsc
# failed on `mdast` during `synap update` (2026-10-19). The globs mirror
# pnpm-workspace.yaml `packages:`. Only this stage re-runs on a source change;
# the install layer below stays cached while no manifest changes.
FROM base AS manifests
COPY . /src
RUN cd /src && for f in package.json apps/*/package.json packages/*/package.json marketplaces/*/package.json; do \
      if [ -f "$f" ]; then mkdir -p "/manifests/$(dirname "$f")" && cp "$f" "/manifests/$f"; fi; \
    done

FROM base AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# ── Layer 1: dependency manifests (cached unless lockfile or package.json changes) ──
COPY pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY --from=manifests /manifests/ ./

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
FROM node:20-slim AS runner

# Synap's own image: `synap tidy` removes a DANGLING image (a rebuild that took
# its tag) only when it carries this label — never another stack's image.
LABEL io.synap.first-party="true"

RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 nodejs && \
    useradd --system --uid 10001 --gid nodejs nodejs

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
