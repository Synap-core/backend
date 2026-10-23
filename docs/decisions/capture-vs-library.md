# Capture is your words; the Library is what you bring in

> Verified against code on 2026-10-20 (backend@c31e261a). Condensed from the
> Capture and Library plan (approved 2026-10-13) and the capture and import
> decision record of 2026-06-01, both removed from the repository on
> 2026-10-20. How the Library works: [`../LIBRARY.md`](../LIBRARY.md). The
> import flow it builds on: [`../IMPORT_CURATE_BUILD.md`](../IMPORT_CURATE_BUILD.md).

- **Status:** Accepted 2026-10-13. The registry and the client redirects are
  built; refusal and removal wait for the criteria below.
- **Scope:** the person's own doors. The agent's capture door is out of scope
  and unchanged (see "The agent door").

## Context

The June 2026 rule was "a capture is what you write; an import is a batch you
did not write", so a single shared link, photo or file still went to Capture.
Capture handled such content badly: links were classified from the URL text
alone, shared photos went unread by the default text model, and every item
spent AI on arrival whether or not anyone looked at it again. Two ways to bring
a link in also confused people about where things went.

The June record also fixed the write invariant that still holds: import follows
the same permission model as every other capability. AI- or agent-originated
imports file a governed proposal; a person's own import is previewed before it
is created. Analyze is deterministic unless the caller opts in to AI
structuring.

## Decision

The line is **authorship, not cardinality**:

| Input                                                            | Route                               |
| ---------------------------------------------------------------- | ----------------------------------- |
| Text the person typed or dictated, even if it contains a URL     | Capture                             |
| Anything shared, saved, dropped, selected-and-saved or forwarded | Library                             |
| A note typed at share time                                       | Capture, linked to the Library item |

The rule is one pure function, `routeIntake()` in `@synap-core/types/intake-route`
(`packages/types/src/intake-route/index.ts`).

The plan built it in waves that code comments still name: L1 the rule and the
deprecation record, L2 the standing Library on the pod, L3 build as update, L4
clients route by the rule, L5 keep-alive, L6 refuse then remove.

Numbered decisions that code comments cite:

- **Decision 3: the Library is a lens, not a store.** A Library item is a
  staged intake document (`metadata.importItem`); the Library read model spans
  import runs. Groups persist in `library_groups` (migration 0328).
- **Decision 4: a Library item is never a capture or a document-list row,**
  before or after its group is built. It stays out of "my captures" and the
  documents list (`notLibraryItemWhere`,
  `packages/database/src/utils/import-staging.ts`) but is indexed for search
  from the moment it is kept.

Guardrails, each a requirement: a cheap light read on save so the Library is
searchable before any build; action chips (read now, add to calendar) that
propose, never execute; a share-time note is a capture; stable groups that are
rebuilt as updates, never twins; keep-alive without inbox pressure.

## The agent door

MCP `synap_capture` and Hub capture with an agent key stay exactly as they are
(founder, 2026-10-13). They are not routed to the Library, not deprecated and
not refused at any stage. Agents do not write the Library. The registry lists
them as kept (`KEPT_AGENT_INTAKE_DOORS`).

## Deprecating the old paths

Every person-facing path where non-typed content enters through Capture has a
row in `DEPRECATED_INTAKE_PATHS`. Existing link and file captures stay where
they are; nothing is migrated or silently re-routed.

| Stage        | What happens                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `marked`     | A registry row plus `@deprecated` JSDoc at the code site                                                                         |
| `redirected` | Clients route to the Library; the pod still accepts the old input and records a `deprecated_intake_path` event naming the caller |
| `refused`    | A person's door gets a typed `USE_LIBRARY` error that names the Library door; never an agent key                                 |
| `removed`    | The code is deleted and the row moves to `REMOVED_INTAKE_PATHS` with its commit                                                  |

On 2026-10-20 the pod rows are `marked`, the relay, browser and extension rows
`redirected`, and `REMOVED_INTAKE_PATHS` is empty.

### Removal criteria

All must hold, checked in a session with the evidence quoted:

- Library save, light read and Read now used for at least 14 days on relay and
  browser by the founder.
- No Read-now regression against single photo or link capture: OCR text,
  receipt to entity and the calendar chip verified on real items.
- The CLI, Raycast and the extension each have a Library door (`/library/add`)
  and are released.
- Zero `deprecated_intake_path` events from first-party clients for 7
  consecutive days.
- The founder confirms in the session.

`removed` additionally needs `refused` live for at least 14 days with zero
first-party events.
