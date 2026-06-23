# Capture & Import — Architecture Decisions

**Status:** Decision doc for review BEFORE further implementation.
**Date:** 2026-06-01
**Grounded in:** the real vault at `/Users/antoine/Documents/knowledge` (8068 files, 331 `.md`).

---

## 0. Clearing one misconception first (IS vs backend vs hub-protocol)

These are three different things and were getting conflated:

| Thing                         | Repo                           | Role                                                                                 |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| **Backend pod**               | `synap-backend`                | Owns data, entities, relations, **proposals**, and the `/api/hub/*` surface.         |
| **Hub Protocol**              | `synap-backend` (`/api/hub/*`) | Just the **REST surface of the backend**. NOT the AI.                                |
| **Intelligence Service (IS)** | `synap-intelligence-service`   | The **AI brain** — LLM structuring, agents. Called by the backend when AI is needed. |

**Does import now force everything through the IS / protocol?** **No.**

- `/import/analyze` lives entirely in the **backend** and is **deterministic — zero LLM, zero IS call.**
- The only thing that changed: `import.submitBatch` stopped **direct-writing** entities and now creates **proposals** — still 100% backend, no AI.

So the real axis is **not** "backend vs IS." It is **"who is allowed to write directly vs through a proposal."** Settled next.

---

## 1. Write invariant — REUSE the existing permission model (do not invent one)

Decision (per owner): **don't add a new rule; import follows the SAME permission model as every other capability.**

- **AI / agent / machine-originated writes → proposal** (same gate as AI capture, agent tools, MCP). Import-by-AI is just another AI capability; it uses the existing proposal system, full stop.
- **User-initiated import from the UI → not necessarily a proposal**, but the UI **previews what will be created before creating it** (show-before-commit). The human is the author; they don't approve their own action — they just see it first.

No new "write invariant" abstraction. No per-flow special-casing. The proposal system already encodes this; import plugs into it like everything else.

Concretely:

- `/import/analyze` (AI/agent path, e.g. MCP/CLI/connector or agent-driven) → creates a **pending proposal** (already implemented).
- A user dragging their own vault into the UI → the client shows a **preview** (the `types`/`items`/`references` the analysis returns) and, on confirm, creates directly **OR** approves the proposal — whichever matches how that surface already handles user-authored writes. Match the existing pattern; don't branch the model.

---

## 2. Capture vs Import — the boundary (settled)

Two intents, two mechanisms, ONE governance + ONE materializer:

|                       | **Capture**                                              | **Import**                                             |
| --------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Input                 | unstructured blob (text, a page, a chat)                 | already-structured corpus (Obsidian, Notion, a folder) |
| Structuring           | **AI** (`capture.structure`, LLM, per item)              | **deterministic** (`/import/analyze`, no LLM)          |
| Needs IS?             | yes                                                      | no                                                     |
| Output                | proposal                                                 | proposal (graph composite)                             |
| Approve / materialize | same `proposals.approve` → same entity/relation creation | same                                                   |

**AI restructuring of imported data is a THIRD, separate step** (the future "Structure Steward") — never folded into import. Import mirrors; restructure improves. See §4 for why this separation is load-bearing.

---

## 3. Import model — generic ingestion (direction), thin adapters (for now)

Decision (per owner): **target a generic format-detect + conventions design; keep the current thin adapters for now to compare quality.**

**The spine is already source-agnostic** (`ImportItem` + `buildImportProposal`). The only source-specific code is the parse shim. Direction:

```
ingest({ path, content, mimeType })
  → detect format: markdown | csv | html | json
  → apply conventions:
       folder path      → type candidate
       frontmatter / columns → properties
       [[wikilinks]] / <a href> / relation-columns → references
  → ImportItem[]  → buildImportProposal → graph composite proposal
```

So "Obsidian", "Notion export", "a folder of markdown" are **the same markdown handler** — not separate adapters. Only genuinely alien semantics (LinkedIn CSV column meaning) justify a named override. **~2 format handlers + conventions, not ~5 adapters.**

**For now:** keep the existing thin `obsidian` adapter so we can A/B its output quality against the generic handler on the real vault before committing. Adapter stays an escape hatch; generic becomes the default.

