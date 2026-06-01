# Data Import × Onboarding — wiring spec

**Status:** Backend complete + tested. Frontend wiring is a small, well-scoped change (other agent's lane). This doc is the hand-off.

## What exists (don't rebuild)

The studio app already has a **complete first-run onboarding wizard** — `HydrationFlow` (`apps/studio/components/onboarding/`), stages `dump → structure → review → arrive`:
- **DumpStage** — categorized dropzones (AI exports, People, Notes incl. **Obsidian/Notion/markdown**, Misc); a frontend `ImporterRegistry` (`@synap-core/hydration`) unzips + parses client-side.
- **StructureStage** — calls `capture.structure` (the **AI/LLM** path) per dump → entity proposals.
- **ReviewStage** — bulk approve/reject → `capture.execute` (governed materialize).
- **ArriveStage** — welcome → `/home`.

So onboarding, import dropzones, AI structuring, review, and the proposal gate **already work**.

## The gap (the only real wiring)

Two import paths don't know about each other, and one is wrong for structured sources:

| Source kind | Right path | Why |
|---|---|---|
| **Unstructured** (ChatGPT/Claude export, loose text) | `capture.structure` (LLM) | needs AI to extract entities from a blob |
| **Already-structured** (Obsidian, Notion, markdown w/ frontmatter+links) | **`POST /api/hub/import/analyze`** (deterministic) | per-note LLM is expensive + lossy on structure; faithful mirror is correct |

Today the wizard sends *everything* through `capture.structure`. Obsidian should go through the new deterministic endpoint instead.

## Backend contract (done, tested, deployed-ready)

`POST /api/hub/import/analyze`
```jsonc
// request
{ "userId": "...", "workspaceId": "...(optional)",
  "source": "obsidian",            // enum, extensible via adapters
  "relationType": "references",    // optional, default "references"
  "items": [ { "path": "Projects/Launch.md", "content": "<raw md>" }, ... ] }

// response
{ "workspaceId": "...", "source": "obsidian",
  "types":  [ { "slug": "project", "displayName": "Project", "source": "type-hint", "metadataKeys": ["status"], "itemCount": 2 } ],
  "items":  [ { "tempId": "t1", "typeSlug": "project", "title": "Launch", "properties": {...}, "sourceRef": "Projects/Launch", "labels": ["priority"] } ],
  "references": [ { "sourceTempId": "t1", "targetTempId": "t3", "targetName": "Antoine", "relationType": "references", "resolved": true } ],
  "stats": { "itemCount": 5, "typeCount": 3, "referenceCount": 4, "unresolvedReferences": 1 },
  "executePayload": { "entities": [...], "relations": [...] },  // <-- READY for capture.execute
  "droppedReferences": 1 }
```

**Key:** `executePayload` is already shaped for `capture.execute` (typeSlug→profileSlug done, unresolved refs dropped). The frontend doesn't transform anything.

## Frontend wiring (other agent's lane) — minimal

1. In `import-categories.ts`, tag structured sources with `source: "obsidian"` (etc.).
2. In `HydrationFlow`, for items whose category has a `source`, call `import.analyze` (new tRPC/REST passthrough) instead of `capture.structure`.
3. Insert an `import-review` sub-stage (or reuse `ReviewStage`) to show `types` + `items` + `references` from the proposal. The explore-agent's spec named the exact files: `HydrationFlow.tsx:39` (stage order), a new `ImportReviewStage.tsx`, `DumpStage.tsx:52-59` (button routing).
4. On approve, forward `response.executePayload` straight to `capture.execute`. Surface `droppedReferences` ("N links pointed outside the import").

## Conceptual model decision (settled)

- **Import = faithful mirror** of already-structured data (deterministic). Source-agnostic `ImportItem` + adapters; only the adapter is source-specific.
- **AI capture (`capture.structure`)** = unstructured blob → entities. Different concern; kept separate.
- **AI restructuring** of imported data = a **separate later step** (Structure Steward), not part of import.

This keeps the two AI/non-AI paths from duplicating, and lets new sources (Apple Notes, Notion, folder) ship as one adapter each with zero downstream change.
