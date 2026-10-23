# Governance — `"proposed"` is success, not an error

This is the single most important thing to get right when writing code that
mutates a Synap pod.

## The contract

Every governed mutation (`entities.create`, `entities.update`, `relations.create`, …)
has one of three outcomes, decided **by the pod**, not by your app:

| Outcome | How it arrives | What your code should do |
|---|---|---|
| applied | resolves with the procedure's own status (`"created"`, `"updated"`, …) | proceed |
| proposed | resolves with `status: "proposed"`, `proposalId`, `reviewUrl`, `message` — queued for the pod owner's review (like a PR) | **surface the review — do NOT treat as failure, do NOT retry** |
| denied | **rejects** with a tRPC `FORBIDDEN` error whose message is the reason | show why; do not retry blindly |

## Why it matters for your code

- **Never treat `proposed` as an error.** It is the normal, healthy path for any
  write that governance decides a human should see first. Retrying a `proposed`
  write creates duplicates.
- **A `proposed` result does not throw.** It is a successful response with a
  status; only a denial throws.
- **Surface the review link/id** so the user can approve it. An unreviewed
  proposal is not yet in the graph — it won't show up in reads until approved.

## Pattern

```ts
import { TRPCClientError } from "@trpc/client";

try {
  const res = await synap.entities.create.mutate(input);
  if (res.status === "proposed") {
    // tell the user "queued for review"; link res.reviewUrl / res.proposalId.
    // res.entity is null — nothing exists until the proposal is approved.
  } else {
    // "created": res.id / res.entity are live
  }
} catch (err) {
  if (err instanceof TRPCClientError && err.data?.code === "FORBIDDEN") {
    // denied: show err.message; don't retry
  } else throw err;
}
```

## Idempotency

`entities.create` takes no idempotency key. The pod dedups some repeats on its
own — an identical agent-authored retry within a short window, and creates that
match an existing entity by identity (a stable `externalId`, or identifying
properties) — but neither covers every case. Never resend a `proposed` write,
and when unsure, read back before re-creating.