---

## 4. What the REAL vault tells us (grounding — this changes the UX requirement)

Measured on `/Users/antoine/Documents/knowledge`:

| Signal          | Reality                                                                      | Implication                                                             |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.md` files     | 331 (of 8068 total files)                                                    | most files aren't notes — ingestion must filter, not choke              |
| **frontmatter** | **1 / 331**                                                                  | `frontmatter.type` is essentially USELESS as a type signal here         |
| **wikilinks**   | **82 / 331** (~25%)                                                          | a real but partial graph — relations matter, but most notes are islands |
| top folders     | "1. Daily", "5. Projects", "4. Questionnements", "journals", "Z_Ressources"… | folders are **numbered buckets / PARA-ish**, not clean entity types     |

**The load-bearing conclusion:** a purely deterministic mirror (`type = frontmatter.type ?? topFolder ?? "note"`) would dump ~330 notes into slug-types like `1-daily`, `5-projects`, `z-ressources`. That is **faithful but not good** — it mirrors the user's filesystem mess, it doesn't produce a clean knowledge structure.

This is the strongest possible validation of the **import-vs-restructure separation**:

1. **Import (deterministic):** faithfully bring everything in — notes as entities, real wikilinks as relations, folders as provisional tags/types. Lossless, cheap, reviewable. **Never tries to be smart.**
2. **Restructure (AI, separate, opt-in):** _after_ import, the Structure Steward proposes a BETTER structure (real entity types, merged dups, inferred relations) — as its own governed proposals the user validates.

If we'd folded "propose a good structure" into import, it would force an LLM pass over 331 notes and still be wrong about folders. Keeping them separate means import is **instant + trustworthy**, and "make it good" is a **deliberate, reviewable AI step** — which is exactly the product story ("you bring your data, the AI helps you structure it").

**UX requirement that falls out of this:** the import review must NOT pretend the deterministic types are final. It should present: "N notes, M links, provisional buckets from your folders — import faithfully now; let the AI propose a cleaner structure next." Two-step, honest.

---

## 5. What this means for the build (plan, not yet code)

Backend (ours):

- `/import/analyze` deterministic graph proposal — **done.** Validate output quality on the real vault (A/B thin-adapter vs generic handler).
- Generic format-detect ingestion as the default path (markdown/csv/html/json + conventions); keep `obsidian` adapter as comparison/escape hatch.
- A tRPC **passthrough** so a browser app can call it (frontend speaks tRPC, not `/api/hub/*` REST) — confirmed required.
- (Later) Structure Steward = the AI restructure step over imported data.

Frontend (other agent's lane; we spec, they build — on **the browser app the user consolidates on**, not assumed to be studio):

- Inbox becomes **composite-graph-aware** (chosen): the generic proposal inbox renders `data.operations[]` (N entities + M relations) so graph proposals — from import AND non-browser callers (MCP/CLI) — have a home. (`ProposalCard`/mapper extension + a `CompositeProposalCard` reusing `EntityRelationshipsDisplay`.)
- Import entry: drop a vault → `import/analyze` (preview) → review (faithful, two-step framing) → approve.

Open validation before/with implementation:

1. Run `/import/analyze` on a slice of the real vault; inspect the proposal quality (types from numbered folders? wikilink resolution rate?). Decide how folders map (provisional tag vs type).
2. Confirm the target browser app (consolidation choice) so the FE spec points at the right app.
3. Confirm the generic-handler vs thin-adapter quality comparison before deleting adapters.

---

## 6. Summary of decisions

1. Import is **backend + deterministic**; it does NOT route through the IS. Misconception cleared.
2. **Reuse the existing permission model** — AI import → proposal; user UI import → preview-before-create. No new invariant.
3. **Capture (AI) vs Import (deterministic)** are separate; **AI restructure is a third, separate step.** One proposal gate + one materializer for all.
4. Import design target: **generic format-detect + conventions**; thin adapters kept temporarily for quality comparison.
5. The real vault proves the **import≠restructure** separation: deterministic import must be faithful-not-smart; "make it good" is a deliberate AI step.
6. Frontend: **composite-aware inbox** (graph proposals render generically) + import entry, on the consolidated browser app.
