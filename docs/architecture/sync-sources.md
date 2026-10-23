# Adding a sync source

> Verified against code on 2026-10-20 (backend@cc4b2d81).

A sync source mirrors records from a connected provider (Google Calendar,
Gmail, Google Contacts today) into the pod. It is configuration plus one pure
mapping function. There is one trigger door (`connection-sync.ts`) and one write
door (`EntityUpsertService`); never add a second pipeline per provider.

Code: `packages/api/src/services/event-sync/`.

## 1. Declare the sync kinds on the capability template

Sync settings live on the provider's capability template, under
`tools[<provider>].metadata.sync`. Synap's official templates are maintained
outside this repository (for example `nango-google.capability.json`).

```json
{
  "tools": {
    "google": {
      "metadata": {
        "sync": {
          "enabled": true,
          "kinds": {
            "event": { "enabled": true, "windowDays": 90, "itemLimit": 200 }
          }
        }
      }
    }
  }
}
```

- The top-level `sync.enabled: true` is required. Without it the runner returns
  `{ skipped: true, reason: "sync_disabled" }` before reading any kind, with no
  error. `kinds.<kind>.enabled` alone is not enough.
- `windowDays` and `itemLimit` bound the first run.
- These are defaults: a user's override in the installed copy of the template
  survives a reconcile.
- A provider reached through the control plane's connector proxy must declare
  its host as a `baseUrlOverride` in the template; the proxy's host allowlist is
  derived from the shipped templates, so an undeclared host is refused.

## 2. Register a sync-kind handler

Register the handler with `registerSyncKind`
(`sync-kind-registry.ts`). Registration happens when the handler module is
imported, so the module must be imported for its side effect:
`connection-sync.ts` imports `./google-sync-kinds.js` for that reason. A new
provider's handler file needs the same import, or it never runs and nothing
reports it.

A handler has three parts; only the middle one is provider-specific:

- **Read** through a capability verb (for example `calendar_list`,
  `gmail_search`), the same execution door and governance gate as every other
  capability call. Never a bespoke HTTP client.
- **Map** with a pure function, no I/O: provider record to graph fragment
  (entities, relations, identity signals, optional external `url`). Being pure,
  it is tested against recorded fixtures (`map-*.test.ts`).
- **Phase**: advance `SyncPhase` (`fetching`, `mapping`, `review_ready`, then
  `synced` or `failed`; `not_connected` when sync is on but no live connection
  backs it) and the counts through the sync-state store, so status reports real
  progress.

## 3. Write through the one door

- Every write goes through `EntityUpsertService` (identity resolution on email,
  phone and URL signals; see [import-pipeline.md](import-pipeline.md)). Never
  write `entities` or `entity_external_links` directly from a handler.
- The first run of a connection and kind is filed as one `import.graph`
  proposal through the import orchestrator.
- Steady runs are gated per write action: the run's `SyncWriteGate` calls
  `resolveConnectionSyncDecision` once per `(subjectType, action)` it needs
  (`entity.create` and `entity.update` can resolve differently) and memoises it.
  `auto` writes directly; anything else is filed for review. A rule can widen
  create and update, never the floors on destructive writes.
- Every write carries `origin: "sync"`: it is indexed and embedded, but event
  automations skip it unless they set `triggerConfig.includeSyncOrigin`, and it
  sends no outbound webhooks.

## 4. External link and "open in source"

If the record has a natural web URL (a calendar event's `htmlLink`), store it on
`entity_external_links.url`. Not every kind has one: Google contacts and the
people and companies resolved from Gmail carry none. Where a URL is stored,
extend `externalTargetFor(provider, link)`
(`packages/api/src/services/places/external-target.ts`) with a host-pinned entry:
it returns the stored URL only if it is `https:` and on a known host for the
provider, and never builds a URL from an id. Clients then get "Open in
<provider>" through `places.openTarget` with no client code.

## What you get without more code

- a bounded first sync with one grouped review;
- governance per connection, editable by the user;
- progress in every client: tRPC `connectors.syncStatus`, Hub REST
  `GET /api/hub/connectors/sync-status`;
- "open in source" where a URL exists.

## Triggering

The connector broker's webhook lands on the control plane, which calls the
pod's `POST /api/connectors/sync-trigger` (`apps/api/src/routers/connectors.ts`);
the pod then enqueues the connection sync. Connecting a provider goes through
one door for every provider (`connectors.session`); do not add a second connect
flow.
