# Import & Structuring — Quality State & Roadmap

**Date:** 2026-06-01
**Purpose:** Where qualitative import+structuring actually stands, what's wrong, and the work to make it polished. Grounded in the real vault (`/Users/antoine/Documents/knowledge`) + a code audit of the AI path.

---

## 0. Honest status of what's been validated

- **Deterministic import** (parsers → graph proposal → `/capture/execute`): validated LIVE on the real vault (331 notes, content + folders + 148 relations). Real bugs found + fixed.
- **The AI path** (`capture.structure` LLM, agent prompts): **NOT yet exercised on import.** The assessment below is a CODE AUDIT, not a live run. This is the next thing to actually test.

---

## 1. The `note`-vs-`document` decision (user is right)

**Today:** markdown import → a `note` ENTITY with the whole body stuffed in `properties.content` (a 100KB-capped inline JSONB string, `seed-profiles.ts:123`).

**The problem with that:** notes' `content` property was designed for _quick captures_, not full markdown files. It gives you **no versioning, no diffing, no decoupled storage**, and a hard 100KB ceiling.

**The model already supports the right shape** — a **document linked to an entity**:

- `documents` table: stores body in **MinIO/R2** (`storageKey`), not inline; typed (`markdown`); `currentVersion`/`lastSavedVersion` (`schema/documents.ts:21-72`).
- `document_versions` table: **full snapshot per version** with author + commit message (`schema/documents.ts:78-109`) → real history + diffing.
- `entities.documentId` FK → an entity OWNS a document (`schema/entities.ts:49-51`).
- **`entities.create` already does the atomic entity+document path** when given `content` (`routers/entities.ts:415-450`): uploads to MinIO → creates the document row → creates the entity with `documentId`.

**Decision: markdown import should create a `note` entity + a LINKED DOCUMENT, not a content-property note.**

