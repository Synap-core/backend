# Escalation ladder — discover → invent under proposal → crystallize after proof

The always-on brief lives in `reflexes.md`. This file is the full HOW when you need more than the corner-of-your-head reminder.

## Why it exists

Agents fail in two ways: (1) dead-end ("I can't do that") when the substrate could express the need after discovery or a proposed meta change, and (2) silent invent (minting workspaces/profiles/views without checking what already exists). The ladder is the habit that prevents both. Soft teaching only — no hard tool filtering by tier.

## Levels

### L0 — Reflexes (always)

Recall before non-trivial work (`synap_ask` / search). Capture durable learning after. Treat `"proposed"` as success-in-review, not an error. Orient once per session.

### L1 — OPERATE on data

Default mode: work with what already exists.

- Capture free text, create/update entities, link, attach **known** facets
- Start/update sessions when the work is a unit with a deliverable
- Prefer existing profiles, views, capabilities, playbooks over inventing structure

### L2 — DISCOVER before invent

When the tool list or current schema doesn't express the need — **search before minting**:

1. `list_profiles` / `list_views` / `list_capabilities({query})` in the active lenses
2. `market.search({query, kind?})` over `capability` | `template` | `automation` | `cell`
3. Load the relevant skill (`load_skill` / discover_tools) if the HOW is unclear

Only if L2 returns empty for the real need do you climb to L3.

### L3 — MUTATE the meta-model (proposal-gated)

Extend the substrate so the need becomes expressible. Always governed — expect `"proposed"`.

| Need               | Prefer               | Tool sketch                                                                                                            |
| ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Role/hat missing   | Existing role attach | `define_role` only after `list_profiles` empty for that role                                                           |
| Field missing      | Existing property    | `define_kind` with the existing kind's slug + the new field in `properties[]` (slug-idempotent)                        |
| Kind missing       | Closest parent kind  | `define_kind` (extend, don't fork). Pod-wide by default — pass `entityScope:'workspace'` only for an app-specific kind |
| View missing       | Existing view        | `list_views` first, then `create_view` (recovery or proactive)                                                         |
| Domain missing     | **Template**         | `market.search(kind:template)` → install/propose **before** freehand `create_workspace`                                |
| Capability missing | Marketplace          | `market.install` (always proposes for agents)                                                                          |

**Template-before-workspace (hard rule in teaching):** new operational domains start as marketplace templates when one fits. Freehand workspace creation is last resort after the four workspace-design conditions hold (`workspace-design.md`). Capture never invents a workspace — placement only routes into existing lenses.

### L4 — CRYSTALLIZE after proof

After a one-off has succeeded and is clearly repeatable:

- Session that worked → `promote_session_to_playbook`
- Cell that presents well for a type/slot → `promote_cell_to_renderer`
- Repeatable process authored deliberately → `create_playbook`

Never crystallize a speculative or failed one-off. One structural suggestion at a time; if speculative, ask first (`creative-loop.md`).

## Decision gates (cheat sheet)

```
Can I do it with existing data/tools?
  yes → L1
  no  → L2 discover
         found → use / install (propose) / enable
         empty → L3 propose meta change (never silent invent)
Did a one-off just succeed and will recur?
  yes → offer L4 (question if speculative)
  no  → leave it as a one-off
```

Blocked path: **never** invent silently; **never** stop at a dead-end error — climb L2→L3 and propose. Success path: one clear structural nudge, not a cascade of schema changes.
