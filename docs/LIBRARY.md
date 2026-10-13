# The Library

**Capture is your words, read now. The Library is everything you keep:** shared, saved, dropped, forwarded. Plan and decisions: [`CAPTURE_LIBRARY_PLAN.md`](CAPTURE_LIBRARY_PLAN.md). Builds on [`IMPORT_CURATE_BUILD.md`](IMPORT_CURATE_BUILD.md).

The contract every client reads is `@synap-core/types/imports` → `library.ts` (items, groups, curate ops, requests and results). Labels go through `@synap-core/types/vocabulary` (`resolveLibraryStatusLabel`).

## Model

| Thing                     | Where it lives                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Library item            | A `documents` row with `metadata.importItem` (staged by the import door). The Library is a **lens** over every such row, across import runs.                                                                                                                                                                                  |
| The person's triage of it | `metadata.importCuration`: `decision`, `note`, `groupIds` (Library group ids), `suggestedGroupIds`, `dismissedGroupIds`, `archivedAt`, `builtAt`, `captureNoteId`. Legacy `groupKeys` stay readable for open imports.                                                                                                         |
| The light read            | `metadata.importRead` (`LibraryItemRead`: status, summary, chars, readAt, suggestedActions). Written only by the `library-light-read` worker.                                                                                                                                                                                 |
| The read text             | **Not** the document body: it is stored at `library-read/<user>/<item>.txt` (`metadata.importRead.textKey`), so a file's bytes stay intact for Build.                                                                                                                                                                         |
| A group                   | A row of `library_groups` (migration 0326): note, outputs, `container_entity_id`, `built_at`, `building_at`, `build_proposal_ids`, `archived_at`. Unique `(user_id, key)`. Owner-floored (`access/registry.ts`, rule `user`). Not an entity before Build on purpose: entity writes fire automations, embeddings and indexing. |
| A run                     | An import session (`focus_sessions.metadata.importCuration`), the unit of undo. `library.add` appends to the open **"Kept from <device>, <day>"** run (`metadata.libraryRun`), one per device, day and lens.                                                                                                                  |

**A Library item is never a row of `captures.list` or `documents.list`**, before or after Build (`notLibraryItemWhere`, `@synap/database`). It **is** in search from the moment it is kept: a title-only row first, its read text after the light read (`searchIndexableDocumentWhere`, `loadDocumentBodyTexts`).

**Embeddings are deferred.** The pod has no document vector store (`entity_vectors` references entities only), so the light read writes text and a summary, and search is Typesense full text. Vectors come when a document vector store exists.

## Doors

tRPC `library.*` (`packages/api/src/routers/library.ts`), every one owner-floored and Zod-validated:

