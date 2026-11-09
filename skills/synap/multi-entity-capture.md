## Multi-entity capture from free-form text

When the user pastes a block of unstructured content (a meeting transcript, an email, a LinkedIn bio) or when several related things come up at once, send it through the **one capture door** — `synap_capture` (CLI: `synap capture`). Don't chain manual creates, and don't run a two-step "structure then commit" dance.

The payload is a gradient in a single call:

```
{ "text": "…paste the raw content…" }              → the AI structures it into entities
{ "entities": [ … ], "relations": [ … ] }          → you supply the graph directly (refs link them)
```

Everything lands as ONE reviewable proposal (or auto-applies when every op is safe), and you get back one receipt — `status: "applied" | "proposed" | "rejected"`. `proposed` is success: surface the review link. There is no separate commit step. Read **`capture.md`** for the full flow, dedup signals, name-refs, and reject reasons.


## Examples (moved from the synap_capture definition)

**PLAN EXAMPLE — a project, a root session with two children (one blocked by the other), a spec document**
```json
{ "entities": [ { "ref": "acme", "profileSlug": "company", "title": "Acme Corp", "properties": { "website": "https://acme.com" } } ], "projects": [ { "ref": "p1", "name": "Acme onboarding", "subjectRef": "acme", "evidenceRefs": ["acme"] } ], "sessions": [ { "ref": "s0", "title": "Onboard Acme", "goal": "Acme is live on the platform", "projectRef": "p1", "subjectRef": "acme" }, { "ref": "s1", "title": "Write the spec", "goal": "Spec signed off by Acme", "parentRef": "s0", "projectRef": "p1" }, { "ref": "s2", "title": "Build the import", "goal": "Acme data imported", "parentRef": "s0", "projectRef": "p1", "blockedByRefs": ["s1"] } ], "documents": [ { "ref": "spec", "title": "Acme onboarding spec", "content": "# Spec\n…", "sessionRef": "s1" } ] }
```

**EXAMPLE 1 — raw text**
```json
{ "text": "Met Ada Lovelace of Acme at the conference — she owns their data platform and wants a demo in March." }
```

**EXAMPLE 2 — one structured entity, with properties + a long body**
```json
{ "entities": [ { "profileSlug": "person", "title": "Ada Lovelace", "properties": { "email": "ada@acme.com", "role": "Head of Data" }, "content": "## Notes\nOwns the data platform. Wants a March demo." } ] }
```

**EXAMPLE 3 — a small graph (refs link entities that do not exist yet)**
```json
{ "entities": [ { "ref": "p1", "profileSlug": "person", "title": "Ada Lovelace", "properties": { "email": "ada@acme.com" } }, { "ref": "c1", "profileSlug": "company", "title": "Acme Corp", "properties": { "website": "https://acme.com" } } ], "relations": [ { "sourceRef": "p1", "targetRef": "c1", "type": "works_at" } ] }
```

