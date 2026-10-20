# Backend code map

> Verified against code on 2026-10-20 (backend@cc4b2d81). Migrated from Synap's
> internal team docs on 2026-10-20.

This page maps the backend's processes and packages and the path a write takes.
What a pod is (the data model, the unit of work, governance) is in
[../ARCHITECTURE-OVERVIEW.md](../ARCHITECTURE-OVERVIEW.md); this page is the
engineering view. The other pages in this folder go deeper; see
[README.md](README.md).

## Processes

`deploy/docker-compose.yml` runs a pod as these services (some optional or
behind profiles):

| Service                       | Role                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `backend`                     | `apps/api`: Hono server with tRPC (`/trpc`), Hub Protocol REST (`/api/hub`), MCP (`/mcp`), webhooks; port 4000 |
| `backend-migrate`             | one-shot migration runner, before `backend` ([migrations.md](migrations.md))                                   |
| `realtime`                    | `packages/realtime`: Socket.IO presence, domain events and Yjs; port 4001 ([realtime.md](realtime.md))         |
| `pod-admin`                   | `apps/pod-admin`: operator surface                                                                             |
| `postgres`, `postgres-backup` | PostgreSQL with pgvector, and its backups                                                                      |
| `redis`                       | cache                                                                                                          |
| `minio`                       | object storage for documents, whiteboards and files                                                            |
| `typesense`                   | full-text search                                                                                               |
| `kratos`, `kratos-migrate`    | Ory Kratos identities and sessions ([auth-and-federation.md](auth-and-federation.md))                          |
| `caddy`                       | TLS and routing (`/socket.io/*` to realtime, the rest to backend)                                              |
| `pod-agent`                   | optional receiver of signed operations commands                                                                |
| `rsshub`, `browserless`       | optional (`rsshub` profile)                                                                                    |
| monitoring and tunnels        | `prometheus`, `grafana`, `alertmanager`, `dozzle`, `cloudflared`, `pangolin-tunnel` (optional)                 |

Background jobs run on pg-boss inside the backend process
(`packages/jobs`: workers in `src/workers/`, schedules in `src/cron.ts`).

## Packages

| Package                                                                                                  | Holds                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@synap/api` (`packages/api`)                                                                            | tRPC routers, Hub Protocol REST, MCP server, services, access layer, permission gate     |
| `@synap/database`                                                                                        | Drizzle schema, repositories, migrations, database services                              |
| `@synap/jobs`                                                                                            | pg-boss workers and cron                                                                 |
| `@synap/events`                                                                                          | operational event types, side-effect reactors, realtime schemas                          |
| `@synap/realtime`                                                                                        | the realtime service                                                                     |
| `@synap/auth`                                                                                            | Kratos session middleware and local mode                                                 |
| `@synap/governance-policy`                                                                               | the pure agent-governance engine and grant grammar mirror                                |
| `@synap/search`, `@synap/storage`, `@synap/ai`, `@synap/ai-embeddings`                                   | Typesense, object storage, model calls, embeddings                                       |
| `@synap/feed-service`                                                                                    | pluggable source providers ([feed-service.md](feed-service.md))                          |
| `@synap/intelligence-client`                                                                             | client for the Intelligence Service chat stream                                          |
| `@synap/playbooks`, `@synap/capability-gate`, `@synap/shared-utils`, `@synap/scripts`, `@synap/test-e2e` | playbook runtime, capability gate, retry and circuit breakers, scripts, end-to-end tests |
| `@synap-core/types`                                                                                      | shared types and Zod schemas, published (includes the vocabulary and grant model)        |
| `@synap-core/api-types`                                                                                  | generated tRPC types for frontends, published                                            |
| `@synap-core/core`                                                                                       | config, logging, telemetry (private)                                                     |
| `@synap-core/hub-protocol`, `@synap-core/hub-rest-client`                                                | Hub Protocol schemas and a zero-dependency REST client, published                        |
| `@synap-core/auth-bootstrap` (published), `@synap-core/external-connect-client` (private)                | credential flows for SDKs and external apps                                              |
| `@synap-core/field-crypto`, `@synap-core/markdown-core`                                                  | field encryption envelope, the markdown parser, published                                |

`@synap/database` must not depend on `@synap-core/types` (the types package
already depends on database at dev time); the grant grammar is mirrored into
`@synap/governance-policy` for the same reason.

## The write path

```
request (tRPC, Hub REST, MCP)
  → authentication (session, API key + grant, IS delegation)
  → checkPermissionOrPropose()          packages/api/src/utils/permission-check.ts
       granted  → repository write → auditLog / emitCompleted → emitSideEffects()
       proposed → pending proposal (see event-chain.md)
       denied   → error
```

- **Workspace roles:** `viewer` < `editor` < `admin` < `owner`
  (`requireWorkspaceRole`, `packages/api/src/utils/workspace-permissions.ts`).
  A write with no workspace is a personal resource.
- **Agents are users.** An agent acts as its own user record
  (`users.user_type`), with its own memberships; its role, not the triggering
  human's, is checked.
- **Agent governance** (auto-approve or propose) has one engine,
  `decideAgentPolicy` (`packages/governance-policy/src/index.ts`), one call site,
  `resolveAgentGovernanceDecision` (`packages/database/src/utils/`), and one
  user-editable store, the `governance_rules` table (migration 0215). Rules can
  only say `auto` or `propose`, and sit below the floors for admin, destructive
  and scope-changing actions, so no rule can auto-approve a delete.
- **Reads** go through the access layer: `scopedDb(AccessContext.from(ctx))`,
  with a visibility rule per scoped table in `packages/api/src/access/registry.ts`.
  Writes check the loaded row's workspace, never a workspace taken from the
  request.
- Events, proposals and side effects: [event-chain.md](event-chain.md).
  Agent and external clients: [hub-protocol.md](hub-protocol.md),
  [api-keys.md](api-keys.md).

## Documents

Document content lives in object storage; the database row holds metadata,
versions and the realtime cache. Text documents are markdown; whiteboards are
tldraw JSON. Co-editing, checkpoints and version history are in
[realtime.md](realtime.md). `documents.entity_id` no longer exists: find a
document's entity with `entities WHERE document_id = ?`.

## Local development

The root `package.json` scripts: `pnpm dev` (API on port 4000), `pnpm dev:all` (API and
realtime), `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`.

## History

The 2026-02 version of this page also described the Intelligence Service's
agent roster, a synchronous "CRUD then audit" write path without proposals in
the chain, a workspace `aiAutoApprove` toggle as the governance source, a
numbered shell integration suite under `tests/integration/`, and pnpm 9 (the
repository uses pnpm 10). Those no longer match the code and were dropped; the
Intelligence Service is documented in its own repository.
