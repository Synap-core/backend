# Hooks & build – what changed and why it broke

## Before (commit 5c49e7c, “before entity-document”)

- **Pre-commit:** `pnpm lint-staged` + `pnpm typecheck`
- **Typecheck:** `tsc -b --pretty false` (no types build in the script)
- **No pre-push hook**
- **No path mappings** in database/jobs tsconfig for `@synap-core/types`

So: typecheck relied on `@synap-core/types` being resolvable (e.g. types package already built and linked). When it wasn’t, pre-commit failed and you couldn’t commit.

## What we changed (this session)

1. **Pre-commit:** removed `pnpm typecheck` so you can commit (only lint-staged runs).
2. **Pre-push:** added hook that runs `pnpm typecheck && pnpm build`.
3. **Typecheck:** first “build types then tsc”, then reverted to just `tsc -b`.
4. **Tsconfig:** added path mappings in database + jobs so `@synap-core/types` → `../types/src/` (typecheck works without building types).
5. **Types package:** build script set to `NODE_OPTIONS=--max-old-space-size=4096 tsup`.

## Where the OOM comes from

- Pre-push runs **pnpm build** (turbo builds all packages, including `@synap-core/types`).
- The **types** build runs **tsup**, which does a DTS step in a **worker**. That worker has its own memory limit and can hit **ERR_WORKER_OUT_OF_MEMORY**.
- `NODE_OPTIONS` applies to the main Node process; the worker may not get the same limit, so the OOM can still happen.

So the failure is in **build** on push, not in typecheck.

## Simplification (recommended)

- **Pre-push:** run **only typecheck**, not build.
  - Push stays fast and no OOM (typecheck uses path mappings, no types build).
  - Full build stays for CI or manual `pnpm build`.

That restores “it worked before” in the sense: you can commit (pre-commit is light), and push only checks types (no heavy build on your machine).
