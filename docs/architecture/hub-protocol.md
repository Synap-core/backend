# Hub Protocol REST surface

> Verified against code on 2026-10-20 (backend@cc4b2d81). Originally from
> `content/team/platform/hub-protocol.mdx` (Synap-core/doc).

The Hub Protocol is the REST API every non-browser client of a pod uses: the
Intelligence Service, external agents, sidecars and the CLI. It is mounted at
`/api/hub/*` (Hono, not tRPC). All Intelligence Service to pod traffic goes
through it; the Intelligence Service never touches the database.

The Zod schemas of the insight format (`HubInsight`, `Action`, `Analysis`) live
in `packages/hub-protocol` and are documented in its
[README](../../packages/hub-protocol/README.md). This page covers the REST
surface in `packages/api`.

## Layout

- `packages/api/src/routers/hub-protocol-rest.ts` is the orchestrator: it owns
  the Hono app, the middleware chain and the order in which route slices are
  registered. Hono matches the first route that fits, so registration order is
  part of the contract (static paths before `/:id`).
- `packages/api/src/routers/hub-protocol/rest/*.ts` holds one file per
  resource; `rest/_codecs/*.ts` holds request and response schemas.
- `packages/api/src/routers/hub-protocol/_middleware/` holds the auth,
  focus-session and idempotency middleware.

## Middleware chain

1. **Health** routes register first and need no auth.
2. **Auth** (`_middleware/auth.ts`) accepts three credentials: a bearer token
   the pod signed itself for one Intelligence Service turn (the IS delegation,
   `utils/is-delegation.ts`), a bearer API key (agents, the CLI), or a Kratos
   session in `X-Session-Token` (the extension and web clients, with full
   `hub-protocol.read` and `hub-protocol.write` scopes). Failures return the
   standard 401 envelope (`utils/auth-error.ts`). See
   [api-keys.md](api-keys.md) for key types, grants and scopes, and
   [auth-and-federation.md](auth-and-federation.md) for sessions and federated
   tokens.
3. **Focus session** (`_middleware/session.ts`): reads `X-Session-Id` once,
   checks it names a focus session owned by the authenticated principal, and
   exposes it to every route.
4. **Idempotency** (`_middleware/idempotency.ts`), below.

## OpenAPI

- `GET /api/hub/openapi.json` serves an OpenAPI 3.1 document, always on.
- `GET /api/hub/docs` serves Swagger UI only when `NODE_ENV !== "production"`.
- Routes defined with `app.openapi(route, handler)` (`@hono/zod-openapi`) get
  runtime validation of body, params and query; failures are flattened into
  `{ error: "<path>: <message>, ..." }` before the handler runs. Other routes
  register their documentation with `registerOpenApi` and validate inside the
  handler.

## Idempotency-Key

Every write (`POST`, `PUT`, `PATCH`, `DELETE`) accepts an optional
`Idempotency-Key` header.

- Cache key: `(userId, key, sha256(body))`, so a retry with a changed body is not
  served the old response.
- Only 2xx responses are cached, for 24 hours. A replay carries
  `X-Idempotent-Replay: true`.
- The store is in memory, per process, bounded to 5,000 entries with LRU
  eviction. A deployment with several API processes gets per-process
  idempotency. The middleware fails open: a cache error never blocks a request.
- Never cached: paths that issue a secret or are authenticated out of band
  (`/setup/agent`, `/setup/service`, `/entity-share/deliver` and the
  unauthenticated setup doors), and any 2xx body that matches the secret-field
  pattern (`hubApiKey`, `subToken`, `apiKey`, `provisioningToken`,
  `sessionToken`, `secret`, `privateKey`, `kratosSecret`).

`@synap-core/hub-rest-client` sends a fresh key on every mutating request, so
its own retries are safe.

## Per-user sub-tokens

One agent key can act for many end users of a shared front end (for example a
shared Open WebUI). Enabled by default; `HUB_PROTOCOL_SUB_TOKENS=false` turns it
off (`services/external-user-mapping.ts`).

- **Header remap:** send `X-External-User-Id: <opaque id>` with the parent
  agent key. The pod looks up `(parent key, external user id)` in
  `api_key_external_users`, provisions the user and mapping on first sight, and
  runs the request as that user. Without the header nothing changes.
- **Child keys:** `POST /api/hub/setup/external-user` with
  `mintSubToken: true` mints a child key (`api_keys.parent_key_id`). Revoking the
  parent revokes its children, and a child cannot widen its parent's scopes.
- `HUB_PROTOCOL_EXTERNAL_USER_WORKSPACE_STRATEGY` (`first` default, `all`,
  `none`) decides which of the parent owner's workspaces a newly provisioned
  external user joins.

## Threads

- `POST /api/hub/threads` with `externalSource` and `externalId` upserts: the
  partial unique index `channels_external_source_id_unique` deduplicates, a
  concurrent insert is recovered from the `23505` violation, and a hit returns
  `{ id, title, reused: true }`.
- `POST /api/hub/threads/:threadId/messages.batch` inserts 1 to 100 messages in
  one transaction. `autoRespond` fires at most once, for the last user message,
  so a replayed history does not start one agent turn per message.

## Event stream

`GET /api/hub/events` lists events (filter with `types[]`, see
[event-chain.md](event-chain.md)). `GET /api/hub/events/stream` is the
Server-Sent Events version:

- `event: event` frames carry the event JSON and its id; reconnect with
  `?since=<ISO timestamp>` to catch up.
- `event: heartbeat` every 30 seconds keeps proxies from closing the connection.
- The handler subscribes before it drains the catch-up, buffers live events
  (cap 1,000) and then writes through. An event can arrive twice across that
  boundary, so consumers dedupe by event id.
- The stream manager is in memory, so it fans out within one API process only.

## Write provenance

`POST /api/hub/entities` accepts `source`, one of `HUB_WRITE_SOURCES`
(`packages/types/src/proposals/index.ts`): `intelligence`, `agent`,
`openwebui-pipeline`, `extension`, `cli`, `n8n`, `raycast`. The response echoes
`effectiveWorkspaceId` so the caller can see the scope it resolved to.

## Agent keys and the human they act for

An agent key can carry `api_keys.linked_user_id`, the human it acts for. When
it does, `POST /api/hub/memory` also writes the fact under that human (sub-token
keys excluded). `POST /api/hub/setup/agent` resolves the linked human when none
is given only on a single-human pod; on a pod with more than one human it
returns 409 `LINKED_USER_REQUIRED` with the candidates. Pod-wide agent keys
carry no linked human and are governed as their own principal.

## Webhook subscriptions

`/api/hub/webhooks` registers push subscriptions. See
[webhooks.md](webhooks.md).

## History

- 2026-05: the Hub Protocol source list included `openclaw`; it was removed
  with the OpenClaw surfaces (2026-10-14).
- The sub-token feature was opt-in (`HUB_PROTOCOL_SUB_TOKENS=true`); it is now on
  by default and inert unless a request sends `X-External-User-Id`.
- `setup/agent` used to link the oldest human on the pod silently; it now fails
  closed on multi-human pods.
