# Synap pod (synap-backend)

Instructions for coding agents in this repository. `AGENTS.md` points here.

- Humans' guide, and the source for every command below: [CONTRIBUTING.md](CONTRIBUTING.md).
- What the product is: [docs/ARCHITECTURE-OVERVIEW.md](docs/ARCHITECTURE-OVERVIEW.md).
- Deploy and operator CLI: [deploy/README.md](deploy/README.md).
- Inside the Synap workspace checkout (this repo at `<root>/synap-backend/`), the
  workspace rules apply too: `../CLAUDE.md` and `../.claude/rules/backend-rules.md`
  (access layer, Hub Protocol, governance, lifecycle and facet doors).

This repository is public: anything committed here is published.

## Commands

```bash
pnpm dev                 # apps/api (tsx watch, reads .env.development.local)
pnpm typecheck           # turbo: every package
pnpm build               # turbo: every package (@synap/api also regenerates API types)
pnpm lint                # eslint
pnpm test                # turbo: every package (most suites need DATABASE_URL, see CONTRIBUTING)
pnpm tripwires           # every *.tripwire.test.ts and __tripwires__/ test
pnpm --filter @synap/database migrate        # apply migrations to DATABASE_URL
pnpm --filter @synap/database schema:check   # schema coherence
pnpm --filter @synap/api gen-types:check     # generated API types are current
```

## Key paths

- `apps/api/src/index.ts` — the HTTP server (Hono)
- `packages/api/src/routers/` — tRPC + Hub Protocol REST (`/api/hub/*`)
- `packages/api/src/routers/mcp/` — MCP server (tools, HTTP handler)
- `packages/api/src/access/` — access layer; every scoped table has a rule in `registry.ts`
- `packages/database/src/schema/` — Drizzle schema
- `packages/database/migrations/` — SQL migrations (hand-written only; never drizzle-kit)
- `packages/jobs/` — pg-boss workers
- `deploy/`, `synap`, `install.sh` — Compose stack, operator CLI, installer

## Rules that bite

- Migrations: numbered `.sql`, `IF [NOT] EXISTS` everywhere; a new column also
  goes into `0000_baseline_schema.sql` and `src/utils/schema-coherence.ts`.
- The root `migrations/` directory is legacy; new migrations go in
  `packages/database/migrations/`. Run the runner as
  `pnpm --filter @synap/database migrate`: outside the Docker image it reads
  `./migrations` relative to the current directory. The root script
  `pnpm db:migrate` points at a file that does not exist.
- A new guard or tripwire must be seen failing with its fix reverted.