- Mechanism is already built — the import just needs to pass `content` to the entity-create path (which routes to the document flow) instead of cramming it into `properties.content`.
- Result: imported notes get versioning, diffing, MinIO storage, no 100KB limit, and the body lives where long-form belongs.
- Keep `properties.content` ONLY for genuinely short captures (the note profile's original intent).

**Where to change:** `import-orchestrator.ts:206-237` (markdown branch) and the graph-composite entity ops — pass `content` through to the create path rather than into `properties`. The composite `create_entity` op already supports a `description`; it needs to also carry `content` so approval materializes a document. (Small extension to `CompositeCreateEntityOp` + the approve loop's `entityCaller.create` call, which already accepts `content`.)

---

## 2. AI structuring quality — blunt assessment (CODE AUDIT)

The LLM path (`capture.structure` → IS `/api/structure`) is a **competent extractor, NOT a graph builder.** Overall graph quality grade: **C — flat, loosely connected.**

**Strengths:**

- Extracts entities + infers relations, low temperature (0.15) → deterministic.
- **Source-aware prompts** (`prompts/import-context.ts`) — genuinely good: per-source guidance (Claude export → people/projects/decisions, not message dumps; LinkedIn CSV → one contact, no invented companies). This is the best part.
- Forced output schema (entities[] + relations[] + followUp), confidence scoring.

**Critical gaps (why output is low-precision):**

1. **No search-before-create.** Neither the structure prompt nor the agent's `SECTION_ORGANIC_STRUCTURING` tells the AI to search for an existing entity before making a new one. → **orphans + duplicates by construction.** Dedup is a _downstream, human-driven_ step (UI "link to X" chips), not AI-driven.
2. **`existingEntityNames` is empty by default** (`capture.ts:279-289`) — the IS gets no context about what already exists unless the frontend passes it. So the LLM literally can't avoid dupes.
3. **Relations are optional** in the schema → many entities stay orphaned; relations that do appear skew to generic `relates_to`.
4. **Confidence is a weak signal** — a likely-duplicate gets confidence 0.4-0.5 but is still created.
5. **Cheap model tier** — structure runs on the free/`action` tier (deepseek-flash); fine for extraction, weak for the reasoning that good dedup/linking needs.
6. **One-shot, no feedback loop** — extract → done. No "search → decide link-vs-create → refine" loop.

**Net:** high recall, low precision. The user is left merging/linking afterwards — the opposite of "qualitative structuring."

---

## 3. The fix: make structuring search-first + relation-required

Priority order (each is a concrete, testable change):

**P1 — Search-before-create (biggest quality lever).**

- Agent path: add a `SECTION_SEARCH_BEFORE_CREATE` to `prompt-sections.ts` and reference it in `ORGANIC_STRUCTURING`: before `create_entity`, call `search_unified({query:title, collections:["entities"]})`; if score > ~0.7, link instead of create.
- Capture path: populate `existingEntityNames`/candidates in `capture.ts` BEFORE calling the IS (run the Typesense search up front), and feed them into the prompt so the LLM can choose link-vs-create.

**P2 — Require connectivity.** Structure prompt: "every extracted entity must have ≥1 relation unless it's a top-level concept (project/person/company); an orphan signals extraction failure." Make the schema/validation nudge toward it.

**P3 — Confidence-driven pre-dedup.** Entities with confidence < 0.5 → run dedup BEFORE materialize, propose linking, don't blind-create.

**P4 — Model tier.** Try the `balanced` tier for structure (better relation/dedup reasoning) — measure quality vs. the +latency.

**P5 — Source traceability.** Add an "extracted_from" link so every AI-created entity traces to its source (note/document/import). Currently missing.

---

## 4. CSV import — needs the AI upgrade you described

Today CSV → `analyze-bulk-mapping` (LLM proposes column→property plan) + per-row entity create. It's "okay, not good." The polished version you want:

- **One CSV → multiple entity TYPES + relations.** A CSV often encodes several entities per row (person + company + deal). AI should detect this (it partly does via bulk-mapping) and propose the multi-entity graph, not one flat entity per row.
- **Auto-generate a default VIEW.** After importing a CSV as entities, create a **table view** scoped to that profile by default (the CSV-as-a-view the user expects), so the import is immediately usable. Possibly a kanban/board if a status-like column exists.
- **Relations from columns.** Columns that reference other entities (assignee, company, project) → relations, not string properties.
- This rides the SAME graph-composite proposal + the (future) view-creation-in-proposal. CSV becomes: rows → graph (entities + relations) + a generated view, all in one governed proposal.

---

## 5. Consolidated roadmap (to "always qualitative import")

| #   | Work                                                                      | Layer                  | Status                 |
| --- | ------------------------------------------------------------------------- | ---------------------- | ---------------------- |
| 1   | Markdown → entity + **linked document** (versioning, MinIO, no 100KB cap) | import + entity-create | **decided, not built** |
| 2   | **Search-before-create** in agent + capture prompts                       | AI prompts             | not built (P1)         |
| 3   | Populate `existingEntityNames`/candidates before IS call                  | capture.ts             | not built (P1)         |
| 4   | Relation-required / anti-orphan in structure prompt+schema                | AI prompts             | not built (P2)         |
| 5   | Confidence-driven pre-dedup before materialize                            | capture pipeline       | not built (P3)         |
| 6   | Structure model tier eval (action → balanced)                             | config                 | not built (P4)         |
| 7   | Source traceability (`extracted_from`)                                    | schema + prompts       | not built (P5)         |
| 8   | CSV → multi-entity graph + auto-generated default view                    | import + views         | not built              |
| 9   | **Actually run the AI path on the real vault** (validate, not audit)      | testing                | **next**               |
| 10  | AI restructure step (Structure Steward) over imported notes               | new agent              | future                 |

**Done already (deterministic, live-validated):** graph composite proposals, governed import, folder-as-data + content-preservation, ref-resolution helpers (tested).

---

## 6. Immediate next step (proposed)

**Run the AI path live on a real-vault slice** — feed ~10 messy notes through `capture.structure` and see what it actually produces (orphans? dupes? good types? relations?). That converts the §2 audit into measured reality and tells us which of P1-P5 matters most. Pair it with #1 (markdown→document) since that's the clearest correctness fix.
