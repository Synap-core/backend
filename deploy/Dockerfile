FROM node:20-alpine AS base
RUN npm install -g pnpm@10.28.0
WORKDIR /app

# ============================================================================
# Manifests: every workspace package.json, DERIVED from the tree
#
# This list used to be hand-written and fell behind (pod-admin's copy missed
# markdown-core and failed `synap update` on 2026-10-19). The globs mirror
# pnpm-workspace.yaml `packages:`. apps/pod-admin is left out on purpose: it
# has its own image, and installing Next.js + sharp here would only slow this
# build. Only this stage re-runs on a source change; the install layer below
# stays cached while no manifest changes.
# ============================================================================
FROM base AS manifests
COPY . /src
RUN cd /src && for f in package.json apps/*/package.json packages/*/package.json marketplaces/*/package.json; do \
      if [ -f "$f" ] && [ "$f" != apps/pod-admin/package.json ]; then mkdir -p "/manifests/$(dirname "$f")" && cp "$f" "/manifests/$f"; fi; \
    done

# ============================================================================
# Builder: Install dependencies and build both services
# ============================================================================
FROM base AS builder

# Build tools for native addons
RUN apk add --no-cache python3 make g++
# node-gyp builds native addons (node-pty) against the headers the node image
# already ships in /usr/local/include/node. Without this it downloads them from
# unofficial-builds.nodejs.org (musl), which hangs on hosts whose IPv6 route is
# broken (ETIMEDOUT, perso pod 2026-10-14) and fails the whole build.
ENV npm_config_nodedir=/usr/local

# ── Layer 1: dependency manifests (cached unless lockfile or package.json changes) ──
# Copy workspace config and all package.json files BEFORE source code.
# This layer is only invalidated when dependencies change, not on every commit.
COPY pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY --from=manifests /manifests/ ./

# Install all dependencies — pnpm store is cached across builds
RUN --mount=type=cache,id=pnpm-synap,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Layer 2: source + build (re-runs on every source change) ──
COPY . .

# Build API + realtime in one turbo pass (no persistent cache — prevents stale build artifacts)
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm turbo build \
      --filter=api \
      --filter=@synap/realtime \
      --concurrency=1

# Build the admin CLI scripts (standalone tsup bundle)
RUN cd /app/packages/api && npx tsup --config tsup.provision.config.ts

# Deploy each service to its own self-contained directory
RUN pnpm deploy --filter=api --prod --legacy /app/deploy/api
RUN pnpm deploy --filter=@synap/realtime --prod --legacy /app/deploy/realtime


# ============================================================================
# Runner: Single image, both entry points included
# ============================================================================
FROM node:20-alpine AS runner

# Synap's own image: `synap tidy` removes a DANGLING image (a rebuild that took
# its tag) only when it carries this label — never another stack's image.
LABEL io.synap.first-party="true"

# Git SHA the image was built from — surfaced at runtime via SYNAP_GIT_SHA so
# /status/release can report `buildStamp` and a deploy-integrity check can
# assert the running image actually matches the commit it claims to be.
# Passed in via `docker compose build --build-arg GIT_SHA=$(git rev-parse HEAD)`
# (see docker-compose.yml `build.args.GIT_SHA`). Defaults to empty when not
# supplied (older callers, local `docker build` without the arg).
ARG GIT_SHA=""
ENV SYNAP_GIT_SHA=$GIT_SHA

# ── The cron scheduler's timezone, PINNED rather than inherited ─────────────
# `computeNextRunAt` (packages/jobs/.../automation-cron-scheduler.ts) matches a
# cron expression with `getHours`/`getDate`/`getDay`/`getMonth` — PROCESS-LOCAL
# accessors. So every scheduled rule fires on this container's clock.
#
# That was already UTC, but only because `node:20-alpine` ships no
# `/etc/localtime` and Node falls back — true by ACCIDENT, not by declaration,
# and silently changed by any base-image or host that supplies a zone. A
# schedule that shifts by an hour produces no error and no empty state: the
# rule just runs at a time nobody chose. Declaring it makes the guarantee real,
# and makes the user-facing "09:00 UTC" labels honest rather than lucky.
#
# ⚠️ This is NOT per-user timezones. `toBackendTrigger` stores
# `timezone: cronTimezone ?? "UTC"` and NOTHING reads it back — a stamp nobody
# earned. The real fix is teaching `computeNextRunAt` that stored value and
# defaulting it to the author's device zone; until then a user outside UTC must
# be TOLD the zone, never shown a bare local-looking hour.
ENV TZ=UTC

RUN apk add --no-cache postgresql-client dumb-init

RUN addgroup -g 10001 -S nodejs && \
    adduser -S nodejs -u 10001

WORKDIR /app
USER nodejs

# API service files
COPY --from=builder --chown=nodejs:nodejs /app/deploy/api ./api/

# Realtime service files
COPY --from=builder --chown=nodejs:nodejs /app/deploy/realtime ./realtime/

# Config files (API needs these at runtime)
COPY --chown=nodejs:nodejs kratos ./api/kratos

# Migrations (used by backend-migrate service)
COPY --from=builder --chown=nodejs:nodejs /app/packages/database/migrations/*.sql ./api/migrations/

# System skill packages — read at runtime by GET /skills/system AND the
# ensureSystemSkills() boot seeder (loadSkillPackagesFromDisk resolves
# process.cwd()/skills = /app/api/skills). Without this the teaching
# substrate 503s and the seeder no-ops in production.
COPY --from=builder --chown=nodejs:nodejs /app/skills ./api/skills

# Admin CLI scripts (create-admin-cli, user-admin-cli, field-crypto)
COPY --from=builder --chown=nodejs:nodejs /app/packages/api/dist/scripts ./api/dist/scripts/

# Shameful hoist for API node_modules (pnpm deploy --legacy doesn't create top-level symlinks)
USER root
RUN pnpm_dir=/app/api/node_modules/.pnpm; \
    ls "$pnpm_dir" | while read entry; do \
      if echo "$entry" | grep -q "^@"; then \
        scope_part=$(echo "$entry" | sed 's/+[^@]*@.*//'); \
        name_part=$(echo "$entry" | sed 's/^[^+]*+//' | sed 's/@.*//'); \
        pkg_path="$scope_part/$name_part"; \
      else \
        pkg_path=$(echo "$entry" | sed 's/@.*//'); \
      fi; \
      target="/app/api/node_modules/$pkg_path"; \
      src="$pnpm_dir/$entry/node_modules/$pkg_path"; \
      if [ ! -e "$target" ] && [ -d "$src" ]; then \
        mkdir -p "$(dirname "$target")" && ln -snf "$src" "$target"; \
      fi; \
    done
USER nodejs

# Default entry point: API (docker-compose overrides CMD for realtime)
WORKDIR /app/api
EXPOSE 4000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
