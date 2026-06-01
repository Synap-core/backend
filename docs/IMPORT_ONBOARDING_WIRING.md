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

## Backend contract (IMPLEMENTED + tested)

`POST /api/hub/import/analyze` — analyze a structured source and create ONE governed **graph composite proposal** (N entities + M relations), validated by the user atomically.

```jsonc
// request
{ "userId": "...", "workspaceId": "...(optional)",
  "source": "obsidian",            // enum, extensible via adapters
  "relationType": "references",    // optional, default "references"
  "items": [ { "path": "Projects/Launch.md", "content": "<raw md>" }, ... ] }

// response
{ "workspaceId": "...", "source": "obsidian",
  "proposalId": "<uuid>",          // <-- the pending GRAPH composite proposal
  "types":  [ { "slug": "project", "displayName": "Project", "source": "type-hint", "metadataKeys": ["status"], "itemCount": 2 } ],
  "items":  [ { "tempId": "t1", "typeSlug": "project", "title": "Launch", "properties": {...}, "sourceRef": "Projects/Launch", "labels": ["priority"] } ],
  "references": [ { "sourceTempId": "t1", "targetTempId": "t3", "targetName": "Antoine", "relationType": "references", "resolved": true } ],
  "stats": { "itemCount": 5, "typeCount": 3, "referenceCount": 4, "unresolvedReferences": 1 },
  "droppedReferences": 1 }
```

**Key change from the first draft:** the endpoint no longer hands back an `executePayload` for the client to forward to `capture.execute`. Instead it **creates a single pending graph composite proposal** (`proposalId`) via the same `createEventBackedProposal` gate every governed write uses. The whole graph is one unit of work: approving that one proposal materializes all entities + relations atomically. The `types`/`items`/`references` are returned for the review UI to render the preview.

### The graph composite proposal (the unit-of-work)

`proposals.data` carries:
```jsonc
{ "operations": [
    { "op": "create_entity", "ref": "t1", "profileSlug": "project", "title": "Launch", "properties": {...} },
    { "op": "create_entity", "ref": "t3", "profileSlug": "person",  "title": "Antoine", ... },
    { "op": "create_relation", "type": "references", "sourceRef": "t1", "targetRef": "t3" }
  ],
  "source": "obsidian" }
```
On approval (generalized composite branch in `routers/proposals.ts`): **pass 1** creates every `create_entity` op (canonical entity path, full side-effects), building a `ref → realId` map (`ref` = the item tempId; positional `$opN` and `$primary` also resolve); **pass 2** creates relations, resolving each `sourceRef`/`targetRef` through the map (a literal that isn't an in-proposal ref is treated as an existing entity UUID, so a graph can link to pre-existing data). Atomic, governed, no pre-minted entity ids — `tempId`/`ref` IS the reservation, living only inside the unit of work.

This is the SAME `CompositeProposalData` type the approve flow consumes — a test (`import.test.ts`) locks the bridge output to `isCompositeProposalData()`.

## Governance — now consistent

All import writes go through proposals:
- `import.submitBatch` (file batch: markdown/csv/bookmarks) — **changed** from direct-write to **pending proposals** via `createEventBackedProposal` (one per parsed entity). Returns `proposalsCreated` in stats. (JSON-chat→channel and raw file storage stay as-is — channels/files aren't entity writes.)
- `/import/analyze` (structured graph) — **one** governed graph proposal.
- `capture.structure` (unstructured) — already proposal-gated.

## Frontend wiring (other agent's lane) — minimal

1. In `import-categories.ts`, tag structured sources with `source: "obsidian"` (etc.).
2. In `HydrationFlow`, for items whose category has a `source`, call `import/analyze` (REST/tRPC passthrough) instead of `capture.structure`.
3. The response gives a `proposalId` (the graph proposal) + a preview (`types`/`items`/`references`). Render the preview in an `import-review` sub-stage (or reuse `ReviewStage`); on approve, call the existing `proposals.approve(proposalId)` — **no per-entity execute, no glue**. Surface `droppedReferences` ("N links pointed outside the import").
4. Anchors from the earlier explore spec: `HydrationFlow.tsx:39` (stage order), new `ImportReviewStage.tsx`, `DumpStage.tsx:52-59` (button routing).

## Front/back seam (decision C)

- **Backend `/import/analyze`** is canonical for **non-browser** callers (MCP, CLI, connectors, API) — the user confirmed import is not browser-only.
- **Frontend `@synap-core/hydration`** stays for interactive onboarding (mature, client-side parsers).
- Both target the **same governed proposal unit** (graph composite for structured; per-entity pending proposal otherwise) and the **same approve gate** — so neither re-implements materialization, and there's no second write path.

## Conceptual model (settled + implemented)

- **Import = faithful mirror** of already-structured data (deterministic). Source-agnostic `ImportItem` + adapters; only the adapter is source-specific.
- **AI capture (`capture.structure`)** = unstructured blob → entities (LLM). Different concern; kept separate.
- **AI restructuring** of imported data = a **separate later step** (Structure Steward), not part of import.
- **The graph composite proposal** is the shared unit-of-work both import and capture-cluster target: the user validates a whole graph at once; entity ids are minted only at approval; `tempId`/`ref` is the in-proposal reservation (no half-created "draft" entities).
