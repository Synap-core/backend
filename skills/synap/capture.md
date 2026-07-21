# Capture — the one write door

`synap_capture` (CLI: `synap capture`) is THE door for writing what you learn into the pod. **Never classify your input first.** The payload is a _gradient_ — send as much structure as you already have, in ONE call. Precision comes from sending MORE structure in the SAME call, never from picking a different tool and never from a second "commit" step.

```
text        → free prose; the AI structures it into the right entities (raw text kept as provenance)
entities[]  → you already know the kind + fields
entities[] + relations[]  → a graph; refs link things that don't exist yet, reviewed as ONE proposal
```

There is no wrong door to pick, because there is one door. `text` alone is the old "capture"; `entities[]` is the old "rich create"; `entities[] + relations[]` is the composite graph. All three go through `synap_capture`.

## One call → one receipt (no plan-and-commit)

You are an agent, so a capture is **one call**. The backend derives that from your identity (agent key ⇒ agent mode) — you never pass a mode. Policy decides the terminal automatically:

- every op is safe/whitelisted → **auto-applied**
- any op is destructive or non-whitelisted → the whole graph is **proposed** (atomic, all-or-nothing)

It always returns the same receipt:

```json
{ "status": "applied" | "proposed" | "rejected",
  "scope":  { "workspaceId": "…", "projectId": "…", "sessionId": "…" },
  "writeReceipt": { … } }
```

**`status: "proposed"` is SUCCESS**, not a failure — the write is queued for the user's review like a PR. Surface the `reviewUrl` and keep working. Never report "done" for a `proposed` result, and there is **no** separate step you must call after capture — the one call is the whole write.

## capture vs create_entity

- **`synap_create_entity`** — use ONLY when you already have exactly ONE fully-structured, typed entity (a known `profileSlug` + fields). Deterministic, direct.
- **`synap_capture`** — everything else: unstructured text, several entities, a graph, or **when in doubt**. It handles the whole gradient; you don't have to decide "loose fact vs structured object."

## Worked examples

```json
// 1 — raw text (the AI structures it)
{ "text": "Met Ada Lovelace of Acme at the conference — she owns their data platform and wants a demo in March." }

// 2 — one structured entity with a long body
{ "entities": [
  { "profileSlug": "person", "title": "Ada Lovelace",
    "properties": { "email": "ada@acme.com", "role": "Head of Data" },
    "content": "## Notes\nOwns the data platform. Wants a March demo." }
] }

// 3 — a small graph (refs link entities that don't exist yet)
{ "entities": [
    { "ref": "p1", "profileSlug": "person",  "title": "Ada Lovelace", "properties": { "email": "ada@acme.com" } },
    { "ref": "c1", "profileSlug": "company", "title": "Acme Corp",    "properties": { "website": "https://acme.com" } }
  ],
  "relations": [ { "sourceRef": "p1", "targetRef": "c1", "type": "works_at" } ] }
```

## Dedup — strong signals only

The dedup signals are the exact property keys `email`, `phone`, `website`, `linkedinUrl`, `twitterHandle`, `githubUsername`. Sending a URL under any other key (e.g. a bare `url`) is **not** a dedup signal and will duplicate the entity.

A same-title hit in a _different_ kind is **advisory** (`crossKindCandidates`), never an auto-merge. So "no exact match" does **not** mean "safe to create" when advisory candidates come back — review them first. To link to something that already exists, give it a `ref` plus `existingEntityId`.

## Name-refs — never ask for a UUID

Reference an existing project by **name**, not id — the server resolves `{ project: { name: "Synap" } }` against the caller's own projects. Exact match ⇒ it files there; no match ⇒ it proposes/creates, never silently mis-files. Never ask the user for a UUID.

## Placement — existing lenses only

Capture **never invents a workspace** (or other meta-structure) to "find a home". It routes into **existing** workspaces/projects/profiles — `synap orient` + `list_profiles` first when placement is ambiguous. Structure emerges progressively: capture into what exists; suggest a new profile only when the user repeatedly tracks a thing that fits none, and a view only once that profile has 3+ entities. Missing structure is an escalation-ladder L2→L3 conversation (discover, then propose), not a side effect of capture. `global: true` stores a pod-wide runbook (text lane only).

## Rejection is a correct outcome — don't retry

`status: "rejected"` means the door protected the graph on purpose. Read the `reason` and act, don't loop:

- **`already-known`** — a lone entity carrying nothing but identity signals that already resolve to an existing one. Its id is returned; re-send with content / extra properties / relations to **enrich** it instead.
- **`no-durable-content`** — nothing storable was sent (empty / whitespace / punctuation-only). Don't call capture with zero substance.
- **`structuring-unavailable`** — text lane only: the AI structurer is down. Tell the user and retry later.

(There is no "recall-loop" rejection.)
