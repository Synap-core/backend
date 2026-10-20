# Realtime

> Verified against code on 2026-10-20 (backend@cc4b2d81). Migrated from Synap's
> internal team docs on 2026-10-20.

The realtime service (`packages/realtime`) is a separate Node process that
carries presence, server-to-client domain events and Yjs co-editing over
Socket.IO. It listens on `REALTIME_PORT` (default 4001). In the Compose stack
Caddy routes `/socket.io/*` to `realtime:4001` (`deploy/Caddyfile`), so clients
use the pod's own origin for both HTTP and WebSocket.

Content edits flow through Yjs. tRPC on the API (port 4000) handles document
metadata, editing sessions, explicit saves and version history.

## Processes and files

| File                                     | Role                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| `packages/realtime/src/server.ts`        | Socket.IO server, origin policy, `/presence` namespace    |
| `packages/realtime/src/session-auth.ts`  | `verifyHandshakeUser`: the one user identity check        |
| `packages/realtime/src/api-key-auth.ts`  | Service-account (API key) handshake                       |
| `packages/realtime/src/room-authz.ts`    | Who may join a `/presence` room                           |
| `packages/realtime/src/bridge.ts`        | HTTP endpoints the API calls (`/bridge/emit`, `/yjs/...`) |
| `packages/realtime/src/yjs-server.ts`    | Yjs rooms, load and persistence                           |
| `packages/realtime/src/document-room.ts` | The text-document room contract (cache, seed, revision)   |

## Origins

The handshake is credentialed, so the server does not reflect every origin.
`isAllowedRealtimeOrigin` (in `server.ts`) mirrors `apps/api/src/cors-origin.ts`:
it allows no origin or `null` (native apps, Electron), subdomains of
`SYNAP_BASE_DOMAIN` (https only in production), the explicit `ALLOWED_ORIGINS`,
`PUBLIC_URL` and `FRONTEND_URL`, and origins of approved cross-origin
applications (`federated_application_connections`).

## `/presence` namespace

Presence (who is viewing what, cursors, typing) and domain events share this
namespace. It never carries document content.

**Handshake.** `socket.handshake.auth` carries either:

- `{ userId, token, viewId?, viewType?, workspaceId? }` for a person or agent
  user. `token` is a Kratos session (token first, cookie value as fallback) and
  must resolve to the same `userId`; a client-asserted `userId` alone is
  rejected. If `workspaceId` is given, the user must be a member of it.
- `{ apiKey }` for a service account. The key must be active, unexpired and
  carry the `realtime:observe` scope (`api-key-auth.ts`). Such a socket may
  join any `workspace:<id>` room on the pod; per-workspace limits for
  service accounts are not implemented.

**Client to server events** (`server.ts`): `cursor:move` `{x, y}`, `typing`
(boolean, or `{ isTyping, documentId }`), `heartbeat`, `ping_heartbeat`
(answered with `pong_heartbeat`), `collaboration:event`, `presence:request`,
`join-room`, `leave-room`. Cursor and typing are ignored unless the socket has
a view. For Yjs views (documents, whiteboards) cursors travel through Yjs
Awareness instead of `cursor:move`.

**Server to client:** `presence:init` `{ users, yourColor }` on connect and
`presence:update` (the user list).

**Rooms.** Rooms are `<prefix>:<id>`. `canUserJoinRoom` decides per prefix and
denies anything else:

| Prefix      | Who may join                                                        |
| ----------- | ------------------------------------------------------------------- |
| `user`      | that user                                                           |
| `workspace` | members of the workspace                                            |
| `channel`   | readers of the channel (`canUserSeeChannel`, the channel read rule) |
| `view`      | the view's owner, or members of its workspace                       |

## Domain events (API to clients)

The API does not hold sockets. It POSTs `{ event, data, target }` to the
realtime service's `/bridge/emit` (`packages/api/src/utils/domain-event-bridge.ts`,
`chat-realtime-broadcast.ts`), which emits into the `/presence` rooms for the
target. When `BRIDGE_SECRET` is set the request must carry it in
`x-bridge-secret`; when it is unset every request passes and the service logs a
warning in production. Set it on any pod reachable from outside.

The bridge validates the payload with `validateEmitPayload`: an event with a Zod
schema in `packages/events/src/realtime-schemas.ts` (`EventSchemas`) must match
it or the bridge returns 400; an event without a schema passes through unchanged.

