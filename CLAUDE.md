# Synap Backend

See root `CLAUDE.md` for architecture, stack, and canonical rules.
Repo-specific rules: `../.claude/rules/backend-rules.md`.

## Commands

```bash
pnpm dev                 # Start API server (port 4000)
pnpm build               # Build + gen-types
pnpm typecheck           # tsc --noEmit
pnpm test                # vitest
pnpm --filter @synap/api build
```

## Key paths

- `packages/api/src/routers/` — tRPC + Hub Protocol REST
- `packages/api/src/routers/mcp/` — MCP server (tools, HTTP handler)
- `packages/database/src/schema/` — Drizzle schema
- `packages/database/migrations/` — SQL migrations (hand-written only)
- `packages/jobs/` — pg-boss workers
