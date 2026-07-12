# Diagnosing what an AI did — the runs door

When a capture, automation, playbook, or session **didn't do what you (or the user) expected** — a facet wasn't attached, an entity landed in the wrong workspace, a step failed silently — do **not** guess or apologize. Every AI run leaves a trace. Read it.

## The one tool

`synap_diagnose` — the unified view of what an AI did across flows.

- **No args** → the recent run feed (automation · playbook · capture · session), newest first. Each run has an `id`, `flowType`, `status`, and `flowName`.
- **`runId` + `flowType`** → that run's **activity timeline**. For a **capture** run this is its decision + trace events: for each thing that was dropped/coerced, a machine-readable `reason` **and an actionable `fixHint`**.

(CLI equivalent for the operator: `synap diagnose` and `synap diagnose <captureId> --flow capture`.)

## The reflex

> "The capture didn't attach the client role" → `synap_diagnose({ runId: <captureId>, flowType: "capture" })` → read the `capture_trace` rows → act on the `fixHint`.

A capture's `id` **is** its correlationId — the same id stamped on the entities it created and returned to you as `captureId`. So you always have the key to diagnose your own last capture.

## Reading a capture trace

Each `capture_trace` activity item names a pipeline stage (`component`), why it stopped (`reason`), and what to do (`fixHint`). The common ones:

| reason                     | what happened                                                                                                           | what to do                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `not_in_creatable_catalog` | a role/kind you asked to create isn't a creatable entity kind — it's a **facet** (client, partner, prospect, investor…) | resolve the real entity first, then `attach_facet` for the role — never a second entity for a hat |
| `kind_mismatch`            | the facet's `applicableKinds` didn't include the target entity's kind                                                   | attach the role to an entity of a kind the role applies to                                        |
| `slug_coerce`              | a profileSlug was normalized/renamed to the canonical one                                                               | use the canonical slug next time (see `list_profiles`)                                            |
| `materialize_skip`         | an operation was skipped (dedup or a missing dependency)                                                                | check the dedup match; re-capture only what's genuinely new                                       |

If a run carries a `channelId` (playbook / session / automation), its message-level story lives in that channel — the timeline points you there rather than duplicating it.

## Why this matters

The point of the flywheel is that mistakes are **visible and fixable**, not silent. If you can see what happened, you can correct it — and every correction teaches the routing. Reach for `synap_diagnose` before you conclude "it didn't work."
