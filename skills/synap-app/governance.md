# Governance — `"proposed"` is success, not an error

This is the single most important thing to get right when writing code that
mutates a Synap pod.

## The contract

Every mutation (`entities.create`, `entities.update`, `relations.create`, …)
resolves to one of three outcomes, decided **by the pod**, not by your app:

| Outcome | Meaning | What your code should do |
|---|---|---|
| `approved` | applied immediately | proceed |
| `proposed` | queued for the pod owner's review (like a PR) | **surface the review — do NOT treat as failure, do NOT retry** |
| `denied` | the principal may not do this | show why; do not retry blindly |

## Why it matters for your code

- **Never treat `proposed` as an error.** It is the normal, healthy path for any
  write that governance decides a human should see first. Retrying a `proposed`
  write creates duplicates.
- **Never `try/catch` a `proposed` as if it threw.** It's a successful response
  with a status, not an exception.
- **Surface the review link/id** so the user can approve it. An unreviewed
  proposal is not yet in the graph — it won't show up in reads until approved.

## Pattern

```ts
const res = await synap.entities.create.mutate(input);
switch (res.status) {
  case "approved": /* it's live */ break;
  case "proposed": /* tell the user: "queued for review" + show res.proposalId */ break;
  case "denied":   /* show res.reason; don't retry */ break;
}
```

## Idempotency

If you must retry a create after a network error, pass an idempotency key where
the API accepts one — a `proposed` write that you retry without one will
duplicate on approval. When unsure, read back before re-creating.
