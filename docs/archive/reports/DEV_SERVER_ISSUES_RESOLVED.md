# Dev Server Issues - Analysis & Resolution

**Date**: 2025-11-18
**Status**: ✅ All Critical Issues Resolved

---

## Issues Found & Resolved

### 🔴 CRITICAL: API Server Failed to Start

**Error**:
```
Error: unable to determine transport target for "pino-pretty"
    at fixTarget (/Users/antoine/Documents/Code/synap-backend/node_modules/.pnpm/pino@9.14.0/node_modules/pino/lib/transport.js:160:13)
```

**Root Cause**:
- The logger configuration in `packages/core/src/logger.ts` was configured to use `pino-pretty` transport in development mode
- `pino-pretty` was not installed as a dependency in `packages/core/package.json`

**Resolution**: ✅
```bash
cd packages/core && pnpm add pino-pretty
```

**Impact**:
- API server now starts successfully
- Development logs are now pretty-printed and colorized
- Production logging remains JSON format

**Files Changed**:
- `packages/core/package.json` - Added `pino-pretty@13.1.2` to dependencies

---

### ⚠️ WARNING: Node.js Version Mismatch

**Warning**:
```
You are using Node.js 22.3.0. Vite requires Node.js version 20.19+ or 22.12+.
Please upgrade your Node.js version.
```

**Root Cause**:
- Using Node.js 22.3.0
- Vite requires 20.19+ or 22.12+ (but not 22.3.0-22.11.x range)

**Current Status**: ⚠️ Non-blocking
- All packages build successfully
- Dev server runs without errors
- This is a warning, not an error

**Recommended Action**:
```bash
# Upgrade to Node.js 22.12+ or use 20.19+
nvm install 22.12.0
nvm use 22.12.0
```

**Impact**:
- None currently - everything works
- Future compatibility risk if Vite updates enforce version check

---

### ⚠️ WARNING: Wrangler Outdated

**Warning**:
```
The version of Wrangler you are using is now out-of-date.
wrangler 3.114.15 (update available 4.49.0)
```

**Root Cause**:
- Wrangler is significantly outdated (3.x vs 4.x major version)

**Current Status**: ⚠️ Non-blocking
- Realtime package (Cloudflare Workers) starts successfully
- Local development works with current version

**Recommended Action**:
```bash
cd packages/realtime
pnpm add -D wrangler@4
```

**Impact**:
- None currently - local dev works
- Missing new features and bug fixes from v4
- Potential security vulnerabilities

---

### ℹ️ INFO: Inngest CLI Installation

**Notice**:
```
Need to install the following packages:
inngest-cli@1.13.7
```

**Root Cause**:
- Inngest CLI is run via `npx`, which prompts to install on first run
- Not a dependency in package.json (intentional - uses latest via npx)

**Current Status**: ℹ️ Expected behavior
- User will be prompted to install on first run
- This is normal for npx-based tools

**No Action Required** - This is expected behavior

---

## Build Status Summary

### ✅ All Packages Build Successfully

```
Tasks:    9 successful, 9 total
Cached:    0 cached, 9 total
Time:    18.446s
```

**Packages Built**:
1. ✅ @synap/core
2. ✅ @synap/types
3. ✅ @synap/storage
4. ✅ @synap/database
5. ✅ @synap/domain
6. ✅ @synap/ai
7. ✅ @synap/jobs
8. ✅ api
9. ✅ admin-ui

---

## Dev Server Status

### Services Running

| Service | Port | Status |
|---------|------|--------|
| Admin UI (Vite) | 5173 | ✅ Running |
| API Server | 3000 | ✅ Running (after fix) |
| Realtime (Cloudflare Workers) | 8787 | ✅ Running |
| Inngest Dev Server | 8288 | ✅ Running (after install) |

---

## Peer Dependency Warnings

### ⚠️ Non-Critical Warnings

```
apps/admin-ui
└─┬ @mantine/dates 8.3.8
  ├── ✕ unmet peer @mantine/core@8.3.8: found 7.17.8
  └── ✕ unmet peer @mantine/hooks@8.3.8: found 7.17.8
```

**Root Cause**:
- admin-ui uses @mantine/core@7.17.8
- @mantine/dates was installed as v8.3.8 (latest)
- Peer dependency mismatch between major versions

**Current Status**: ⚠️ Non-blocking
- Functionality works correctly
- DateTimePicker components render properly
- No runtime errors

**Recommended Action** (Optional):
```bash
# Option 1: Upgrade all Mantine to v8 (recommended)
cd apps/admin-ui
pnpm add @mantine/core@8 @mantine/hooks@8

# Option 2: Downgrade dates to v7 (quick fix)
cd apps/admin-ui
pnpm add @mantine/dates@7
```

**Impact**:
- Minor risk of unexpected behavior
- Works correctly in current implementation

---

## Testing Vitest Peer Dependency Warnings

```
packages/ai, packages/domain, packages/jobs, packages/storage
└─┬ vitest 1.6.1
  └── ✕ unmet peer @vitest/ui@1.6.1: found 4.0.7
```

**Root Cause**:
- vitest v1.6.1 expects @vitest/ui@1.6.1
- Found @vitest/ui@4.0.7 (major version mismatch)

**Current Status**: ⚠️ Non-blocking
- Tests run successfully
- No impact on dev server

**Recommended Action** (Low Priority):
```bash
# Align vitest and ui versions
pnpm add -D vitest@4 @vitest/ui@4 -w
```

---

## Resolution Summary

### ✅ Critical Issues Fixed

1. **pino-pretty missing** → Installed `pino-pretty@13.1.2`
2. **Build verification** → All 9 packages build successfully

### ⚠️ Warnings (Non-blocking)

3. **Node.js version** → Recommend upgrade to 22.12+
4. **Wrangler outdated** → Recommend upgrade to v4
5. **Mantine peer deps** → Optional upgrade to v8
6. **Vitest peer deps** → Optional version alignment

---

## Next Steps

### Immediate (Required)
- ✅ pino-pretty installed
- ✅ All packages building
- ✅ Dev server ready to run

### Recommended (Optional)
- [ ] Upgrade Node.js to 22.12+
- [ ] Upgrade Wrangler to v4
- [ ] Align Mantine versions (all to v8)
- [ ] Align Vitest versions (all to v4)

### How to Start Dev Server

```bash
# All services
pnpm dev

# Individual services
pnpm --filter admin-ui dev      # Admin UI only
pnpm --filter api dev           # API only
pnpm --filter @synap/realtime dev  # Realtime only
pnpm --filter @synap/jobs dev   # Jobs only
```

---

## Test URLs

After starting `pnpm dev`:

- **Admin UI**: http://localhost:5173
- **API**: http://localhost:3000
- **Realtime**: http://localhost:8787
- **Inngest**: http://localhost:8288

### Admin UI Pages

- `/` - Live Event Stream
- `/trace` - Event Trace Viewer ⭐⭐⭐⭐⭐
- `/metrics` - Metrics Dashboard ⭐⭐⭐⭐
- `/architecture` - Architecture Visualizer ⭐⭐⭐⭐
- `/search` - Event Search ⭐⭐⭐
- `/playground` - AI Tools Playground ⭐⭐⭐
- `/capabilities` - System Capabilities
- `/publish` - Event Publisher

---

**Status**: ✅ Ready for Development
**Last Updated**: 2025-11-18
