# Import → Curate → Build

**Status:** founder-approved plan (2026-10-12), being built. Replaces
`IMPORT_ONBOARDING_WIRING.md` and `IMPORT_QUALITY_STATE.md` (retired: they
described `submitBatch`, which is deleted, and an analyze that was not
deterministic). Amends `CAPTURE_IMPORT_ARCHITECTURE.md` §0/§2.

## 1. The split

|               | Capture                                    | Import                                                                            |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| What comes in | one thing the person is writing or sharing | a batch the person did not write: files, links, videos, notes                     |
| Reads content | immediately                                | only at **Build**, only for **kept** items, guided by the person's notes          |
| AI on entry   | structures the item                        | one cheap pass over **titles** to propose groups                                  |
| Output        | entities                                   | per group, one governed bundle: things, the group, Tools, Templates, Rules, Lists |
| Where         | everywhere                                 | collect anywhere; curate on desktop (light on relay); build anywhere              |

Rule for clients: **a capture is what you write; an import is a batch you
didn't write.** A share appends to the open import when one is open.

## 2. The three steps

1. **Collect** — items are STAGED without reading content: title, source
   host/platform, oEmbed/OpenGraph card, file name/mime. One AI pass over
   titles (with what the pod already has) proposes groups; an item may be in
   several. Fallback when the AI is unavailable: deterministic groups by
   platform/host/file type, and the response says so.
2. **Curate** — a note per group (every item inherits it); per-item
   exceptions: exclude, later, item note; move items between groups.
3. **Build** (per group) — read only kept items (readable page, an attached
   or staged file through the extractor; caption items have no pod reader yet
   and are filed from their card and reported `unreadable`; title-only items
   are not read), structure each with `instructions` = item note + group note
   (imported text is data, never instructions), reuse a matching Template
   (Tools and Rules are not matched yet), then file ONE `submitCaptureGraph`
   with `sessionId` = the import. Rules arrive switched off, Templates as
   drafts. A Build claims its group (`buildingAt`) under the session lock, so
   a second Build of the same group is refused (`already_building`). Undo =
   the import session's revert.

## 3. Where it lives (existing primitives only)

| Concept              | Lives in                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| Import               | a focus session with `metadata.run`; phase `collecting → curating → building → done`    |
| Staged item          | an intake-source document, marker `pending: "awaiting_curation"`, `metadata.importItem` |
| Item decision + note | `documents.metadata.importCuration` (sibling of `intakeSource`, which has one writer)   |
| Groups + group notes | `focus_sessions.metadata.importCuration.groups[]`                                       |
| Group after Build    | a container entity (corpus-map shape) + one `parent_of` edge per member                 |
| A List               | the `create_view` composite op in the same bundle (below)                               |

Contract types: `@synap-core/types/imports` (`packages/types/src/imports/curate.ts`).
API: the tRPC `import` router (`stage`, `list`, `get`, `group`, `curate`,
`attachFile`, `build`, `discard`), owner-floored. Opening an import in a space
requires write access to it (`assertWorkspaceWrite`); staged and attached
files pass the upload door's type allowlist (`isAllowedMimeType`).

## 4. Composite ops a bundle uses

- `create_entity` / `create_relation` — the things and the group membership.
- `create_skill` (Tool), `create_automation` (Rule behaviour), `create_rule`,
  `create_playbook` (Template, always `draft`).
- `create_view` (List): `{ ref, name, viewType: list|table|kanban|gallery,
workspaceId?, scopeProfileSlugs?, entityRefs?, containerRef?, config? }`.
  Governed as `view.create`; materialized last through `views.create`. The
  members become the view's fixed set (`query.entityIds`, honoured by
  `views.execute`); the group container is recorded as `config.membersOf` for
  a later "members of" filter. Kinds: the op's slugs, else the members' kinds.

Preflight (`validatePlanOperations`, run on submit, dry run and revision)
refuses, before anything is filed:

- an event `create_automation` without `flowDefinition.triggerConfig.eventPattern`;
- a `create_playbook` in a bundle with no space;
- a `create_view` with neither kinds nor members, or a dangling ref.

Revert: `create_playbook` and `create_view` are recorded (`playbookIds`,
`viewIds`) and undone by a proposal or session revert — the untouched draft
playbook is archived, the untouched list deleted; an edited list or a
playbook that has run is kept and named.

## 5. Legacy analyze path (still served)

`import.analyze` / `analyzeLarge` / `enqueueLargeImport` and REST
`/import/analyze` / `/import/enqueue-corpus` are **deterministic by default**
(D4): `aiStructure` defaults to `false`; only `true` sends content to the IS
(deep structuring for prose, AI typing for rows). `analyzeLarge` without it is
`analyze()`'s deterministic run. The corpus job carries the flag. A rerun
replays an import with the engine its parent recorded. The CSV column→kind
table plan keeps its own flag (`csvTablePlan`, on).

## 6. Decisions (as recommended)

- D1 the room renders by phase; no new navigation view.
- D2 group membership = `parent_of` container → item.
- D3 a group becomes a List (container + list view) or a Project, per the person's choice.
- D4 import reads content at Build only (default flipped).
- D5 link metadata at Collect via the ungated `readPublicUrl()`, metadata only.
- D6 video content: fetched on the person's device, plus files they provide.
- D7 contacts / Telegram / LinkedIn stay direct for now.

## 7. Side effects to carry

- An open import must not attract unrelated captures (non-`work` session kind).
- `revertSession` reverts proposals, not sources; `import.discard` soft-deletes never-built staged items.
- `captures.list`, `documents.list` and `fullReindex` exclude staged items.
- UI copy: Tools, Templates, Rules, Lists, Space, Things; status words come from the vocabulary SSOT.
- Spend: Collect = one IS call per import; Build = N+1 per group, estimated before the person presses Build.