| Door        | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`       | Keep 1–100 items. Library-wide dedup (a link kept again, from any device, is the same item). A share-time `note` becomes a **Capture** (door `library_note`, a row of "my captures", openable at `/capture/:id`) linked to every item; `captureNoteId` links a later call of the same share to that note. `readNow` (one item) runs Read now; a failure is said in `readNowFailed`, the item is kept regardless. Queues the light read and a title-only search row. |
| `list`      | Newest first, keyset-paged on `(created_at DESC, id DESC)` with a microsecond cursor (served by `documents_library_items_idx`). Filters: group / `ungrouped`, read status, archived, space, project, text.                                                                                                                                                                                                                                                          |
| `groups`    | Every live group with counts (`items`, `read`, `notRead`, `needsFile`, `newSinceBuilt`, `actions` = unrun chips) plus `ungrouped` / `archived`. Optional space/project lens.                                                                                                                                                                                                                                                                                        |
| `group`     | One group and the first page of its items.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `curate`    | Ops applied in order, atomically (a bad op writes nothing): `group.create/update/archive/merge/items`, `item.decide/note/groups/archive/unarchive`, `suggestion.accept/dismiss`. Returns the touched groups as they now read.                                                                                                                                                                                                                                       |
| `search`    | ONE search over captures (titles) and the Library (title, card, URL, read summary, notes). Archived items stay findable.                                                                                                                                                                                                                                                                                                                                            |
| `readNow`   | One item structured now and filed alone (no group container). Governed. AI rate-limited.                                                                                                                                                                                                                                                                                                                                                                            |
| `runAction` | One suggested chip → one governed proposal (`services/library/run-action.ts`).                                                                                                                                                                                                                                                                                                                                                                                      |
| `build`     | A group → one governed bundle through the shared Build core (`buildImportMembers`). A rebuild reads only the items staged after `built_at`; nothing new is refused (`nothing_new`). Claims the group (`building_at`) so a double tap is refused. AI rate-limited.                                                                                                                                                                                                   |
| `health`    | `{ unread, groupsWaiting, oldestWaitDays }` — also orient's `StartHere.library`.                                                                                                                                                                                                                                                                                                                                                                                    |

Hub REST for the CLI, the extension and Raycast: `POST /api/hub/library/add`, `GET /api/hub/library/list`, `GET /api/hub/library/search`.

**Nothing an agent sends lands in the Library.** The Hub `add` door refuses an agent key or the IS's internal key (`AGENT_USE_CAPTURE`); there is no MCP Library "add" tool. The AI's door, MCP `synap_capture`, is unchanged.

## Groups made inside an import

A group made in an import session (before the Library) is **adopted lazily**: the first Library read turns it into a `library_groups` row (note, outputs, origin, built state carried over), stamps `libraryGroupId` on the session's group and adds the id to its members — once, idempotently. No data migration rewrites rows.

## Rebuild = update mode

A group built before is **rebuilt, never twinned**. `library.build` passes the group's earlier bundles (`build_proposal_ids`) and its recorded container to the Build core, which reads what they made from their stamped `proposals.data.materialized.byOp` (`resolvePriorBuild`, live rows only) and files `update_*` ops (`update_entity` / `update_skill` / `update_playbook` / `update_automation` / `update_rule` / `update_view`, each stamped `{before, patch}` so revert restores `before`) plus new things only where nothing exists.

- **The container.** Before approval a first bundle has only a ref, so nothing is recorded then. The next build resolves the real container from that bundle's stamp, reuses it, and records it in `library_groups.container_entity_id`; a bundle that applies at once records it immediately. Every later rebuild reuses the same entity.
- **A rebuild waits for review.** While the group's newest bundle is still pending, a rebuild would twin what it makes: the service refuses with `previous_build_pending` and the tRPC door answers `CONFLICT` ("approve or reject it, then build again"). The claim is released.
- A rebuild reads only the items staged after `built_at`; nothing new is refused (`nothing_new`).

## Lists stay alive

A List a Build makes for a group carries `config.membersOf = <container entity id>`, a **view scope** in `views.execute`: it shows the container's CURRENT members (a `parent_of` edge each), so a rebuild that attaches new members grows the List without editing it. The scope only narrows: it is ANDed with the access floor and the List's own filters, so a member of a kind the List does not show stays out.

## Keep it alive (L5)

A daily pass (`library-keep-alive` queue, **04:23 UTC**) keeps the Library from becoming a pile without making it an inbox:

- **Quiet archive.** An ungrouped, never-built item unseen for 90 days (clock: `importCuration.seenAt`, else the day it was kept) gets `importCuration.archivedAt`. Still searchable; a grouped item is never archived from under its group.
- **"Build one group"** (`library.build_suggestion`): the person's longest-waiting group, at most once a week, as a notification with registry role `suggestion` — never a pending proposal (pending reads as blocking).
- **Resurfacing** (`library.resurface`): "From your Library, for <project>" for kept items that name a project worked on this week, or were kept into it.
- **Pod setting** `pod_settings.settings.libraryKeepAlive` `{ enabled (default true), archiveAfterDays (90; 0 = never) }`, through `proactive.getLibraryKeepAlive` / `setLibraryKeepAlive` (pod admins).

## Not yet

- AI group suggestions for new items: `suggestedGroupIds` is read and curated here; the light-read wave writes it.
