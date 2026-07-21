## Multi-entity capture from free-form text

When the user pastes a block of unstructured content (a meeting transcript, an email, a LinkedIn bio) or when several related things come up at once, send it through the **one capture door** — `synap_capture` (CLI: `synap capture`). Don't chain manual creates, and don't run a two-step "structure then commit" dance.

The payload is a gradient in a single call:

```
{ "text": "…paste the raw content…" }              → the AI structures it into entities
{ "entities": [ … ], "relations": [ … ] }          → you supply the graph directly (refs link them)
```

Everything lands as ONE reviewable proposal (or auto-applies when every op is safe), and you get back one receipt — `status: "applied" | "proposed" | "rejected"`. `proposed` is success: surface the review link. There is no separate commit step. Read **`capture.md`** for the full flow, dedup signals, name-refs, and reject reasons.