Event names are governed by the registry in `packages/types/src/events/index.ts`
(`EventNames`, payload types in `DomainServerToClientEvents`). New events use
`{actor}:{entity}:{action}`; see
[decisions/realtime-event-naming.md](../decisions/realtime-event-naming.md) for
the convention and the checklist. Emit through `emitTyped(event, payload, target)`
(`packages/api/src/utils/event-emit.ts`): it infers the payload type from the
name and throws unless the target names at least one of `workspaceId`, `viewId`,
`userId`, `channelId`.

## Yjs co-editing

y-socket.io registers a dynamic namespace `/yjs|<room>`. The handshake carries
the same `{ userId, token }` as presence and is verified with
`verifyHandshakeUser`; access to the room's document is then resolved with
`resolveDocumentRoomAccess` (`vendor/document-access.ts`). A client whose declared `editorSchema` is older
than the room's is served read-only.

| Content    | Room name                 | Yjs structure         | Canonical storage                      |
| ---------- | ------------------------- | --------------------- | -------------------------------------- |
| Document   | `{documentId}`            | editor fragment       | markdown at `documents.storage_key`    |
| Whiteboard | `whiteboard-{documentId}` | `tl_map_{documentId}` | tldraw JSON at `documents.storage_key` |

A whiteboard's `documentId` is the view's `documentId`, not the view id.

**Text documents.** The markdown in object storage is canonical; the room's Yjs
state is a cache in `documents.working_state`, trusted only while
`working_state_revision` equals `documents.content_revision`. Any other writer
(an approved edit, a restore, a non-collaborative save) moves
`content_revision` through `claimDocumentRevision`, which invalidates the cache.
A room with no trusted cache starts empty and asks one client to seed it from
the markdown (the `synap-room` Y.Map: `revision`, `seedRevision`, `seedClaim`,
`loadError`, `schemaVersion`; the web client keeps a mirror of these keys, and
the two key sets must stay identical). A room that failed to load sets
`loadError`; clients must not seed or write back into it.

**Persistence** (`yjs-server.ts`, interval 10 s from `server.ts`):

| Trigger                                                                                 | Document                                                        | Whiteboard                                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| Debounced update                                                                        | Yjs cache to `documents.working_state`                          | tldraw JSON to object storage                           |
| Last connection closes                                                                  | cache, then a room-close checkpoint of the markdown if it moved | final flush, then one rolling `<storageKey>.bak` backup |
| `doc-autosave` / `whiteboard-autosave` cron (every 30 min, `packages/jobs/src/cron.ts`) | autosave checkpoint                                             | autosave snapshot                                       |

A whiteboard upload that fails on every attempt is recorded and reported by
`GET /health/yjs` on the realtime service; `updatedAt` is only bumped after a
verified save. When the last connection closes, the document's active editing
sessions are marked ended.

`GET /yjs/:roomId/state` and `POST /yjs/:roomId/restore` on the realtime
service are behind the same bridge secret as `/bridge/emit`.

## Editing sessions and versions (tRPC)

| Action                  | Document                                | Whiteboard (by `viewId`)        |
| ----------------------- | --------------------------------------- | ------------------------------- |
| Start / end a session   | `documents.startSession` / `endSession` | not needed                      |
| Explicit save           | `documents.saveVersion`                 | `whiteboards.saveVersion`       |
| List versions           | `documents.listVersions`                | `whiteboards.listVersions`      |
| Restore                 | `documents.restoreVersion`              | `whiteboards.restoreVersion`    |
| Preview a version       | `documents.getVersionPreview`           | `whiteboards.getVersionPreview` |
| Load / save without Yjs | -                                       | `views.get` / `views.save`      |

## Troubleshooting

- **Socket never connects.** Check the origin is allowed and that the handshake
  sends a valid Kratos session `token` with the `userId`.
- **Room stays empty.** Check the room name (`{documentId}` or
  `whiteboard-{documentId}`) and whether `loadError` is set in the room; then
  the realtime logs (`docker compose logs realtime`) for `[Yjs]` lines.
- **Whiteboard empty after refresh.** Check `GET /health/yjs` for a recorded
  upload failure and that the object at the document's `storageKey` is not
  empty.

## History

- The Yjs gate used to trust the client's `userId`; it now verifies a Kratos
  session with the same check as `/presence`.
- Text documents used to persist Yjs updates as `document_versions` rows. They
  now keep the Yjs state as a revision-stamped cache and checkpoint the
  markdown instead.
- The server used to accept every origin; it now applies the API's origin policy.
