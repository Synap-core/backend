# Capture = your words · Library = everything you bring in: plan

**Status:** plan approved in principle (founder, 2026-10-13: "agree on all recommendations"). Each wave starts with its own session.
**Decision brief:** pod document "Decision brief — Capture = your words, Library = everything you bring in" (session "Decision: capture = your words…").
**Evidence:** these reports in the build scratchpad:

- `10-entrypoints-map.md`: every entry point, file:line.
- `11-intake-model-prior-art.md`: 30+ products.
- `12-vision-fit.md`: north star and past plans.

**Builds on:** `IMPORT_CURATE_BUILD.md` (Import → Curate → Build, shipped 2026-10-12 on `claude/festive-turing-ebdyco`).

---

## 1. The model (decided)

|                 | **Capture**                                                       | **Library**                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What            | What you **type or dictate**                                      | Everything you **bring in**: shared, saved, dropped, forwarded                                                                                                      |
| When it is read | Now. AI files it.                                                 | **Light read on save** (text / OCR / transcript, short summary, embedding). **Build** (structure, Tools, Templates, Rules, Lists) runs only when you ask, per group |
| Where           | Composer, dictation (relay FAB, home bar, ⌘N text, widgets, Siri) | Share sheet, Save page/link, drop, import, extension                                                                                                                |
| Life            | One capture → filed                                               | **One permanent Library per pod**, lensed by space/project. Groups persist and grow; Build re-runs on new items and proposes **updates**, never twins               |

**One search:** Search and Ask span both.

**Five guardrails** (each is a requirement, not an option):

1. Cheap processing on save, so the Library is searchable even before any Build.
2. Action chips on actionable items (receipt, date, contact, task): a one-tap **Read now** / **Add to calendar**. AI proposes, never executes.
3. A note typed while sharing **is a Capture**, linked to the item.
4. Stable structure: groups persist, a built thing shows "N new since built", rebuilds propose updates, nothing re-clusters on each arrival.
5. Keep it alive: a weekly "build one group" proposal, resurfacing tied to current work, quiet auto-archive (still searchable), no inbox-zero pressure.

**The AI's capture door is out of scope and unchanged (founder, 2026-10-13).** MCP `synap_capture` (and the Hub capture an agent calls) stays exactly as it is: an agent may keep sending its words, links or files there, and they are processed as today. It is **not** routed to the Library, **not** deprecated, and its description is **not** rewritten. `routeIntake()` decides only for the person's own doors. Library tools for agents are optional, later and additive (read/search), never a replacement for `synap_capture`.

