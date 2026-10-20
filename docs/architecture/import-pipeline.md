# Import pipeline: identity resolution and the write path

> Verified against code on 2026-10-20 (backend@cc4b2d81). Migrated from Synap's
> internal team docs on 2026-10-20.

Data the person did not type (contact exports, connector syncs, files, notes
vaults) reaches the pod through several entry points but is written through one
path. This page covers that path and the deduplication behind it. The product
flow of an import (analyze, curate, build) is in
[IMPORT_CURATE_BUILD.md](../IMPORT_CURATE_BUILD.md); the capture and import
boundary is in [decisions/capture-vs-library.md](../decisions/capture-vs-library.md)
and [LIBRARY.md](../LIBRARY.md).

## Entry points

| Source                             | Entry                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown, Obsidian, CSV, bookmarks | tRPC `import.analyze` / `applyImport`, and `analyzeLarge` / `enqueueLargeImport` / `applyLarge` for large batches (`packages/api/src/routers/import.ts`) |
| LinkedIn archive                   | tRPC `import.linkedInContacts`, worker `linkedin-bulk-import` (`packages/jobs/src/workers/linkedin-bulk-import.ts`)                                      |
| Connector sync (Google)            | `connection-sync.ts`; see [sync-sources.md](sync-sources.md)                                                                                             |
| AI structuring                     | the Intelligence Service through the Hub Protocol, governed like any agent write                                                                         |

Analyze is deterministic by default; content is read with a model only when the
caller opts in (`aiStructure`).

## The write path

```
source record
  → mapping (per source)
  → EntityUpsertService.upsert(...)          identity resolution
      → materializeEntity(...)               the governed single door for a new row
          → EntityRepository.create(...)     scope, validation, property index, event
```

- **`materializeEntity`** (`packages/database/src/utils/materialize-entity.ts`)
  wraps `EntityRepository.create` and applies, in order: the relation-slug
  guard (an entity titled like a relation slug is refused), a per-type dedup
  policy, the `belongs_to_project` edge when a project is given, required
  provenance (`human`, `ai_agent` or `system`; there is no default), then the
  insert. The governance decision (write or propose) is made before it, in the
  router or worker.
- **Role profiles are never created as entities.** `EntityUpsertService`
  resolves a role slug (`client`, `partner`, ...) up front, so a match attaches
  the role as a facet to the matched entity instead.
- Imports may skip property validation: source extras (`importedAt`, counts,
  scores) are kept in the JSONB properties.

## Identity resolution

`EntityUpsertService` (`packages/database/src/services/entity-upsert-service.ts`):

1. **Exact re-import** by `entity_external_links (provider, external_id)`.
   Links are unique per provider, record and connection
   (`entity_external_links_provider_external_id_connection_idx`), so two people
   syncing the same shared record each keep their own link. Only the caller's
   own copy is resolved onto: this connection's row first, then an unstamped
   import link, then a row on an entity the caller owns.
2. **Cross-source match** by `entity_identity_signals (signal_type, signal_value)`,
   unique per signal, through `resolveIdentity` (strong matches only).
3. **No match:** `materializeEntity` with dedup `none` (steps 1 and 2 already
   ran), then register the signals and the external link.

Every call also registers new signals for the matched entity, so a later
import from another source that shares any signal resolves to it.

**Signal types:** `email`, `phone`, `linkedin_url`, `github_username`,
`twitter_handle`, `telegram_phone`, `website`. Normalisation is one function,
`normalizeIdentitySignal` (`identity-resolution-service.ts`), used for both
writes and lookups so they agree byte for byte. `extractSignalsFromProperties`
builds the signal list from a standard properties object.

Two records with no shared signal (a phone in one source, an email in the
other) still produce two entities; there is no merge service.

**Stable external ids.** Fallback ids derived from a name must be
deterministic (no batch index), so importing the same contact twice yields the
same id. Non-OAuth imports use the connection id sentinel `direct-import`.

The Google provider id is `google` (one integration for Gmail, Calendar and
Contacts), never `google-calendar` or `google-contacts`.

## Adding an import source

1. Parse structured data in pure TypeScript, with no platform I/O, so it runs in
   Node, the browser and tests.
2. For bulk work add a pg-boss worker in `packages/jobs/src/workers/` and
   register it in `workers/index.ts`.
3. Expose a tRPC procedure in `packages/api/src/routers/import.ts` that enqueues
   it.
4. Write every record with `EntityUpsertService.upsert()` and
   `extractSignalsFromProperties`. Per-source code is only the mapping.

## Exception: pod-to-pod sync

`packages/database/src/utils/sync-materializer.ts` (used by
`POST /api/sync/receive` and the `sync-pull` worker) replays events from a peer
pod by exact id with last-write-wins conflict resolution. It does not go through
`EntityUpsertService`: replicated rows must not be re-resolved or re-fire
automations.

## History

- 2026-04: imports called `EntityRepository.create` directly; Telegram and
  device-contact imports had their own tRPC procedures and workers. The
  `materializeEntity` door, per-connection link uniqueness and the deterministic
  analyze came later. `import.submitBatch` has been deleted.
- 2026-09-13: the per-record connector pipeline was replaced by the one sync
  door (`connection-sync.ts`).
