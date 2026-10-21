# Contributing to the Synap pod

Thank you for helping. This file covers working on this repository: setting it
up, running the checks CI runs, writing migrations, and sending a change.

- Found a security problem? Do not open an issue: see [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- For a large change, open an issue first so the approach can be agreed before
  you write it.

## Requirements

- **Node.js 20.** The exact version is in `.node-version`; CI runs Node 20.
- **pnpm 10.** The version is pinned in `package.json` (`packageManager`);
  `corepack enable` picks it up.
- **Docker**, to run PostgreSQL (TimescaleDB) for the tests that need a database.

## Set up

```bash
git clone https://github.com/Synap-core/backend.git
cd backend
pnpm install
```

`pnpm install` also installs the git hooks (husky):

| Hook         | Runs                                                                  |
| ------------ | --------------------------------------------------------------------- |
| `commit-msg` | commitlint (see "Commits" below)                                      |
| `pre-commit` | prettier and eslint on the staged files; it checks, it never rewrites |
| `pre-push`   | `pnpm typecheck && pnpm build`                                        |

## Repository layout

| Path                             | What it holds                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/api/`                      | The pod's HTTP server (Hono): entry point `src/index.ts`                                 |
| `apps/pod-admin/`                | The operator console (Next.js)                                                           |
| `packages/api/src/routers/`      | tRPC routers and the Hub Protocol REST routes (`/api/hub/*`)                             |
| `packages/api/src/access/`       | The access layer: every scoped table's visibility rule                                   |
| `packages/database/src/schema/`  | Drizzle schema                                                                           |
| `packages/database/migrations/`  | SQL migrations, applied in file-name order                                               |
| `packages/jobs/`                 | pg-boss workers                                                                          |
| `packages/realtime/`             | Socket.IO and Yjs server                                                                 |
| `skills/`                        | System skills shipped with every pod                                                     |
| `deploy/`, `synap`, `install.sh` | The production Compose stack and the operator CLI ([deploy/README.md](deploy/README.md)) |

## Run the API locally

```bash
pnpm dev            # apps/api with tsx watch, port from PORT (4000 in the stack)
pnpm dev:all        # the API and the realtime server
```

`pnpm dev` reads `.env.development.local` at the repository root, so create it
first; it needs at least a `DATABASE_URL`. The other services a pod talks to
are defined in `deploy/docker-compose.yml`, and `deploy/env.schema` lists every
variable with its type. To run the whole stack from your checkout instead,
`./synap install --domain localhost` builds the images from source (see
[deploy/README.md](deploy/README.md)).

## Checks

These are the commands CI runs. Run the ones that cover your change before you
push.

```bash
pnpm lint                                    # eslint
pnpm format                                  # prettier --check (pnpm format:fix rewrites)
pnpm typecheck                               # turbo: tsc in every package
pnpm build                                   # turbo: build every package
pnpm --filter @synap/api gen-types:check     # generated API types are up to date
pnpm tripwires                               # every architectural tripwire test
```

### Tests

Most suites need a migrated PostgreSQL. CI uses the TimescaleDB image; the same
locally:

```bash
docker run -d --name synap-test-db -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=synap_test \
  timescale/timescaledb-ha:pg16

export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/synap_test
pnpm --filter @synap/database migrate
pnpm --filter @synap/database schema:check
pnpm test
```

Run one package's tests with `pnpm --filter <package> test`, for example
`pnpm --filter @synap/database test`.

A few tests read sibling repositories (`../synap-app`,
`../synap-control-plane-api`) that are not public. They fail when those
checkouts are missing; CI lays them out and runs them.

CI has two jobs. **Release gate** (lint, typecheck, migrations on a real
Postgres, schema coherence, build, a boot smoke test, the Docker build) must be
green for a commit to be released. **Full suite** (all tests, the test floor,
the tripwires, `pnpm audit`) reports the rest.

### Tests and guards you add

A test that guards an invariant is only trusted once it has failed: revert your
fix, run the test, and confirm it goes red. Tests named `*.tripwire.test.ts`, or
placed under a `__tripwires__/` directory, are picked up by `pnpm tripwires`
automatically.

## Migrations

The rules are strict because a migration runs on every pod during
`synap update`.

- Hand-write every migration as a numbered `.sql` file in
  `packages/database/migrations/`. **Never** use `drizzle-kit generate` or
  `drizzle-kit push`.
- Write it defensively: `IF NOT EXISTS` / `IF EXISTS` on every `CREATE`,
  `ALTER ... ADD COLUMN` and `DROP`.
- Each migration runs in its own transaction. A failure rolls it back, is never
  recorded as applied, and stops the runner with a non-zero exit.
- A new column also goes into `packages/database/migrations/0000_baseline_schema.sql`
  and `packages/database/src/utils/schema-coherence.ts`. The pod checks schema
  coherence at startup, and CI runs `schema:check`.
- Never drop or edit the `_migrations` table by hand.
- Migrations are **forward-only** (expand/contract). A failed update rolls a pod
  back to the previous images but keeps the migrated database, so the previous
  release must keep working on the new schema. A migration that has not shipped
  in a `v*` release may not `DROP` a table or column, `RENAME`, change a column
  `TYPE` or `SET NOT NULL`. To remove or reshape something: release A adds the
  new shape and stops using the old one (expand); a later migration removes the
  old one and says so on one line, naming A's migration (contract):
  `-- synap:contract-of 0331_official_catalog_digests.sql`. A new required
  column is `ADD COLUMN … NOT NULL DEFAULT …` in one statement. The Release gate
  checks this (`deploy/__tests__/migration-forward-only.test.sh`, which runs
  `scripts/check-migrations-forward-only.mjs`).

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/),
enforced by commitlint (`.commitlintrc.json`):

```
<type>(<optional scope>): <subject>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`. The subject is not upper case. The history uses scopes
named after the area touched, for example `fix(proposals): ...` or
`feat(inbox): ...`.

## Pull requests

1. Branch from `main`: `feat/<topic>` or `fix/<topic>`.
2. Keep a pull request to one change, and say in its description what it
   changes and how you checked it.
3. Open it against `main`. The Release gate must be green before it is merged.
4. If you change the data model or a public claim, update
   [`docs/ARCHITECTURE-OVERVIEW.md`](docs/ARCHITECTURE-OVERVIEW.md) in the same
   pull request.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