**THE routing rule** (the person's doors only). One pure function `routeIntake()` in `@synap-core/types/intake-route`, used by every door and guarded by a tripwire:

| Input                                                                                                                                      | Route                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Text the person typed / dictated (even if it contains a URL)                                                                               | `capture`                              |
| Anything shared / saved / dropped / selected-and-saved / forwarded (link, page, file, photo, screenshot, post, video, folder, shared text) | `library`                              |
| A note typed **at share time**                                                                                                             | `capture` (linked to the Library item) |

---

## 2. Deprecation: old link and file captures (read this before touching capture)

**What is deprecated:** every path where **non-typed content** (a URL, an HTML page, a file, a photo, a PDF) enters through **Capture** (`capture.structure` / `capture.execute` / `/capture/structure` / `capture.thought` with `url`/`file`/`html`, the vision lane for captures, the link reader adjunct, the per-run photo cap, capture-side file staging), plus every client door that sends such content to capture.

**Why** (stated so any human or AI understands it without the history):

1. **Capture means "your words, read now".** Sending unread material through it mixes two intents in one box. Prior art shows the saved material then drowns the writing (Evernote clips, OmniFocus link piles, Keep screenshot backlogs).
2. **Capture handled such content badly:**
   - links were classified from the URL text alone (the page was never read);
   - shared photos were silently unread (the default model is text-only);
   - every item spent AI on arrival, even items never looked at again.
3. **The Library does it better:**
   - nothing is lost;
   - content is read cheaply and searchable;
   - urgent items get a Read-now chip;
   - structure is built deliberately, steered by your notes, with undo.
4. **Two parallel ways to bring a link in is product debt.** It confuses people ("where did I put it?").

**Existing data:** old file/link captures **stay where they are**. They are readable, searchable, and still openable from history. **No migration.** They are never re-routed silently.

**Lifecycle:**

| Stage                     | What happens                                                                                                                                                                                      | Gate to enter                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **1. Marked** (wave L1)   | Each deprecated path carries a registry row + `@deprecated` JSDoc pointing here.                                                                                                                  | this plan merged                                                                          |
| **2. Redirected** (L2–L4) | Every client door routes non-typed content to the Library. The pod still ACCEPTS url/file on capture (old CLI, Raycast, offline queue) but logs a `deprecated_intake_path` event with the caller  | Library save + light read + Read now live on relay **and** browser                        |
| **3. Refused** (L6)       | Capture answers url/file/html from a person's door (never from an agent key) with a typed error that names the Library door (`USE_LIBRARY`). Old clients see a clear message, never a silent drop | **Removal criteria** met (below)                                                          |
| **4. Removed** (L6)       | Code deleted (≈450–650 backend + 700–900 frontend lines, list in report 10 §2) and the registry row moved to `REMOVED_INTAKE_PATHS` with the commit                                               | Stage 3 live ≥ 14 days with zero `deprecated_intake_path` events from first-party clients |

**Removal criteria** (all must be true; checked in a session, evidence quoted):

- Library save + light read + Read now dogfooded **≥ 14 days** on relay and browser by the founder.
- No Read-now regression vs today's single-photo/link capture: OCR text, receipt to entity, and calendar chip all verified on real items.
- CLI, Raycast and the extension each have a Library door (`/library/add`) and are released. (MCP `synap_capture` is the AI's door and is not part of this.)
- `deprecated_intake_path` events from first-party clients = 0 for 7 consecutive days.
- The founder confirms in the session ("remove").

**Registry** (machine-readable, the SSOT for "what is going away and why"): `DEPRECATED_INTAKE_PATHS` in `@synap-core/types/intake-route`, following the `DEPRECATED_SURFACES` shape plus lifecycle:

```ts
{ id: "capture.url", host: "pod", since: "2026-10-13", stage: "marked",
  reason: "Capture is your words, read now. A link is material you bring in: it belongs to the Library (read cheaply, searchable, built on request).",
  replacedBy: "import.stage / Library (synap_library_add, /library/add)",
  removalCriteria: "CAPTURE_LIBRARY_PLAN.md §2", decisionDoc: "docs/CAPTURE_LIBRARY_PLAN.md" }
```

Rows:

| Host      | Rows                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| pod       | `capture.url`, `capture.file`, `capture.html`, `capture.vision`, `capture.linkReader`, `capture.thought.url` |
| relay     | `relay.note.attachments`, `relay.captureUrlHint`                                                             |
| browser   | `browser.saveLink.capture`, `browser.smartCapture`, `browser.quickCapture.file`                              |
| extension | `extension.savePage.capture`, `extension.tabScan`                                                            |
| CLI       | `cli.capture.url`                                                                                            |

A tripwire fails if a NEW person-facing call site sends url/file/html to capture outside the registry. The agent path (MCP `synap_capture`, Hub capture) is allowlisted by name as **kept**, not deprecated, and stays open at stage 3 and 4: "Refused" and "Removed" apply to the person's doors only.

---

## 3. Waves

Every wave:

- starts with an audit of what exists (extend, never twin);
- ends with gates green, negative controls, a review pass, and a push.

### L0: Shipped fixes before anything new

- Done: the reaper no longer stales an open import (61eea7d).
- Merge the Import → Curate → Build branches, deploy, bump the relay pin, dogfood the current curate flow (the baseline).

### L1: The rule + the deprecation record (small, no behaviour change)

- `@synap-core/types/intake-route`: `routeIntake(input)` + `DEPRECATED_INTAKE_PATHS` + tests.
- `@deprecated` JSDoc at each registry path.
- Rewrite the docs that state the old model:
  - PRODUCT.md "never organize anything" → "never lose anything; organize when you choose";
  - CAPTURE-IMPORT-UNIFICATION, CAPTURE-UI-CONSOLIDATION, INTAKE-CONSOLIDATION ("single file/URL → capture");
  - Smart URL Capture (→ Library readers);
  - IMPORT_CURATE_BUILD §1;
  - AGENTS.md copy.
- Vocabulary: "Library" (and retire the deprecated browser "Library" app name collision: it is hidden already; rename its id references in copy).

### L2: The standing Library (pod)

**Status (2026-10-13):** pod core shipped on `claude/festive-turing-ebdyco` — `library_groups` (0326), the read model, curate, add (runs, dedup, share note as a capture), build/rebuild (new items only) and Read now through the shared Build core, one search, health + orient `StartHere.library`, tRPC `library` + Hub `/library/{add,list,search}`. Light read + chips: see `library-light-read`. Reference: [`LIBRARY.md`](LIBRARY.md).

- **Model:** the Library is a lens over staged items (intake-source documents with `importItem`), not one giant session.
  - Items carry the Library marker.
  - Import runs remain the session/undo unit (one run per share batch / drop / import).
  - The Library read model spans runs.
- **Persistent groups:** groups move from `focus_sessions.metadata.importCuration` to a pod-level store. Use an existing table if one fits (audit: corpus containers / collections); otherwise a hand-written migration.
  - A group keeps its note, outputs, `builtAt`, built refs and a "new since built" count.
  - Items join groups incrementally: titles + light-read summary, existing groups as the vocabulary, a suggestion only (the person confirms or it auto-joins only above a high confidence).
- **Light read on save** (async job, cheap tier, budgeted):
  - URL → `readPublicUrl` text (metadata + body cap);
  - file → existing extraction;
  - image → OCR via the vision model with the pod's vision preference and the bulk lane;
  - audio/video file → transcript;
  - then a short summary plus an embedding;
  - **Instagram/TikTok remain metadata-only** (no scraping); the item asks for the file.
- **Action detection** on the light read (date / receipt / contact / task) → a `suggestedActions[]` chip list.
- **Caps:** remove per-import caps where the Library replaces them (2000 items / 40 groups / 400 titles / 200 run sources); page everything.
- **Doors:**
  - `library.add` (= `import.stage` without a batch, appending to a run per device/day);
  - `library.list` / `get` / `search` (one search with captures);
  - `library.readNow(itemId)` (single item: structure now, the old capture behaviour, explicitly chosen);
  - Hub REST `/library/*` for first-party clients. Optional later: read-only MCP `synap_library_search` for agents. No agent "add" door: agents keep `synap_capture`.
- **Fix found in the audit:** after Build, new items can join a built group, and the group can be rebuilt in **update mode**.

### L3: Build that updates (pod)

- **Update operations in composite proposals:**
  - `update_skill`, `update_playbook`, `update_automation`, `update_rule`, `update_view` (view update has no door today), plus `update_entity`;
  - each with stamp/revert;
  - preflight shows a diff.
- **Rebuild of a group:**
  - reads only new / changed items + the note;
  - matches existing built refs first;
  - proposes updates (diff) and new things only where nothing exists;
  - "N new since built" resets on approve.
- Lists become dynamic: the `membersOf(container)` view filter (deferred in IMPORT_CURATE_BUILD).

### L4: Clients route by the rule

- **relay:** share sheet / camera / single photo / single link → Library (one tap, background upload). Plus:
  - an optional note field (= a capture);
  - a Read-now toggle;
  - the FAB/composer stays Capture (text + dictation only);
  - a Library tab/section (counts, waiting age, groups, chips);
  - light curate: dictate a group note, "Build this group";
  - delete note attachments (deprecated).
- **browser:** Save page/link/selection, ⌘N file/link and the overlay file/link → Library. Plus:
  - the context menu keeps one "Add to Library" (plus "Read now");
  - the Import app becomes **Library** (the workbench = today's Curate, now standing);
  - Home shows the weekly build proposal and chips.
- **extension, CLI, Raycast:** switch to `/library/add`.
- Copy everywhere: Capture = "Write", Library = "Keep". Vocabulary door only.

### L5: Keep it alive

- Weekly "build one group" proposal (a pod rule, off by default until dogfooded, then on).
- Resurfacing tied to the current project/track.
- Auto-archive after N days untouched (still searchable, "Archived" mark).
- Library health in orient: unread count, groups waiting, oldest wait.

### L6: Refuse, then remove

Stage 3 then stage 4 of §2, only when the removal criteria hold. Delete code, move registry rows to `REMOVED_INTAKE_PATHS`, update docs.

---

## 4. Side effects to carry

- **Agents:**
  - `synap_capture` is unchanged: an agent's words, links and files go there exactly as today;
  - nothing an agent sends lands in the Library;
  - governance unchanged (Build bundles are proposals).
- **Spend:** the light read costs ~1 cheap call per item (budgeted, bulk lane, skipped over budget with a visible "not read yet" mark, never a silent drop).
- **Search:**
  - Library items are indexed after the light read;
  - staged-but-unread items get a title-only index row so they can be found immediately.
- **Onboarding:** the first run auto-proposes building the top group, so the "magic moment" stays under 10 min.
- **Offline (relay):** shares need a connection. Say so; spool later.
- **Old imports (per-batch):** become runs inside the Library; no data move.
- **The `captures.list` history keeps only typed captures going forward;** old file/link captures stay visible there with a "kept in history" mark.

## 5. Out of scope

- Server-side scraping of Instagram/TikTok/YouTube (never).
- Gmail/Drive sources (stay in the validated corpus design's W4/W5).
- Migrating old captures.
